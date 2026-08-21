const app = document.querySelector("#app")

const DRAFTS_KEY = "opencode-pocket-drafts-v1"
const BOTTOM_THRESHOLD = 80
const savedDrafts = loadDrafts()

const state = {
  snapshot: { connected: false, sessions: [], questions: [], permissions: [] },
  routeSessionId: sessionFromHash(),
  messages: [],
  loadingMessages: false,
  messageDrafts: new Map(draftEntries(savedDrafts.messages).filter(([, value]) => typeof value === "string")),
  questionAnswers: new Map(draftEntries(savedDrafts.questions).filter(([, value]) => Array.isArray(value))),
  toast: "",
  refreshTimer: null,
  viewKey: "",
  renderedMessages: "",
  renderedAttention: "",
  attentionRequest: "",
  attentionCollapsed: false,
  followMessages: true,
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

function sessionFromHash() {
  const match = location.hash.match(/^#\/session\/([^/]+)$/)
  return match ? decodeURIComponent(match[1]) : ""
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

function sessionFor(id) {
  return state.snapshot.sessions.find((item) => item.id === id)
}

function pendingQuestion(id) {
  return state.snapshot.questions.find((item) => (item.sessionID || item.sessionId) === id)
}

function pendingPermission(id) {
  return state.snapshot.permissions.find((item) => (item.sessionID || item.sessionId) === id)
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
  if (!state.routeSessionId || state.loadingMessages) return
  state.loadingMessages = true
  if (!quiet) render()
  try {
    state.messages = await api(`/api/sessions/${encodeURIComponent(state.routeSessionId)}/messages?limit=120`)
  } catch (error) {
    showToast(error.message)
  } finally {
    state.loadingMessages = false
    render()
  }
}

function scheduleMessagesRefresh() {
  clearTimeout(state.refreshTimer)
  state.refreshTimer = setTimeout(() => loadMessages({ quiet: true }), 180)
}

function messageText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const text = parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
  return text
}

function toolSummary(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const tools = parts.filter((part) => part?.type === "tool")
  if (!tools.length) return ""
  const names = tools.map((part) => part.tool || part.name || part.state?.title || "tool")
  return `<div class="tool-line">${esc(names.join(" · "))}</div>`
}

function renderMessages() {
  if (state.loadingMessages && !state.messages.length) return `<div class="empty">Loading conversation…</div>`
  if (!state.messages.length) return `<div class="empty">No messages yet.</div>`
  return `<div class="messages">${state.messages.map((message) => {
    const role = message?.info?.role || message?.role || "assistant"
    const text = messageText(message)
    if (!text && !toolSummary(message)) return ""
    return `<article class="message ${esc(role)}">
      <div class="message-role">${esc(role)}</div>
      ${text ? `<div class="message-text">${esc(text)}</div>` : ""}
      ${toolSummary(message)}
    </article>`
  }).join("")}</div>`
}

function isNearBottom() {
  const remaining = document.documentElement.scrollHeight - window.innerHeight - window.scrollY
  return remaining <= BOTTOM_THRESHOLD
}

function scrollToLatest() {
  const sessionId = state.routeSessionId
  requestAnimationFrame(() => {
    if (state.followMessages && state.routeSessionId === sessionId) {
      window.scrollTo(0, document.documentElement.scrollHeight)
    }
  })
}

function questionId(q) { return q?.id || q?.requestID || q?.requestId || "" }
function permissionId(p) { return p?.id || p?.requestID || p?.requestId || p?.permissionID || "" }

function renderQuestionCard(request) {
  if (!request) return ""
  const rid = questionId(request)
  const questions = Array.isArray(request.questions) ? request.questions : []
  if (!state.questionAnswers.has(rid)) state.questionAnswers.set(rid, questions.map(() => []))
  const answers = state.questionAnswers.get(rid)
  for (let index = 0; index < questions.length; index += 1) {
    if (!Array.isArray(answers[index])) answers[index] = []
  }

  return `<section class="attention-card" data-question-id="${esc(rid)}">
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

function renderList() {
  const sessions = state.snapshot.sessions || []
  return `<div class="shell">
    <header class="topbar">
      <div>
        <h1>OpenCode Pocket</h1>
        <div class="connection"><span class="dot ${state.snapshot.connected ? "connected" : ""}"></span>${state.snapshot.connected ? "live" : "reconnecting"}</div>
      </div>
      <button class="icon-button" data-notifications title="Enable notifications">🔔</button>
      <button class="icon-button" data-refresh title="Refresh">↻</button>
    </header>
    ${state.snapshot.lastError ? `<div class="banner">${esc(state.snapshot.lastError)}</div>` : ""}
    ${sessions.length ? `<div class="list">${sessions.map((session) => {
      const status = statusFor(session)
      return `<button class="agent-card" data-open-session="${esc(session.id)}">
        <div class="agent-row">
          <div class="agent-main">
            <div class="agent-title">${esc(titleFor(session))}</div>
            <div class="agent-subtitle">${esc(session.directory || session.id)} · ${esc(prettyTime(session?.time?.updated || session?.time?.created))}</div>
          </div>
          <span class="badge ${status.className}">${esc(status.label)}</span>
        </div>
      </button>`
    }).join("")}</div>` : `<div class="empty">No OpenCode sessions found.<br><br>Start or create a session on the configured OpenCode server.</div>`}
    ${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ""}
  </div>`
}

function renderConversationShell() {
  const draft = state.messageDrafts.get(state.routeSessionId) || ""
  return `<div class="shell conversation">
    <header class="topbar">
      <button class="icon-button" data-back aria-label="Back">←</button>
      <div style="min-width:0;flex:1">
        <h1 data-session-title style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></h1>
        <div class="connection"><span class="badge idle" data-session-status>idle</span></div>
      </div>
      <button class="icon-button" data-abort title="Abort session">■</button>
    </header>
    <div class="meta" data-session-meta></div>
    <div data-messages></div>
    <div class="composer-wrap">
      <section class="attention-sheet" data-attention-sheet hidden>
        <button type="button" class="attention-sheet-toggle" data-toggle-attention aria-expanded="true">
          <span><strong>Needs input</strong><small data-attention-summary></small></span>
          <span class="attention-sheet-action" data-attention-action>Hide</span>
        </button>
        <div class="attention-sheet-body" data-attention></div>
      </section>
      <form class="composer" data-composer>
        <textarea name="message" rows="1" placeholder="Message OpenCode…" autocomplete="off">${esc(draft)}</textarea>
        <div class="composer-actions">
          <button type="button" class="stop-button" data-stop hidden aria-label="Stop current request" title="Stop current request">
            <span class="activity-ring" aria-hidden="true"></span>
            <span class="stop-square" aria-hidden="true"></span>
          </button>
          <button type="submit">Send</button>
        </div>
      </form>
    </div>
    <div data-toast></div>
  </div>`
}

function updateAttention(force = false) {
  const slot = app.querySelector("[data-attention]")
  const sheet = app.querySelector("[data-attention-sheet]")
  if (!slot || !sheet) return
  const question = pendingQuestion(state.routeSessionId)
  const permission = pendingPermission(state.routeSessionId)
  const requestKey = `${questionId(question)}:${permissionId(permission)}`
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

function updateConversation(session) {
  const status = statusFor(session)
  app.querySelector("[data-session-title]").textContent = titleFor(session)
  app.querySelector("[data-session-meta]").textContent = session.directory || session.id
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
    state.viewKey = "list"
    app.innerHTML = renderList()
    return
  }

  const session = sessionFor(state.routeSessionId)
  if (!session) {
    const key = `missing:${state.routeSessionId}`
    if (state.viewKey !== key) {
      app.innerHTML = `<div class="shell"><header class="topbar"><button class="icon-button" data-back>←</button><h1>Session</h1></header><div class="empty">Session not found.</div></div>`
      state.viewKey = key
    }
    return
  }

  const key = `conversation:${state.routeSessionId}`
  if (state.viewKey !== key) {
    app.innerHTML = renderConversationShell()
    state.viewKey = key
    state.renderedMessages = ""
    state.renderedAttention = ""
    state.attentionRequest = ""
    state.attentionCollapsed = false
    state.followMessages = true
  }
  updateConversation(session)
}

function selectedAnswersFromCard(card) {
  const rid = card.dataset.questionId
  const answers = state.questionAnswers.get(rid) || []
  card.querySelectorAll("[data-question-index]").forEach((group) => {
    const index = Number(group.dataset.questionIndex)
    const custom = group.querySelector("[data-custom-answer]")?.value.trim()
    if (custom) {
      const options = [...group.querySelectorAll("[data-answer-option]")].map((b) => b.dataset.answerOption)
      answers[index] = [...(answers[index] || []).filter((x) => options.includes(x)), custom]
    }
  })
  state.questionAnswers.set(rid, answers)
  persistDrafts()
  return answers
}

app.addEventListener("input", (event) => {
  const input = event.target
  if (input.matches("[data-composer] textarea")) {
    if (input.value) state.messageDrafts.set(state.routeSessionId, input.value)
    else state.messageDrafts.delete(state.routeSessionId)
    persistDrafts()
    return
  }

  if (input.matches("[data-custom-answer]")) {
    const card = input.closest("[data-question-id]")
    const group = input.closest("[data-question-index]")
    if (!card || !group) return
    const rid = card.dataset.questionId
    const index = Number(group.dataset.questionIndex)
    const answers = state.questionAnswers.get(rid) || []
    const options = [...group.querySelectorAll("[data-answer-option]")].map((button) => button.dataset.answerOption)
    const selected = (answers[index] || []).filter((answer) => options.includes(answer))
    answers[index] = input.value ? [...selected, input.value] : selected
    state.questionAnswers.set(rid, answers)
    persistDrafts()
  }
})

app.addEventListener("click", async (event) => {
  const target = event.target.closest("button")
  if (!target) return

  if (target.dataset.openSession) {
    location.hash = `#/session/${encodeURIComponent(target.dataset.openSession)}`
    return
  }
  if (target.hasAttribute("data-back")) {
    location.hash = "#/"
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
    try { await api(`/api/sessions/${encodeURIComponent(state.routeSessionId)}/abort`, { method: "POST" }); showToast("Abort sent") } catch (error) { showToast(error.message) }
    return
  }
  if (target.hasAttribute("data-stop")) {
    target.disabled = true
    try {
      await api(`/api/sessions/${encodeURIComponent(state.routeSessionId)}/abort`, { method: "POST" })
      showToast("Stop sent")
    } catch (error) {
      showToast(error.message)
    } finally {
      target.disabled = false
    }
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
    const rid = card.dataset.questionId
    const index = Number(group.dataset.questionIndex)
    const answers = state.questionAnswers.get(rid)
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
    const answers = selectedAnswersFromCard(card)
    if (answers.some((answer) => !answer?.length)) return showToast("Answer each question first")
    try {
      await api(`/api/questions/${encodeURIComponent(rid)}/reply`, { method: "POST", body: JSON.stringify({ answers }) })
      state.questionAnswers.delete(rid)
      persistDrafts()
      showToast("Answer sent")
    } catch (error) { showToast(error.message) }
    return
  }

  if (target.hasAttribute("data-reject-question")) {
    const rid = target.closest("[data-question-id]").dataset.questionId
    try {
      await api(`/api/questions/${encodeURIComponent(rid)}/reject`, { method: "POST" })
      state.questionAnswers.delete(rid)
      persistDrafts()
      showToast("Question rejected")
    } catch (error) { showToast(error.message) }
    return
  }

  if (target.dataset.permissionResponse) {
    const permission = pendingPermission(state.routeSessionId)
    if (!permission) return
    try {
      await api(`/api/permissions/${encodeURIComponent(state.routeSessionId)}/${encodeURIComponent(permissionId(permission))}/reply`, {
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
  try {
    await api(`/api/sessions/${encodeURIComponent(sid)}/messages`, { method: "POST", body: JSON.stringify({ text }) })
    state.messageDrafts.delete(sid)
    persistDrafts()
    textarea.value = ""
    scheduleMessagesRefresh()
  } catch (error) {
    showToast(error.message)
  }
})

window.addEventListener("hashchange", () => {
  state.routeSessionId = sessionFromHash()
  state.messages = []
  render()
  if (state.routeSessionId) loadMessages()
})

window.addEventListener("scroll", () => {
  if (state.routeSessionId) state.followMessages = isNearBottom()
}, { passive: true })

function maybeNotify(event) {
  if (!("Notification" in window) || Notification.permission !== "granted") return
  if (document.visibilityState === "visible") return
  const session = sessionFor(event.sessionId)
  const title = titleFor(session)
  if (event.type === "question.asked") new Notification(`${title} needs an answer`, { body: event.request?.questions?.[0]?.question || "OpenCode asked a question", tag: event.requestId })
  if (event.type === "permission.asked") new Notification(`${title} needs permission`, { body: event.request?.title || event.request?.type || "Permission requested", tag: event.requestId })
}

const source = new EventSource("/api/events")
source.addEventListener("state", (event) => {
  state.snapshot = JSON.parse(event.data)
  render()
})
source.addEventListener("agent-event", (message) => {
  const event = JSON.parse(message.data)
  if ((event.type === "question.replied" || event.type === "question.rejected") && event.requestId) {
    state.questionAnswers.delete(event.requestId)
    persistDrafts()
  }
  maybeNotify(event)
  if (state.routeSessionId && event.sessionId === state.routeSessionId && ["message.part", "message.updated", "session.status"].includes(event.type)) scheduleMessagesRefresh()
})

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {})
loadState().then(() => { if (state.routeSessionId) loadMessages() })
render()
