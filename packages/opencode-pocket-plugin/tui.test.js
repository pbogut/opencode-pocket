import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

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
    tokenFile: "/state/opencode-pocket/plugin-token",
  })
  assert.deepEqual(
    resolveOptions(
      { pocketUrl: "https://pocket.example/base", tokenFile: "~/.pocket-token" },
      { OPENCODE_POCKET_URL: "https://ignored.example" },
      "/home/test",
    ),
    { pocketUrl: "https://pocket.example", tokenFile: "/home/test/.pocket-token" },
  )
  assert.deepEqual(resolveOptions({}, { OPENCODE_POCKET_TOKEN_FILE: "~/.env-token" }, "/home/test"), {
    pocketUrl: "http://127.0.0.1:8787",
    tokenFile: "/home/test/.env-token",
  })
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
