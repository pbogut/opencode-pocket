const CACHE = "opencode-pocket-v2"
const ASSETS = ["/", "/styles.css", "/app.js", "/manifest.webmanifest", "/icon.svg"]
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS))))
self.addEventListener("activate", (event) => event.waitUntil(Promise.all([
  self.clients.claim(),
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
])))
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/api/")) return
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone()
    caches.open(CACHE).then((cache) => cache.put(event.request, copy))
    return response
  }).catch(() => caches.match(event.request)))
})

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
    if (windows.some((client) => client.visibilityState === "visible")) return
    let data = {}
    try { data = event.data?.json() || {} } catch { data = {} }
    await self.registration.showNotification(data.title || "OpenCode Pocket", {
      body: data.body || "OpenCode has an update.",
      tag: data.tag || "opencode-pocket",
      data: { url: data.url || "/#/" },
    })
  })())
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
