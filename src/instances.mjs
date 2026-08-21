import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { OpenCodeDiscovery } from "./discovery.mjs"
import { OpenCodeBridge } from "./opencode.mjs"

const MDNS_OFFLINE_TIMEOUT_MS = 30_000

export function instanceIdForUrl(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 12)
}

function pluginServerUrl(value) {
  let target
  try { target = new URL(value) } catch { return "" }
  const host = target.hostname.replace(/^\[|\]$/g, "")
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || target.protocol !== "http:" || !target.port) return ""
  return target.origin
}

function primarySource(sources) {
  return ["configured", "mdns", "plugin", "discovered"].find((source) => sources.has(source)) || "discovered"
}

export class InstanceManager extends EventEmitter {
  constructor(config, options = {}) {
    super()
    this.config = config
    this.Bridge = options.Bridge || OpenCodeBridge
    this.discovery = options.discovery || new OpenCodeDiscovery()
    this.instances = new Map()
    this.maintenanceTimer = null
    this.discovery.on("up", (endpoint) => {
      this.add(endpoint.url, { source: "mdns", serviceName: endpoint.serviceName }).catch((error) => this.emit("error", error))
    })
    this.discovery.on("down", (endpoint) => {
      const instance = this.instanceForUrl(endpoint.url)
      if (instance) this.removeSource(instance, "mdns")
    })
    this.discovery.on("error", (error) => this.emit("error", error))
  }

  async start() {
    if (this.config.openCodeUrl) await this.add(this.config.openCodeUrl, { source: "configured" })
    if (this.config.discovery) this.discovery.start()
    this.maintenanceTimer = setInterval(() => {
      const now = Date.now()
      this.expireTuiStates(now)
      this.expireOfflineSources(now)
    }, 3_000)
    this.maintenanceTimer.unref?.()
  }

  async add(url, metadata = {}) {
    const normalizedUrl = url.replace(/\/$/, "")
    const id = metadata.id || instanceIdForUrl(normalizedUrl)
    const source = metadata.source || "discovered"
    const existing = this.instances.get(id) || this.instanceForUrl(normalizedUrl)
    if (existing) {
      const previousSource = existing.source
      const previousServiceName = existing.serviceName
      const addedSource = !existing.sources.has(source)
      existing.sources.add(source)
      existing.source = primarySource(existing.sources)
      if (metadata.serviceName) existing.serviceName = metadata.serviceName
      if (source === "mdns" && addedSource) existing.offlineSince = null
      if (existing.source !== previousSource || existing.serviceName !== previousServiceName) this.emitState()
      return existing
    }

    const bridge = new this.Bridge({
      ...this.config,
      openCodeUrl: normalizedUrl,
      openCodeDirectory: metadata.directory || this.config.openCodeDirectory,
    })
    const instance = {
      id,
      url: normalizedUrl,
      source,
      sources: new Set([source]),
      serviceName: metadata.serviceName || "",
      path: null,
      project: null,
      bridge,
      tui: null,
      offlineSince: null,
    }
    this.instances.set(id, instance)
    bridge.on("state", () => this.emitState())
    bridge.on("event", (event) => this.emit("event", { ...event, instanceId: id }))
    await bridge.start()
    const description = await bridge.describe().catch(() => null)
    if (description) {
      instance.path = description.path
      instance.project = description.project
    }
    this.emitState()
    return instance
  }

  remove(id) {
    const instance = this.instances.get(id)
    if (!instance) return false
    instance.bridge.stop()
    this.instances.delete(id)
    this.emitState()
    return true
  }

  removeSource(instance, source) {
    if (!instance.sources.delete(source)) return false
    if (instance.sources.size === 0) return this.remove(instance.id)
    if (source === "mdns") instance.serviceName = ""
    instance.source = primarySource(instance.sources)
    this.emitState()
    return true
  }

  get(id) {
    return this.instances.get(id)
  }

  bridge(id) {
    const instance = this.get(id)
    if (!instance) throw new Error(`OpenCode instance not found: ${id}`)
    return instance.bridge
  }

  async refresh() {
    await Promise.all([...this.instances.values()].map((instance) => instance.bridge.refresh().catch(() => {})))
    this.emitState()
  }

  health() {
    return Promise.all([...this.instances.values()].map(async (instance) => ({
      instanceId: instance.id,
      ...(await instance.bridge.health()),
    })))
  }

  instanceForUrl(value) {
    if (typeof value !== "string") return null
    const normalizedUrl = value.replace(/\/$/, "")
    const localUrl = pluginServerUrl(normalizedUrl)
    return [...this.instances.values()].find((instance) => {
      if (instance.url === normalizedUrl) return true
      const instanceLocalUrl = pluginServerUrl(instance.url)
      return localUrl && instanceLocalUrl && new URL(localUrl).port === new URL(instanceLocalUrl).port
    }) || null
  }

  instanceForPluginUrl(value) {
    const serverUrl = pluginServerUrl(value)
    return serverUrl ? this.instanceForUrl(serverUrl) : null
  }

  async updateTuiState(report) {
    if (!report || typeof report !== "object") throw new Error("Invalid plugin state report")
    const serverUrl = pluginServerUrl(report?.serverUrl)
    const route = typeof report.route === "string" ? report.route : "unknown"
    const sessionId = route === "session" && typeof report.sessionId === "string" ? report.sessionId : ""
    const instanceNonce = typeof report.instanceNonce === "string" ? report.instanceNonce : ""
    const sequence = Number(report.sequence)
    if (!serverUrl || !instanceNonce || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid plugin state report")
    const instance = await this.add(serverUrl, { source: "plugin" })
    const previous = instance.tui
    if (previous?.instanceNonce === instanceNonce && sequence <= previous.sequence) return instance
    const changed = !previous?.connected || previous.instanceNonce !== instanceNonce || previous.route !== route || previous.sessionId !== sessionId
    instance.tui = {
      connected: true,
      route,
      sessionId,
      instanceNonce,
      sequence,
      pluginVersion: typeof report.pluginVersion === "string" ? report.pluginVersion : "",
      lastSeenAt: Date.now(),
    }
    if (sessionId && !instance.bridge.snapshot().sessions.some((session) => session.id === sessionId)) instance.bridge.refresh().catch(() => {})
    if (changed) {
      this.emit("tui", { instanceId: instance.id, tui: instance.tui })
      this.emitState()
    }
    return instance
  }

  removeTuiState(report) {
    const instance = this.instanceForPluginUrl(report?.serverUrl)
    if (!instance?.tui || instance.tui.instanceNonce !== report.instanceNonce) return false
    instance.tui = { ...instance.tui, connected: false, lastSeenAt: Date.now() }
    this.emit("tui", { instanceId: instance.id, tui: instance.tui })
    if (!this.removeSource(instance, "plugin")) this.emitState()
    return true
  }

  expireTuiStates(now = Date.now()) {
    for (const instance of [...this.instances.values()]) {
      if (!instance.tui?.connected || now - instance.tui.lastSeenAt <= 12_000) continue
      instance.tui = { ...instance.tui, connected: false }
      this.emit("tui", { instanceId: instance.id, tui: instance.tui })
      if (!this.removeSource(instance, "plugin")) this.emitState()
    }
  }

  expireOfflineSources(now = Date.now()) {
    for (const instance of [...this.instances.values()]) {
      if (instance.bridge.snapshot().connected) {
        instance.offlineSince = null
        continue
      }
      if (instance.offlineSince == null) instance.offlineSince = now
      if (!instance.sources.has("mdns") || now - instance.offlineSince <= MDNS_OFFLINE_TIMEOUT_MS) continue
      this.removeSource(instance, "mdns")
    }
  }

  snapshot() {
    const instances = []
    const sessions = []
    const questions = []
    const permissions = []

    for (const instance of this.instances.values()) {
      const snapshot = instance.bridge.snapshot()
      instances.push({
        id: instance.id,
        source: instance.source,
        serviceName: instance.serviceName,
        connected: snapshot.connected,
        lastError: snapshot.lastError,
        lastEventAt: snapshot.lastEventAt,
        path: instance.path,
        project: instance.project,
        tui: instance.tui,
        sessionCount: snapshot.sessions.length,
      })
      sessions.push(...snapshot.sessions.map((session) => ({ ...session, instanceId: instance.id })))
      questions.push(...snapshot.questions.map((question) => ({ ...question, instanceId: instance.id })))
      permissions.push(...snapshot.permissions.map((permission) => ({ ...permission, instanceId: instance.id })))
    }

    sessions.sort((a, b) => (b?.time?.updated || b?.time?.created || 0) - (a?.time?.updated || a?.time?.created || 0))
    return {
      connected: instances.some((instance) => instance.connected),
      instances,
      sessions,
      questions,
      permissions,
    }
  }

  emitState() {
    this.emit("state", this.snapshot())
  }

  stop() {
    clearInterval(this.maintenanceTimer)
    this.maintenanceTimer = null
    this.discovery.stop()
    for (const instance of this.instances.values()) instance.bridge.stop()
    this.instances.clear()
  }
}
