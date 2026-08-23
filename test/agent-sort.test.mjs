import assert from "node:assert/strict"
import test from "node:test"
import { normalizeAgentSort, sortAgentItems } from "../public/agent-sort.js"

const agents = [
  { id: "three", path: "/work/zeta", updated: 30, status: "idle" },
  { id: "two", path: "/work/alpha", updated: 10, status: "busy" },
  { id: "one", path: "/work/alpha", updated: 20, status: "attention" },
  { id: "four", path: "/work/beta", updated: 40, status: "offline" },
]

test("agent sorting defaults to deterministic path order", () => {
  assert.equal(normalizeAgentSort("unknown"), "path")
  assert.deepEqual(sortAgentItems(agents, "path").map((agent) => agent.id), ["one", "two", "four", "three"])
})

test("agent sorting supports recent activity", () => {
  assert.deepEqual(sortAgentItems(agents, "recent").map((agent) => agent.id), ["four", "three", "one", "two"])
})

test("agent sorting orders blocked, working, idle, then offline", () => {
  const withRetry = [...agents, { id: "retry", path: "/work/retry", updated: 50, status: "retry" }]
  assert.deepEqual(sortAgentItems(withRetry, "status").map((agent) => agent.id), ["one", "retry", "two", "three", "four"])
})

test("agent sorting uses path and id as deterministic final fallbacks", () => {
  const tied = [
    { id: "three", path: "/work/zeta", updated: 10, status: "busy" },
    { id: "two", path: "/work/alpha", updated: 10, status: "busy" },
    { id: "one", path: "/work/alpha", updated: 10, status: "busy" },
  ]
  const expected = ["one", "two", "three"]
  assert.deepEqual(sortAgentItems(tied, "path").map((agent) => agent.id), expected)
  assert.deepEqual(sortAgentItems(tied, "recent").map((agent) => agent.id), expected)
  assert.deepEqual(sortAgentItems(tied, "status").map((agent) => agent.id), expected)
})

test("agent sorting does not mutate its input", () => {
  const original = [...agents]
  sortAgentItems(agents, "recent")
  assert.deepEqual(agents, original)
})
