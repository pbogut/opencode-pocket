import assert from "node:assert/strict"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { loadConfig } from "../src/config.mjs"
import { Notifications } from "../src/notifications.mjs"

function subscription(endpoint = "https://push.example/subscription") {
  return { endpoint, expirationTime: null, keys: { p256dh: "key", auth: "secret" } }
}

async function setup(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-pocket-push-"))
  const calls = []
  const fetchCalls = []
  const webPush = {
    generateVAPIDKeys: () => ({ publicKey: "generated-public", privateKey: "generated-private" }),
    setVapidDetails: (...args) => calls.push(["details", ...args]),
    sendNotification: async (...args) => {
      calls.push(["send", ...args])
      return options.sendNotification?.(...args)
    },
  }
  const config = {
    pushPublicKey: "public",
    pushPrivateKey: "private",
    pushSubject: "mailto:test@example.com",
    pushVapidFile: join(directory, "push-vapid.json"),
    pushSubscriptionsFile: join(directory, "push-subscriptions.json"),
    notificationSettingsFile: join(directory, "notification-settings.json"),
    ntfyTopic: options.ntfyTopic || "",
    ntfyUrl: "https://ntfy.sh",
    ntfyToken: options.ntfyToken || "",
    publicUrl: options.publicUrl || "",
  }
  const fetch = async (...args) => {
    fetchCalls.push(args)
    return options.fetch?.(...args) || { ok: true }
  }
  const service = new Notifications(config, { webPush, fetch, logger: options.logger || { error() {} } })
  await service.start()
  return { calls, config, fetchCalls, service, webPush }
}

test("persists per-device preferences and sends selected events", async () => {
  const { calls, config, service } = await setup()
  await service.upsert(subscription(), { blockers: false, completed: true })

  await service.handleEvent({ type: "question.asked", instanceId: "one", sessionId: "ses", requestId: "que_1" })
  await service.handleEvent({ type: "session.completed", instanceId: "one", sessionId: "ses" })

  const sends = calls.filter(([type]) => type === "send")
  assert.equal(sends.length, 1)
  assert.equal(JSON.parse(sends[0][2]).title, "OpenCode finished")
  assert.deepEqual(JSON.parse(await readFile(config.pushSubscriptionsFile, "utf8"))[0].preferences, { blockers: false, completed: true })
  assert.equal((await stat(config.pushSubscriptionsFile)).mode & 0o777, 0o600)
})

test("deduplicates blocker updates", async () => {
  const { calls, service } = await setup()
  await service.upsert(subscription(), { blockers: true, completed: false })
  const event = { type: "permission.asked", instanceId: "one", sessionId: "ses", requestId: "per_1" }

  await service.handleEvent(event)
  await service.handleEvent(event)

  assert.equal(calls.filter(([type]) => type === "send").length, 1)
})

test("removes subscriptions rejected by the push service", async () => {
  const error = Object.assign(new Error("gone"), { statusCode: 410 })
  const { config, service } = await setup({ sendNotification: async () => { throw error } })
  await service.upsert(subscription())

  await service.handleEvent({ type: "session.completed", instanceId: "one", sessionId: "ses" })

  assert.equal(service.subscriptions.size, 0)
  assert.deepEqual(JSON.parse(await readFile(config.pushSubscriptionsFile, "utf8")), [])
})

test("does not notify when a child session completes", async () => {
  const { calls, service } = await setup()
  await service.upsert(subscription())

  await service.handleEvent(
    { type: "session.completed", instanceId: "one", sessionId: "child" },
    { sessions: [{ id: "child", instanceId: "one", parentID: "parent" }] },
  )

  assert.equal(calls.filter(([type]) => type === "send").length, 0)
})

test("delivers to Web Push and ntfy with independent preferences", async () => {
  const { calls, fetchCalls, service } = await setup({
    ntfyTopic: "pocket_secret",
    ntfyToken: "tk_secret",
    publicUrl: "https://pocket.example.ts.net",
  })
  await service.upsert(subscription(), { blockers: true, completed: false })
  await service.updateNtfy({ enabled: true, preferences: { blockers: false, completed: true } })

  await service.handleEvent({ type: "question.asked", instanceId: "one", sessionId: "ses", requestId: "que_1" })
  await service.handleEvent({ type: "session.completed", instanceId: "one", sessionId: "ses" })

  const pushes = calls.filter(([type]) => type === "send")
  assert.equal(pushes.length, 1)
  assert.equal(JSON.parse(pushes[0][2]).title, "OpenCode needs you")
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0][0], "https://ntfy.sh")
  assert.equal(fetchCalls[0][1].headers.Authorization, "Bearer tk_secret")
  assert.deepEqual(JSON.parse(fetchCalls[0][1].body), {
    topic: "pocket_secret",
    title: "OpenCode finished",
    message: "A task has finished.",
    priority: 4,
    click: "https://pocket.example.ts.net/?notification=1#/instance/one/session/ses",
  })
})

test("clears ntfy blocker notifications when they are resolved", async () => {
  const { fetchCalls, service } = await setup({ ntfyTopic: "pocket_secret", ntfyToken: "tk_secret" })
  await service.updateNtfy({ enabled: true, preferences: { blockers: true } })

  await service.handleEvent({ type: "question.asked", instanceId: "one", sessionId: "ses", requestId: "que_1" })
  await service.updateNtfy({ enabled: false })
  await service.handleEvent({ type: "question.replied", instanceId: "one", sessionId: "ses", requestId: "que_1" })
  await service.handleEvent({ type: "question.replied", instanceId: "one", sessionId: "ses", requestId: "que_1" })

  assert.equal(fetchCalls.length, 2)
  const published = JSON.parse(fetchCalls[0][1].body)
  assert.match(published.sequence_id, /^pocket-[-_A-Za-z0-9]{43}$/)
  assert.equal(fetchCalls[1][0], `https://ntfy.sh/pocket_secret/${published.sequence_id}/clear`)
  assert.equal(fetchCalls[1][1].method, "PUT")
  assert.equal(fetchCalls[1][1].headers.Authorization, "Bearer tk_secret")
})

test("clears ntfy blockers after a Pocket restart", async () => {
  const first = await setup({ ntfyTopic: "pocket_secret" })
  await first.service.updateNtfy({ enabled: true, preferences: { blockers: true } })
  await first.service.handleEvent({ type: "permission.asked", instanceId: "one", sessionId: "ses", requestId: "per_1" })

  const restarted = new Notifications(first.config, {
    webPush: first.webPush,
    fetch: async (...args) => {
      first.fetchCalls.push(args)
      return { ok: true }
    },
  })
  await restarted.start()
  await restarted.handleEvent({ type: "permission.replied", instanceId: "one", sessionId: "ses", requestId: "per_1" })

  assert.equal(first.fetchCalls.length, 2)
  const sequenceId = JSON.parse(first.fetchCalls[0][1].body).sequence_id
  assert.equal(first.fetchCalls[1][0], `https://ntfy.sh/pocket_secret/${sequenceId}/clear`)
})

test("persists global ntfy settings privately", async () => {
  const { config, service, webPush } = await setup({ ntfyTopic: "pocket_secret" })
  await service.updateNtfy({ enabled: false, preferences: { blockers: true, completed: false } })

  const stored = JSON.parse(await readFile(config.notificationSettingsFile, "utf8"))
  assert.deepEqual(stored.ntfy, { enabled: false, preferences: { blockers: true, completed: false } })
  assert.equal((await stat(config.notificationSettingsFile)).mode & 0o777, 0o600)

  const reloaded = new Notifications(config, { webPush, fetch: async () => ({ ok: true }) })
  await reloaded.start()
  assert.deepEqual(reloaded.publicConfig().ntfy, {
    available: true,
    enabled: false,
    preferences: { blockers: true, completed: false },
  })
})

test("configuring ntfy does not enable it before user opt-in", async () => {
  const { fetchCalls, service } = await setup({ ntfyTopic: "pocket_secret" })

  await service.handleEvent({ type: "session.completed", instanceId: "one", sessionId: "ses" })

  assert.equal(service.publicConfig().ntfy.enabled, false)
  assert.equal(fetchCalls.length, 0)
})

test("merges partial ntfy preference updates", async () => {
  const { service } = await setup({ ntfyTopic: "pocket_secret" })
  await service.updateNtfy({ enabled: true, preferences: { blockers: false } })

  const updated = await service.updateNtfy({ preferences: { completed: false } })

  assert.deepEqual(updated, {
    available: true,
    enabled: true,
    preferences: { blockers: false, completed: false },
  })
})

test("rejects credentials in the public notification URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-pocket-push-"))
  const webPush = {
    generateVAPIDKeys: () => ({ publicKey: "public", privateKey: "private" }),
    setVapidDetails() {},
  }
  const service = new Notifications({
    pushPublicKey: "public",
    pushPrivateKey: "private",
    pushSubject: "mailto:test@example.com",
    pushVapidFile: join(directory, "vapid.json"),
    pushSubscriptionsFile: join(directory, "subscriptions.json"),
    notificationSettingsFile: join(directory, "settings.json"),
    ntfyTopic: "pocket_secret",
    ntfyUrl: "https://ntfy.sh",
    ntfyToken: "",
    publicUrl: "https://user:secret@pocket.example",
  }, { webPush })

  await assert.rejects(service.start(), /OPENCODE_POCKET_PUBLIC_URL must not include credentials/)
})

test("ntfy failures do not block Web Push delivery", async () => {
  const errors = []
  const { calls, service } = await setup({
    ntfyTopic: "pocket_secret",
    fetch: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
    logger: { error: (...args) => errors.push(args) },
  })
  await service.upsert(subscription())
  await service.updateNtfy({ enabled: true })

  await service.handleEvent({ type: "session.completed", instanceId: "one", sessionId: "ses" })

  assert.equal(calls.filter(([type]) => type === "send").length, 1)
  assert.equal(errors.length, 1)
  assert.match(errors[0][1].message, /503 unavailable/)
})

test("loads ntfy environment configuration", () => {
  const config = loadConfig({
    HOME: "/home/test",
    XDG_STATE_HOME: "/tmp/state",
    OPENCODE_POCKET_NTFY_TOPIC: "pocket_secret",
    OPENCODE_POCKET_NTFY_URL: "https://notify.example/",
    OPENCODE_POCKET_NTFY_TOKEN: "tk_secret",
    OPENCODE_POCKET_PUBLIC_URL: "https://pocket.example/",
  })

  assert.equal(config.ntfyTopic, "pocket_secret")
  assert.equal(config.ntfyUrl, "https://notify.example")
  assert.equal(config.ntfyToken, "tk_secret")
  assert.equal(config.publicUrl, "https://pocket.example")
  assert.equal(config.notificationSettingsFile, "/tmp/state/opencode-pocket/notification-settings.json")
})
