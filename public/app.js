import { completionId, completionTag, isVisibleSession } from "./notification-state.js"
import { normalizeAgentSort, sortAgentItems } from "./agent-sort.js"
import { isStaleObservation, latestModels, reconcileSelection, supportsImages, visibleMessageParts } from "./model-state.js"

const app = document.querySelector("#app")

const DRAFTS_KEY = "opencode-pocket-drafts-v1"
const AGENT_SORT_KEY = "opencode-pocket-agent-sort-v1"
const MODEL_SELECTIONS_KEY = "opencode-pocket-model-selections-v1"
const BOTTOM_THRESHOLD = 80
const DEFAULT_NOTIFICATION_PREFERENCES = { blockers: true, completed: true }
const IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"])
const MAX_IMAGE_COUNT = 4
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024
const MESSAGE_REFRESH_INTERVAL = 250
const savedDrafts = loadDrafts()
const savedModelSelections = loadModelSelections()
const initialRoute = routeFromHash()
const notificationRoute = new URLSearchParams(location.search).get("notification") === "1"
if (notificationRoute) history.replaceState(null, "", `${location.pathname}${location.hash}`)

const state = {
  snapshot: { instances: [], sessions: [], questions: [], permissions: [] },
  routeInstanceId: initialRoute.instanceId,
  routeSessionId: initialRoute.sessionId,
  messages: [],
  loadingMessages: false,
  loadingConversations: new Set(),
  agents: [],
  agentSessionId: "",
  switchingAgentSession: "",
  composerSelection: null,
  selectedAgents: new Map(),
  selectedModels: new Map(Object.entries(savedModelSelections)),
  observedModels: new Map(),
  models: [],
  modelSessionId: "",
  loadingModelsSession: "",
  modelPickerOpen: false,
  modelQuery: "",
  changes: [],
  changesSessionId: "",
  loadingChangesSession: "",
  changesOpen: false,
  sessionsOpen: false,
  conversationActionsOpen: false,
  agentDrawerOpen: false,
  creatingSession: false,
  switchingSessionId: "",
  changesTimer: null,
  diffs: new Map(),
  diffErrors: new Map(),
  loadingDiffs: new Set(),
  messageDrafts: new Map(draftEntries(savedDrafts.messages).filter(([, value]) => typeof value === "string")),
  messageAttachments: new Map(),
  loadingAttachments: new Map(),
  pendingAttachmentBytes: 0,
  sendingMessages: new Set(),
  questionAnswers: new Map(draftEntries(savedDrafts.questions).filter(([, value]) => Array.isArray(value))),
  toast: "",
  refreshTimer: null,
  messagesRefreshPending: false,
  viewKey: "",
  renderedMessages: "",
  renderedAttention: "",
  renderedAgents: "",
  renderedChanges: "",
  renderedSessions: "",
  renderedAgentNavigation: "",
  renderedNotifications: "",
  attentionRequest: "",
  attentionCollapsed: false,
  stopConfirmation: null,
  followMessages: true,
  scrollingToLatest: false,
  scrollToLatestTimer: null,
  followInstanceId: "",
  directFollowInstanceId: initialRoute.sessionId && !notificationRoute ? initialRoute.instanceId : "",
  pendingTuiSelection: null,
  expandedParts: new Set(),
  notificationsOpen: false,
  notificationConfig: null,
  notificationSubscription: null,
  notificationPreferences: { ...DEFAULT_NOTIFICATION_PREFERENCES },
  ntfySettings: { available: false, enabled: false, preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES } },
  notificationBusy: false,
  agentSort: loadAgentSort(),
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

function loadAgentSort() {
  try {
    return normalizeAgentSort(localStorage.getItem(AGENT_SORT_KEY))
  } catch {
    return "path"
  }
}

function persistAgentSort() {
  try { localStorage.setItem(AGENT_SORT_KEY, state.agentSort) } catch {}
}

function loadModelSelections() {
  try {
    const value = JSON.parse(localStorage.getItem(MODEL_SELECTIONS_KEY) || "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function persistModelSelections() {
  try { localStorage.setItem(MODEL_SELECTIONS_KEY, JSON.stringify(Object.fromEntries(state.selectedModels))) } catch {}
}

function decodeRoutePart(value) {
  try { return decodeURIComponent(value) } catch { return "" }
}

function routeFromHash() {
  const conversation = location.hash.match(/^#\/instance\/([^/]+)\/session\/([^/]+)$/)
  if (conversation) return { instanceId: decodeRoutePart(conversation[1]), sessionId: decodeRoutePart(conversation[2]) }
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

function routeHash(instanceId = "", sessionId = "") {
  if (!instanceId) return "#/"
  const instance = `#/instance/${encodeURIComponent(instanceId)}`
  return sessionId ? `${instance}/session/${encodeURIComponent(sessionId)}` : instance
}

function navigateTo(instanceId = "", sessionId = "") {
  const route = routeFromHash()
  if (route.instanceId === instanceId && route.sessionId === sessionId) return false
  location.hash = routeHash(instanceId, sessionId)
  return true
}

function esc(value = "") {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[ch])
}

function titleCase(value = "") {
  const text = String(value)
  return text.charAt(0).toUpperCase() + text.slice(1)
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
  if (session.attention || pendingQuestion(session.instanceId, session.id) || pendingPermission(session.instanceId, session.id)) {
    return { label: "blocked", className: "attention" }
  }
  const type = session.status?.type || "idle"
  return { label: type === "busy" ? "working" : type, className: type }
}

function instanceFor(id) {
  return state.snapshot.instances.find((item) => item.id === id)
}

function sessionFor(instanceId, sessionId) {
  return state.snapshot.sessions.find((item) => item.instanceId === instanceId && item.id === sessionId)
}

function requestSessionId(request) {
  return request?.sessionID || request?.sessionId || ""
}

function sessionContains(instanceId, ancestorId, sessionId) {
  const seen = new Set()
  let currentId = sessionId
  while (currentId && !seen.has(currentId)) {
    if (currentId === ancestorId) return true
    seen.add(currentId)
    const session = sessionFor(instanceId, currentId)
    currentId = session?.parentID || session?.parentId || ""
  }
  return false
}

function rootSessionsFor(instanceId) {
  return state.snapshot.sessions
    .filter((session) => session.instanceId === instanceId && !session.parentID && !session.parentId)
    .sort((a, b) => (b?.time?.updated || b?.time?.created || 0) - (a?.time?.updated || a?.time?.created || 0))
    .slice(0, 10)
}

function connectedTui(instance) {
  return instance?.tui?.connected ? instance.tui : null
}

function isSessionInTui(instance, sessionId) {
  const tui = connectedTui(instance)
  return tui?.route === "session" && tui.sessionId === sessionId
}

function reconcileTuiRoute() {
  if (state.directFollowInstanceId && state.routeInstanceId === state.directFollowInstanceId && state.routeSessionId) {
    if (connectedTui(instanceFor(state.directFollowInstanceId))) {
      state.followInstanceId = state.directFollowInstanceId
      state.directFollowInstanceId = ""
    }
  }

  const instanceId = state.followInstanceId
  const instance = instanceFor(instanceId)
  const tui = connectedTui(instance)
  const pending = state.pendingTuiSelection
  if (!instanceId || !tui) {
    if (pending?.instanceId === instanceId) state.pendingTuiSelection = null
    return false
  }

  if (pending?.instanceId === instanceId) {
    if (tui.route === "session" && tui.sessionId === pending.sessionId) state.pendingTuiSelection = null
    else return false
  }

  if (tui.route !== "session") return navigateTo()
  if (!sessionFor(instanceId, tui.sessionId)) return false
  return navigateTo(instanceId, tui.sessionId)
}

function applySnapshot(snapshot) {
  state.snapshot = snapshot
  const navigated = reconcileTuiRoute()
  if (!navigated) render()
  return navigated
}

function pendingQuestion(instanceId, sessionId) {
  return state.snapshot.questions.find((item) => item.instanceId === instanceId && sessionContains(instanceId, sessionId, requestSessionId(item)))
}

function pendingPermission(instanceId, sessionId) {
  return state.snapshot.permissions.find((item) => item.instanceId === instanceId && sessionContains(instanceId, sessionId, requestSessionId(item)))
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

function acknowledgeVisibleCompletion(instanceId = state.routeInstanceId, sessionId = state.routeSessionId, completedAt) {
  if (!isVisibleSession(document.visibilityState, state.routeInstanceId, state.routeSessionId, instanceId, sessionId)) return
  const tag = completionTag(instanceId, sessionId)
  const worker = "serviceWorker" in navigator ? navigator.serviceWorker.ready : null
  if ("serviceWorker" in navigator) {
    worker.then(async (registration) => {
      const notifications = await registration.getNotifications?.({ tag }) || []
      for (const notification of notifications) notification.close()
      registration.active?.postMessage({
        type: "clear-completion",
        instanceId,
        sessionId,
        tag,
        completionId: completionId(instanceId, sessionId, completedAt),
      })
    }).catch(() => {})
  }
  api("/api/notifications/completed", {
    method: "PUT",
    body: JSON.stringify({ instanceId, sessionId }),
  }).then((result) => worker?.then((registration) => {
    registration.active?.postMessage({
      type: "clear-completion",
      instanceId,
      sessionId,
      tag,
      acknowledgedAt: result.acknowledgedAt,
    })
  })).catch(() => {})
}

function showToast(text) {
  state.toast = text
  render()
  clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => { state.toast = ""; render() }, 2600)
}

async function loadState({ quiet = false } = {}) {
  try {
    return applySnapshot(await api("/api/state"))
  } catch (error) {
    if (!quiet) showToast(error.message)
    return false
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
    if (routeMatches(iid, sid)) {
      state.messages = messages
      reconcileMessageModels(iid, sid, messages)
    }
  } catch (error) {
    if (routeMatches(iid, sid)) showToast(error.message)
  } finally {
    if (routeMatches(iid, sid)) {
      state.loadingMessages = false
      render()
    }
  }
}

function modelSelectionKey(instanceId, sessionId, agent) {
  return scopedKey(instanceId, sessionId, agent)
}

function reconcileObservedModel(instanceId, sessionId, agent, observed) {
  const key = modelSelectionKey(instanceId, sessionId, agent)
  const selected = state.selectedModels.get(key)
  const previousObserved = state.observedModels.get(key) || (selected?.local && selected.observedMessageId ? {
    messageId: selected.observedMessageId,
    created: Number(selected.observedCreated || observed.created),
  } : null)
  if (isStaleObservation(observed, previousObserved)) return
  const next = reconcileSelection(selected, observed, previousObserved)
  state.observedModels.set(key, observed)
  if (next) state.selectedModels.set(key, next)
}

function reconcileMessageModels(instanceId, sessionId, messages) {
  for (const [agent, observed] of latestModels(messages)) reconcileObservedModel(instanceId, sessionId, agent, observed)
  persistModelSelections()
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

async function loadModels() {
  const iid = state.routeInstanceId
  const sid = state.routeSessionId
  const key = conversationKey(iid, sid)
  if (!key || state.loadingModelsSession === key) return
  state.loadingModelsSession = key
  try {
    const models = await api(sessionApiPath(iid, sid, "models"))
    if (!routeMatches(iid, sid)) return
    state.models = Array.isArray(models) ? models : []
    state.modelSessionId = key
    render()
  } catch (error) {
    if (routeMatches(iid, sid)) showToast(error.message)
  } finally {
    if (state.loadingModelsSession === key) state.loadingModelsSession = ""
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
  const key = conversationKey()
  if (!key || state.loadingConversations.has(key)) return
  state.loadingConversations.add(key)
  try {
    await loadMessages()
    await Promise.all([loadAgents(), loadModels(), loadChanges()])
  } finally {
    state.loadingConversations.delete(key)
  }
}

async function flushMessagesRefresh() {
  state.refreshTimer = null
  if (!state.messagesRefreshPending) return
  if (state.loadingMessages) {
    state.refreshTimer = setTimeout(flushMessagesRefresh, MESSAGE_REFRESH_INTERVAL)
    return
  }
  state.messagesRefreshPending = false
  await loadMessages({ quiet: true })
  if (state.messagesRefreshPending && !state.refreshTimer) {
    state.refreshTimer = setTimeout(flushMessagesRefresh, MESSAGE_REFRESH_INTERVAL)
  }
}

function scheduleMessagesRefresh() {
  state.messagesRefreshPending = true
  if (!state.refreshTimer) state.refreshTimer = setTimeout(flushMessagesRefresh, MESSAGE_REFRESH_INTERVAL)
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
  const toolName = part.tool || part.name || "tool"
  const isShell = toolName === "bash"
  const isTask = toolName === "task"
  const command = isShell
    ? typeof input.command === "string" ? input.command : Array.isArray(input.command) ? input.command.join(" ") : ""
    : ""
  const firstCommandLine = command.split("\n")[0]
  const title = isTask
    ? input.description || toolState.title || "Subagent task"
    : firstCommandLine ? `$ ${firstCommandLine}` : toolState.title || toolName
  const duration = durationLabel(toolState.time)
  const key = partKey(message, part, index)
  const inputText = isTask ? input.prompt || "" : command || (Object.keys(input).length ? detailText(input) : "")
  const inputLabel = isTask ? "Prompt" : command ? "Command" : "Input"
  const output = toolState.output ?? toolState.error ?? ""
  const outputLabel = toolState.error ? "Error" : "Output"
  const body = `${inputText ? `<div class="tool-detail-label">${inputLabel}</div><pre class="tool-detail">${esc(command ? `$ ${inputText}` : inputText)}</pre>` : ""}
    ${output ? `<div class="tool-detail-label">${outputLabel}</div><pre class="tool-detail ${toolState.error ? "error" : ""}">${esc(detailText(output))}</pre>` : `<div class="tool-empty">${status === "running" ? "Running…" : "No output"}</div>`}`
  return `<details class="tool-block ${esc(status)}" data-part-key="${esc(key)}" ${state.expandedParts.has(key) ? "open" : ""}>
    <summary>
      <span class="tool-summary"><span class="tool-name">${esc(toolName)}</span><span class="tool-title">${esc(title)}</span></span>
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

function renderFilePart(part) {
  const mime = typeof part.mime === "string" ? part.mime : ""
  const filename = typeof part.filename === "string" ? part.filename : "Attached image"
  const url = typeof part.url === "string" ? part.url : ""
  if (!IMAGE_MIME_TYPES.has(mime) || !url.startsWith(`data:${mime};base64,`)) return ""
  return `<figure class="message-image"><img src="${esc(url)}" alt="${esc(filename)}" loading="lazy" decoding="async"><figcaption>${esc(filename)}</figcaption></figure>`
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
  const parts = visibleMessageParts(message)
  return parts.map((part, index) => {
    if (part?.type === "text" && typeof part.text === "string") return `<div class="message-text">${esc(part.text)}</div>`
    if (part?.type === "reasoning") return renderReasoning(message, part, index)
    if (part?.type === "tool") return renderTool(message, part, index)
    if (part?.type === "patch") return renderPatchPart(message, part, index)
    if (part?.type === "file") return renderFilePart(part)
    return ""
  }).filter(Boolean).join("")
}

function renderMessages() {
  if (state.loadingMessages && !state.messages.length) return `<div class="empty">Loading conversation…</div>`
  if (!state.messages.length) return `<div class="empty">No messages yet.</div>`
  return `<div class="messages">${state.messages.map((message) => {
    const info = message?.info || message
    const role = info?.role || "assistant"
    const mode = info?.agent || info?.mode || ""
    const plan = mode === "plan"
    const model = role === "assistant" ? info?.modelID || info?.model?.modelID || "" : ""
    const provider = role === "assistant" ? info?.providerID || info?.model?.providerID || "" : ""
    const metadata = `<span class="message-role-name">${esc(titleCase(role))}</span>
      ${mode ? `<span class="message-separator">·</span><span class="message-mode">${esc(titleCase(mode))}</span>` : ""}
      ${model ? `<span class="message-separator">·</span><span class="message-model">${esc(model)}</span>` : ""}
      ${provider ? `<span class="message-separator">·</span><span class="message-provider">${esc(provider)}</span>` : ""}`
    const parts = renderMessageParts(message)
    if (!parts) return ""
    return `<article class="message ${esc(role)}${plan ? " plan" : ""}">
      <div class="message-role">${metadata}</div>
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

function updateScrollToLatestButton() {
  const button = app.querySelector("[data-scroll-latest]")
  if (!button) return
  button.hidden = state.followMessages || state.scrollingToLatest || isNearBottom()
}

function finishJumpToLatest() {
  state.scrollingToLatest = false
  state.followMessages = isNearBottom()
  updateScrollToLatestButton()
}

function scheduleJumpToLatestFinish(delay = 120) {
  clearTimeout(state.scrollToLatestTimer)
  state.scrollToLatestTimer = setTimeout(finishJumpToLatest, delay)
}

function jumpToLatest() {
  state.followMessages = true
  state.scrollingToLatest = true
  updateScrollToLatestButton()
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" })
  scheduleJumpToLatestFinish(reducedMotion ? 0 : 1_000)
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

function agentPath(instance) {
  const project = instance?.project
  return instance?.path?.directory
    || instance?.path?.worktree
    || (typeof project === "string" ? project : project?.worktree)
    || projectLabel(instance)
    || instance?.id
    || ""
}

function instanceTitle(instance) {
  return instance?.serviceName || projectLabel(instance) || instance?.source || instance?.id || "Instance"
}

function agentStatus(instance) {
  const session = sessionFor(instance.id, instance.activeSessionId)
  const status = !instance.connected
    ? { label: "offline", className: "offline" }
    : session ? statusFor(session) : { label: "idle", className: "idle" }
  return { session, status }
}

function agentSummary(instances) {
  const counts = { working: 0, blocked: 0, idle: 0, offline: 0 }
  const blocked = []
  for (const instance of instances) {
    const { session, status } = agentStatus(instance)
    if (status.className === "busy" || status.className === "retry") counts.working += 1
    else if (status.className === "attention") {
      counts.blocked += 1
      if (session) blocked.push({ instance, session })
    } else if (status.className === "idle") counts.idle += 1
    else counts.offline += 1
  }
  return { counts, blocked }
}

function renderAgentSummary(instances) {
  const { counts, blocked } = agentSummary(instances)
  const countItems = [
    ["working", counts.working, "working"],
    ["idle", counts.idle, "idle"],
    ["offline", counts.offline, "offline"],
  ].filter(([, count]) => count > 0)
  const summaryItems = counts.blocked ? [...countItems, ["blocked", counts.blocked]] : countItems
  const summaryLabel = summaryItems.map(([label, count]) => `${count} ${label}`).join(", ") || "No instances"
  const countsHtml = countItems.map(([label, count, className]) => `<span class="agent-count ${className}" title="${esc(`${count} ${label}`)}"><i aria-hidden="true"></i>${count}</span>`).join("")
  const currentIndex = blocked.findIndex(({ instance, session }) => routeMatches(instance.id, session.id))
  const nextBlocked = blocked[currentIndex >= 0 ? (currentIndex + 1) % blocked.length : 0]
  const alert = nextBlocked
    ? `<button type="button" class="agent-alert blocked" data-open-session="${esc(nextBlocked.session.id)}" data-instance-id="${esc(nextBlocked.instance.id)}" aria-label="Open next blocked session: ${esc(titleFor(nextBlocked.session))}" title="Open next blocked session"><i aria-hidden="true"></i><strong>${counts.blocked} blocked</strong></button>`
    : ""
  return `<button type="button" class="agent-summary" data-open-agents aria-label="Open instances. ${esc(summaryLabel)}">${countsHtml}</button>${alert}`
}

function renderAgentSort() {
  const options = [
    ["path", "Path"],
    ["recent", "Recency"],
    ["status", "Status"],
  ].map(([value, label]) => `<option value="${value}" ${state.agentSort === value ? "selected" : ""}>${label}</option>`).join("")
  return `<label class="agent-sort"><span>Sort by</span><select data-agent-sort aria-label="Sort instances">${options}</select></label>`
}

function sortedAgentItems(instances) {
  return sortAgentItems(instances.map((instance) => {
    const { session, status } = agentStatus(instance)
    return {
      instance,
      session,
      id: instance.id,
      path: agentPath(instance),
      updated: session?.time?.updated || session?.time?.created || 0,
      status: status.className,
      statusDetails: status,
    }
  }), state.agentSort)
}

function renderAgentList(instances) {
  if (!instances.length) return `<div class="empty">No OpenCode instances found.</div>`
  return `${renderAgentSort()}<div class="agent-list">${sortedAgentItems(instances).map((item) => {
    const { instance, session, statusDetails: status } = item
    const details = projectLabel(instance) || instance.serviceName || instanceTitle(instance)
    const openable = session && instance.connected
    return `<button class="agent-card" ${openable ? `data-open-session="${esc(session.id)}" data-instance-id="${esc(instance.id)}"` : "disabled"}>
      <span class="agent-main">
        <span class="agent-title">${esc(session ? titleFor(session) : "No active session")}</span>
        <span class="agent-subtitle">${esc(details)}</span>
      </span>
      <span class="badge ${status.className}">${esc(status.label)}</span>
    </button>`
  }).join("")}</div>`
}

function notificationSupport() {
  return window.isSecureContext && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window
}

function renderNotificationSettings() {
  if (!state.notificationsOpen) return ""
  const subscribed = Boolean(state.notificationSubscription)
  const denied = "Notification" in window && Notification.permission === "denied"
  const browserStatus = !notificationSupport()
    ? "Requires a supported browser on HTTPS."
    : denied
      ? "Blocked in browser settings for this site."
      : subscribed ? "Enabled on this browser." : "Disabled on this browser."
  const ntfy = state.ntfySettings
  const choices = (backend, selected, disabled) => `<div class="notification-choices">
    <label class="notification-choice">
      <span><strong>Needs input</strong><small>Questions and permission requests</small></span>
      <input type="checkbox" data-${backend}-notification-preference="blockers" ${selected.blockers ? "checked" : ""} ${disabled ? "disabled" : ""}>
    </label>
    <label class="notification-choice">
      <span><strong>Task finished</strong><small>When an agent stops working</small></span>
      <input type="checkbox" data-${backend}-notification-preference="completed" ${selected.completed ? "checked" : ""} ${disabled ? "disabled" : ""}>
    </label>
  </div>`
  return `<div class="notification-overlay">
    <button type="button" class="notification-backdrop" data-close-notifications aria-label="Close notification settings"></button>
    <section class="notification-drawer" role="dialog" aria-modal="true" aria-labelledby="notification-title">
      <header class="notification-header">
        <div><h2 id="notification-title">Notifications</h2><p>${state.notificationBusy ? "Saving…" : "Configure each destination independently."}</p></div>
        <button type="button" class="icon-button" data-close-notifications aria-label="Close notification settings">×</button>
      </header>
      <div class="notification-content">
        <section class="notification-backend">
          <div class="notification-backend-header"><span><strong>Browser on this device</strong><small>${esc(browserStatus)}</small></span><span class="badge ${subscribed ? "idle" : ""}">${subscribed ? "on" : "off"}</span></div>
          ${choices("browser", state.notificationPreferences, !subscribed || state.notificationBusy)}
          <button type="button" class="button ${subscribed ? "danger" : "primary"} notification-toggle" data-${subscribed ? "disable" : "enable"}-notifications ${state.notificationBusy || denied || !notificationSupport() ? "disabled" : ""}>${subscribed ? "Disable on this device" : "Enable on this device"}</button>
        </section>
        ${ntfy.available ? `<section class="notification-backend">
          <div class="notification-backend-header"><span><strong>ntfy</strong><small>Shared destination configured on the Pocket server.</small></span><span class="badge ${ntfy.enabled ? "idle" : ""}">${ntfy.enabled ? "on" : "off"}</span></div>
          ${choices("ntfy", ntfy.preferences, !ntfy.enabled || state.notificationBusy)}
          <button type="button" class="button ${ntfy.enabled ? "danger" : "primary"} notification-toggle" data-toggle-ntfy ${state.notificationBusy ? "disabled" : ""}>${ntfy.enabled ? "Disable ntfy" : "Enable ntfy"}</button>
        </section>` : ""}
      </div>
    </section>
  </div>`
}

function applicationServerKey(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4)
  const binary = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function subscriptionUsesKey(subscription, publicKey) {
  const current = subscription.options?.applicationServerKey
  if (!current) return true
  const expected = applicationServerKey(publicKey)
  const actual = new Uint8Array(current)
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

let notificationSettingsPromise = null
async function loadNotificationSettings() {
  if (notificationSettingsPromise) return notificationSettingsPromise
  notificationSettingsPromise = loadNotificationSettingsOnce()
  try { return await notificationSettingsPromise } finally { notificationSettingsPromise = null }
}

async function loadNotificationSettingsOnce() {
  state.notificationBusy = true
  render()
  try {
    state.notificationConfig = await api("/api/notifications")
    state.ntfySettings = state.notificationConfig.ntfy || state.ntfySettings
    if (notificationSupport()) {
      const registration = await navigator.serviceWorker.ready
      let subscription = await registration.pushManager.getSubscription()
      if (subscription && !subscriptionUsesKey(subscription, state.notificationConfig.publicKey)) {
        await api("/api/notifications/subscription", {
          method: "DELETE",
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }).catch(() => {})
        await subscription.unsubscribe()
        subscription = null
      }
      state.notificationSubscription = subscription
      if (subscription) {
        const result = await api("/api/notifications/subscription", {
          method: "PUT",
          body: JSON.stringify({ subscription }),
        })
        state.notificationPreferences = result.preferences
      }
    }
  } catch (error) {
    showToast(error.message)
  } finally {
    state.notificationBusy = false
    render()
  }
}

async function enableNotifications() {
  state.notificationBusy = true
  render()
  try {
    const config = state.notificationConfig || await api("/api/notifications")
    state.notificationConfig = config
    const permission = await Notification.requestPermission()
    if (permission !== "granted") throw new Error(`Notifications are ${permission}`)
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(config.publicKey),
    })
    const result = await api("/api/notifications/subscription", {
      method: "PUT",
      body: JSON.stringify({ subscription, preferences: state.notificationPreferences }),
    })
    state.notificationSubscription = subscription
    state.notificationPreferences = result.preferences
    showToast("Notifications enabled")
  } catch (error) {
    showToast(error.message)
  } finally {
    state.notificationBusy = false
    render()
  }
}

async function disableNotifications() {
  const subscription = state.notificationSubscription
  if (!subscription) return
  state.notificationBusy = true
  render()
  try {
    const unsubscribed = await subscription.unsubscribe()
    if (!unsubscribed) throw new Error("The browser could not remove this subscription")
    state.notificationSubscription = null
    await api("/api/notifications/subscription", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    })
    showToast("Notifications disabled")
  } catch (error) {
    showToast(error.message)
  } finally {
    state.notificationBusy = false
    render()
  }
}

async function saveNotificationPreferences() {
  const subscription = state.notificationSubscription
  if (!subscription) return
  state.notificationBusy = true
  render()
  try {
    const result = await api("/api/notifications/subscription", {
      method: "PUT",
      body: JSON.stringify({ subscription, preferences: state.notificationPreferences }),
    })
    state.notificationPreferences = result.preferences
  } catch (error) {
    showToast(error.message)
  } finally {
    state.notificationBusy = false
  }
  render()
}

async function saveNtfySettings(update) {
  if (!state.ntfySettings.available) return
  state.notificationBusy = true
  render()
  try {
    state.ntfySettings = await api("/api/notifications/ntfy", {
      method: "PUT",
      body: JSON.stringify(update),
    })
  } catch (error) {
    showToast(error.message)
  } finally {
    state.notificationBusy = false
  }
  render()
}

function renderConversationShell(empty = false) {
  const draft = empty ? "" : state.messageDrafts.get(conversationKey()) || ""
  return `<div class="shell conversation${empty ? " empty-conversation" : ""}">
    <header class="topbar conversation-topbar">
      <div class="topbar-row">
        <button class="icon-button agent-drawer-button" data-open-agents aria-label="Open instances" title="Open instances">☰</button>
        <h1 class="session-title" data-session-title>${empty ? "OpenCode Pocket" : ""}</h1>
        <div class="agent-radar" data-agent-radar></div>
        <div class="conversation-actions" data-conversation-actions ${empty ? "hidden" : ""}>
          <button class="icon-button conversation-actions-button" data-toggle-conversation-actions aria-label="Conversation actions" aria-haspopup="menu" aria-expanded="false" title="Conversation actions"><span aria-hidden="true">⋮</span></button>
          <div class="conversation-actions-menu" data-conversation-actions-menu role="menu" hidden>
            <button type="button" class="conversation-action" data-open-sessions role="menuitem"><span>Sessions</span><small>Switch or create</small></button>
            <button type="button" class="conversation-action" data-open-changes role="menuitem" disabled><span>Git changes</span><small data-changes-menu-summary>No changes</small></button>
          </div>
        </div>
      </div>
      <span class="badge session-status-sticky idle" data-session-status ${empty ? "hidden" : ""}>idle</span>
    </header>
    <div class="meta" data-session-meta ${empty ? "hidden" : ""}></div>
    <div data-messages>${empty ? `<div class="no-session">
      <img src="/icon.svg" alt="" width="88" height="88">
      <strong>Select an OpenCode instance</strong>
      <button type="button" class="select-instance-button" data-open-agents><span aria-hidden="true">☰</span>Select instance</button>
    </div>` : ""}</div>
    <div class="agent-swipe-edge" data-agent-swipe-edge aria-hidden="true"></div>
    <div class="agent-drawer-overlay" data-agent-drawer-overlay hidden>
      <button type="button" class="agent-drawer-backdrop" data-close-agents aria-label="Close instances"></button>
      <aside class="agent-drawer" role="dialog" aria-modal="true" aria-labelledby="agent-drawer-title">
        <header class="agent-drawer-header">
          <div><h2 id="agent-drawer-title">OpenCode instances</h2><p data-agent-drawer-summary></p></div>
          <div class="agent-drawer-actions">
            <button type="button" class="icon-button notification-button${state.notificationSubscription || state.ntfySettings.enabled ? " enabled" : ""}" data-notifications aria-label="Notification settings" title="Notification settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"></path></svg></button>
            <button type="button" class="icon-button refresh-button" data-refresh aria-label="Refresh instances" title="Refresh"><span aria-hidden="true">↻</span></button>
            <button type="button" class="icon-button" data-close-agents aria-label="Close instances">×</button>
          </div>
        </header>
        <div class="agent-drawer-content" data-agent-drawer-content></div>
      </aside>
    </div>
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
    <div class="sessions-overlay" data-sessions-overlay hidden>
      <button type="button" class="sessions-backdrop" data-close-sessions aria-label="Close sessions"></button>
      <section class="sessions-drawer" role="dialog" aria-modal="true" aria-labelledby="sessions-title">
        <header class="sessions-header">
          <div><h2 id="sessions-title">Sessions</h2><p data-sessions-summary></p></div>
          <button type="button" class="icon-button" data-close-sessions aria-label="Close sessions">×</button>
        </header>
        <div class="sessions-content" data-sessions-content></div>
      </section>
    </div>
    <div class="stop-confirm-overlay" data-stop-confirm-overlay hidden>
      <button type="button" class="stop-confirm-backdrop" data-cancel-stop aria-label="Keep agent working"></button>
      <section class="stop-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="stop-confirm-title" aria-describedby="stop-confirm-description">
        <div class="stop-confirm-icon" aria-hidden="true"><span></span></div>
        <h2 id="stop-confirm-title" data-stop-confirm-title>Stop this agent?</h2>
        <p id="stop-confirm-description">The current response in <strong data-stop-confirm-session></strong> will be interrupted. Work already completed will remain.</p>
        <div class="stop-confirm-actions">
          <button type="button" class="button primary" data-cancel-stop>Keep working</button>
          <button type="button" class="button danger" data-confirm-stop>Stop agent</button>
        </div>
      </section>
    </div>
    <div class="model-overlay" data-model-overlay hidden>
      <button type="button" class="model-backdrop" data-close-models aria-label="Close model selection"></button>
      <section class="model-drawer" role="dialog" aria-modal="true" aria-labelledby="model-title">
        <header class="model-header">
          <div><h2 id="model-title">Select model</h2><p data-model-summary></p></div>
          <button type="button" class="icon-button" data-close-models aria-label="Close model selection">×</button>
        </header>
        <div class="model-search-wrap"><input type="search" data-model-search placeholder="Search models or providers" autocomplete="off" aria-label="Search models"></div>
        <div class="model-content" data-model-content></div>
      </section>
    </div>
    <div data-notification-settings></div>
    <div class="composer-wrap" ${empty ? "hidden" : ""}>
      <button type="button" class="scroll-latest" data-scroll-latest hidden>Scroll to bottom <span aria-hidden="true">↓</span></button>
      <section class="attention-sheet" data-attention-sheet hidden>
        <button type="button" class="attention-sheet-toggle" data-toggle-attention aria-expanded="true">
          <span><strong>Needs input</strong><small data-attention-summary></small></span>
          <span class="attention-sheet-action" data-attention-action>Hide</span>
        </button>
        <div class="attention-sheet-body" data-attention></div>
      </section>
      <form class="composer" data-composer>
        <div class="composer-input">
          <div class="attachment-previews" data-attachment-previews hidden></div>
          <div class="composer-toolbar">
            <div class="mode-picker">
              <label><span>Mode</span><select data-agent-select aria-label="OpenCode mode"><option value="">Loading modes…</option></select></label>
              <button type="button" class="mode-cycle" data-cycle-agent hidden aria-label="Switch to next mode" title="Switch to next mode">↻</button>
              <button type="button" class="model-picker-button" data-open-models aria-label="Select model" title="Select model">Model</button>
            </div>
            <div class="composer-tools">
              <input type="file" data-image-input accept="image/gif,image/jpeg,image/png,image/webp" multiple hidden>
              <button type="button" class="attach-button" data-attach-image aria-label="Attach images" title="Attach images">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20.5 11.5-8.8 8.8a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.8-8.8"></path></svg>
              </button>
              <button type="button" class="dictate-button" data-dictate hidden aria-label="Start dictation" aria-pressed="false" title="Start dictation">
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"></path></svg>
              </button>
            </div>
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
      ? agents.map((agent) => `<option value="${esc(agent.name)}" title="${esc(agent.description)}">${esc(titleCase(agent.name))}</option>`).join("")
      : `<option value="">Loading modes…</option>`
    state.renderedAgents = key
  }
  select.disabled = agents.length === 0 || state.switchingAgentSession === sessionKey
  const selected = state.selectedAgents.get(sessionKey)
  if (selected && agents.some((agent) => agent.name === selected)) select.value = selected
  select.closest(".composer")?.classList.toggle("plan", select.value === "plan")
  const currentIndex = agents.findIndex((agent) => agent.name === selected)
  const next = agents.length ? agents[(currentIndex + 1) % agents.length] : null
  cycle.hidden = agents.length < 2
  cycle.disabled = state.switchingAgentSession === sessionKey
  if (next) {
    cycle.setAttribute("aria-label", `Switch to ${next.name} mode`)
    cycle.title = `Switch to ${next.name}`
  }
  updateModelControl()
}

function selectedAgent() {
  return state.selectedAgents.get(conversationKey()) || ""
}

function currentModel() {
  const agent = selectedAgent()
  if (!agent) return null
  const selected = state.selectedModels.get(modelSelectionKey(state.routeInstanceId, state.routeSessionId, agent))
  if (selected?.providerID && selected?.modelID) {
    return { providerID: selected.providerID, modelID: selected.modelID, ...(selected.variant ? { variant: selected.variant } : {}) }
  }
  return state.agents.find((item) => item.name === agent)?.model || null
}

function catalogModel(ref = currentModel()) {
  if (!ref) return null
  return state.models.find((model) => model.providerID === ref.providerID && model.modelID === ref.modelID) || null
}

function updateModelControl() {
  const button = app.querySelector("[data-open-models]")
  if (!button) return
  const ref = currentModel()
  const model = catalogModel(ref)
  button.textContent = model?.name || ref?.modelID || "Model"
  button.title = ref ? `${model?.name || ref.modelID} · ${model?.providerName || ref.providerID}${ref.variant ? ` · ${ref.variant}` : ""}` : "Select model"
  button.disabled = !selectedAgent() || state.modelSessionId !== conversationKey() || state.models.length === 0
  button.classList.toggle("incompatible", model?.supportsImages === false)
}

function setModelPickerOpen(open) {
  state.modelPickerOpen = open
  if (open) state.modelQuery = ""
  document.body.classList.toggle("model-open", open)
  updateModelSheet()
}

function updateModelSheet() {
  const overlay = app.querySelector("[data-model-overlay]")
  const content = app.querySelector("[data-model-content]")
  const search = app.querySelector("[data-model-search]")
  if (!overlay || !content || !search) return
  overlay.hidden = !state.modelPickerOpen
  if (!state.modelPickerOpen) return
  if (search.value !== state.modelQuery) search.value = state.modelQuery
  const needle = state.modelQuery.trim().toLowerCase()
  const attachments = state.messageAttachments.get(conversationKey()) || []
  const selected = currentModel()
  const models = state.models.filter((model) => !needle || `${model.name} ${model.modelID} ${model.providerName} ${model.providerID}`.toLowerCase().includes(needle))
  app.querySelector("[data-model-summary]").textContent = `${titleCase(selectedAgent())} mode · ${state.models.length} available`
  content.innerHTML = models.length ? models.map((model) => {
    const active = selected?.providerID === model.providerID && selected?.modelID === model.modelID
    const incompatible = attachments.length > 0 && !supportsImages(model)
    return `<button type="button" class="model-choice${active ? " current" : ""}" data-model-provider="${esc(model.providerID)}" data-model-id="${esc(model.modelID)}" ${incompatible ? "disabled" : ""}>
      <span><strong>${esc(model.name)}</strong><small>${esc(model.providerName)} · ${esc(model.modelID)}</small></span>
      <em>${incompatible ? "No image input" : active ? "Selected" : ""}</em>
    </button>`
  }).join("") : `<div class="models-empty">No matching models.</div>`
}

function selectModel(providerID, modelID) {
  const agent = selectedAgent()
  const model = state.models.find((item) => item.providerID === providerID && item.modelID === modelID)
  if (!agent || !model) return
  const current = currentModel()
  const key = modelSelectionKey(state.routeInstanceId, state.routeSessionId, agent)
  const observed = state.observedModels.get(key)
  state.selectedModels.set(key, {
    providerID,
    modelID,
    ...(current?.providerID === providerID && current?.modelID === modelID && current.variant ? { variant: current.variant } : {}),
    observedMessageId: observed?.messageId,
    observedCreated: observed?.created,
    local: true,
  })
  persistModelSelections()
  setModelPickerOpen(false)
  updateModelControl()
  updateAttachmentView()
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
  updateModelSheet()
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
  if (open && state.conversationActionsOpen) setConversationActionsOpen(false)
  if (open && state.sessionsOpen) setSessionsOpen(false)
  if (open && state.agentDrawerOpen) setAgentDrawerOpen(false)
  state.changesOpen = open
  document.body.classList.toggle("changes-open", open)
  if (open) state.followMessages = false
  else state.followMessages = isNearBottom()
  updateChangesView()
}

function setAgentDrawerOpen(open) {
  if (open && state.conversationActionsOpen) setConversationActionsOpen(false)
  if (open && state.changesOpen) setChangesOpen(false)
  if (open && state.sessionsOpen) setSessionsOpen(false)
  state.agentDrawerOpen = open
  document.body.classList.toggle("agent-drawer-open", open)
  updateAgentNavigation()
}

function updateAgentNavigation() {
  const radar = app.querySelector("[data-agent-radar]")
  const overlay = app.querySelector("[data-agent-drawer-overlay]")
  const content = app.querySelector("[data-agent-drawer-content]")
  if (!radar || !overlay || !content) return
  const instances = state.snapshot.instances || []
  overlay.hidden = !state.agentDrawerOpen && !agentSwipe?.active
  const { counts } = agentSummary(instances)
  overlay.querySelector("[data-agent-drawer-summary]").textContent = [
    counts.working ? `${counts.working} working` : "",
    counts.blocked ? `${counts.blocked} blocked` : "",
    counts.idle ? `${counts.idle} idle` : "",
    counts.offline ? `${counts.offline} offline` : "",
  ].filter(Boolean).join(" · ") || "No instances"
  const radarHtml = renderAgentSummary(instances)
  const drawerHtml = renderAgentList(instances)
  const key = `${radarHtml}\n${drawerHtml}`
  if (state.renderedAgentNavigation !== key) {
    radar.innerHTML = radarHtml
    content.innerHTML = drawerHtml
    state.renderedAgentNavigation = key
  }
}

function renderSessionDrawer() {
  const sessions = rootSessionsFor(state.routeInstanceId)
  const newLabel = state.creatingSession ? "Creating session…" : "New session"
  const choices = sessions.length
    ? `<div class="session-choices">${sessions.map((session) => {
      const status = statusFor(session)
      const current = session.id === state.routeSessionId
      const disabled = current || Boolean(state.switchingSessionId) || state.creatingSession
      const detail = [prettyTime(session?.time?.updated || session?.time?.created), session.directory].filter(Boolean).join(" · ")
      return `<button type="button" class="session-choice${current ? " current" : ""}" data-switch-session="${esc(session.id)}" ${disabled ? "disabled" : ""} ${current ? 'aria-current="true"' : ""}>
        <span class="session-choice-main"><strong>${esc(titleFor(session))}</strong><small>${esc(detail || session.id)}</small></span>
        <span class="badge ${esc(status.className)}">${esc(current ? "current" : status.label)}</span>
      </button>`
    }).join("")}</div>`
    : `<div class="sessions-empty">No recent sessions.</div>`
  return `<button type="button" class="button primary new-session-button" data-new-session ${state.creatingSession || Boolean(state.switchingSessionId) ? "disabled" : ""}>${newLabel}</button>${choices}`
}

function setConversationActionsOpen(open, restoreFocus = false) {
  state.conversationActionsOpen = open
  const trigger = app.querySelector("[data-toggle-conversation-actions]")
  const menu = app.querySelector("[data-conversation-actions-menu]")
  if (!trigger || !menu) return
  trigger.setAttribute("aria-expanded", String(open))
  menu.hidden = !open
  if (open) requestAnimationFrame(() => menu.querySelector("[role=menuitem]:not(:disabled)")?.focus())
  else if (restoreFocus) trigger.focus()
}

function setSessionsOpen(open) {
  if (open && state.conversationActionsOpen) setConversationActionsOpen(false)
  if (open && state.changesOpen) setChangesOpen(false)
  if (open && state.agentDrawerOpen) setAgentDrawerOpen(false)
  state.sessionsOpen = open
  document.body.classList.toggle("sessions-open", open)
  updateSessionsView()
}

function updateSessionsView() {
  const overlay = app.querySelector("[data-sessions-overlay]")
  const content = app.querySelector("[data-sessions-content]")
  if (!overlay || !content) return
  overlay.hidden = !state.sessionsOpen
  overlay.querySelector("[data-sessions-summary]").textContent = instanceTitle(instanceFor(state.routeInstanceId))
  const html = renderSessionDrawer()
  if (state.renderedSessions !== html) {
    content.innerHTML = html
    state.renderedSessions = html
  }
}

function updateChangesView() {
  const button = app.querySelector("[data-open-changes]")
  const overlay = app.querySelector("[data-changes-overlay]")
  const content = app.querySelector("[data-changes-content]")
  if (!button || !overlay || !content) return
  const sessionKey = conversationKey()
  const changes = state.changesSessionId === sessionKey ? state.changes : []
  const uniqueFiles = new Set(changes.flatMap((change) => change.files || []))
  const loading = state.loadingChangesSession === sessionKey
  button.disabled = changes.length === 0
  button.querySelector("[data-changes-menu-summary]").textContent = loading
    ? "Loading…"
    : changes.length
      ? `${changes.length} ${changes.length === 1 ? "turn" : "turns"} · ${uniqueFiles.size} ${uniqueFiles.size === 1 ? "file" : "files"}`
      : "No changes"
  button.setAttribute("aria-label", `Open ${changes.length} session change ${changes.length === 1 ? "turn" : "turns"}`)
  overlay.hidden = !state.changesOpen
  overlay.querySelector("[data-changes-summary]").textContent = `${changes.length} ${changes.length === 1 ? "turn" : "turns"} · ${uniqueFiles.size} ${uniqueFiles.size === 1 ? "file" : "files"}`
  const html = renderChangesDrawer()
  if (state.renderedChanges !== html) {
    content.innerHTML = html
    state.renderedChanges = html
  }
}

function updateNotificationSettingsView() {
  for (const button of app.querySelectorAll("[data-notifications]")) {
    button.classList.toggle("enabled", Boolean(state.notificationSubscription || state.ntfySettings.enabled))
  }
  const slot = app.querySelector("[data-notification-settings]")
  if (!slot) return
  const html = renderNotificationSettings()
  if (state.renderedNotifications === html) return
  slot.innerHTML = html
  state.renderedNotifications = html
}

function setStopConfirmation(value, restoreFocus = false) {
  state.stopConfirmation = value
  document.body.classList.toggle("stop-confirm-open", Boolean(value))
  updateStopConfirmation()
  if (value) {
    requestAnimationFrame(() => app.querySelector("[data-cancel-stop]:not(.stop-confirm-backdrop)")?.focus())
  } else if (restoreFocus) {
    requestAnimationFrame(() => app.querySelector("[data-stop]")?.focus())
  }
}

function updateStopConfirmation() {
  const overlay = app.querySelector("[data-stop-confirm-overlay]")
  if (!overlay) return
  const pending = state.stopConfirmation
  overlay.hidden = !pending
  if (!pending) return
  const session = sessionFor(pending.instanceId, pending.sessionId)
  overlay.querySelector("[data-stop-confirm-title]").textContent = pending.retrying ? "Stop retrying?" : "Stop this agent?"
  overlay.querySelector("[data-stop-confirm-session]").textContent = titleFor(session)
}

function updateConversation(session) {
  const instance = instanceFor(state.routeInstanceId)
  const status = statusFor(session)
  app.querySelector("[data-session-title]").textContent = titleFor(session)
  const meta = [instanceTitle(instance), session.directory || session.id].filter(Boolean).join(" · ")
  const tui = connectedTui(instance)
  const syncLabel = isSessionInTui(instance, session.id)
    ? "In TUI"
    : state.pendingTuiSelection?.instanceId === instance?.id && state.pendingTuiSelection.sessionId === session.id
      ? "Syncing TUI"
      : tui ? "TUI connected" : ""
  app.querySelector("[data-session-meta]").innerHTML = `<span class="meta-detail">${esc(meta)}</span>${syncLabel ? `<span class="tui-sync-status">${syncLabel}</span>` : ""}`
  const badge = app.querySelector("[data-session-status]")
  badge.textContent = status.label
  badge.className = `badge session-status-sticky ${status.className}`
  const stop = app.querySelector("[data-stop]")
  const activity = session.status?.type
  const active = status.className !== "attention" && (activity === "busy" || activity === "retry")
  stop.hidden = !active
  stop.classList.toggle("retry", activity === "retry")
  stop.setAttribute("aria-label", activity === "retry" ? "Agent is retrying. Stop current request" : "Agent is working. Stop current request")
  stop.title = activity === "retry" ? "Agent is retrying. Stop current request" : "Agent is working. Stop current request"
  if (!active && state.stopConfirmation?.instanceId === state.routeInstanceId && state.stopConfirmation.sessionId === state.routeSessionId) {
    setStopConfirmation(null)
  } else {
    updateStopConfirmation()
  }
  updateAttachmentView()
  updateDictationButton()
  resizeComposerTextarea()
  updateAgentSelector()
  updateChangesView()
  updateNotificationSettingsView()
  updateSessionsView()
  updateAgentNavigation()

  updateAttention()

  const messages = renderMessages()
  if (state.renderedMessages !== messages) {
    app.querySelector("[data-messages]").innerHTML = messages
    state.renderedMessages = messages
    if (state.followMessages) scrollToLatest()
  }
  updateScrollToLatestButton()

  app.querySelector("[data-toast]").innerHTML = state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ""
}

function updateEmptyConversation() {
  updateAgentNavigation()
  updateNotificationSettingsView()
  app.querySelector("[data-toast]").innerHTML = state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ""
}

function render() {
  if (!state.routeSessionId) {
    document.body.classList.remove("changes-open", "sessions-open")
    if (state.viewKey !== "conversation-empty") {
      app.innerHTML = renderConversationShell(true)
      state.viewKey = "conversation-empty"
      state.renderedAgentNavigation = ""
      state.renderedNotifications = ""
    }
    updateEmptyConversation()
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
    state.renderedSessions = ""
    state.renderedAgentNavigation = ""
    state.renderedNotifications = ""
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

let composerInsetFrame = 0
function updateComposerInset() {
  cancelAnimationFrame(composerInsetFrame)
  composerInsetFrame = requestAnimationFrame(() => {
    const conversation = app.querySelector(".conversation")
    const composer = app.querySelector(".composer-wrap")
    if (conversation && composer) conversation.style.paddingBottom = `${Math.ceil(composer.getBoundingClientRect().height + 18)}px`
  })
}

function resizeComposerTextarea(textarea = app.querySelector("[data-composer] textarea")) {
  if (!textarea) return
  textarea.style.height = "auto"
  textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`
  textarea.scrollTop = textarea.scrollHeight
  updateComposerInset()
}

function renderAttachmentPreviews() {
  const attachments = state.messageAttachments.get(conversationKey()) || []
  return attachments.map((attachment) => `<figure class="attachment-preview">
    <img src="${esc(attachment.url)}" alt="">
    <figcaption>${esc(attachment.filename)}</figcaption>
    <button type="button" data-remove-attachment="${esc(attachment.id)}" aria-label="Remove ${esc(attachment.filename)}" title="Remove image">×</button>
  </figure>`).join("")
}

function updateAttachmentView() {
  const previews = app.querySelector("[data-attachment-previews]")
  const attach = app.querySelector("[data-attach-image]")
  const send = app.querySelector("[data-composer] .send-button")
  if (!previews || !attach || !send) return
  const key = conversationKey()
  const attachments = state.messageAttachments.get(key) || []
  const loading = (state.loadingAttachments.get(key) || 0) > 0
  const sending = state.sendingMessages.has(key)
  previews.hidden = attachments.length === 0
  previews.innerHTML = renderAttachmentPreviews()
  attach.disabled = loading || sending || attachments.length >= MAX_IMAGE_COUNT
  attach.setAttribute("aria-label", loading ? "Images are loading" : attachments.length >= MAX_IMAGE_COUNT ? "Maximum images attached" : "Attach images")
  send.disabled = loading || sending
  send.setAttribute("aria-label", loading ? "Images are loading" : sending ? "Sending message" : "Send message")
  updateComposerInset()
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read image"))
    reader.onerror = () => reject(new Error(`Could not read ${file.name || "image"}`))
    reader.readAsDataURL(file)
  })
}

function safeImageFilename(file) {
  const extension = { "image/gif": "gif", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type] || "img"
  return (file.name.trim() || `image.${extension}`).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 255)
}

function draftImageBytes() {
  let total = 0
  for (const attachments of state.messageAttachments.values()) {
    for (const attachment of attachments) total += attachment.size
  }
  return total
}

function setAttachmentLoading(key, loading) {
  const count = state.loadingAttachments.get(key) || 0
  if (loading) state.loadingAttachments.set(key, count + 1)
  else if (count > 1) state.loadingAttachments.set(key, count - 1)
  else state.loadingAttachments.delete(key)
  if (conversationKey() === key) updateAttachmentView()
}

async function addImageFiles(fileList) {
  const key = conversationKey()
  if (!key) return
  const current = state.messageAttachments.get(key) || []
  let count = current.length
  let total = current.reduce((sum, attachment) => sum + attachment.size, 0)
  let draftTotal = draftImageBytes() + state.pendingAttachmentBytes
  let acceptedBytes = 0
  const accepted = []
  const errors = []

  for (const file of fileList) {
    if (!IMAGE_MIME_TYPES.has(file.type)) {
      errors.push(`${file.name || "Image"} is not a supported image type`)
      continue
    }
    if (count >= MAX_IMAGE_COUNT) {
      errors.push(`A message can include at most ${MAX_IMAGE_COUNT} images`)
      break
    }
    if (file.size > MAX_IMAGE_BYTES) {
      errors.push(`${file.name || "Image"} exceeds the 5 MiB limit`)
      continue
    }
    if (total + file.size > MAX_IMAGE_TOTAL_BYTES) {
      errors.push("Images exceed the 10 MiB total limit")
      continue
    }
    if (draftTotal + file.size > MAX_IMAGE_TOTAL_BYTES) {
      errors.push("Image drafts across sessions exceed the 10 MiB limit")
      continue
    }
    accepted.push(file)
    count += 1
    total += file.size
    draftTotal += file.size
    acceptedBytes += file.size
  }

  if (!accepted.length) {
    if (errors.length) showToast(errors[0])
    return
  }
  state.pendingAttachmentBytes += acceptedBytes
  setAttachmentLoading(key, true)
  try {
    const attachments = await Promise.all(accepted.map(async (file) => {
      const url = await readImage(file)
      if (!url.startsWith(`data:${file.type};base64,`)) throw new Error(`Could not encode ${file.name || "image"}`)
      return {
        id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
        mime: file.type,
        filename: safeImageFilename(file),
        size: file.size,
        url,
      }
    }))
    const latest = state.messageAttachments.get(key) || []
    let latestSize = latest.reduce((sum, attachment) => sum + attachment.size, 0)
    let latestCount = latest.length
    let latestDraftSize = draftImageBytes()
    const available = attachments.filter((attachment) => {
      if (latestCount >= MAX_IMAGE_COUNT || latestSize + attachment.size > MAX_IMAGE_TOTAL_BYTES || latestDraftSize + attachment.size > MAX_IMAGE_TOTAL_BYTES) return false
      latestCount += 1
      latestSize += attachment.size
      latestDraftSize += attachment.size
      return true
    })
    if (available.length < attachments.length) errors.push("Some images could not be added because the attachment limit was reached")
    if (available.length) state.messageAttachments.set(key, [...latest, ...available])
  } catch (error) {
    errors.push(error.message || "Could not read image")
  } finally {
    state.pendingAttachmentBytes = Math.max(0, state.pendingAttachmentBytes - acceptedBytes)
    setAttachmentLoading(key, false)
  }

  if (errors.length) showToast(errors[0])
}

function revealComposer(textarea) {
  if (!textarea?.isConnected) return
  resizeComposerTextarea(textarea)
  window.scrollTo(0, document.documentElement.scrollHeight)
  textarea.scrollIntoView({ block: "nearest" })
}

let composerRevealFrame = 0
let composerRevealTimer = 0
let composerRevealDeadline = 0

function scheduleComposerReveal(textarea) {
  state.followMessages = true
  const reveal = () => {
    if (document.activeElement === textarea && textarea.isConnected) revealComposer(textarea)
  }
  cancelAnimationFrame(composerRevealFrame)
  clearTimeout(composerRevealTimer)
  composerRevealFrame = requestAnimationFrame(reveal)
  composerRevealTimer = setTimeout(reveal, 350)
}

function cancelComposerReveal() {
  composerRevealDeadline = 0
  cancelAnimationFrame(composerRevealFrame)
  clearTimeout(composerRevealTimer)
}

function beginComposerReveal(textarea, shouldReveal = isNearBottom()) {
  if (!shouldReveal) {
    cancelComposerReveal()
    return
  }
  composerRevealDeadline = Date.now() + 1_500
  scheduleComposerReveal(textarea)
}

function revealComposerAfterViewportResize() {
  if (Date.now() > composerRevealDeadline) return
  const textarea = app.querySelector("[data-composer] textarea")
  if (document.activeElement === textarea) scheduleComposerReveal(textarea)
}

function restoreComposerFocus(reveal = false) {
  const selection = state.composerSelection
  state.composerSelection = null
  if (!selection || selection.sessionKey !== conversationKey()) return
  const textarea = app.querySelector("[data-composer] textarea")
  if (!textarea) return
  textarea.focus({ preventScroll: !reveal })
  textarea.setSelectionRange(selection.start, selection.end, selection.direction)
  resizeComposerTextarea(textarea)
  try { navigator.virtualKeyboard?.show() } catch {}
  if (!reveal) return
  beginComposerReveal(textarea)
}

let speechDictation = null

function speechRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition
}

function updateDictationButton() {
  const button = app.querySelector("[data-dictate]")
  if (!button) return
  const supported = Boolean(speechRecognitionConstructor())
  const active = supported && speechDictation?.key === conversationKey()
  button.hidden = !supported
  button.classList.toggle("recording", active)
  button.setAttribute("aria-pressed", String(active))
  button.setAttribute("aria-label", active ? "Stop dictation" : "Start dictation")
  button.title = active ? "Stop dictation" : "Start dictation"
}

function stopDictation(abort = false) {
  const current = speechDictation
  if (!current) return
  if (abort) {
    speechDictation = null
    current.aborted = true
    try { current.recognition.abort() } catch {}
    updateDictationButton()
    return
  }
  try { current.recognition.stop() } catch {}
}

function concatSpeechTranscripts(...parts) {
  return parts.map((part) => part.trim()).filter(Boolean).join(" ")
}

function applyDictationTranscript(current) {
  const transcript = concatSpeechTranscripts(current.finalTranscript, current.interimTranscript)
  const before = current.prefix && transcript && !/\s$/.test(current.prefix) ? " " : ""
  const after = current.suffix && transcript && !/^\s|^[,.;!?]/.test(current.suffix) ? " " : ""
  current.textarea.value = `${current.prefix}${before}${transcript}${after}${current.suffix}`
  const cursor = current.prefix.length + before.length + transcript.length
  current.textarea.setSelectionRange(cursor, cursor)
  resizeComposerTextarea(current.textarea)
  current.textarea.dispatchEvent(new Event("input", { bubbles: true }))
}

function startDictation() {
  const Recognition = speechRecognitionConstructor()
  const textarea = app.querySelector("[data-composer] textarea")
  if (!Recognition || !textarea || speechDictation) return
  const recognition = new Recognition()
  const end = textarea.value.length
  const android = /Android/i.test(navigator.userAgent)
  const current = {
    recognition,
    key: conversationKey(),
    textarea,
    prefix: textarea.value,
    suffix: "",
    android,
    finalTranscript: "",
    interimTranscript: "",
    previousResultWasFinalOnly: false,
    aborted: false,
  }
  speechDictation = current
  recognition.continuous = !android
  recognition.interimResults = true
  recognition.maxAlternatives = 1
  recognition.lang = navigator.language || "en-US"
  recognition.onresult = (event) => {
    if (speechDictation !== current || !textarea.isConnected || current.key !== conversationKey()) return stopDictation(true)
    let finalTranscript = ""
    let interimTranscript = ""
    const firstChanged = event.resultIndex ?? Math.max(0, event.results.length - 1)
    for (let index = firstChanged; index < event.results.length; index += 1) {
      const result = event.results[index]
      const transcript = result[0]?.transcript?.trim()
      if (!transcript) continue
      const isFinal = result.isFinal && (!android || result[0].confidence > 0)
      if (isFinal) finalTranscript = concatSpeechTranscripts(finalTranscript, transcript)
      else interimTranscript = concatSpeechTranscripts(interimTranscript, transcript)
    }
    const finalOnly = !interimTranscript && Boolean(finalTranscript)
    if (finalOnly && current.previousResultWasFinalOnly) return
    current.previousResultWasFinalOnly = finalOnly
    current.finalTranscript = concatSpeechTranscripts(current.finalTranscript, finalTranscript)
    current.interimTranscript = interimTranscript
    applyDictationTranscript(current)
  }
  recognition.onerror = (event) => {
    if (current.aborted || event.error === "aborted") return
    const message = event.error === "not-allowed" || event.error === "service-not-allowed"
      ? "Microphone permission was denied"
      : event.error === "no-speech" ? "No speech detected" : `Dictation failed: ${event.error}`
    showToast(message)
  }
  recognition.onend = () => {
    if (speechDictation === current) speechDictation = null
    updateDictationButton()
  }
  textarea.focus({ preventScroll: true })
  textarea.setSelectionRange(end, end)
  beginComposerReveal(textarea)
  updateDictationButton()
  try {
    recognition.start()
  } catch (error) {
    speechDictation = null
    updateDictationButton()
    showToast(error.message || "Could not start dictation")
  }
}

let agentSwipe = null

function finishAgentSwipe(open) {
  if (!agentSwipe) return
  const overlay = app.querySelector("[data-agent-drawer-overlay]")
  const drawer = overlay?.querySelector(".agent-drawer")
  const backdrop = overlay?.querySelector(".agent-drawer-backdrop")
  overlay?.classList.remove("dragging")
  drawer?.style.removeProperty("transform")
  backdrop?.style.removeProperty("opacity")
  agentSwipe = null
  if (open) setAgentDrawerOpen(true)
  else if (state.agentDrawerOpen) setAgentDrawerOpen(false)
  else if (overlay) {
    overlay.hidden = true
    document.body.classList.remove("agent-drawer-open")
  }
}

app.addEventListener("pointerdown", (event) => {
  const edge = event.target.closest("[data-agent-swipe-edge]")
  const overlay = event.target.closest("[data-agent-drawer-overlay]")
  if (!event.isPrimary || !["touch", "pen"].includes(event.pointerType)) return
  const mode = state.agentDrawerOpen && overlay ? "close" : "open"
  if (mode === "open" && (!edge || !state.routeSessionId || state.agentDrawerOpen || state.changesOpen || state.sessionsOpen)) return
  if (mode === "close" && !overlay) return
  agentSwipe = { mode, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startedAt: performance.now(), active: false, width: 0, dx: 0 }
})

app.addEventListener("pointermove", (event) => {
  if (!agentSwipe || event.pointerId !== agentSwipe.pointerId) return
  const dx = Math.max(0, agentSwipe.mode === "open" ? event.clientX - agentSwipe.startX : agentSwipe.startX - event.clientX)
  const dy = Math.abs(event.clientY - agentSwipe.startY)
  agentSwipe.dx = dx
  if (!agentSwipe.active) {
    if (dy > 12 && dy > dx) return finishAgentSwipe(agentSwipe.mode === "close")
    if (dx < 10 || dx < dy * 1.25) return
    updateAgentNavigation()
    const overlay = app.querySelector("[data-agent-drawer-overlay]")
    const drawer = overlay?.querySelector(".agent-drawer")
    if (!overlay || !drawer) return finishAgentSwipe(false)
    overlay.hidden = false
    overlay.classList.add("dragging")
    document.body.classList.add("agent-drawer-open")
    agentSwipe.active = true
    agentSwipe.width = drawer.getBoundingClientRect().width
  }
  const overlay = app.querySelector("[data-agent-drawer-overlay]")
  const drawer = overlay?.querySelector(".agent-drawer")
  const backdrop = overlay?.querySelector(".agent-drawer-backdrop")
  const progress = Math.min(1, dx / agentSwipe.width)
  const offset = agentSwipe.mode === "open" ? Math.min(0, dx - agentSwipe.width) : -Math.min(dx, agentSwipe.width)
  drawer?.style.setProperty("transform", `translateX(${offset}px)`)
  backdrop?.style.setProperty("opacity", String(agentSwipe.mode === "open" ? progress : 1 - progress))
})

app.addEventListener("pointerup", (event) => {
  if (!agentSwipe || event.pointerId !== agentSwipe.pointerId) return
  const elapsed = Math.max(1, performance.now() - agentSwipe.startedAt)
  const distance = agentSwipe.mode === "close" ? agentSwipe.width * 0.15 : agentSwipe.width * 0.3
  const crossedThreshold = agentSwipe.active && (agentSwipe.dx >= distance || (agentSwipe.dx >= 32 && agentSwipe.dx / elapsed >= 0.35))
  const open = agentSwipe.mode === "open" ? crossedThreshold : !crossedThreshold
  finishAgentSwipe(open)
})

app.addEventListener("pointercancel", (event) => {
  if (agentSwipe?.pointerId === event.pointerId) finishAgentSwipe(agentSwipe.mode === "close")
})

async function selectAndNavigate(instanceId, sessionId) {
  if (!instanceId || !sessionId || state.switchingSessionId || state.creatingSession) return
  if (routeMatches(instanceId, sessionId)) {
    setSessionsOpen(false)
    return
  }
  const instance = instanceFor(instanceId)
  const tui = connectedTui(instance)
  const selection = tui && !isSessionInTui(instance, sessionId) ? { instanceId, sessionId } : null
  state.directFollowInstanceId = ""
  state.followInstanceId = tui ? instanceId : ""
  state.pendingTuiSelection = selection
  state.switchingSessionId = sessionId
  updateSessionsView()
  try {
    if (selection) await api(sessionApiPath(instanceId, sessionId, "select"), { method: "POST" })
    setSessionsOpen(false)
    navigateTo(instanceId, sessionId)
  } catch (error) {
    if (state.pendingTuiSelection === selection) state.pendingTuiSelection = null
    state.followInstanceId = ""
    showToast(error.message)
  } finally {
    if (state.switchingSessionId === sessionId) state.switchingSessionId = ""
    updateSessionsView()
  }
}

async function createAndOpenSession() {
  if (state.creatingSession || state.switchingSessionId) return
  const instanceId = state.routeInstanceId
  const current = sessionFor(instanceId, state.routeSessionId)
  if (!instanceId || !current) return
  state.creatingSession = true
  updateSessionsView()
  try {
    const session = await api(`/api/instances/${encodeURIComponent(instanceId)}/sessions`, {
      method: "POST",
      body: JSON.stringify({ directory: current.directory || "" }),
    })
    state.snapshot.sessions = [
      { ...session, instanceId },
      ...state.snapshot.sessions.filter((item) => item.instanceId !== instanceId || item.id !== session.id),
    ]
    const instance = instanceFor(instanceId)
    const tui = connectedTui(instance)
    state.directFollowInstanceId = ""
    state.followInstanceId = tui ? instanceId : ""
    state.pendingTuiSelection = tui && !isSessionInTui(instance, session.id) ? { instanceId, sessionId: session.id } : null
    setSessionsOpen(false)
    navigateTo(instanceId, session.id)
  } catch (error) {
    showToast(error.message)
  } finally {
    state.creatingSession = false
    updateSessionsView()
  }
}

app.addEventListener("pointerdown", (event) => {
  const textarea = event.target.closest("[data-composer] textarea")
  if (textarea) beginComposerReveal(textarea)
  const control = event.target.closest("[data-agent-select], [data-cycle-agent]")
  if (!control) return
  const hadComposerFocus = captureComposerSelection()
  if (hadComposerFocus && control.hasAttribute("data-cycle-agent")) event.preventDefault()
})

app.addEventListener("focusin", (event) => {
  const textarea = event.target.closest("[data-composer] textarea")
  if (!textarea) return
  if (Date.now() <= composerRevealDeadline) scheduleComposerReveal(textarea)
  else beginComposerReveal(textarea)
})

app.addEventListener("input", (event) => {
  const input = event.target
  if (input.matches("[data-composer] textarea")) {
    resizeComposerTextarea(input)
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

app.addEventListener("paste", (event) => {
  if (!event.target.closest("[data-composer] textarea")) return
  const files = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean)
  if (!files.length) return
  addImageFiles(files)
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
  updateScrollToLatestButton()
}, true)

app.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.modelPickerOpen) {
    event.preventDefault()
    setModelPickerOpen(false)
    return
  }
  if (state.stopConfirmation && event.key === "Escape") {
    event.preventDefault()
    setStopConfirmation(null, true)
    return
  }
  if (state.stopConfirmation && event.key === "Tab") {
    const controls = [...app.querySelectorAll("[data-stop-confirm-overlay] .stop-confirm-actions button:not(:disabled)")]
    if (!controls.length) return
    const next = event.shiftKey ? controls.at(-1) : controls[0]
    if (!controls.includes(document.activeElement) || (event.shiftKey && document.activeElement === controls[0]) || (!event.shiftKey && document.activeElement === controls.at(-1))) {
      event.preventDefault()
      next.focus()
    }
    return
  }
  if (event.key === "Escape" && state.notificationsOpen) {
    event.preventDefault()
    state.notificationsOpen = false
    render()
    return
  }
  if (state.conversationActionsOpen && event.key === "Escape") {
    event.preventDefault()
    setConversationActionsOpen(false, true)
    return
  }
  if (state.conversationActionsOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    const items = [...app.querySelectorAll("[data-conversation-actions-menu] [role=menuitem]:not(:disabled)")]
    if (!items.length) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement)
    const offset = event.key === "ArrowDown" ? 1 : -1
    items[(current + offset + items.length) % items.length].focus()
    return
  }
  if (event.key === "Escape" && state.changesOpen) {
    event.preventDefault()
    setChangesOpen(false)
    return
  }
  if (event.key === "Escape" && state.sessionsOpen) {
    event.preventDefault()
    setSessionsOpen(false)
    return
  }
  if (event.key === "Escape" && state.agentDrawerOpen) {
    event.preventDefault()
    setAgentDrawerOpen(false)
    return
  }
  const textarea = event.target.closest("[data-composer] textarea")
  if (!textarea || event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  textarea.form.requestSubmit()
})

app.addEventListener("change", (event) => {
  const imageInput = event.target.closest("[data-image-input]")
  if (imageInput) {
    addImageFiles([...imageInput.files])
    imageInput.value = ""
    return
  }
  const browserPreference = event.target.closest("[data-browser-notification-preference]")
  if (browserPreference) {
    state.notificationPreferences[browserPreference.dataset.browserNotificationPreference] = browserPreference.checked
    saveNotificationPreferences()
    return
  }
  const ntfyPreference = event.target.closest("[data-ntfy-notification-preference]")
  if (ntfyPreference) {
    saveNtfySettings({ preferences: { [ntfyPreference.dataset.ntfyNotificationPreference]: ntfyPreference.checked } })
    return
  }
  const agentSort = event.target.closest("[data-agent-sort]")
  if (agentSort) {
    state.agentSort = normalizeAgentSort(agentSort.value)
    persistAgentSort()
    state.renderedAgentNavigation = ""
    render()
    return
  }
  const select = event.target.closest("[data-agent-select]")
  if (!select || !select.value) return
  switchAgent(select.value)
  restoreComposerFocus(true)
})

app.addEventListener("input", (event) => {
  const search = event.target.closest("[data-model-search]")
  if (!search) return
  state.modelQuery = search.value
  updateModelSheet()
})

app.addEventListener("click", async (event) => {
  if (state.conversationActionsOpen && !event.target.closest("[data-conversation-actions]")) setConversationActionsOpen(false)
  const target = event.target.closest("button")
  if (!target) return

  if (target.hasAttribute("data-toggle-conversation-actions")) {
    setConversationActionsOpen(!state.conversationActionsOpen)
    return
  }

  if (target.dataset.openSession) {
    const instanceId = target.dataset.instanceId
    const sessionId = target.dataset.openSession
    setAgentDrawerOpen(false)
    await selectAndNavigate(instanceId, sessionId)
    return
  }
  if (target.hasAttribute("data-scroll-latest")) {
    jumpToLatest()
    return
  }
  if (target.hasAttribute("data-cancel-stop")) {
    setStopConfirmation(null, true)
    return
  }
  if (target.hasAttribute("data-confirm-stop")) {
    const pending = state.stopConfirmation
    if (!pending) return
    target.disabled = true
    target.textContent = "Stopping…"
    try {
      await api(sessionApiPath(pending.instanceId, pending.sessionId, "abort"), { method: "POST" })
      setStopConfirmation(null)
      showToast("Stop sent")
    } catch (error) {
      showToast(error.message)
      if (target.isConnected) {
        target.disabled = false
        target.textContent = "Stop agent"
      }
    }
    return
  }
  if (target.hasAttribute("data-open-agents")) {
    setAgentDrawerOpen(true)
    requestAnimationFrame(() => app.querySelector(".agent-drawer-header [data-close-agents]")?.focus())
    return
  }
  if (target.hasAttribute("data-close-agents")) {
    setAgentDrawerOpen(false)
    return
  }
  if (target.hasAttribute("data-dictate")) {
    if (speechDictation) stopDictation()
    else startDictation()
    return
  }
  if (target.hasAttribute("data-attach-image")) {
    if (!supportsImages(catalogModel())) {
      showToast("This model does not support image attachments.")
      return
    }
    app.querySelector("[data-image-input]")?.click()
    return
  }
  if (target.hasAttribute("data-open-models")) {
    setModelPickerOpen(true)
    requestAnimationFrame(() => app.querySelector("[data-model-search]")?.focus())
    return
  }
  if (target.hasAttribute("data-close-models")) {
    setModelPickerOpen(false)
    return
  }
  if (target.dataset.modelProvider && target.dataset.modelId) {
    selectModel(target.dataset.modelProvider, target.dataset.modelId)
    return
  }
  if (target.dataset.removeAttachment) {
    const key = conversationKey()
    const attachments = (state.messageAttachments.get(key) || []).filter((attachment) => attachment.id !== target.dataset.removeAttachment)
    if (attachments.length) state.messageAttachments.set(key, attachments)
    else state.messageAttachments.delete(key)
    updateAttachmentView()
    return
  }
  if (target.hasAttribute("data-back")) {
    state.followInstanceId = ""
    state.directFollowInstanceId = ""
    state.pendingTuiSelection = null
    navigateTo()
    return
  }
  if (target.hasAttribute("data-refresh")) {
    target.classList.remove("refreshing")
    void target.offsetWidth
    target.classList.add("refreshing")
    target.addEventListener("animationend", () => target.classList.remove("refreshing"), { once: true })
    try { applySnapshot(await api("/api/refresh", { method: "POST" })) } catch (error) { showToast(error.message) }
    return
  }
  if (target.hasAttribute("data-notifications")) {
    if (state.agentDrawerOpen) setAgentDrawerOpen(false)
    state.notificationsOpen = true
    render()
    loadNotificationSettings()
    requestAnimationFrame(() => app.querySelector(".notification-header [data-close-notifications]")?.focus())
    return
  }
  if (target.hasAttribute("data-close-notifications")) {
    state.notificationsOpen = false
    render()
    return
  }
  if (target.hasAttribute("data-enable-notifications")) {
    await enableNotifications()
    return
  }
  if (target.hasAttribute("data-disable-notifications")) {
    await disableNotifications()
    return
  }
  if (target.hasAttribute("data-toggle-ntfy")) {
    await saveNtfySettings({ enabled: !state.ntfySettings.enabled })
    return
  }
  if (target.hasAttribute("data-open-sessions")) {
    setSessionsOpen(true)
    requestAnimationFrame(() => app.querySelector(".sessions-header [data-close-sessions]")?.focus())
    return
  }
  if (target.hasAttribute("data-close-sessions")) {
    setSessionsOpen(false)
    return
  }
  if (target.hasAttribute("data-new-session")) {
    await createAndOpenSession()
    return
  }
  if (target.dataset.switchSession) {
    await selectAndNavigate(state.routeInstanceId, target.dataset.switchSession)
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
    const session = sessionFor(state.routeInstanceId, state.routeSessionId)
    setStopConfirmation({
      instanceId: state.routeInstanceId,
      sessionId: state.routeSessionId,
      retrying: session?.status?.type === "retry",
    })
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
    const permissionSessionId = requestSessionId(permission)
    if (!permissionSessionId) return showToast("Permission session not found")
    try {
      await api(`/api/instances/${encodeURIComponent(state.routeInstanceId)}/permissions/${encodeURIComponent(permissionSessionId)}/${encodeURIComponent(permissionId(permission))}/reply`, {
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
  stopDictation(true)
  const textarea = form.elements.message
  const text = textarea.value.trim()
  const sid = state.routeSessionId
  const iid = state.routeInstanceId
  const key = conversationKey(iid, sid)
  if ((state.loadingAttachments.get(key) || 0) > 0) return showToast("Wait for images to finish loading")
  if (state.sendingMessages.has(key)) return
  const attachments = [...(state.messageAttachments.get(key) || [])]
  if (!text && attachments.length === 0) return
  const agent = state.selectedAgents.get(key) || ""
  const model = currentModel()
  if (!model?.providerID || !model?.modelID) return showToast("Select a model before sending.")
  if (attachments.length > 0 && !supportsImages(catalogModel(model))) return showToast("This model does not support image attachments.")
  state.sendingMessages.add(key)
  updateAttachmentView()
  try {
    const images = attachments.map(({ mime, filename, url }) => ({ mime, filename, url }))
    await api(sessionApiPath(iid, sid, "messages"), { method: "POST", body: JSON.stringify({ text, agent, images, model }) })
    state.messageDrafts.delete(key)
    const sentIds = new Set(attachments.map((attachment) => attachment.id))
    const remaining = (state.messageAttachments.get(key) || []).filter((attachment) => !sentIds.has(attachment.id))
    if (remaining.length) state.messageAttachments.set(key, remaining)
    else state.messageAttachments.delete(key)
    persistDrafts()
    textarea.value = ""
    resizeComposerTextarea(textarea)
    if (routeMatches(iid, sid)) {
      updateAttachmentView()
      scheduleMessagesRefresh()
    }
  } catch (error) {
    showToast(error.message)
  } finally {
    state.sendingMessages.delete(key)
    if (routeMatches(iid, sid)) updateAttachmentView()
  }
})

window.addEventListener("hashchange", () => {
  stopDictation(true)
  setStopConfirmation(null)
  document.body.classList.remove("changes-open", "sessions-open", "agent-drawer-open", "model-open")
  state.modelPickerOpen = false
  clearTimeout(state.refreshTimer)
  clearTimeout(state.changesTimer)
  clearTimeout(state.scrollToLatestTimer)
  state.scrollingToLatest = false
  state.refreshTimer = null
  state.messagesRefreshPending = false
  const wasConversation = Boolean(state.routeSessionId)
  const route = routeFromHash()
  state.routeInstanceId = route.instanceId
  state.routeSessionId = route.sessionId
  if (!route.instanceId) {
    state.followInstanceId = ""
    state.directFollowInstanceId = ""
    state.pendingTuiSelection = null
  }
  state.messages = []
  state.loadingMessages = false
  state.agents = []
  state.agentSessionId = ""
  state.models = []
  state.modelSessionId = ""
  state.loadingModelsSession = ""
  state.changes = []
  state.changesSessionId = ""
  state.loadingChangesSession = ""
  state.changesOpen = false
  state.sessionsOpen = false
  state.conversationActionsOpen = false
  state.agentDrawerOpen = false
  state.diffs.clear()
  state.diffErrors.clear()
  state.loadingDiffs.clear()
  render()
  if (wasConversation && !state.routeSessionId) requestAnimationFrame(() => window.scrollTo(0, 0))
  if (state.routeSessionId) {
    loadConversation()
    acknowledgeVisibleCompletion()
  }
})

let stateRecoveryTimer = 0
let stateRecoveryInFlight = false

function scheduleStateRecovery(delay = 0) {
  clearTimeout(stateRecoveryTimer)
  stateRecoveryTimer = setTimeout(async () => {
    if (document.visibilityState !== "visible" || stateRecoveryInFlight) return
    stateRecoveryInFlight = true
    try {
      await loadState({ quiet: true })
    } finally {
      stateRecoveryInFlight = false
    }
  }, delay)
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return
  acknowledgeVisibleCompletion()
  scheduleStateRecovery()
})

window.addEventListener("scroll", () => {
  if (!state.routeSessionId) return
  if (state.scrollingToLatest) {
    scheduleJumpToLatestFinish()
    return
  }
  state.followMessages = isNearBottom()
  updateScrollToLatestButton()
}, { passive: true })

window.visualViewport?.addEventListener("resize", revealComposerAfterViewportResize)
window.addEventListener("resize", revealComposerAfterViewportResize)

let devServerId = ""
let sourceHasOpened = false
const source = new EventSource("/api/events")
source.addEventListener("open", () => {
  if (sourceHasOpened) scheduleStateRecovery()
  sourceHasOpened = true
})
source.addEventListener("error", () => scheduleStateRecovery(500))
source.addEventListener("dev-server", (event) => {
  const nextId = JSON.parse(event.data).id
  if (devServerId && devServerId !== nextId) return location.reload()
  devServerId = nextId
})
source.addEventListener("dev-reload", () => location.reload())
source.addEventListener("state", (event) => {
  applySnapshot(JSON.parse(event.data))
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
  if (event.type === "session.completed") acknowledgeVisibleCompletion(event.instanceId, event.sessionId, event.completedAt)
  if (event.type === "message.part" && event.part?.type === "patch" && routeMatches(event.instanceId, event.sessionId)) scheduleChangesRefresh()
  if (state.routeSessionId && routeMatches(event.instanceId, event.sessionId) && ["message.part", "message.updated", "session.status"].includes(event.type)) scheduleMessagesRefresh()
})

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {})
loadState().then((navigated) => {
  if (!navigated && state.routeSessionId && sessionFor(state.routeInstanceId, state.routeSessionId)) loadConversation()
  acknowledgeVisibleCompletion()
})
render()
