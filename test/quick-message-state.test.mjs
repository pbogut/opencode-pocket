import assert from "node:assert/strict"
import { test } from "bun:test"
import { normalizeQuickMessages, quickMessageModeAvailable } from "../public/quick-message-state.js"

test("quick messages normalize valid local storage entries", () => {
  assert.deepEqual(normalizeQuickMessages([
    { name: " Implement plan ", message: " Please, implement the plan. ", mode: " build " },
    null,
    { name: "Missing mode", message: "No mode" },
  ]), [
    { name: "Implement plan", message: "Please, implement the plan.", mode: "build" },
  ])
})

test("quick messages discard duplicate names without changing order", () => {
  assert.deepEqual(normalizeQuickMessages([
    { name: "Review", message: "Review this", mode: "plan" },
    { name: "review", message: "Review that", mode: "build" },
    { name: "Ship", message: "Ship this", mode: "build" },
  ]).map((item) => item.name), ["Review", "Ship"])
})

test("quick message modes must match an available agent exactly", () => {
  const agents = [{ name: "plan" }, { name: "build" }]
  assert.equal(quickMessageModeAvailable({ mode: "build" }, agents), true)
  assert.equal(quickMessageModeAvailable({ mode: "Build" }, agents), false)
  assert.equal(quickMessageModeAvailable({ mode: "review" }, agents), false)
})
