import test from "node:test"
import assert from "node:assert/strict"
import { normalizeEvent, queryWithDirectory, requestId, sessionId } from "../src/opencode.mjs"

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
