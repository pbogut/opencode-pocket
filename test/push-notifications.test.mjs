import assert from "node:assert/strict"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { PushNotifications } from "../src/push-notifications.mjs"

function subscription(endpoint = "https://push.example/subscription") {
  return { endpoint, expirationTime: null, keys: { p256dh: "key", auth: "secret" } }
}

async function setup(sendNotification = async () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-pocket-push-"))
  const calls = []
  const webPush = {
    generateVAPIDKeys: () => ({ publicKey: "generated-public", privateKey: "generated-private" }),
    setVapidDetails: (...args) => calls.push(["details", ...args]),
    sendNotification: async (...args) => {
      calls.push(["send", ...args])
      return sendNotification(...args)
    },
  }
  const config = {
    pushPublicKey: "public",
    pushPrivateKey: "private",
    pushSubject: "mailto:test@example.com",
    pushVapidFile: join(directory, "push-vapid.json"),
    pushSubscriptionsFile: join(directory, "push-subscriptions.json"),
  }
  const service = new PushNotifications(config, { webPush })
  await service.start()
  return { calls, config, service }
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
  const { config, service } = await setup(async () => { throw error })
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
