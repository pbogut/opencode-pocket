import { EventEmitter } from "node:events"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function queryWithDirectory(path, directory) {
  if (!directory) return path
  const url = new URL(path, "http://local.invalid")
  if (!url.searchParams.has("directory")) url.searchParams.set("directory", directory)
  return `${url.pathname}${url.search}`
}

export function eventPayload(event) {
  if (!event || typeof event !== "object") return {}
  if (event.properties && typeof event.properties === "object") return event.properties
  if (event.data && typeof event.data === "object") return event.data
  return {}
}

export function requestId(value) {
  if (!value || typeof value !== "object") return ""
  return value.id || value.requestID || value.requestId || value.permissionID || value.questionID || ""
}

export function sessionId(value) {
  if (!value || typeof value !== "object") return ""
  return value.sessionID || value.sessionId || value.session?.id || ""
}

export function normalizeEvent(event) {
  const type = event?.type || "unknown"
  const data = eventPayload(event)
  const sid = sessionId(data) || sessionId(data.part)

  if (type === "question.asked") {
    return { type: "question.asked", sessionId: sid, request: data, requestId: requestId(data), raw: event }
  }
  if (type === "question.replied" || type === "question.rejected") {
    return { type, sessionId: sid, requestId: requestId(data), raw: event }
  }
  if (type === "permission.asked" || type === "permission.updated") {
    return { type: "permission.asked", sessionId: sid, request: data, requestId: requestId(data), raw: event }
  }
  if (type === "permission.replied") {
    return { type, sessionId: sid, requestId: requestId(data), raw: event }
  }
  if (type === "session.status") {
    return { type, sessionId: sid, status: data.status || data, raw: event }
  }
  if (type === "session.idle") {
    return { type: "session.status", sessionId: sid, status: { type: "idle" }, raw: event }
  }
  if (type === "session.error") {
    return { type, sessionId: sid, error: data.error || data, raw: event }
  }
  if (type === "message.part.updated" || type === "message.part.delta") {
    return {
      type: "message.part",
      sessionId: sid,
      messageId: data.part?.messageID || data.messageID || "",
      part: data.part || data,
      delta: data.delta || "",
      raw: event,
    }
  }
  if (type === "message.updated") {
    return { type, sessionId: sid || data.info?.sessionID || "", message: data, raw: event }
  }
  return { type, sessionId: sid, data, raw: event }
}

export async function* parseSSE(body) {
  if (!body) return
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n")
    while (true) {
      const boundary = buffer.indexOf("\n\n")
      if (boundary < 0) break
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (!data) continue
      try {
        yield JSON.parse(data)
      } catch {
        // Ignore malformed/non-JSON SSE frames. OpenCode heartbeats are comments and land here only if unusual.
      }
    }
  }
}

export class OpenCodeBridge extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.sessions = new Map()
    this.statuses = new Map()
    this.questions = new Map()
    this.permissions = new Map()
    this.running = false
    this.abortController = null
    this.connected = false
    this.lastError = null
    this.lastEventAt = 0
  }

  authHeaders() {
    if (!this.config.openCodePassword) return {}
    const token = Buffer.from(`${this.config.openCodeUsername}:${this.config.openCodePassword}`).toString("base64")
    return { Authorization: `Basic ${token}` }
  }

  async request(path, options = {}) {
    const url = `${this.config.openCodeUrl}${path}`
    const headers = {
      Accept: "application/json",
      ...this.authHeaders(),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    }
    const response = await fetch(url, { ...options, headers })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(`OpenCode ${options.method || "GET"} ${path} failed: ${response.status} ${detail}`.trim())
    }
    if (response.status === 204) return null
    const contentType = response.headers.get("content-type") || ""
    if (contentType.includes("application/json")) return response.json()
    const text = await response.text()
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
  }

  directoryForSession(sid) {
    const session = this.sessions.get(sid)
    return session?.directory || session?.path?.cwd || this.config.openCodeDirectory || ""
  }

  pathForSession(path, sid) {
    return queryWithDirectory(path, this.directoryForSession(sid))
  }

  async health() {
    try {
      const data = await this.request("/global/health")
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: String(error.message || error) }
    }
  }

  async refresh() {
    const directory = this.config.openCodeDirectory
    const sessionPath = queryWithDirectory("/session", directory)
    const statusPath = queryWithDirectory("/session/status", directory)
    const [sessions, statuses] = await Promise.all([
      this.request(sessionPath),
      this.request(statusPath).catch(() => ({})),
    ])

    for (const item of Array.isArray(sessions) ? sessions : []) {
      if (item?.id) this.sessions.set(item.id, item)
    }
    this.statuses.clear()
    for (const [sid, status] of Object.entries(statuses || {})) this.statuses.set(sid, status)

    await this.refreshPending().catch(() => {})
    this.emitState()
  }

  async refreshPending() {
    const directories = new Set([this.config.openCodeDirectory].filter(Boolean))
    for (const session of this.sessions.values()) {
      if (session?.directory) directories.add(session.directory)
    }
    if (directories.size === 0) directories.add("")

    const questions = new Map()
    const permissions = new Map()
    for (const directory of directories) {
      const q = await this.request(queryWithDirectory("/question", directory)).catch(() => [])
      for (const item of Array.isArray(q) ? q : []) {
        const id = requestId(item)
        if (id) questions.set(id, item)
      }
      const p = await this.request(queryWithDirectory("/permission", directory)).catch(() => [])
      for (const item of Array.isArray(p) ? p : []) {
        const id = requestId(item)
        if (id) permissions.set(id, item)
      }
    }
    this.questions = questions
    this.permissions = permissions
  }

  snapshot() {
    const sessions = [...this.sessions.values()]
      .map((session) => ({
        ...session,
        status: this.statuses.get(session.id) || { type: "idle" },
        attention: this.attentionForSession(session.id),
      }))
      .sort((a, b) => (b?.time?.updated || b?.time?.created || 0) - (a?.time?.updated || a?.time?.created || 0))

    return {
      connected: this.connected,
      lastError: this.lastError,
      lastEventAt: this.lastEventAt,
      sessions,
      questions: [...this.questions.values()],
      permissions: [...this.permissions.values()],
    }
  }

  attentionForSession(sid) {
    const question = [...this.questions.values()].find((item) => sessionId(item) === sid)
    if (question) return { type: "question", id: requestId(question) }
    const permission = [...this.permissions.values()].find((item) => sessionId(item) === sid)
    if (permission) return { type: "permission", id: requestId(permission) }
    return null
  }

  emitState() {
    this.emit("state", this.snapshot())
  }

  handleEvent(raw) {
    this.lastEventAt = Date.now()
    const event = normalizeEvent(raw)
    if (event.sessionId && !this.sessions.has(event.sessionId)) {
      // Session metadata is authoritative and cheap enough to refresh when a previously unseen session appears.
      this.refresh().catch(() => {})
    }

    if (event.type === "question.asked" && event.requestId) {
      this.questions.set(event.requestId, event.request)
    } else if ((event.type === "question.replied" || event.type === "question.rejected") && event.requestId) {
      this.questions.delete(event.requestId)
    } else if (event.type === "permission.asked" && event.requestId) {
      this.permissions.set(event.requestId, event.request)
    } else if (event.type === "permission.replied" && event.requestId) {
      this.permissions.delete(event.requestId)
    } else if (event.type === "session.status" && event.sessionId) {
      if (event.status?.type === "idle") this.statuses.delete(event.sessionId)
      else this.statuses.set(event.sessionId, event.status)
    }

    this.emit("event", event)
    this.emitState()
  }

  async start() {
    if (this.running) return
    this.running = true
    await this.refresh().catch((error) => {
      this.lastError = String(error.message || error)
    })
    this.eventLoop().catch(() => {})
  }

  stop() {
    this.running = false
    this.abortController?.abort()
  }

  async eventLoop() {
    let backoff = 500
    while (this.running) {
      this.abortController = new AbortController()
      try {
        const path = queryWithDirectory("/event", this.config.openCodeDirectory)
        const response = await fetch(`${this.config.openCodeUrl}${path}`, {
          headers: { Accept: "text/event-stream", ...this.authHeaders() },
          signal: this.abortController.signal,
        })
        if (!response.ok || !response.body) throw new Error(`SSE failed with ${response.status}`)
        this.connected = true
        this.lastError = null
        this.emitState()
        backoff = 500
        for await (const event of parseSSE(response.body)) {
          if (!this.running) break
          this.handleEvent(event)
        }
        if (this.running) throw new Error("OpenCode event stream ended")
      } catch (error) {
        if (!this.running) break
        this.connected = false
        this.lastError = String(error.message || error)
        this.emitState()
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 10_000)
        await this.refresh().catch(() => {})
      }
    }
  }

  async listMessages(sid, limit = 100) {
    const path = this.pathForSession(`/session/${encodeURIComponent(sid)}/message?limit=${Math.max(1, Math.min(limit, 300))}`, sid)
    const data = await this.request(path)
    return Array.isArray(data) ? data : []
  }

  async listAgents(sid) {
    const data = await this.request(this.pathForSession("/agent", sid))
    return (Array.isArray(data) ? data : [])
      .filter((agent) => agent && !agent.hidden && (agent.mode === "primary" || agent.mode === "all"))
      .map((agent) => ({
        name: agent.name,
        description: agent.description || "",
        mode: agent.mode,
        color: agent.color || "",
      }))
      .filter((agent) => agent.name)
  }

  async sendMessage(sid, text, agent = "") {
    const body = { parts: [{ type: "text", text }], ...(agent ? { agent } : {}) }
    return this.request(this.pathForSession(`/session/${encodeURIComponent(sid)}/prompt_async`, sid), {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  async switchAgent(sid, agent) {
    return this.request(this.pathForSession(`/api/session/${encodeURIComponent(sid)}/agent`, sid), {
      method: "POST",
      body: JSON.stringify({ agent }),
    })
  }

  async abortSession(sid) {
    return this.request(this.pathForSession(`/session/${encodeURIComponent(sid)}/abort`, sid), {
      method: "POST",
    })
  }

  async replyQuestion(id, answers) {
    const question = this.questions.get(id)
    const sid = sessionId(question)
    const path = this.pathForSession(`/question/${encodeURIComponent(id)}/reply`, sid)
    const result = await this.request(path, { method: "POST", body: JSON.stringify({ answers }) })
    this.questions.delete(id)
    this.emitState()
    return result
  }

  async rejectQuestion(id) {
    const question = this.questions.get(id)
    const sid = sessionId(question)
    const path = this.pathForSession(`/question/${encodeURIComponent(id)}/reject`, sid)
    const result = await this.request(path, { method: "POST" })
    this.questions.delete(id)
    this.emitState()
    return result
  }

  async replyPermission(sid, id, response) {
    if (!["once", "always", "reject"].includes(response)) throw new Error("Invalid permission response")
    const result = await this.request(
      this.pathForSession(`/session/${encodeURIComponent(sid)}/permissions/${encodeURIComponent(id)}`, sid),
      { method: "POST", body: JSON.stringify({ response }) },
    )
    this.permissions.delete(id)
    this.emitState()
    return result
  }
}
