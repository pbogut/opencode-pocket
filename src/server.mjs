import { timingSafeEqual } from "node:crypto"
import http from "node:http"
import { createReadStream, watch } from "node:fs"
import { stat } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "./config.mjs"
import { InstanceManager } from "./instances.mjs"
import { loadPluginToken } from "./plugin-token.mjs"
import { Notifications } from "./notifications.mjs"

const config = loadConfig()
const pluginToken = await loadPluginToken(config)
const manager = new InstanceManager(config)
const notifications = new Notifications(config)
await notifications.start()
const publicDir = fileURLToPath(new URL("../public/", import.meta.url))
const sseClients = new Set()
const devMode = process.argv.includes("--dev")
const devServerId = `${process.pid}-${Date.now()}`
let publicWatcher = null
let reloadTimer = null

function json(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  })
  res.end(body)
}

async function bodyJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw new Error("Request body too large")
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function broadcast(type, payload) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const client of sseClients) client.write(frame)
}

function authorizedPlugin(req) {
  const value = req.headers.authorization || ""
  const token = value.startsWith("Bearer ") ? value.slice(7) : ""
  const expected = Buffer.from(pluginToken)
  const actual = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

if (devMode) {
  publicWatcher = watch(publicDir, { recursive: true }, () => {
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => broadcast("dev-reload", { at: Date.now() }), 100)
  })
  publicWatcher.on("error", (error) => console.error("Live reload watcher failed", error))
}

manager.on("state", (state) => broadcast("state", state))
manager.on("event", (event) => {
  broadcast("agent-event", event)
  notifications.handleEvent(event, manager.snapshot()).catch((error) => console.error("Notification handling failed", error))
})
manager.on("tui", (event) => broadcast("tui-state", event))
manager.on("error", (error) => console.error("OpenCode discovery failed", error))

function mime(path) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  }[extname(path)] || "application/octet-stream"
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1)
  const safe = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "")
  let file = join(publicDir, safe)
  try {
    const info = await stat(file)
    if (info.isDirectory()) file = join(file, "index.html")
    res.writeHead(200, {
      "Content-Type": mime(file),
      "Cache-Control": devMode ? "no-store" : file.endsWith("index.html") ? "no-cache" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    })
    createReadStream(file).pipe(res)
    return true
  } catch {
    return false
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  const path = url.pathname

  try {
    if (req.method === "GET" && path === "/api/health") {
      return json(res, 200, { hub: { ok: true }, opencode: await manager.health(), state: manager.snapshot() })
    }
    if (req.method === "GET" && path === "/api/state") {
      return json(res, 200, manager.snapshot())
    }
    if (req.method === "POST" && path === "/api/refresh") {
      await manager.refresh()
      return json(res, 200, manager.snapshot())
    }
    if (req.method === "GET" && path === "/api/notifications") {
      return json(res, 200, notifications.publicConfig())
    }
    if (req.method === "PUT" && path === "/api/notifications/subscription") {
      const input = await bodyJson(req)
      const subscription = await notifications.upsert(input.subscription, input.preferences)
      return json(res, 200, { preferences: subscription.preferences })
    }
    if (req.method === "DELETE" && path === "/api/notifications/subscription") {
      const input = await bodyJson(req)
      await notifications.remove(input.endpoint)
      return json(res, 200, { ok: true })
    }
    if (req.method === "PUT" && path === "/api/notifications/ntfy") {
      const input = await bodyJson(req)
      return json(res, 200, await notifications.updateNtfy(input))
    }
    if ((req.method === "POST" || req.method === "DELETE") && path === "/api/plugin/tui-state") {
      if (!authorizedPlugin(req)) return json(res, 401, { error: "Unauthorized" })
      const input = await bodyJson(req)
      if (req.method === "DELETE") manager.removeTuiState(input)
      else await manager.updateTuiState(input)
      return json(res, 200, { ok: true })
    }
    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      })
      res.write(`event: state\ndata: ${JSON.stringify(manager.snapshot())}\n\n`)
      if (devMode) res.write(`event: dev-server\ndata: ${JSON.stringify({ id: devServerId })}\n\n`)
      const timer = setInterval(() => res.write(": heartbeat\n\n"), 15_000)
      sseClients.add(res)
      req.on("close", () => {
        clearInterval(timer)
        sseClients.delete(res)
      })
      return
    }

    let match = path.match(/^\/api\/instances\/([^/]+)\/sessions$/)
    if (match && req.method === "POST") {
      const input = await bodyJson(req)
      const bridge = manager.bridge(decodeURIComponent(match[1]))
      const directory = typeof input.directory === "string" ? input.directory.trim() : ""
      const session = await bridge.createSession(directory)
      await bridge.selectSession(session.id)
      return json(res, 201, session)
    }

    match = path.match(/^\/api\/instances\/([^/]+)\/sessions\/([^/]+)\/messages$/)
    if (match && req.method === "GET") {
      const bridge = manager.bridge(decodeURIComponent(match[1]))
      const sid = decodeURIComponent(match[2])
      return json(res, 200, await bridge.listMessages(sid, Number(url.searchParams.get("limit") || 100)))
    }
    if (match && req.method === "POST") {
      const bridge = manager.bridge(decodeURIComponent(match[1]))
      const sid = decodeURIComponent(match[2])
      const input = await bodyJson(req)
      const text = String(input.text || "").trim()
      if (!text) return json(res, 400, { error: "Message text is required" })
      const agent = String(input.agent || "").trim()
      await bridge.sendMessage(sid, text, agent)
      return json(res, 202, { ok: true })
    }

    match = path.match(/^\/api\/instances\/([^/]+)\/sessions\/([^/]+)\/changes$/)
    if (match && req.method === "GET") {
      return json(res, 200, await manager.bridge(decodeURIComponent(match[1])).listChangeTurns(decodeURIComponent(match[2])))
    }

    match = path.match(/^\/api\/instances\/([^/]+)\/sessions\/([^/]+)\/diff$/)
    if (match && req.method === "GET") {
      const messageId = String(url.searchParams.get("messageId") || "").trim()
      if (!messageId) return json(res, 400, { error: "messageId is required" })
      return json(res, 200, await manager.bridge(decodeURIComponent(match[1])).getMessageDiff(decodeURIComponent(match[2]), messageId))
    }

    match = path.match(/^\/api\/instances\/([^/]+)\/sessions\/([^/]+)\/agents$/)
    if (match && req.method === "GET") {
      return json(res, 200, await manager.bridge(decodeURIComponent(match[1])).listAgents(decodeURIComponent(match[2])))
    }

    match = path.match(/^\/api\/instances\/([^/]+)\/sessions\/([^/]+)\/agent$/)
    if (match && req.method === "POST") {
      const input = await bodyJson(req)
      const agent = String(input.agent || "").trim()
      if (!agent) return json(res, 400, { error: "Agent is required" })
      await manager.bridge(decodeURIComponent(match[1])).switchAgent(decodeURIComponent(match[2]), agent)
      return json(res, 200, { ok: true })
    }

    match = path.match(/^\/api\/instances\/([^/]+)\/sessions\/([^/]+)\/abort$/)
    if (match && req.method === "POST") {
      await manager.bridge(decodeURIComponent(match[1])).abortSession(decodeURIComponent(match[2]))
      return json(res, 200, { ok: true })
    }

    match = path.match(/^\/api\/instances\/([^/]+)\/sessions\/([^/]+)\/select$/)
    if (match && req.method === "POST") {
      await manager.bridge(decodeURIComponent(match[1])).selectSession(decodeURIComponent(match[2]))
      return json(res, 200, { ok: true })
    }

    match = path.match(/^\/api\/instances\/([^/]+)\/questions\/([^/]+)\/reply$/)
    if (match && req.method === "POST") {
      const input = await bodyJson(req)
      if (!Array.isArray(input.answers)) return json(res, 400, { error: "answers must be an array" })
      await manager.bridge(decodeURIComponent(match[1])).replyQuestion(decodeURIComponent(match[2]), input.answers)
      return json(res, 200, { ok: true })
    }

    match = path.match(/^\/api\/instances\/([^/]+)\/questions\/([^/]+)\/reject$/)
    if (match && req.method === "POST") {
      await manager.bridge(decodeURIComponent(match[1])).rejectQuestion(decodeURIComponent(match[2]))
      return json(res, 200, { ok: true })
    }

    match = path.match(/^\/api\/instances\/([^/]+)\/permissions\/([^/]+)\/([^/]+)\/reply$/)
    if (match && req.method === "POST") {
      const input = await bodyJson(req)
      await manager.bridge(decodeURIComponent(match[1])).replyPermission(decodeURIComponent(match[2]), decodeURIComponent(match[3]), input.response)
      return json(res, 200, { ok: true })
    }

    if (path.startsWith("/api/")) return json(res, 404, { error: "Not found" })
    if (await serveStatic(req, res, path)) return
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("Not found")
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500
    if (status >= 500) console.error(error)
    json(res, status, { error: String(error.message || error) })
  }
})

await manager.start()
server.listen(config.port, config.host, () => {
  console.log(`OpenCode Pocket: http://${config.host}:${config.port}`)
  if (config.openCodeUrl) console.log(`OpenCode server: ${config.openCodeUrl}`)
  if (config.discovery) console.log("OpenCode discovery: mDNS enabled")
  console.log(`OpenCode plugin token: ${config.pluginToken ? "environment" : config.pluginTokenFile}`)
  if (devMode) console.log("Live reload: enabled")
  if (!config.openCodePassword) console.log("OpenCode auth: none configured in Pocket")
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    manager.stop()
    clearTimeout(reloadTimer)
    publicWatcher?.close()
    server.close(() => process.exit(0))
  })
}
