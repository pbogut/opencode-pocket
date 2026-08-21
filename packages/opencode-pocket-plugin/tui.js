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
  const pocketUrl = options.pocketUrl || options.url || env.OPENCODE_POCKET_URL || DEFAULT_POCKET_URL
  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state")
  const tokenFile = expandHome(
    options.tokenFile || env.OPENCODE_POCKET_TOKEN_FILE || join(stateHome, "opencode-pocket", "plugin-token"),
    home,
  )

  try {
    return { pocketUrl: new URL(pocketUrl).origin, tokenFile }
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
  let sending = false
  let retryTimer
  let discoveryTimer
  let activeController
  let warnedMissingPort = false
  const queue = []
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

  const request = async (method, body, timeoutMs) => {
    const controller = new AbortController()
    activeController = controller
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${config.pocketUrl}/api/plugin/tui-state`, {
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
      if (activeController === controller) activeController = undefined
    }
  }

  const flush = async () => {
    if (disposed || sending || !serverUrl || queue.length === 0) return
    sending = true
    try {
      token ||= await loadToken()
      if (!token) throw new Error("Pocket plugin token is empty")
      while (!disposed && queue.length > 0) {
        const item = queue[0]
        await request("POST", { serverUrl, ...item }, 2_000)
        if (queue[0] === item) queue.shift()
      }
    } catch {
      token = undefined
      if (!disposed && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          void flush()
        }, RETRY_MS)
      }
    } finally {
      sending = false
    }
  }

  const enqueue = (state) => {
    queue.splice(0, queue.length, report(state))
    void flush()
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
      void flush()
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
    clearTimeout(retryTimer)
    clearTimeout(discoveryTimer)
    activeController?.abort()

    if (!serverUrl) return
    try {
      token ||= await loadToken()
      if (!token) return
      await request("DELETE", { serverUrl, ...report(current) }, 1_000)
    } catch {
      // Shutdown reporting is best effort.
    }
  })
}

export default {
  id: "opencode-pocket",
  tui,
}
