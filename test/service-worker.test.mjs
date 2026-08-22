import assert from "node:assert/strict"
import test from "node:test"

test("service worker keeps background completions and clears foreground completions", async () => {
  const originalSelf = globalThis.self
  const listeners = new Map()
  const shown = []
  let clients = []
  let notifications = []
  const cached = new Map()
  const originalCaches = globalThis.caches
  globalThis.caches = {
    match: async (request) => cached.get(request.url)?.clone(),
    open: async () => ({
      match: async (request) => cached.get(request.url)?.clone(),
      put: async (request, response) => cached.set(request.url, response.clone()),
      addAll: async () => {},
    }),
    keys: async () => [],
    delete: async () => true,
  }
  globalThis.self = {
    location: { origin: "https://pocket.example" },
    skipWaiting: async () => {},
    addEventListener: (type, listener) => listeners.set(type, listener),
    clients: { matchAll: async () => clients },
    registration: {
      showNotification: async (...args) => shown.push(args),
      getNotifications: async () => notifications,
    },
  }

  const dispatch = async (type, data) => {
    let pending = Promise.resolve()
    listeners.get(type)({ ...data, waitUntil: (promise) => { pending = promise } })
    await pending
  }

  try {
    await import(`../public/sw.js?test=${Date.now()}`)
    const completion = {
      title: "OpenCode finished",
      tag: "completed:one:ses",
      completionId: "one:ses:123",
      completedAt: 123,
      instanceId: "one",
      sessionId: "ses",
      url: "/#/instance/one/session/ses",
    }

    clients = [{ visibilityState: "visible", url: "https://pocket.example/#/instance/one/session/ses" }]
    await dispatch("push", { data: { json: () => completion } })
    assert.equal(shown.length, 0)

    clients = [{ visibilityState: "visible", url: "https://pocket.example/#/instance/one/session/other" }]
    await dispatch("push", { data: { json: () => ({ ...completion, completionId: "one:ses:124" }) } })
    assert.equal(shown.length, 1)

    clients = [{ visibilityState: "hidden", url: "https://pocket.example/#/instance/one/session/ses" }]
    await dispatch("push", { data: { json: () => ({ ...completion, completionId: "one:ses:125" }) } })
    assert.equal(shown.length, 2)

    let closed = false
    notifications = [{ tag: completion.tag, data: { instanceId: "one", sessionId: "ses" }, close: () => { closed = true } }]
    await dispatch("message", { data: { type: "clear-completion", ...completion } })
    assert.equal(closed, true)

    await dispatch("push", { data: { json: () => completion } })
    assert.equal(shown.length, 2)

    await dispatch("message", { data: { type: "clear-completion", ...completion, completionId: "", acknowledgedAt: 200 } })
    await dispatch("push", { data: { json: () => ({ ...completion, completionId: "one:ses:old", completedAt: 199 }) } })
    assert.equal(shown.length, 2)

    await dispatch("push", { data: { json: () => ({ ...completion, completionId: "one:ses:new", completedAt: 201 }) } })
    assert.equal(shown.length, 3)
  } finally {
    globalThis.self = originalSelf
    globalThis.caches = originalCaches
  }
})
