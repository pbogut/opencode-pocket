import assert from "node:assert/strict"
import { test } from "bun:test"
import { completionId, completionTag, isVisibleSession } from "../public/notification-state.js"

test("builds the Web Push tag used by completion notifications", () => {
  assert.equal(completionTag("instance", "session"), "completed:instance:session")
  assert.equal(completionId("instance", "session", 123), "instance:session:123")
  assert.equal(completionId("instance", "session"), "")
})

test("acknowledges only the matching foreground session", () => {
  assert.equal(isVisibleSession("visible", "one", "ses", "one", "ses"), true)
  assert.equal(isVisibleSession("hidden", "one", "ses", "one", "ses"), false)
  assert.equal(isVisibleSession("visible", "one", "other", "one", "ses"), false)
  assert.equal(isVisibleSession("visible", "two", "ses", "one", "ses"), false)
})
