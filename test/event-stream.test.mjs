import assert from "node:assert/strict"
import { test } from "bun:test"
import { createEventStream, createLatestRequest } from "../public/event-stream.js"

class FakeEventSource {
  constructor() {
    this.listeners = new Map()
    this.closed = false
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener)
  }

  dispatch(type, data) {
    this.listeners.get(type)?.({ data })
  }

  close() {
    this.closed = true
  }
}

test("event stream ignores callbacks from a disconnected source", () => {
  const sources = []
  const received = []
  const stream = createEventStream(() => {
    const source = new FakeEventSource()
    sources.push(source)
    return source
  }, {
    state: (event) => received.push(event.data),
  })

  assert.equal(stream.connect(), true)
  assert.equal(stream.connect(), false)
  sources[0].dispatch("state", "current")
  assert.deepEqual(received, ["current"])

  assert.equal(stream.disconnect(), true)
  assert.equal(stream.disconnect(), false)
  assert.equal(sources[0].closed, true)
  sources[0].dispatch("state", "stale")
  assert.deepEqual(received, ["current"])

  assert.equal(stream.connect(), true)
  sources[1].dispatch("state", "resumed")
  assert.deepEqual(received, ["current", "resumed"])
})

test("latest request cancels and ignores an older response or failure", async () => {
  const pending = []
  const requests = createLatestRequest((signal, value) => new Promise((resolve, reject) => {
    pending.push({ signal, value, resolve, reject })
  }))

  const first = requests.run("old")
  const second = requests.run("current")
  assert.equal(pending[0].signal.aborted, true)
  assert.equal(pending[1].signal.aborted, false)

  pending[0].resolve(pending[0].value)
  pending[1].resolve(pending[1].value)
  assert.equal(await first, undefined)
  assert.equal(await second, "current")

  const staleFailure = requests.run("stale failure")
  const current = requests.run("new current")
  pending[2].reject(new Error("old request failed"))
  pending[3].resolve(pending[3].value)
  assert.equal(await staleFailure, undefined)
  assert.equal(await current, "new current")

  const cancelled = requests.run("cancelled")
  requests.cancel()
  pending[4].resolve(pending[4].value)
  assert.equal(await cancelled, undefined)
})
