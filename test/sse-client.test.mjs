import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "bun:test"
import { SSEClient, sseEvent } from "../src/sse-client.mjs"

class FakeResponse extends EventEmitter {
  constructor(results = []) {
    super()
    this.results = results
    this.frames = []
    this.destroyed = false
    this.ended = false
  }

  write(frame) {
    this.frames.push(frame)
    return this.results.length ? this.results.shift() : true
  }

  destroy() {
    this.destroyed = true
  }

  end() {
    this.ended = true
  }
}

test("SSE events use named JSON frames", () => {
  assert.equal(sseEvent("state", { connected: true }), "event: state\ndata: {\"connected\":true}\n\n")
})

test("SSE client flushes one pending frame after backpressure clears", () => {
  const response = new FakeResponse([false, true])
  const client = new SSEClient(response)

  assert.equal(client.write("first"), true)
  assert.equal(client.write("latest"), true)
  assert.deepEqual(response.frames, ["first"])

  response.emit("drain")
  assert.deepEqual(response.frames, ["first", "latest"])
  assert.equal(response.destroyed, false)
})

test("SSE client disconnects instead of building a backlog", () => {
  const response = new FakeResponse([false])
  let closed = 0
  const client = new SSEClient(response, () => { closed += 1 })

  client.write("first")
  client.write("second")
  assert.equal(client.write("third"), false)
  assert.equal(response.destroyed, true)
  assert.equal(closed, 1)

  response.emit("drain")
  assert.deepEqual(response.frames, ["first"])
  assert.equal(client.destroy(), false)
  assert.equal(closed, 1)
})
