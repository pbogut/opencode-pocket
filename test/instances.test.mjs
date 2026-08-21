import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import test from "node:test"
import { activeSessionId, InstanceManager, instanceIdForUrl } from "../src/instances.mjs"

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

test("active session prefers the TUI route and ignores subagent sessions", () => {
  const sessions = [
    { id: "ses_old", time: { updated: 10 } },
    { id: "ses_child", parentID: "ses_old", time: { updated: 30 } },
    { id: "ses_new", time: { updated: 20 } },
  ]

  assert.equal(activeSessionId(sessions, { connected: true, route: "session", sessionId: "ses_old" }), "ses_old")
  assert.equal(activeSessionId(sessions, { connected: true, route: "session", sessionId: "ses_child" }), "ses_new")
  assert.equal(activeSessionId(sessions, { connected: true, route: "home" }), "ses_new")
  assert.equal(activeSessionId([{ id: "ses_child", parentId: "ses_parent" }], null), "")
})

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
  assert.deepEqual(snapshot.instances.map((item) => item.activeSessionId), ["ses_shared", "ses_shared"])
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
  await manager.updateTuiState({
    serverUrl: "http://localhost:4201",
    route: "session",
    sessionId: "ses_new",
    instanceNonce: "nonce-1",
    sequence: 2,
    pluginVersion: "test",
  })
  assert.equal(instance.tui.sessionId, "ses_new")
  assert.equal(instance.tui.connected, true)

  await manager.updateTuiState({
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

test("plugin reports discover loopback instances and own their lifecycle", async () => {
  const manager = new InstanceManager({
    openCodeUrl: "",
    openCodeUsername: "opencode",
    openCodePassword: "",
    openCodeDirectory: "",
  }, { Bridge: FakeBridge })
  const instance = await manager.updateTuiState({
    serverUrl: "http://127.0.0.1:4301",
    route: "home",
    instanceNonce: "nonce-plugin",
    sequence: 1,
  })

  assert.equal(instance.source, "plugin")
  assert.equal(manager.snapshot().instances.length, 1)
  assert.equal(manager.removeTuiState({ serverUrl: "http://localhost:4301", instanceNonce: "nonce-plugin" }), true)
  assert.equal(instance.bridge.stopped, true)
  assert.equal(manager.snapshot().instances.length, 0)

  const expired = await manager.updateTuiState({
    serverUrl: "http://127.0.0.1:4302",
    route: "home",
    instanceNonce: "nonce-expired",
    sequence: 1,
  })
  manager.expireTuiStates(expired.tui.lastSeenAt + 12_001)
  assert.equal(expired.bridge.stopped, true)
  assert.equal(manager.snapshot().instances.length, 0)

  await assert.rejects(manager.updateTuiState({
    serverUrl: "http://192.168.1.10:4303",
    route: "home",
    instanceNonce: "nonce-remote",
    sequence: 1,
  }), (error) => {
    assert.equal(error.message, "Invalid plugin state report: serverUrl")
    assert.equal(error.statusCode, 400)
    return true
  })
  assert.equal(manager.snapshot().instances.length, 0)
  manager.stop()
})

test("plugin disconnect keeps instances discovered from another source", async () => {
  const manager = new InstanceManager({
    openCodeUrl: "",
    openCodeUsername: "opencode",
    openCodePassword: "",
    openCodeDirectory: "",
  }, { Bridge: FakeBridge })
  const instance = await manager.add("http://127.0.0.1:4401", { source: "mdns" })
  const reported = await manager.updateTuiState({
    serverUrl: "http://localhost:4401",
    route: "home",
    instanceNonce: "nonce-shared",
    sequence: 1,
  })

  assert.equal(reported, instance)
  manager.removeTuiState({ serverUrl: "http://localhost:4401", instanceNonce: "nonce-shared" })
  assert.equal(manager.snapshot().instances.length, 1)
  assert.equal(instance.source, "mdns")
  assert.equal(instance.tui.connected, false)
  manager.stop()
})

test("manager removes stale mDNS instances after an offline grace period", async () => {
  const manager = new InstanceManager({
    openCodeUrl: "",
    openCodeUsername: "opencode",
    openCodePassword: "",
    openCodeDirectory: "",
  }, { Bridge: FakeBridge })
  const stale = await manager.add("http://127.0.0.1:4501", { source: "mdns" })
  stale.bridge.connected = false

  manager.expireOfflineSources(1_000)
  manager.expireOfflineSources(31_000)
  assert.equal(manager.snapshot().instances.length, 1)

  manager.expireOfflineSources(31_001)
  assert.equal(stale.bridge.stopped, true)
  assert.equal(manager.snapshot().instances.length, 0)
  manager.stop()
})

test("manager resets mDNS expiry after reconnect and preserves configured instances", async () => {
  const manager = new InstanceManager({
    openCodeUrl: "",
    openCodeUsername: "opencode",
    openCodePassword: "",
    openCodeDirectory: "",
  }, { Bridge: FakeBridge })
  const recovered = await manager.add("http://127.0.0.1:4601", { source: "mdns" })
  recovered.bridge.connected = false
  manager.expireOfflineSources(1_000)
  recovered.bridge.connected = true
  manager.expireOfflineSources(20_000)
  recovered.bridge.connected = false
  manager.expireOfflineSources(25_000)
  manager.expireOfflineSources(50_001)
  assert.equal(manager.snapshot().instances.length, 1)

  const configured = await manager.add("http://127.0.0.1:4602", { source: "configured" })
  configured.bridge.connected = false
  manager.expireOfflineSources(60_000)
  manager.expireOfflineSources(100_001)
  assert.equal(recovered.bridge.stopped, true)
  assert.equal(manager.snapshot().instances.length, 1)
  assert.equal(manager.get(configured.id), configured)
  manager.stop()
})
