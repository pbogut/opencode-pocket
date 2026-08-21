import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import test from "node:test"
import { InstanceManager, instanceIdForUrl } from "../src/instances.mjs"

class FakeBridge extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.connected = true
    this.stopped = false
  }

  async start() {}
  async refresh() {}
  async health() { return { ok: true } }
  async describe() { return { path: { directory: `/work/${this.config.openCodeUrl.at(-1)}` }, project: null } }
  stop() { this.stopped = true }
  snapshot() {
    return {
      connected: this.connected,
      lastError: null,
      lastEventAt: 0,
      sessions: [{ id: "ses_shared", title: this.config.openCodeUrl }],
      questions: [{ id: "que_shared", sessionID: "ses_shared" }],
      permissions: [{ id: "per_shared", sessionID: "ses_shared" }],
    }
  }
}

test("manager namespaces duplicate OpenCode identities by instance", async () => {
  const manager = new InstanceManager({
    openCodeUrl: "",
    openCodeUsername: "opencode",
    openCodePassword: "",
    openCodeDirectory: "",
  }, { Bridge: FakeBridge })
  const first = await manager.add("http://127.0.0.1:4101")
  const second = await manager.add("http://127.0.0.1:4102")
  const snapshot = manager.snapshot()

  assert.equal(snapshot.instances.length, 2)
  assert.deepEqual(new Set(snapshot.sessions.map((item) => item.instanceId)), new Set([first.id, second.id]))
  assert.deepEqual(new Set(snapshot.questions.map((item) => item.instanceId)), new Set([first.id, second.id]))
  assert.deepEqual(new Set(snapshot.permissions.map((item) => item.instanceId)), new Set([first.id, second.id]))
  assert.notEqual(first.id, second.id)
  assert.equal(first.id, instanceIdForUrl("http://127.0.0.1:4101"))

  const event = once(manager, "event")
  second.bridge.emit("event", { type: "session.status", sessionId: "ses_shared" })
  assert.equal((await event)[0].instanceId, second.id)

  assert.equal(manager.remove(first.id), true)
  assert.equal(first.bridge.stopped, true)
  assert.equal(manager.snapshot().instances.length, 1)
  manager.stop()
})

test("manager tracks current TUI routes and rejects stale reports", async () => {
  const manager = new InstanceManager({
    openCodeUrl: "",
    openCodeUsername: "opencode",
    openCodePassword: "",
    openCodeDirectory: "",
  }, { Bridge: FakeBridge })
  const instance = await manager.add("http://127.0.0.1:4201")
  manager.updateTuiState({
    serverUrl: "http://localhost:4201",
    route: "session",
    sessionId: "ses_new",
    instanceNonce: "nonce-1",
    sequence: 2,
    pluginVersion: "test",
  })
  assert.equal(instance.tui.sessionId, "ses_new")
  assert.equal(instance.tui.connected, true)

  manager.updateTuiState({
    serverUrl: "http://127.0.0.1:4201",
    route: "home",
    instanceNonce: "nonce-1",
    sequence: 1,
  })
  assert.equal(instance.tui.sessionId, "ses_new")

  manager.expireTuiStates(instance.tui.lastSeenAt + 12_001)
  assert.equal(instance.tui.connected, false)
  manager.stop()
})
