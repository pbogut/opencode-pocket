import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { OpenCodeBridge } from "./opencode.mjs"

export function instanceIdForUrl(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 12)
}

export class InstanceManager extends EventEmitter {
  constructor(config, options = {}) {
    super()
    this.config = config
    this.Bridge = options.Bridge || OpenCodeBridge
    this.instances = new Map()
  }

  async start() {
    if (this.config.openCodeUrl) await this.add(this.config.openCodeUrl, { source: "configured" })
  }

  async add(url, metadata = {}) {
    const normalizedUrl = url.replace(/\/$/, "")
    const id = metadata.id || instanceIdForUrl(normalizedUrl)
    const existing = this.instances.get(id)
    if (existing) return existing

    const bridge = new this.Bridge({
      ...this.config,
      openCodeUrl: normalizedUrl,
      openCodeDirectory: metadata.directory || this.config.openCodeDirectory,
    })
    const instance = {
      id,
      url: normalizedUrl,
      source: metadata.source || "discovered",
      serviceName: metadata.serviceName || "",
      path: null,
      project: null,
      bridge,
      tui: null,
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
    for (const instance of this.instances.values()) instance.bridge.stop()
    this.instances.clear()
  }
}
