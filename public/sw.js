const CACHE = "opencode-pocket-v37"
const ACK_CACHE = "opencode-pocket-notification-acks-v1"
const ASSETS = ["/", "/styles.css", "/app.js", "/agent-sort.js", "/model-state.js", "/notification-state.js", "/manifest.webmanifest", "/icon.svg"]
const acknowledgedCompletions = new Set()
self.addEventListener("install", (event) => event.waitUntil(Promise.all([
  self.skipWaiting(),
  caches.open(CACHE).then((cache) => cache.addAll(ASSETS)),
])))
self.addEventListener("activate", (event) => event.waitUntil(Promise.all([
  self.clients.claim(),
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== ACK_CACHE).map((key) => caches.delete(key)))),
])))
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/api/")) return
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone()
    caches.open(CACHE).then((cache) => cache.put(event.request, copy))
    return response
  }).catch(() => caches.match(event.request)))
})

function acknowledgementRequest(tag) {
  return new Request(`${self.location.origin}/__notification_ack__/${encodeURIComponent(tag)}`)
}

async function acknowledged(data) {
  if (data.completionId && acknowledgedCompletions.delete(data.completionId)) return true
  if (!data.tag || !data.completedAt) return false
  const response = await caches.match(acknowledgementRequest(data.tag), { cacheName: ACK_CACHE })
  return response ? Number(await response.text()) >= Number(data.completedAt) : false
}

async function storeAcknowledgement(tag, acknowledgedAt) {
  const cache = await caches.open(ACK_CACHE)
  const request = acknowledgementRequest(tag)
  const existing = await cache.match(request)
  const previous = existing ? Number(await existing.text()) : 0
  await cache.put(request, new Response(String(Math.max(previous, Number(acknowledgedAt)))))
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = {}
    try { data = event.data?.json() || {} } catch { data = {} }
    if (await acknowledged(data)) return
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
    const visible = windows.filter((client) => client.visibilityState === "visible")
    if (data.tag?.startsWith("completed:")) {
      const targetHash = new URL(data.url || "/#/", self.location.origin).hash
      if (visible.some((client) => new URL(client.url).hash === targetHash)) return
    } else if (visible.length > 0) {
      return
    }
    await self.registration.showNotification(data.title || "OpenCode Pocket", {
      body: data.body || "OpenCode has an update.",
      tag: data.tag || "opencode-pocket",
      data: {
        url: data.url || "/#/",
        instanceId: data.instanceId,
        sessionId: data.sessionId,
      },
    })
  })())
})

self.addEventListener("message", (event) => {
  if (event.data?.type !== "clear-completion" || typeof event.data.tag !== "string") return
  if (event.data.completionId) acknowledgedCompletions.add(event.data.completionId)
  event.waitUntil(Promise.all([
    self.registration.getNotifications().then((notifications) => {
      for (const notification of notifications) {
        if (notification.tag === event.data.tag
          || (notification.data?.instanceId === event.data.instanceId && notification.data?.sessionId === event.data.sessionId)) {
          notification.close()
        }
      }
    }),
    event.data.acknowledgedAt
      ? storeAcknowledgement(event.data.tag, event.data.acknowledgedAt)
      : Promise.resolve(),
  ]))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || "/#/", self.location.origin).href
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
    const client = windows.find((item) => new URL(item.url).origin === self.location.origin)
    if (client) {
      await client.navigate(target)
      return client.focus()
    }
    return self.clients.openWindow(target)
  })())
})
