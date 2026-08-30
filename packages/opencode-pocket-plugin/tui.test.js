import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "bun:test"

import plugin, { healthOrigin, resolveOptions, routeState } from "./tui.js"

async function waitFor(predicate, timeout = 1_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for plugin report")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("resolves Pocket URL and the XDG token path", () => {
  assert.deepEqual(resolveOptions({}, { XDG_STATE_HOME: "/state" }, "/home/test"), {
    pocketUrl: "http://127.0.0.1:8787",
    pocketUrls: ["http://127.0.0.1:8787"],
    tokenFile: "/state/opencode-pocket/plugin-token",
  })
  assert.deepEqual(
    resolveOptions(
      { pocketUrl: "https://pocket.example/base", tokenFile: "~/.pocket-token" },
      { OPENCODE_POCKET_URLS: "https://ignored-one.example,https://ignored-two.example", OPENCODE_POCKET_URL: "https://ignored.example" },
      "/home/test",
    ),
    { pocketUrl: "https://pocket.example", pocketUrls: ["https://pocket.example"], tokenFile: "/home/test/.pocket-token" },
  )
  assert.deepEqual(resolveOptions({}, { OPENCODE_POCKET_TOKEN_FILE: "~/.env-token" }, "/home/test"), {
    pocketUrl: "http://127.0.0.1:8787",
    pocketUrls: ["http://127.0.0.1:8787"],
    tokenFile: "/home/test/.env-token",
  })
  assert.deepEqual(resolveOptions({ pocketUrls: ["http://127.0.0.1:8787", "http://127.0.0.1:8788", "http://127.0.0.1:8787/path"] }, {}, "/home/test"), {
    pocketUrl: "http://127.0.0.1:8787",
    pocketUrls: ["http://127.0.0.1:8787", "http://127.0.0.1:8788"],
    tokenFile: "/home/test/.local/state/opencode-pocket/plugin-token",
  })
  assert.deepEqual(resolveOptions({}, { OPENCODE_POCKET_URLS: "http://127.0.0.1:8787, http://127.0.0.1:8788" }, "/home/test")?.pocketUrls, [
    "http://127.0.0.1:8787",
    "http://127.0.0.1:8788",
  ])
  assert.deepEqual(resolveOptions({ pocketUrl: "http://127.0.0.1:8787/path,a" }, {}, "/home/test")?.pocketUrls, ["http://127.0.0.1:8787"])
})

test("extracts route state and includes session IDs only for sessions", () => {
  assert.deepEqual(routeState({ name: "home" }), { route: "home" })
  assert.deepEqual(routeState({ name: "session", params: { sessionID: "ses_123" } }), {
    route: "session",
    sessionId: "ses_123",
  })
  assert.deepEqual(routeState({ name: "plugin.route", params: { sessionID: "ignored" } }), {
    route: "plugin.route",
  })
})

test("derives the OpenCode origin from health response or request URLs", () => {
  assert.equal(healthOrigin({ response: { url: "http://localhost:4096/global/health" } }), "http://localhost:4096")
  assert.equal(healthOrigin({ request: { url: "http://127.0.0.1:4321/global/health" } }), "http://127.0.0.1:4321")
  assert.equal(healthOrigin({ response: { url: "http://opencode.internal/global/health" } }), undefined)
  assert.equal(healthOrigin({ request: { url: "https://localhost:4096/global/health" } }), undefined)
  assert.equal(healthOrigin({ request: { url: "http://192.168.1.10:4096/global/health" } }), undefined)
  assert.equal(healthOrigin({}), undefined)
})

test("warns once instead of reporting an internal OpenCode origin", async () => {
  let dispose
  const warnings = []
  const requests = []
  const originalFetch = globalThis.fetch
  const api = {
    route: { current: { name: "home" } },
    client: {
      global: { health: async () => ({ response: { url: "http://opencode.internal/global/health" } }) },
      tui: { showToast: async (warning) => warnings.push(warning) },
    },
    lifecycle: { onDispose: (callback) => { dispose = callback } },
  }
  globalThis.fetch = async (...args) => {
    requests.push(args)
    return { ok: true }
  }

  try {
    await plugin.tui(api)
    await waitFor(() => warnings.length === 1)
    assert.equal(warnings[0].variant, "warning")
    assert.match(warnings[0].message, /--port 0/)
    assert.equal(requests.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    await dispose?.()
  }
})

test("reports TUI route changes and disconnects on disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-pocket-plugin-"))
  const tokenFile = join(directory, "token")
  await writeFile(tokenFile, "test-token\n")
  const requests = []
  const originalFetch = globalThis.fetch
  let dispose
  const api = {
    route: { current: { name: "home" } },
    client: {
      global: {
        health: async () => ({ response: { url: "http://127.0.0.1:4321/global/health" } }),
      },
    },
    lifecycle: { onDispose: (callback) => { dispose = callback } },
  }
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method, headers: options.headers, body: JSON.parse(options.body) })
    return { ok: true }
  }

  try {
    await plugin.tui(api, { pocketUrl: "http://127.0.0.1:8787", tokenFile })
    await waitFor(() => requests.length === 1)
    api.route.current = { name: "session", params: { sessionID: "ses_123" } }
    await waitFor(() => requests.length === 2)
    await dispose()

    assert.deepEqual(requests.map((request) => request.method), ["POST", "POST", "DELETE"])
    assert.equal(requests[0].url, "http://127.0.0.1:8787/api/plugin/tui-state")
    assert.equal(requests[0].headers.Authorization, "Bearer test-token")
    assert.equal(requests[0].body.serverUrl, "http://127.0.0.1:4321")
    assert.equal(requests[0].body.route, "home")
    assert.equal(requests[1].body.sessionId, "ses_123")
    assert.equal(requests[2].body.instanceNonce, requests[0].body.instanceNonce)
    assert.ok(requests[2].body.sequence > requests[1].body.sequence)
  } finally {
    globalThis.fetch = originalFetch
    if (dispose && requests.at(-1)?.method !== "DELETE") await dispose()
  }
})

test("reports to each Pocket target independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-pocket-plugin-multi-"))
  const tokenFile = join(directory, "token")
  await writeFile(tokenFile, "test-token\n")
  const requests = []
  const originalFetch = globalThis.fetch
  let dispose
  let disposed = false
  const api = {
    route: { current: { name: "home" } },
    client: {
      global: {
        health: async () => ({ response: { url: "http://127.0.0.1:4321/global/health" } }),
      },
    },
    lifecycle: { onDispose: (callback) => { dispose = callback } },
  }
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) })
    return url.startsWith("http://127.0.0.1:8787") ? { ok: false, status: 503 } : { ok: true }
  }

  try {
    await plugin.tui(api, { pocketUrls: ["http://127.0.0.1:8787", "http://127.0.0.1:8788"], tokenFile })
    await waitFor(() => requests.some((request) => request.url.startsWith("http://127.0.0.1:8788") && request.method === "POST"))
    api.route.current = { name: "session", params: { sessionID: "ses_multi" } }
    await waitFor(() => requests.some((request) => request.url.startsWith("http://127.0.0.1:8788") && request.body.sessionId === "ses_multi"))
    await waitFor(() => requests.filter((request) => request.url.startsWith("http://127.0.0.1:8787") && request.method === "POST").length >= 3, 1_500)
    await dispose()
    disposed = true

    const healthy = requests.filter((request) => request.url.startsWith("http://127.0.0.1:8788"))
    assert.deepEqual(healthy.map((request) => request.method), ["POST", "POST", "DELETE"])
    assert.ok(requests.some((request) => request.url.startsWith("http://127.0.0.1:8787")))
    assert.equal(healthy[0].body.serverUrl, "http://127.0.0.1:4321")
    assert.equal(healthy[1].body.sessionId, "ses_multi")
  } finally {
    globalThis.fetch = originalFetch
    if (dispose && !disposed) await dispose()
  }
})

test("waits for in-flight reports before disconnecting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-pocket-plugin-dispose-"))
  const tokenFile = join(directory, "token")
  await writeFile(tokenFile, "test-token\n")
  const events = []
  const originalFetch = globalThis.fetch
  let dispose
  const api = {
    route: { current: { name: "home" } },
    client: {
      global: {
        health: async () => ({ response: { url: "http://127.0.0.1:4321/global/health" } }),
      },
    },
    lifecycle: { onDispose: (callback) => { dispose = callback } },
  }
  globalThis.fetch = async (_url, options) => {
    events.push(`${options.method}-start`)
    if (options.method === "POST") await new Promise((resolve) => setTimeout(resolve, 50))
    events.push(`${options.method}-end`)
    return { ok: true }
  }

  try {
    await plugin.tui(api, { tokenFile })
    await waitFor(() => events.includes("POST-start"))
    await dispose()
    assert.deepEqual(events, ["POST-start", "POST-end", "DELETE-start", "DELETE-end"])
  } finally {
    globalThis.fetch = originalFetch
  }
})
