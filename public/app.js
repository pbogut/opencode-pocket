const app = document.querySelector("#app")

const DRAFTS_KEY = "opencode-pocket-drafts-v1"
const BOTTOM_THRESHOLD = 80
const savedDrafts = loadDrafts()
const initialRoute = routeFromHash()

const state = {
  snapshot: { connected: false, instances: [], sessions: [], questions: [], permissions: [] },
  routeInstanceId: initialRoute.instanceId,
  routeSessionId: initialRoute.sessionId,
  messages: [],
  loadingMessages: false,
  agents: [],
  agentSessionId: "",
  switchingAgentSession: "",
  composerSelection: null,
  selectedAgents: new Map(),
  changes: [],
  changesSessionId: "",
  loadingChangesSession: "",
  changesOpen: false,
  changesTimer: null,
  diffs: new Map(),
  diffErrors: new Map(),
  loadingDiffs: new Set(),
  messageDrafts: new Map(draftEntries(savedDrafts.messages).filter(([, value]) => typeof value === "string")),
  questionAnswers: new Map(draftEntries(savedDrafts.questions).filter(([, value]) => Array.isArray(value))),
  toast: "",
  refreshTimer: null,
  viewKey: "",
  renderedMessages: "",
  renderedAttention: "",
  renderedAgents: "",
  renderedChanges: "",
  attentionRequest: "",
  attentionCollapsed: false,
  followMessages: true,
  expandedParts: new Set(),
}

function draftEntries(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : []
}

function loadDrafts() {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function persistDrafts() {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify({
      messages: Object.fromEntries(state.messageDrafts),
      questions: Object.fromEntries(state.questionAnswers),
    }))
  } catch {
    // In-memory drafts still protect input during this page session.
  }
}

function decodeRoutePart(value) {
  try { return decodeURIComponent(value) } catch { return "" }
}

function routeFromHash() {
  const conversation = location.hash.match(/^#\/instance\/([^/]+)\/session\/([^/]+)$/)
  if (conversation) return { instanceId: decodeRoutePart(conversation[1]), sessionId: decodeRoutePart(conversation[2]) }
  const instance = location.hash.match(/^#\/instance\/([^/]+)$/)
  if (instance) return { instanceId: decodeRoutePart(instance[1]), sessionId: "" }
  return { instanceId: "", sessionId: "" }
}

function scopedKey(...parts) {
  return JSON.stringify(parts)
}

function conversationKey(instanceId = state.routeInstanceId, sessionId = state.routeSessionId) {
  return instanceId && sessionId ? scopedKey(instanceId, sessionId) : ""
}

function routeMatches(instanceId, sessionId = state.routeSessionId) {
  return state.routeInstanceId === instanceId && state.routeSessionId === sessionId
}

function sessionApiPath(instanceId, sessionId, suffix) {
  return `/api/instances/${encodeURIComponent(instanceId)}/sessions/${encodeURIComponent(sessionId)}/${suffix}`
}

function esc(value = "") {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[ch])
}

function prettyTime(value) {
  if (!value) return ""
  const ms = value > 10_000_000_000 ? value : value * 1000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ""
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return "now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return d.toLocaleDateString()
}

function titleFor(session) {
  return session?.title || session?.slug || session?.id?.slice(0, 12) || "Session"
}

function statusFor(session) {
  if (session.attention) return { label: "needs input", className: "attention" }
  const type = session.status?.type || "idle"
  return { label: type === "busy" ? "working" : type, className: type }
}

function instanceFor(id) {
  return state.snapshot.instances.find((item) => item.id === id)
}

function sessionFor(instanceId, sessionId) {
  return state.snapshot.sessions.find((item) => item.instanceId === instanceId && item.id === sessionId)
}

function pendingQuestion(instanceId, sessionId) {
  return state.snapshot.questions.find((item) => item.instanceId === instanceId && (item.sessionID || item.sessionId) === sessionId)
}

function pendingPermission(instanceId, sessionId) {
  return state.snapshot.permissions.find((item) => item.instanceId === instanceId && (item.sessionID || item.sessionId) === sessionId)
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
  })
  const text = await response.text()
  let data = null
  if (text) { try { data = JSON.parse(text) } catch { data = text } }
  if (!response.ok) throw new Error(data?.error || `${response.status} ${response.statusText}`)
  return data
}

function showToast(text) {
  state.toast = text
  render()
  clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => { state.toast = ""; render() }, 2600)
}

async function loadState() {
  try {
    state.snapshot = await api("/api/state")
    render()
  } catch (error) {
    showToast(error.message)
  }
}

async function loadMessages({ quiet = false } = {}) {
  const iid = state.routeInstanceId
  const sid = state.routeSessionId
  if (!iid || !sid || state.loadingMessages) return
  state.loadingMessages = true
  if (!quiet) render()
  try {
    const messages = await api(`${sessionApiPath(iid, sid, "messages")}?limit=120`)
    if (routeMatches(iid, sid)) state.messages = messages
  } catch (error) {
    if (routeMatches(iid, sid)) showToast(error.message)
  } finally {
    if (routeMatches(iid, sid)) {
      state.loadingMessages = false
      render()
    }
  }
}

function agentFromMessages() {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const info = state.messages[index]?.info || state.messages[index]
    const agent = info?.agent || info?.mode
    if (agent) return agent
  }
  return ""
}

async function loadAgents() {
  const iid = state.routeInstanceId
  const sid = state.routeSessionId
  const key = conversationKey(iid, sid)
  if (!key) return
  try {
    const agents = await api(sessionApiPath(iid, sid, "agents"))
    if (!routeMatches(iid, sid)) return
    state.agents = Array.isArray(agents) ? agents : []
    state.agentSessionId = key
    const available = new Set(state.agents.map((agent) => agent.name))
    const remembered = state.selectedAgents.get(key)
    const inferred = agentFromMessages()
    const selected = available.has(remembered) ? remembered : available.has(inferred) ? inferred : state.agents[0]?.name
    if (selected) state.selectedAgents.set(key, selected)
    state.renderedAgents = ""
    render()
  } catch (error) {
    if (routeMatches(iid, sid)) showToast(error.message)
  }
}

async function loadChanges({ quiet = false } = {}) {
  const iid = state.routeInstanceId
  const sid = state.routeSessionId
  const key = conversationKey(iid, sid)
  if (!key || state.loadingChangesSession === key) return
  state.loadingChangesSession = key
  if (!quiet) render()
  try {
    const changes = await api(sessionApiPath(iid, sid, "changes"))
    if (!routeMatches(iid, sid)) return
    state.changes = Array.isArray(changes) ? changes : []
    state.changesSessionId = key
    state.renderedChanges = ""
  } catch (error) {
    if (routeMatches(iid, sid)) showToast(error.message)
  } finally {
    if (state.loadingChangesSession === key) state.loadingChangesSession = ""
    if (routeMatches(iid, sid)) render()
  }
}

async function loadDiff(messageId) {
  const iid = state.routeInstanceId
  const sid = state.routeSessionId
  const key = scopedKey(iid, sid, messageId)
  if (!iid || !sid || !messageId || state.diffs.has(key) || state.loadingDiffs.has(key)) return
  state.loadingDiffs.add(key)
  state.diffErrors.delete(key)
  render()
  try {
    const diff = await api(`${sessionApiPath(iid, sid, "diff")}?messageId=${encodeURIComponent(messageId)}`)
    if (routeMatches(iid, sid)) state.diffs.set(key, Array.isArray(diff) ? diff : [])
  } catch (error) {
    if (routeMatches(iid, sid)) state.diffErrors.set(key, error.message)
  } finally {
    state.loadingDiffs.delete(key)
    if (routeMatches(iid, sid)) render()
  }
}

async function loadConversation() {
  await loadMessages()
  await Promise.all([loadAgents(), loadChanges()])
}

function scheduleMessagesRefresh() {
  clearTimeout(state.refreshTimer)
  state.refreshTimer = setTimeout(() => loadMessages({ quiet: true }), 180)
}

function scheduleChangesRefresh() {
  clearTimeout(state.changesTimer)
  state.changesTimer = setTimeout(() => loadChanges({ quiet: true }), 220)
}

function durationLabel(time) {
  if (!Number.isFinite(time?.start) || !Number.isFinite(time?.end)) return ""
  const milliseconds = Math.max(0, time.end - time.start)
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 10_000) return `${(milliseconds / 1000).toFixed(1)}s`
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)}s`
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`
}

function partKey(message, part, index) {
  const id = part.id || part.callID || `${message?.info?.id || message?.id || "message"}:${index}`
  return scopedKey(state.routeInstanceId, state.routeSessionId, id)
}

function detailText(value) {
  if (typeof value === "string") return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value ?? "") }
}

function renderReasoning(message, part, index) {
  const text = typeof part.text === "string" ? part.text.trim() : ""
  if (!Number.isFinite(part.time?.end)) return `<div class="thought-line thinking">Thinking</div>`
  const firstLine = text.split("\n").find((line) => line.trim())?.trim() || "Completed"
  const duration = durationLabel(part.time)
  const summary = `<span class="thought-summary"><strong>Thought:</strong> ${esc(firstLine)}</span>${duration ? `<span class="part-duration">${duration}</span>` : ""}`
  if (!text.includes("\n") && text.length <= 120) return `<div class="thought-line">${summary}</div>`
  const key = partKey(message, part, index)
  return `<details class="thought-block" data-part-key="${esc(key)}" ${state.expandedParts.has(key) ? "open" : ""}>
    <summary>${summary}</summary>
    <div class="thought-detail">${esc(text)}</div>
  </details>`
}

function renderTool(message, part, index) {
  const toolState = part.state || {}
  const status = toolState.status || "pending"
  const input = toolState.input && typeof toolState.input === "object" ? toolState.input : {}
  const command = typeof input.command === "string" ? input.command : Array.isArray(input.command) ? input.command.join(" ") : ""
  const firstCommandLine = command.split("\n")[0]
  const title = firstCommandLine ? `$ ${firstCommandLine}` : toolState.title || part.tool || part.name || "Tool"
  const duration = durationLabel(toolState.time)
  const key = partKey(message, part, index)
  const inputText = command || (Object.keys(input).length ? detailText(input) : "")
  const output = toolState.output ?? toolState.error ?? ""
  const outputLabel = toolState.error ? "Error" : "Output"
  const body = `${inputText ? `<div class="tool-detail-label">${command ? "Command" : "Input"}</div><pre class="tool-detail">${esc(command ? `$ ${inputText}` : inputText)}</pre>` : ""}
    ${output ? `<div class="tool-detail-label">${outputLabel}</div><pre class="tool-detail ${toolState.error ? "error" : ""}">${esc(detailText(output))}</pre>` : `<div class="tool-empty">${status === "running" ? "Running…" : "No output"}</div>`}`
  return `<details class="tool-block ${esc(status)}" data-part-key="${esc(key)}" ${state.expandedParts.has(key) ? "open" : ""}>
    <summary>
      <span class="tool-summary"><span class="tool-name">${esc(part.tool || part.name || "tool")}</span><span class="tool-title">${esc(title)}</span></span>
      <span class="tool-meta"><span class="tool-status">${esc(status)}</span>${duration ? `<span class="part-duration">${duration}</span>` : ""}</span>
    </summary>
    <div class="tool-body">${body}</div>
  </details>`
}

function diffLineClass(line) {
  if (line.startsWith("@@")) return "hunk"
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) return "header"
  if (line.startsWith("+")) return "addition"
  if (line.startsWith("-")) return "deletion"
  return "context"
}

function renderPatchLines(patch) {
  return String(patch || "").split("\n").map((line) => `<span class="diff-line ${diffLineClass(line)}">${esc(line || " ")}</span>`).join("")
}

function renderDiffFiles(messageId) {
  const diffKey = scopedKey(state.routeInstanceId, state.routeSessionId, messageId)
  if (state.loadingDiffs.has(diffKey)) return `<div class="diff-loading">Loading patch…</div>`
  if (state.diffErrors.has(diffKey)) return `<div class="diff-error">${esc(state.diffErrors.get(diffKey))}</div>`
  if (!state.diffs.has(diffKey)) return `<div class="diff-loading">Expand to load patch.</div>`
  const files = state.diffs.get(diffKey)
  if (!files.length) return `<div class="diff-loading">No diff is available for this turn.</div>`
  return `<div class="diff-files">${files.map((file) => {
    const path = file.file || "Changed file"
    const key = scopedKey(state.routeInstanceId, state.routeSessionId, "diff-file", messageId, path)
    const status = { added: "A", deleted: "D", modified: "M" }[file.status] || "M"
    return `<details class="diff-file ${esc(file.status)}" data-part-key="${esc(key)}" ${state.expandedParts.has(key) ? "open" : ""}>
      <summary>
        <span class="diff-file-main"><span class="diff-status">${status}</span><span class="diff-path">${esc(path)}</span></span>
        <span class="diff-counts"><span>+${Number(file.additions || 0)}</span><span>−${Number(file.deletions || 0)}</span></span>
      </summary>
      <pre class="diff-patch"><code>${renderPatchLines(file.patch)}</code></pre>
    </details>`
  }).join("")}</div>`
}

function renderPatchPart(message, part, index) {
  const info = message?.info || message
  const messageId = info?.parentID || ""
  const key = scopedKey(state.routeInstanceId, state.routeSessionId, "patch", partKey(message, part, index))
  const files = [...new Set(Array.isArray(part.files) ? part.files : [])]
  return `<details class="diff-block" data-part-key="${esc(key)}" ${messageId ? `data-diff-message="${esc(messageId)}"` : ""} ${state.expandedParts.has(key) ? "open" : ""}>
    <summary>
      <span class="diff-summary"><strong>Changes</strong><span>${files.length} ${files.length === 1 ? "file" : "files"}</span></span>
    </summary>
    <div class="diff-body">${messageId ? renderDiffFiles(messageId) : `<div class="diff-error">The turn ID is unavailable.</div>`}</div>
  </details>`
}

function diffTotals(files) {
  return (Array.isArray(files) ? files : []).reduce((totals, file) => ({
    additions: totals.additions + Number(file.additions || 0),
    deletions: totals.deletions + Number(file.deletions || 0),
  }), { additions: 0, deletions: 0 })
}

function renderChangeTurn(change) {
  const key = scopedKey(state.routeInstanceId, state.routeSessionId, "change-turn", change.messageId)
  const files = state.diffs.get(scopedKey(state.routeInstanceId, state.routeSessionId, change.messageId))
  const totals = diffTotals(files)
  const counts = files ? `<span class="diff-counts"><span>+${totals.additions}</span><span>−${totals.deletions}</span></span>` : ""
  return `<details class="change-turn" data-part-key="${esc(key)}" data-diff-message="${esc(change.messageId)}" ${state.expandedParts.has(key) ? "open" : ""}>
    <summary>
      <span class="change-turn-main"><strong>${esc(change.title || "Changed files")}</strong><small>${change.files?.length || 0} ${(change.files?.length || 0) === 1 ? "file" : "files"}${change.time ? ` · ${esc(prettyTime(change.time))}` : ""}</small></span>
      ${counts}
    </summary>
    <div class="change-turn-body">${renderDiffFiles(change.messageId)}</div>
  </details>`
}

function renderChangesDrawer() {
  if (state.loadingChangesSession === conversationKey() && !state.changes.length) return `<div class="changes-empty">Loading change history…</div>`
  if (!state.changes.length) return `<div class="changes-empty">No file changes in this session.</div>`
  return `<div class="change-turns">${[...state.changes].reverse().map(renderChangeTurn).join("")}</div>`
}

function renderMessageParts(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  return parts.map((part, index) => {
    if (part?.type === "text" && typeof part.text === "string") return `<div class="message-text">${esc(part.text)}</div>`
    if (part?.type === "reasoning") return renderReasoning(message, part, index)
    if (part?.type === "tool") return renderTool(message, part, index)
    if (part?.type === "patch") return renderPatchPart(message, part, index)
    return ""
  }).filter(Boolean).join("")
}

function renderMessages() {
  if (state.loadingMessages && !state.messages.length) return `<div class="empty">Loading conversation…</div>`
  if (!state.messages.length) return `<div class="empty">No messages yet.</div>`
  return `<div class="messages">${state.messages.map((message) => {
    const role = message?.info?.role || message?.role || "assistant"
    const parts = renderMessageParts(message)
    if (!parts) return ""
    return `<article class="message ${esc(role)}">
      <div class="message-role">${esc(role)}</div>
      <div class="message-parts">${parts}</div>
    </article>`
  }).join("")}</div>`
}

function isNearBottom() {
  const remaining = document.documentElement.scrollHeight - window.innerHeight - window.scrollY
  return remaining <= BOTTOM_THRESHOLD
}

function scrollToLatest() {
  const sessionKey = conversationKey()
  requestAnimationFrame(() => {
    if (state.followMessages && conversationKey() === sessionKey) {
      window.scrollTo(0, document.documentElement.scrollHeight)
    }
  })
}

function questionId(q) { return q?.id || q?.requestID || q?.requestId || "" }
function permissionId(p) { return p?.id || p?.requestID || p?.requestId || p?.permissionID || "" }

function renderQuestionCard(request) {
  if (!request) return ""
  const rid = questionId(request)
  const key = scopedKey(request.instanceId, rid)
  const questions = Array.isArray(request.questions) ? request.questions : []
  if (!state.questionAnswers.has(key)) state.questionAnswers.set(key, questions.map(() => []))
  const answers = state.questionAnswers.get(key)
  for (let index = 0; index < questions.length; index += 1) {
    if (!Array.isArray(answers[index])) answers[index] = []
  }

  return `<section class="attention-card" data-question-id="${esc(rid)}" data-question-key="${esc(key)}">
    <div class="attention-title">OpenCode needs your answer</div>
    ${questions.map((q, index) => {
      const selected = answers[index] || []
      return `<div class="question" data-question-index="${index}">
        ${q.header ? `<h3>${esc(q.header)}</h3>` : ""}
        <p>${esc(q.question || "Question")}</p>
        <div class="options">${(q.options || []).map((option) => {
          const label = typeof option === "string" ? option : option.label
          const description = typeof option === "object" ? option.description : ""
          return `<button class="option ${selected.includes(label) ? "selected" : ""}" data-answer-option="${esc(label)}" data-multiple="${q.multiple ? "true" : "false"}">
            ${esc(label)}${description ? `<small>${esc(description)}</small>` : ""}
          </button>`
        }).join("")}</div>
        ${q.custom === false ? "" : `<input class="custom-answer" data-custom-answer placeholder="Other answer…" value="${esc(selected.find((x) => !(q.options || []).some((o) => (typeof o === "string" ? o : o.label) === x)) || "")}">`}
      </div>`
    }).join("")}
    <div class="actions">
      <button class="button primary" data-submit-question>Send answer</button>
      <button class="button" data-reject-question>Reject</button>
    </div>
  </section>`
}

function renderPermissionCard(permission) {
  if (!permission) return ""
  const title = permission.title || permission.type || "Permission request"
  const pattern = Array.isArray(permission.pattern) ? permission.pattern.join("\n") : permission.pattern || ""
  const metadata = permission.metadata && Object.keys(permission.metadata).length ? JSON.stringify(permission.metadata, null, 2) : ""
  return `<section class="attention-card" data-permission-id="${esc(permissionId(permission))}">
    <div class="attention-title">Permission requested</div>
    <h3>${esc(title)}</h3>
    ${pattern ? `<div class="permission-code">${esc(pattern)}</div>` : ""}
    ${metadata ? `<details><summary class="meta">Details</summary><div class="permission-code">${esc(metadata)}</div></details>` : ""}
    <div class="actions">
      <button class="button primary" data-permission-response="once">Allow once</button>
      <button class="button" data-permission-response="always">Always allow</button>
      <button class="button danger" data-permission-response="reject">Reject</button>
    </div>
  </section>`
}

function projectLabel(instance) {
  const project = instance?.project
  if (typeof project === "string") return project
  return project?.name || project?.worktree || project?.id || instance?.path?.directory || instance?.path?.worktree || ""
}

function instanceTitle(instance) {
  return instance?.serviceName || projectLabel(instance) || instance?.source || instance?.id || "Instance"
}

function instanceMetadata(instance) {
  const values = [projectLabel(instance), instance?.source].filter(Boolean)
  return [...new Set(values)].join(" · ")
}

function renderSessionList(sessions, instanceId) {
  if (!sessions.length) return `<div class="empty instance-empty">No sessions found for this instance.</div>`
  return `<div class="list">${sessions.map((session) => {
    const status = statusFor(session)
    return `<button class="agent-card" data-open-session="${esc(session.id)}" data-instance-id="${esc(instanceId)}">
      <div class="agent-row">
        <div class="agent-main">
          <div class="agent-title">${esc(titleFor(session))}</div>
          <div class="agent-subtitle">${esc(session.directory || session.id)} · ${esc(prettyTime(session?.time?.updated || session?.time?.created))}</div>
        </div>
        <span class="badge ${status.className}">${esc(status.label)}</span>
      </div>
    </button>`
  }).join("")}</div>`
}

function renderList(instanceId = "") {
  const instances = state.snapshot.instances || []
  const sessions = state.snapshot.sessions || []
  const instance = instanceId ? instanceFor(instanceId) : null
  if (instanceId && !instance) {
    return `<div class="shell"><header class="topbar"><button class="icon-button" data-back>←</button><h1>Instance</h1></header><div class="empty">Instance not found.</div></div>`
  }
  const content = instance
    ? `${instance.lastError ? `<div class="banner">${esc(instance.lastError)}</div>` : ""}${renderSessionList(sessions.filter((session) => session.instanceId === instance.id), instance.id)}`
    : instances.length ? `<div class="instance-groups">${instances.map((item) => {
      const itemSessions = sessions.filter((session) => session.instanceId === item.id)
      return `<section class="instance-section">
        <button class="instance-heading" data-open-instance="${esc(item.id)}">
          <span><strong>${esc(instanceTitle(item))}</strong><small>${esc(instanceMetadata(item) || item.id)}</small></span>
          <span class="instance-current"><span class="dot ${item.connected ? "connected" : ""}"></span>${item.connected ? "live" : "offline"} · ${itemSessions.length}</span>
        </button>
        ${item.lastError ? `<div class="banner">${esc(item.lastError)}</div>` : ""}
        ${renderSessionList(itemSessions, item.id)}
      </section>`
    }).join("")}</div>` : `<div class="empty">No OpenCode instances found.</div>`
  return `<div class="shell">
    <header class="topbar">
      ${instance ? `<button class="icon-button" data-back aria-label="Back">←</button>` : ""}
      <div>
        <h1>${esc(instance ? instanceTitle(instance) : "OpenCode Pocket")}</h1>
        <div class="connection"><span class="dot ${(instance ? instance.connected : state.snapshot.connected) ? "connected" : ""}"></span>${instance ? esc(instanceMetadata(instance) || (instance.connected ? "live" : "offline")) : state.snapshot.connected ? "live" : "reconnecting"}</div>
      </div>
      <button class="icon-button" data-notifications title="Enable notifications">🔔</button>
      <button class="icon-button" data-refresh title="Refresh">↻</button>
    </header>
    ${content}
    ${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ""}
  </div>`
}

function renderConversationShell() {
  const draft = state.messageDrafts.get(conversationKey()) || ""
  return `<div class="shell conversation">
    <header class="topbar">
      <button class="icon-button" data-back aria-label="Back">←</button>
      <div style="min-width:0;flex:1">
        <h1 data-session-title style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></h1>
        <div class="connection"><span class="badge idle" data-session-status>idle</span></div>
      </div>
      <button class="icon-button changes-button" data-open-changes hidden aria-label="Open session changes" title="Session changes"><span aria-hidden="true">±</span><small data-changes-count></small></button>
      <button class="icon-button" data-abort title="Abort session">■</button>
    </header>
    <div class="meta" data-session-meta></div>
    <div data-messages></div>
    <div class="changes-overlay" data-changes-overlay hidden>
      <button type="button" class="changes-backdrop" data-close-changes aria-label="Close session changes"></button>
      <section class="changes-drawer" role="dialog" aria-modal="true" aria-labelledby="changes-title">
        <header class="changes-header">
          <div><h2 id="changes-title">Session changes</h2><p data-changes-summary></p></div>
          <button type="button" class="icon-button" data-close-changes aria-label="Close session changes">×</button>
        </header>
        <div class="changes-content" data-changes-content></div>
      </section>
    </div>
    <div class="composer-wrap">
      <section class="attention-sheet" data-attention-sheet hidden>
        <button type="button" class="attention-sheet-toggle" data-toggle-attention aria-expanded="true">
          <span><strong>Needs input</strong><small data-attention-summary></small></span>
          <span class="attention-sheet-action" data-attention-action>Hide</span>
        </button>
        <div class="attention-sheet-body" data-attention></div>
      </section>
      <form class="composer" data-composer>
        <div class="composer-input">
          <div class="mode-picker">
            <label><span>Mode</span><select data-agent-select aria-label="OpenCode mode"><option value="">Loading modes…</option></select></label>
            <button type="button" class="mode-cycle" data-cycle-agent hidden aria-label="Switch to next mode" title="Switch to next mode">↻</button>
          </div>
          <textarea name="message" rows="1" placeholder="Message OpenCode…" autocomplete="off" aria-keyshortcuts="Enter" title="Enter to send, Shift+Enter for a new line">${esc(draft)}</textarea>
        </div>
        <div class="composer-actions">
          <button type="button" class="stop-button" data-stop hidden aria-label="Stop current request" title="Stop current request">
            <span class="activity-ring" aria-hidden="true"></span>
            <span class="stop-square" aria-hidden="true"></span>
          </button>
          <button type="submit" class="send-button" aria-label="Send message" title="Send message">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"></path><path d="m22 2-11 11"></path></svg>
          </button>
        </div>
      </form>
    </div>
    <div data-toast></div>
  </div>`
}

function updateAgentSelector() {
  const select = app.querySelector("[data-agent-select]")
  const cycle = app.querySelector("[data-cycle-agent]")
  if (!select || !cycle) return
  const sessionKey = conversationKey()
  const agents = state.agentSessionId === sessionKey ? state.agents : []
  const key = JSON.stringify(agents)
  if (state.renderedAgents !== key) {
    select.innerHTML = agents.length
      ? agents.map((agent) => `<option value="${esc(agent.name)}" title="${esc(agent.description)}">${esc(agent.name)}</option>`).join("")
      : `<option value="">Loading modes…</option>`
    state.renderedAgents = key
  }
  select.disabled = agents.length === 0 || state.switchingAgentSession === sessionKey
  const selected = state.selectedAgents.get(sessionKey)
  if (selected && agents.some((agent) => agent.name === selected)) select.value = selected
  const currentIndex = agents.findIndex((agent) => agent.name === selected)
  const next = agents.length ? agents[(currentIndex + 1) % agents.length] : null
  cycle.hidden = agents.length < 2
  cycle.disabled = state.switchingAgentSession === sessionKey
  if (next) {
    cycle.setAttribute("aria-label", `Switch to ${next.name} mode`)
    cycle.title = `Switch to ${next.name}`
  }
}

async function switchAgent(agent) {
  const iid = state.routeInstanceId
  const sid = state.routeSessionId
  const key = conversationKey(iid, sid)
  if (!agent || !key || state.switchingAgentSession === key) return
  const previous = state.selectedAgents.get(key)
  state.selectedAgents.set(key, agent)
  state.switchingAgentSession = key
  updateAgentSelector()
  try {
    await api(sessionApiPath(iid, sid, "agent"), {
      method: "POST",
      body: JSON.stringify({ agent }),
    })
  } catch (error) {
    if (previous) state.selectedAgents.set(key, previous)
    else state.selectedAgents.delete(key)
    showToast(error.message)
  } finally {
    if (state.switchingAgentSession === key) state.switchingAgentSession = ""
    if (routeMatches(iid, sid)) updateAgentSelector()
  }
}

function updateAttention(force = false) {
  const slot = app.querySelector("[data-attention]")
  const sheet = app.querySelector("[data-attention-sheet]")
  if (!slot || !sheet) return
  const question = pendingQuestion(state.routeInstanceId, state.routeSessionId)
  const permission = pendingPermission(state.routeInstanceId, state.routeSessionId)
  const requestKey = scopedKey(state.routeInstanceId, questionId(question), permissionId(permission))
  const key = JSON.stringify([question || null, permission || null])

  if (!question && !permission) {
    sheet.hidden = true
    state.attentionRequest = ""
    state.attentionCollapsed = false
  } else {
    if (state.attentionRequest !== requestKey) {
      state.attentionRequest = requestKey
      state.attentionCollapsed = false
    }
    sheet.hidden = false
    sheet.classList.toggle("collapsed", state.attentionCollapsed)
    const toggle = sheet.querySelector("[data-toggle-attention]")
    toggle.setAttribute("aria-expanded", String(!state.attentionCollapsed))
    sheet.querySelector("[data-attention-action]").textContent = state.attentionCollapsed ? "Show" : "Hide"
    sheet.querySelector("[data-attention-summary]").textContent = question && permission
      ? "Question and permission waiting"
      : question ? "Question waiting" : "Permission waiting"
  }

  if (force || state.renderedAttention !== key) {
    slot.innerHTML = `${renderQuestionCard(question)}${renderPermissionCard(permission)}`
    state.renderedAttention = key
  }
}

function setChangesOpen(open) {
  state.changesOpen = open
  document.body.classList.toggle("changes-open", open)
  if (open) state.followMessages = false
  else state.followMessages = isNearBottom()
  updateChangesView()
}

function updateChangesView() {
  const button = app.querySelector("[data-open-changes]")
  const overlay = app.querySelector("[data-changes-overlay]")
  const content = app.querySelector("[data-changes-content]")
  if (!button || !overlay || !content) return
  const sessionKey = conversationKey()
  const changes = state.changesSessionId === sessionKey ? state.changes : []
  const uniqueFiles = new Set(changes.flatMap((change) => change.files || []))
  button.hidden = changes.length === 0 && state.loadingChangesSession !== sessionKey
  button.querySelector("[data-changes-count]").textContent = changes.length || ""
  button.setAttribute("aria-label", `Open ${changes.length} session change ${changes.length === 1 ? "turn" : "turns"}`)
  overlay.hidden = !state.changesOpen
  overlay.querySelector("[data-changes-summary]").textContent = `${changes.length} ${changes.length === 1 ? "turn" : "turns"} · ${uniqueFiles.size} ${uniqueFiles.size === 1 ? "file" : "files"}`
  const html = renderChangesDrawer()
  if (state.renderedChanges !== html) {
    content.innerHTML = html
    state.renderedChanges = html
  }
}

function updateConversation(session) {
  const instance = instanceFor(state.routeInstanceId)
  const status = statusFor(session)
  app.querySelector("[data-session-title]").textContent = titleFor(session)
  app.querySelector("[data-session-meta]").textContent = [instanceTitle(instance), session.directory || session.id].filter(Boolean).join(" · ")
  const badge = app.querySelector("[data-session-status]")
  badge.textContent = status.label
  badge.className = `badge ${status.className}`
  const stop = app.querySelector("[data-stop]")
  const activity = session.status?.type
  const active = !session.attention && (activity === "busy" || activity === "retry")
  stop.hidden = !active
  stop.classList.toggle("retry", activity === "retry")
  stop.setAttribute("aria-label", activity === "retry" ? "Agent is retrying. Stop current request" : "Agent is working. Stop current request")
  stop.title = activity === "retry" ? "Agent is retrying. Stop current request" : "Agent is working. Stop current request"
  updateAgentSelector()
  updateChangesView()

  updateAttention()

  const messages = renderMessages()
  if (state.renderedMessages !== messages) {
    app.querySelector("[data-messages]").innerHTML = messages
    state.renderedMessages = messages
    if (state.followMessages) scrollToLatest()
  }

  app.querySelector("[data-toast]").innerHTML = state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ""
}

function render() {
  if (!state.routeSessionId) {
    document.body.classList.remove("changes-open")
    state.viewKey = `list:${state.routeInstanceId}`
    app.innerHTML = renderList(state.routeInstanceId)
    return
  }

  const session = sessionFor(state.routeInstanceId, state.routeSessionId)
  if (!session) {
    const key = scopedKey("missing", state.routeInstanceId, state.routeSessionId)
    if (state.viewKey !== key) {
      app.innerHTML = `<div class="shell"><header class="topbar"><button class="icon-button" data-back>←</button><h1>Session</h1></header><div class="empty">Session not found.</div></div>`
      state.viewKey = key
    }
    return
  }

  const key = scopedKey("conversation", state.routeInstanceId, state.routeSessionId)
  if (state.viewKey !== key) {
    app.innerHTML = renderConversationShell()
    state.viewKey = key
    state.renderedMessages = ""
    state.renderedAttention = ""
    state.renderedAgents = ""
    state.renderedChanges = ""
    state.attentionRequest = ""
    state.attentionCollapsed = false
    state.followMessages = true
  }
  updateConversation(session)
}

function selectedAnswersFromCard(card) {
  const key = card.dataset.questionKey
  const answers = state.questionAnswers.get(key) || []
  card.querySelectorAll("[data-question-index]").forEach((group) => {
    const index = Number(group.dataset.questionIndex)
    const custom = group.querySelector("[data-custom-answer]")?.value.trim()
    if (custom) {
      const options = [...group.querySelectorAll("[data-answer-option]")].map((b) => b.dataset.answerOption)
      answers[index] = [...(answers[index] || []).filter((x) => options.includes(x)), custom]
    }
  })
  state.questionAnswers.set(key, answers)
  persistDrafts()
  return answers
}

function captureComposerSelection() {
  const textarea = app.querySelector("[data-composer] textarea")
  if (!textarea || document.activeElement !== textarea) return false
  state.composerSelection = {
    sessionKey: conversationKey(),
    start: textarea.selectionStart,
    end: textarea.selectionEnd,
    direction: textarea.selectionDirection,
  }
  return true
}

function restoreComposerFocus(reveal = false) {
  const selection = state.composerSelection
  state.composerSelection = null
  if (!selection || selection.sessionKey !== conversationKey()) return
  const textarea = app.querySelector("[data-composer] textarea")
  if (!textarea) return
  textarea.focus({ preventScroll: !reveal })
  textarea.setSelectionRange(selection.start, selection.end, selection.direction)
  try { navigator.virtualKeyboard?.show() } catch {}
  if (!reveal) return
  state.followMessages = true
  const revealComposer = () => {
    if (document.activeElement !== textarea || !textarea.isConnected) return
    window.scrollTo(0, document.documentElement.scrollHeight)
    textarea.scrollIntoView({ block: "nearest" })
  }
  requestAnimationFrame(revealComposer)
  setTimeout(revealComposer, 350)
}

app.addEventListener("pointerdown", (event) => {
  const control = event.target.closest("[data-agent-select], [data-cycle-agent]")
  if (!control) return
  const hadComposerFocus = captureComposerSelection()
  if (hadComposerFocus && control.hasAttribute("data-cycle-agent")) event.preventDefault()
})

app.addEventListener("input", (event) => {
  const input = event.target
  if (input.matches("[data-composer] textarea")) {
    const key = conversationKey()
    if (input.value) state.messageDrafts.set(key, input.value)
    else state.messageDrafts.delete(key)
    persistDrafts()
    return
  }

  if (input.matches("[data-custom-answer]")) {
    const card = input.closest("[data-question-id]")
    const group = input.closest("[data-question-index]")
    if (!card || !group) return
    const key = card.dataset.questionKey
    const index = Number(group.dataset.questionIndex)
    const answers = state.questionAnswers.get(key) || []
    const options = [...group.querySelectorAll("[data-answer-option]")].map((button) => button.dataset.answerOption)
    const selected = (answers[index] || []).filter((answer) => options.includes(answer))
    answers[index] = input.value ? [...selected, input.value] : selected
    state.questionAnswers.set(key, answers)
    persistDrafts()
  }
})

app.addEventListener("toggle", (event) => {
  const details = event.target.closest("details[data-part-key]")
  if (!details) return
  const key = details.dataset.partKey
  if (details.open) {
    state.expandedParts.add(key)
    state.followMessages = false
    if (details.dataset.diffMessage) loadDiff(details.dataset.diffMessage)
  } else {
    state.expandedParts.delete(key)
    state.followMessages = isNearBottom()
  }
}, true)

app.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.changesOpen) {
    event.preventDefault()
    setChangesOpen(false)
    return
  }
  const textarea = event.target.closest("[data-composer] textarea")
  if (!textarea || event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  textarea.form.requestSubmit()
})

app.addEventListener("change", (event) => {
  const select = event.target.closest("[data-agent-select]")
  if (!select || !select.value) return
  switchAgent(select.value)
  restoreComposerFocus(true)
})

app.addEventListener("click", async (event) => {
  const target = event.target.closest("button")
  if (!target) return

  if (target.dataset.openSession) {
    location.hash = `#/instance/${encodeURIComponent(target.dataset.instanceId)}/session/${encodeURIComponent(target.dataset.openSession)}`
    return
  }
  if (target.dataset.openInstance) {
    location.hash = `#/instance/${encodeURIComponent(target.dataset.openInstance)}`
    return
  }
  if (target.hasAttribute("data-back")) {
    location.hash = state.routeSessionId ? `#/instance/${encodeURIComponent(state.routeInstanceId)}` : "#/"
    return
  }
  if (target.hasAttribute("data-refresh")) {
    try { state.snapshot = await api("/api/refresh", { method: "POST" }); render() } catch (error) { showToast(error.message) }
    return
  }
  if (target.hasAttribute("data-notifications")) {
    if (!("Notification" in window)) return showToast("Notifications are not supported by this browser")
    const permission = await Notification.requestPermission()
    showToast(permission === "granted" ? "Notifications enabled" : `Notifications: ${permission}`)
    return
  }
  if (target.hasAttribute("data-abort")) {
    if (!confirm("Abort this OpenCode session?")) return
    try { await api(sessionApiPath(state.routeInstanceId, state.routeSessionId, "abort"), { method: "POST" }); showToast("Abort sent") } catch (error) { showToast(error.message) }
    return
  }
  if (target.hasAttribute("data-open-changes")) {
    setChangesOpen(true)
    requestAnimationFrame(() => app.querySelector(".changes-header [data-close-changes]")?.focus())
    return
  }
  if (target.hasAttribute("data-close-changes")) {
    setChangesOpen(false)
    return
  }
  if (target.hasAttribute("data-stop")) {
    target.disabled = true
    try {
      await api(sessionApiPath(state.routeInstanceId, state.routeSessionId, "abort"), { method: "POST" })
      showToast("Stop sent")
    } catch (error) {
      showToast(error.message)
    } finally {
      target.disabled = false
    }
    return
  }
  if (target.hasAttribute("data-cycle-agent")) {
    const key = conversationKey()
    const agents = state.agentSessionId === key ? state.agents : []
    const selected = state.selectedAgents.get(key)
    const currentIndex = agents.findIndex((agent) => agent.name === selected)
    const next = agents.length ? agents[(currentIndex + 1) % agents.length] : null
    if (next) switchAgent(next.name)
    restoreComposerFocus()
    return
  }
  if (target.hasAttribute("data-toggle-attention")) {
    state.attentionCollapsed = !state.attentionCollapsed
    updateAttention()
    return
  }

  const option = target.closest("[data-answer-option]")
  if (option) {
    const card = option.closest("[data-question-id]")
    const group = option.closest("[data-question-index]")
    const key = card.dataset.questionKey
    const index = Number(group.dataset.questionIndex)
    const answers = state.questionAnswers.get(key)
    const selected = answers[index] || []
    const label = option.dataset.answerOption
    if (option.dataset.multiple === "true") {
      answers[index] = selected.includes(label) ? selected.filter((x) => x !== label) : [...selected, label]
    } else {
      answers[index] = [label]
    }
    persistDrafts()
    state.renderedAttention = ""
    render()
    return
  }

  if (target.hasAttribute("data-submit-question")) {
    const card = target.closest("[data-question-id]")
    const rid = card.dataset.questionId
    const key = card.dataset.questionKey
    const answers = selectedAnswersFromCard(card)
    if (answers.some((answer) => !answer?.length)) return showToast("Answer each question first")
    try {
      await api(`/api/instances/${encodeURIComponent(state.routeInstanceId)}/questions/${encodeURIComponent(rid)}/reply`, { method: "POST", body: JSON.stringify({ answers }) })
      state.questionAnswers.delete(key)
      persistDrafts()
      showToast("Answer sent")
    } catch (error) { showToast(error.message) }
    return
  }

  if (target.hasAttribute("data-reject-question")) {
    const card = target.closest("[data-question-id]")
    const rid = card.dataset.questionId
    try {
      await api(`/api/instances/${encodeURIComponent(state.routeInstanceId)}/questions/${encodeURIComponent(rid)}/reject`, { method: "POST" })
      state.questionAnswers.delete(card.dataset.questionKey)
      persistDrafts()
      showToast("Question rejected")
    } catch (error) { showToast(error.message) }
    return
  }

  if (target.dataset.permissionResponse) {
    const permission = pendingPermission(state.routeInstanceId, state.routeSessionId)
    if (!permission) return
    try {
      await api(`/api/instances/${encodeURIComponent(state.routeInstanceId)}/permissions/${encodeURIComponent(state.routeSessionId)}/${encodeURIComponent(permissionId(permission))}/reply`, {
        method: "POST",
        body: JSON.stringify({ response: target.dataset.permissionResponse }),
      })
      showToast(target.dataset.permissionResponse === "reject" ? "Rejected" : "Approved")
    } catch (error) { showToast(error.message) }
  }
})

app.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-composer]")
  if (!form) return
  event.preventDefault()
  const textarea = form.elements.message
  const text = textarea.value.trim()
  if (!text) return
  const sid = state.routeSessionId
  const iid = state.routeInstanceId
  const key = conversationKey(iid, sid)
  const agent = state.selectedAgents.get(key) || ""
  try {
    await api(sessionApiPath(iid, sid, "messages"), { method: "POST", body: JSON.stringify({ text, agent }) })
    state.messageDrafts.delete(key)
    persistDrafts()
    textarea.value = ""
    if (routeMatches(iid, sid)) scheduleMessagesRefresh()
  } catch (error) {
    showToast(error.message)
  }
})

window.addEventListener("hashchange", () => {
  document.body.classList.remove("changes-open")
  clearTimeout(state.refreshTimer)
  clearTimeout(state.changesTimer)
  const route = routeFromHash()
  state.routeInstanceId = route.instanceId
  state.routeSessionId = route.sessionId
  state.messages = []
  state.loadingMessages = false
  state.agents = []
  state.agentSessionId = ""
  state.changes = []
  state.changesSessionId = ""
  state.loadingChangesSession = ""
  state.changesOpen = false
  state.diffs.clear()
  state.diffErrors.clear()
  state.loadingDiffs.clear()
  render()
  if (state.routeSessionId) loadConversation()
})

window.addEventListener("scroll", () => {
  if (state.routeSessionId) state.followMessages = isNearBottom()
}, { passive: true })

function maybeNotify(event) {
  if (!("Notification" in window) || Notification.permission !== "granted") return
  if (document.visibilityState === "visible") return
  const session = sessionFor(event.instanceId, event.sessionId)
  const title = titleFor(session)
  const tag = scopedKey(event.instanceId, event.requestId)
  if (event.type === "question.asked") new Notification(`${title} needs an answer`, { body: event.request?.questions?.[0]?.question || "OpenCode asked a question", tag })
  if (event.type === "permission.asked") new Notification(`${title} needs permission`, { body: event.request?.title || event.request?.type || "Permission requested", tag })
}

let devServerId = ""
const source = new EventSource("/api/events")
source.addEventListener("dev-server", (event) => {
  const nextId = JSON.parse(event.data).id
  if (devServerId && devServerId !== nextId) return location.reload()
  devServerId = nextId
})
source.addEventListener("dev-reload", () => location.reload())
source.addEventListener("state", (event) => {
  state.snapshot = JSON.parse(event.data)
  render()
})
source.addEventListener("agent-event", (message) => {
  const event = JSON.parse(message.data)
  if ((event.type === "question.replied" || event.type === "question.rejected") && event.requestId) {
    state.questionAnswers.delete(scopedKey(event.instanceId, event.requestId))
    persistDrafts()
  }
  const switchedAgent = event.type === "session.next.agent.switched" ? event.data?.agent : event.message?.info?.agent
  if (event.instanceId && event.sessionId && switchedAgent) {
    state.selectedAgents.set(conversationKey(event.instanceId, event.sessionId), switchedAgent)
    if (routeMatches(event.instanceId, event.sessionId)) render()
  }
  maybeNotify(event)
  if (event.type === "message.part" && event.part?.type === "patch" && routeMatches(event.instanceId, event.sessionId)) scheduleChangesRefresh()
  if (state.routeSessionId && routeMatches(event.instanceId, event.sessionId) && ["message.part", "message.updated", "session.status"].includes(event.type)) scheduleMessagesRefresh()
})

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {})
loadState().then(() => { if (state.routeSessionId) loadConversation() })
render()
