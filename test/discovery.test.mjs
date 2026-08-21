import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import test from "node:test"
import { OpenCodeDiscovery, openCodeService } from "../src/discovery.mjs"

class FakeBrowser extends EventEmitter {
  expire() {}
  update() {}
  stop() {}
}

class FakeBonjour {
  constructor() { this.browser = new FakeBrowser() }
  find(options, onup) {
    this.options = options
    this.onup = onup
    return this.browser
  }
  destroy() {}
}

test("recognizes local OpenCode HTTP advertisements", () => {
  const local = new Set(["127.0.0.1", "192.0.2.10"])
  assert.deepEqual(openCodeService({
    name: "opencode-4123",
    type: "http",
    protocol: "tcp",
    port: 4123,
    addresses: ["192.0.2.10"],
  }, local), { url: "http://127.0.0.1:4123", serviceName: "opencode-4123", port: 4123 })
  assert.equal(openCodeService({ name: "printer", type: "http", port: 4123 }, local), null)
  assert.equal(openCodeService({ name: "opencode-4123", type: "http", port: 9999 }, local), null)
  assert.equal(openCodeService({
    name: "opencode-4123",
    type: "http",
    port: 4123,
    addresses: ["192.0.2.99"],
  }, local), null)
})

test("emits live OpenCode endpoint additions and removals", async () => {
  const discovery = new OpenCodeDiscovery({ Bonjour: FakeBonjour, addresses: new Set(["127.0.0.1"]) })
  discovery.start()
  const service = { name: "opencode-4567", type: "http", protocol: "tcp", port: 4567, addresses: ["127.0.0.1"] }

  const up = once(discovery, "up")
  discovery.bonjour.onup(service)
  assert.equal((await up)[0].url, "http://127.0.0.1:4567")

  const down = once(discovery, "down")
  discovery.browser.emit("down", service)
  assert.equal((await down)[0].serviceName, "opencode-4567")
  discovery.stop()
})
