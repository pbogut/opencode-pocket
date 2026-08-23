import test from "node:test"
import assert from "node:assert/strict"
import { normalizeEvent, OpenCodeBridge, queryWithDirectory, requestId, sessionId } from "../src/opencode.mjs"

test("directory routing preserves existing query params", () => {
  assert.equal(queryWithDirectory("/session/abc/message?limit=20", "/tmp/project"), "/session/abc/message?limit=20&directory=%2Ftmp%2Fproject")
})

test("question event is normalized across request id naming", () => {
  const event = normalizeEvent({
    type: "question.asked",
    properties: { requestID: "que_1", sessionID: "ses_1", questions: [{ question: "Pick" }] },
  })
  assert.equal(event.requestId, "que_1")
  assert.equal(event.sessionId, "ses_1")
  assert.equal(event.type, "question.asked")
})

test("v2-shaped permission event is accepted", () => {
  const event = normalizeEvent({ type: "permission.asked", data: { id: "per_1", sessionID: "ses_2", title: "bash" } })
  assert.equal(event.requestId, "per_1")
  assert.equal(event.sessionId, "ses_2")
})

test("message part can derive session from part", () => {
  const event = normalizeEvent({ type: "message.part.updated", properties: { part: { sessionID: "ses_3", messageID: "msg_1", type: "text", text: "hi" } } })
  assert.equal(event.type, "message.part")
  assert.equal(event.sessionId, "ses_3")
})

test("session lifecycle events expose complete session metadata", () => {
  const info = { id: "ses_4", title: "Updated title" }
  const event = normalizeEvent({ type: "session.updated", properties: { sessionID: "ses_4", info } })
  assert.equal(event.type, "session.updated")
  assert.equal(event.sessionId, "ses_4")
  assert.equal(event.session, info)
})

test("id helpers accept common spellings", () => {
  assert.equal(requestId({ id: "x" }), "x")
  assert.equal(requestId({ requestID: "y" }), "y")
  assert.equal(sessionId({ sessionId: "s" }), "s")
})

test("busy to idle emits one completion event", () => {
  const bridge = new OpenCodeBridge({})
  const events = []
  bridge.on("event", (event) => events.push(event))

  bridge.handleEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })
  bridge.handleEvent({ type: "session.idle", properties: { sessionID: "ses_1" } })
  bridge.handleEvent({ type: "session.idle", properties: { sessionID: "ses_1" } })

  const completed = events.filter((event) => event.type === "session.completed")
  assert.equal(completed.length, 1)
  assert.equal(completed[0].sessionId, "ses_1")
  assert.equal(completed[0].previousStatus.type, "busy")
})

test("session errors suppress completion", () => {
  const bridge = new OpenCodeBridge({})
  const events = []
  bridge.on("event", (event) => events.push(event))

  bridge.handleEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })
  bridge.handleEvent({ type: "session.error", properties: { sessionID: "ses_1", error: { message: "failed" } } })
  bridge.handleEvent({ type: "session.idle", properties: { sessionID: "ses_1" } })

  assert.equal(events.some((event) => event.type === "session.completed"), false)
})

test("state-changing events publish updated state before the event", () => {
  const bridge = new OpenCodeBridge({})
  bridge.sessions.set("ses_1", { id: "ses_1" })
  const order = []
  bridge.on("state", (state) => {
    order.push("state")
    assert.equal(state.questions[0]?.id, "que_1")
  })
  bridge.on("event", () => order.push("event"))

  bridge.handleEvent({
    type: "question.asked",
    properties: { id: "que_1", sessionID: "ses_1", questions: [{ question: "Pick" }] },
  })

  assert.deepEqual(order, ["state", "event"])
})

test("message events do not publish unchanged state snapshots", () => {
  const bridge = new OpenCodeBridge({})
  bridge.sessions.set("ses_1", { id: "ses_1" })
  let stateEvents = 0
  let agentEvents = 0
  bridge.on("state", () => { stateEvents += 1 })
  bridge.on("event", () => { agentEvents += 1 })

  bridge.handleEvent({
    type: "message.part.delta",
    properties: { part: { sessionID: "ses_1", messageID: "msg_1", type: "text" }, delta: "hi" },
  })

  assert.equal(stateEvents, 0)
  assert.equal(agentEvents, 1)
})
