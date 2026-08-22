import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const PLUGIN_VERSION = "0.1.0"
const INSTANCE_NONCE = randomUUID()
const DEFAULT_POCKET_URL = "http://127.0.0.1:8787"
const ROUTE_POLL_MS = 150
const HEARTBEAT_MS = 5_000
const RETRY_MS = 750
let sequence = 0

function expandHome(value, home) {
  if (value === "~") return home
  if (value.startsWith("~/")) return join(home, value.slice(2))
  return resolve(value)
}

export function resolveOptions(options = {}, env = process.env, home = homedir()) {
  const optionUrls = options.pocketUrls
  const optionUrl = options.pocketUrl || options.url
  const envUrls = env.OPENCODE_POCKET_URLS
  const values = optionUrls
    ? Array.isArray(optionUrls) ? optionUrls : String(optionUrls).split(",")
    : optionUrl ? [optionUrl]
      : envUrls ? String(envUrls).split(",")
        : [env.OPENCODE_POCKET_URL || DEFAULT_POCKET_URL]
  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state")
  const tokenFile = expandHome(
    options.tokenFile || env.OPENCODE_POCKET_TOKEN_FILE || join(stateHome, "opencode-pocket", "plugin-token"),
    home,
  )

  try {
    const pocketUrls = [...new Set(values.map((value) => new URL(String(value).trim()).origin))]
    if (pocketUrls.length === 0) return null
    return { pocketUrl: pocketUrls[0], pocketUrls, tokenFile }
  } catch {
    return null
  }
}

export function routeState(route) {
  const name = typeof route?.name === "string" ? route.name : "unknown"
  return {
    route: name,
    ...(name === "session" && typeof route?.params?.sessionID === "string"
      ? { sessionId: route.params.sessionID }
      : {}),
  }
}

export function healthOrigin(result) {
  const value = result?.response?.url || result?.request?.url
  if (!value) return undefined
  try {
    const target = new URL(value)
    const host = target.hostname.replace(/^\[|\]$/g, "")
    if (target.protocol !== "http:" || !target.port || !["127.0.0.1", "localhost", "::1"].includes(host)) return undefined
    return target.origin
  } catch {
    return undefined
  }
}

async function tui(api, options) {
  const config = resolveOptions(options)
  if (!config) return

  let disposed = false
  let serverUrl
  let token
  let discoveryTimer
  let warnedMissingPort = false
  const targets = config.pocketUrls.map((pocketUrl) => ({ pocketUrl, queue: [], sending: false }))
  let current = routeState(api.route.current)
  let currentKey = JSON.stringify(current)

  const loadToken = async () => {
    const fromEnv = process.env.OPENCODE_POCKET_TOKEN?.trim()
    if (fromEnv) return fromEnv
    return (await readFile(config.tokenFile, "utf8")).trim()
  }

  const report = (state) => ({
    ...state,
    instanceNonce: INSTANCE_NONCE,
    sequence: ++sequence,
    pluginVersion: PLUGIN_VERSION,
  })

  const request = async (target, method, body, timeoutMs) => {
    const controller = new AbortController()
    target.activeController = controller
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${target.pocketUrl}/api/plugin/tui-state`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Pocket returned ${response.status}`)
    } finally {
      clearTimeout(timeout)
      if (target.activeController === controller) target.activeController = undefined
    }
  }

  const flush = (target) => {
    if (disposed || target.sending || !serverUrl || target.queue.length === 0) return target.flushPromise
    target.sending = true
    target.flushPromise = (async () => {
      try {
        token ||= await loadToken()
        if (!token) throw new Error("Pocket plugin token is empty")
        while (!disposed && target.queue.length > 0) {
          const item = target.queue[0]
          await request(target, "POST", { serverUrl, ...item }, 2_000)
          if (target.queue[0] === item) target.queue.shift()
        }
      } catch {
        token = undefined
        if (!disposed && !target.retryTimer) {
          target.retryTimer = setTimeout(() => {
            target.retryTimer = undefined
            void flush(target)
          }, RETRY_MS)
        }
      } finally {
        target.sending = false
      }
    })()
    return target.flushPromise
  }

  const enqueue = (state) => {
    const item = report(state)
    for (const target of targets) {
      target.queue.splice(0, target.queue.length, item)
      void flush(target)
    }
  }

  const discover = async () => {
    try {
      const health = await api.client.global.health()
      serverUrl = healthOrigin(health)
      if (!serverUrl && !warnedMissingPort) {
        warnedMissingPort = true
        await api.client.tui?.showToast?.({
          title: "OpenCode Pocket",
          message: "Restart OpenCode with --port 0 to enable Pocket discovery.",
          variant: "warning",
          duration: 8_000,
        }).catch(() => {})
      }
    } catch {
      serverUrl = undefined
    }
    if (serverUrl) {
      for (const target of targets) void flush(target)
      return
    }
    if (!disposed) discoveryTimer = setTimeout(() => void discover(), RETRY_MS)
  }

  enqueue(current)
  void discover()

  const poll = setInterval(() => {
    try {
      const next = routeState(api.route.current)
      const key = JSON.stringify(next)
      if (key === currentKey) return
      current = next
      currentKey = key
      enqueue(current)
    } catch {
      // Route reporting must never interfere with the TUI.
    }
  }, ROUTE_POLL_MS)

  const heartbeat = setInterval(() => enqueue(current), HEARTBEAT_MS)

  api.lifecycle.onDispose(async () => {
    disposed = true
    clearInterval(poll)
    clearInterval(heartbeat)
    clearTimeout(discoveryTimer)
    for (const target of targets) {
      clearTimeout(target.retryTimer)
    }
    await Promise.allSettled(targets.map((target) => target.flushPromise).filter(Boolean))

    if (!serverUrl) return
    try {
      token ||= await loadToken()
      if (!token) return
      const item = report(current)
      await Promise.allSettled(targets.map((target) => request(target, "DELETE", { serverUrl, ...item }, 1_000)))
    } catch {
      // Shutdown reporting is best effort.
    }
  })
}

export default {
  id: "opencode-pocket",
  tui,
}
