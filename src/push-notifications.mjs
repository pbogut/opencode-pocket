import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import webPush from "web-push"

export const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({ blockers: true, completed: true })

function preferences(value, fallback = DEFAULT_NOTIFICATION_PREFERENCES) {
  return {
    blockers: typeof value?.blockers === "boolean" ? value.blockers : fallback.blockers,
    completed: typeof value?.completed === "boolean" ? value.completed : fallback.completed,
  }
}

function validSubscription(value) {
  if (!value || typeof value !== "object" || typeof value.endpoint !== "string") return false
  try {
    if (new URL(value.endpoint).protocol !== "https:") return false
  } catch {
    return false
  }
  return typeof value.keys?.p256dh === "string" && typeof value.keys?.auth === "string"
}

async function privateJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
  await chmod(file, 0o600)
}

async function readJson(file, fallback) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"))
    await chmod(file, 0o600)
    return value
  } catch (error) {
    if (error.code === "ENOENT") return fallback
    throw error
  }
}

export class PushNotifications {
  constructor(config, options = {}) {
    this.config = config
    this.webPush = options.webPush || webPush
    this.subscriptions = new Map()
    this.notifiedBlockers = new Set()
    this.writePromise = Promise.resolve()
  }

  async start() {
    const configuredKeys = this.config.pushPublicKey && this.config.pushPrivateKey
      ? { publicKey: this.config.pushPublicKey, privateKey: this.config.pushPrivateKey }
      : null
    this.keys = configuredKeys || await readJson(this.config.pushVapidFile, null)
    if (!this.keys?.publicKey || !this.keys?.privateKey) {
      this.keys = this.webPush.generateVAPIDKeys()
      await privateJson(this.config.pushVapidFile, this.keys)
    }
    this.webPush.setVapidDetails(this.config.pushSubject, this.keys.publicKey, this.keys.privateKey)

    const stored = await readJson(this.config.pushSubscriptionsFile, [])
    for (const record of Array.isArray(stored) ? stored : []) {
      if (!validSubscription(record)) continue
      this.subscriptions.set(record.endpoint, {
        endpoint: record.endpoint,
        expirationTime: record.expirationTime ?? null,
        keys: record.keys,
        preferences: preferences(record.preferences),
      })
    }
  }

  publicConfig() {
    return {
      supported: true,
      publicKey: this.keys.publicKey,
      defaults: DEFAULT_NOTIFICATION_PREFERENCES,
    }
  }

  async upsert(subscription, selectedPreferences) {
    if (!validSubscription(subscription)) {
      const error = new Error("Invalid push subscription")
      error.statusCode = 400
      throw error
    }
    const current = this.subscriptions.get(subscription.endpoint)
    const record = {
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime ?? null,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      preferences: preferences(selectedPreferences, current?.preferences || DEFAULT_NOTIFICATION_PREFERENCES),
    }
    this.subscriptions.set(record.endpoint, record)
    await this.persist()
    return record
  }

  async remove(endpoint) {
    if (typeof endpoint !== "string" || !endpoint) return false
    const removed = this.subscriptions.delete(endpoint)
    if (removed) await this.persist()
    return removed
  }

  persist() {
    this.writePromise = this.writePromise.catch(() => {}).then(() => privateJson(this.config.pushSubscriptionsFile, [...this.subscriptions.values()]))
    return this.writePromise
  }

  async handleEvent(event, snapshot) {
    const blockerType = event.type === "question.asked" || event.type === "permission.asked"
    const resolvedType = ["question.replied", "question.rejected", "permission.replied"].includes(event.type)
    const blockerKey = `${event.instanceId || ""}:${event.requestId || ""}`

    if (resolvedType) {
      this.notifiedBlockers.delete(blockerKey)
      return
    }
    if (blockerType) {
      if (!event.requestId || this.notifiedBlockers.has(blockerKey)) return
      this.notifiedBlockers.add(blockerKey)
      return this.send("blockers", {
        title: "OpenCode needs you",
        body: "A task is waiting for your input.",
        tag: `blocker:${blockerKey}`,
        url: this.eventUrl(event),
      })
    }
    if (event.type === "session.completed") {
      const session = snapshot?.sessions?.find((item) => item.instanceId === event.instanceId && item.id === event.sessionId)
      if (session?.parentID || session?.parentId) return
      return this.send("completed", {
        title: "OpenCode finished",
        body: "A task has finished.",
        tag: `completed:${event.instanceId || ""}:${event.sessionId || ""}`,
        url: this.eventUrl(event),
      })
    }
  }

  eventUrl(event) {
    if (!event.instanceId || !event.sessionId) return "/#/"
    return `/#/instance/${encodeURIComponent(event.instanceId)}/session/${encodeURIComponent(event.sessionId)}`
  }

  async send(kind, payload) {
    const expired = []
    await Promise.all([...this.subscriptions.values()].map(async (subscription) => {
      if (!subscription.preferences[kind]) return
      try {
        await this.webPush.sendNotification(subscription, JSON.stringify(payload), {
          TTL: kind === "blockers" ? 86_400 : 3_600,
          urgency: kind === "blockers" ? "high" : "normal",
        })
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) expired.push(subscription.endpoint)
        else console.error("Web Push delivery failed", error)
      }
    }))
    if (!expired.length) return
    for (const endpoint of expired) this.subscriptions.delete(endpoint)
    await this.persist()
  }
}
