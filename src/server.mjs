import http from "node:http"
import { createReadStream, watch } from "node:fs"
import { stat } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "./config.mjs"
import { OpenCodeBridge } from "./opencode.mjs"

const config = loadConfig()
const bridge = new OpenCodeBridge(config)
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

if (devMode) {
  publicWatcher = watch(publicDir, { recursive: true }, () => {
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => broadcast("dev-reload", { at: Date.now() }), 100)
  })
  publicWatcher.on("error", (error) => console.error("Live reload watcher failed", error))
}

bridge.on("state", (state) => broadcast("state", state))
bridge.on("event", (event) => broadcast("agent-event", event))

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
      return json(res, 200, { hub: { ok: true }, opencode: await bridge.health(), state: bridge.snapshot() })
    }
    if (req.method === "GET" && path === "/api/state") {
      return json(res, 200, bridge.snapshot())
    }
    if (req.method === "POST" && path === "/api/refresh") {
      await bridge.refresh()
      return json(res, 200, bridge.snapshot())
    }
    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      })
      res.write(`event: state\ndata: ${JSON.stringify(bridge.snapshot())}\n\n`)
      if (devMode) res.write(`event: dev-server\ndata: ${JSON.stringify({ id: devServerId })}\n\n`)
      const timer = setInterval(() => res.write(": heartbeat\n\n"), 15_000)
      sseClients.add(res)
      req.on("close", () => {
        clearInterval(timer)
        sseClients.delete(res)
      })
      return
    }

    let match = path.match(/^\/api\/sessions\/([^/]+)\/messages$/)
    if (match && req.method === "GET") {
      const sid = decodeURIComponent(match[1])
      return json(res, 200, await bridge.listMessages(sid, Number(url.searchParams.get("limit") || 100)))
    }
    if (match && req.method === "POST") {
      const sid = decodeURIComponent(match[1])
      const input = await bodyJson(req)
      const text = String(input.text || "").trim()
      if (!text) return json(res, 400, { error: "Message text is required" })
      const agent = String(input.agent || "").trim()
      await bridge.sendMessage(sid, text, agent)
      return json(res, 202, { ok: true })
    }

    match = path.match(/^\/api\/sessions\/([^/]+)\/agents$/)
    if (match && req.method === "GET") {
      return json(res, 200, await bridge.listAgents(decodeURIComponent(match[1])))
    }

    match = path.match(/^\/api\/sessions\/([^/]+)\/agent$/)
    if (match && req.method === "POST") {
      const input = await bodyJson(req)
      const agent = String(input.agent || "").trim()
      if (!agent) return json(res, 400, { error: "Agent is required" })
      await bridge.switchAgent(decodeURIComponent(match[1]), agent)
      return json(res, 200, { ok: true })
    }

    match = path.match(/^\/api\/sessions\/([^/]+)\/abort$/)
    if (match && req.method === "POST") {
      await bridge.abortSession(decodeURIComponent(match[1]))
      return json(res, 200, { ok: true })
    }

    match = path.match(/^\/api\/questions\/([^/]+)\/reply$/)
    if (match && req.method === "POST") {
      const input = await bodyJson(req)
      if (!Array.isArray(input.answers)) return json(res, 400, { error: "answers must be an array" })
      await bridge.replyQuestion(decodeURIComponent(match[1]), input.answers)
      return json(res, 200, { ok: true })
    }

    match = path.match(/^\/api\/questions\/([^/]+)\/reject$/)
    if (match && req.method === "POST") {
      await bridge.rejectQuestion(decodeURIComponent(match[1]))
      return json(res, 200, { ok: true })
    }

    match = path.match(/^\/api\/permissions\/([^/]+)\/([^/]+)\/reply$/)
    if (match && req.method === "POST") {
      const input = await bodyJson(req)
      await bridge.replyPermission(decodeURIComponent(match[1]), decodeURIComponent(match[2]), input.response)
      return json(res, 200, { ok: true })
    }

    if (path.startsWith("/api/")) return json(res, 404, { error: "Not found" })
    if (await serveStatic(req, res, path)) return
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("Not found")
  } catch (error) {
    console.error(error)
    json(res, 500, { error: String(error.message || error) })
  }
})

await bridge.start()
server.listen(config.port, config.host, () => {
  console.log(`OpenCode Pocket: http://${config.host}:${config.port}`)
  console.log(`OpenCode server: ${config.openCodeUrl}`)
  if (devMode) console.log("Live reload: enabled")
  if (!config.openCodePassword) console.log("OpenCode auth: none configured in Pocket")
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    bridge.stop()
    clearTimeout(reloadTimer)
    publicWatcher?.close()
    server.close(() => process.exit(0))
  })
}
