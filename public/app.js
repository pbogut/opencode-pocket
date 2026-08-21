const app = document.querySelector("#app")

const state = {
  snapshot: { connected: false, sessions: [], questions: [], permissions: [] },
  routeSessionId: sessionFromHash(),
  messages: [],
  loadingMessages: false,
  questionAnswers: new Map(),
  toast: "",
  refreshTimer: null,
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

function questionId(q) { return q?.id || q?.requestID || q?.requestId || "" }
function permissionId(p) { return p?.id || p?.requestID || p?.requestId || p?.permissionID || "" }

function renderQuestionCard(request) {
  if (!request) return ""
  const rid = questionId(request)
  const questions = Array.isArray(request.questions) ? request.questions : []
  if (!state.questionAnswers.has(rid)) state.questionAnswers.set(rid, questions.map(() => []))
  const answers = state.questionAnswers.get(rid)

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

function renderConversation() {
  const session = sessionFor(state.routeSessionId)
  if (!session) return `<div class="shell"><header class="topbar"><button class="icon-button" data-back>←</button><h1>Session</h1></header><div class="empty">Session not found.</div></div>`
  const status = statusFor(session)
  return `<div class="shell conversation">
    <header class="topbar">
      <button class="icon-button" data-back aria-label="Back">←</button>
      <div style="min-width:0;flex:1">
        <h1 style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(titleFor(session))}</h1>
        <div class="connection"><span class="badge ${status.className}">${esc(status.label)}</span></div>
      </div>
      <button class="icon-button" data-abort title="Abort session">■</button>
    </header>
    <div class="meta">${esc(session.directory || session.id)}</div>
    ${renderQuestionCard(pendingQuestion(session.id))}
    ${renderPermissionCard(pendingPermission(session.id))}
    ${renderMessages()}
    <div class="composer-wrap"><form class="composer" data-composer>
      <textarea name="message" rows="1" placeholder="Message OpenCode…" autocomplete="off"></textarea>
      <button type="submit">Send</button>
    </form></div>
    ${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ""}
  </div>`
}

function render() {
  app.innerHTML = state.routeSessionId ? renderConversation() : renderList()
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
  return answers
}

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

  const option = target.closest("[data-answer-option]")
  if (option) {
    const card = option.closest("[data-question-id]")
    const group = option.closest("[data-question-index]")
    const rid = card.dataset.questionId
    const index = Number(group.dataset.questionIndex)
    const answers = state.questionAnswers.get(rid)
    const label = option.dataset.answerOption
    if (option.dataset.multiple === "true") {
      answers[index] = answers[index].includes(label) ? answers[index].filter((x) => x !== label) : [...answers[index], label]
    } else {
      answers[index] = [label]
    }
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
      showToast("Answer sent")
    } catch (error) { showToast(error.message) }
    return
  }

  if (target.hasAttribute("data-reject-question")) {
    const rid = target.closest("[data-question-id]").dataset.questionId
    try { await api(`/api/questions/${encodeURIComponent(rid)}/reject`, { method: "POST" }); showToast("Question rejected") } catch (error) { showToast(error.message) }
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
  textarea.value = ""
  try {
    await api(`/api/sessions/${encodeURIComponent(state.routeSessionId)}/messages`, { method: "POST", body: JSON.stringify({ text }) })
    scheduleMessagesRefresh()
  } catch (error) {
    textarea.value = text
    showToast(error.message)
  }
})

window.addEventListener("hashchange", () => {
  state.routeSessionId = sessionFromHash()
  state.messages = []
  render()
  if (state.routeSessionId) loadMessages()
})

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
  maybeNotify(event)
  if (state.routeSessionId && event.sessionId === state.routeSessionId && ["message.part", "message.updated", "session.status"].includes(event.type)) scheduleMessagesRefresh()
})

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {})
loadState().then(() => { if (state.routeSessionId) loadMessages() })
render()
