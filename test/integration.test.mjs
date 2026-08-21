import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { once } from "node:events"
import { OpenCodeBridge } from "../src/opencode.mjs"

const waitFor = async (fn, timeout = 2500) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("Timed out waiting for condition")
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

test("bridge performs the terminal-free OpenCode control loop", async (t) => {
  const calls = []
  const sseClients = new Set()
  const projectDir = "/work/demo"
  const session = { id: "ses_1", title: "Demo agent", directory: projectDir, time: { updated: Date.now() } }
  let question = null
  let permission = null

  const fake = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost")
    calls.push({ method: req.method, path: url.pathname, search: url.search, body: req.method === "POST" ? await readJson(req) : undefined })

    if (url.pathname === "/global/health") return sendJson(res, { healthy: true, version: "test" })
    if (url.pathname === "/session" && req.method === "GET") return sendJson(res, [session])
    if (url.pathname === "/session/status") return sendJson(res, { ses_1: { type: "busy" } })
    if (url.pathname === "/question" && req.method === "GET") return sendJson(res, question ? [question] : [])
    if (url.pathname === "/permission" && req.method === "GET") return sendJson(res, permission ? [permission] : [])
    if (url.pathname === "/agent" && req.method === "GET") {
      return sendJson(res, [
        { name: "build", description: "Build mode", mode: "primary", permission: [], options: {} },
        { name: "review", description: "Review changes", mode: "all", permission: [], options: {} },
        { name: "explore", mode: "subagent", permission: [], options: {} },
        { name: "summary", mode: "primary", hidden: true, permission: [], options: {} },
      ])
    }
    if (url.pathname === "/session/ses_1/message" && req.method === "GET") {
      return sendJson(res, [{ info: { role: "assistant" }, parts: [{ type: "text", text: "Working" }] }])
    }
    if (url.pathname === "/session/ses_1/prompt_async" && req.method === "POST") {
      res.writeHead(204); return res.end()
    }
    if (url.pathname === "/api/session/ses_1/agent" && req.method === "POST") {
      res.writeHead(204); return res.end()
    }
    if (url.pathname === "/question/que_1/reply" && req.method === "POST") {
      question = null
      return sendJson(res, true)
    }
    if (url.pathname === "/session/ses_1/permissions/per_1" && req.method === "POST") {
      permission = null
      return sendJson(res, true)
    }
    if (url.pathname === "/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive", "Cache-Control": "no-cache" })
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`)
      sseClients.add(res)
      req.on("close", () => sseClients.delete(res))
      return
    }
    sendJson(res, { error: "not found" }, 404)
  })

  fake.listen(0, "127.0.0.1")
  await once(fake, "listening")
  t.after(() => fake.close())
  const address = fake.address()

  const bridge = new OpenCodeBridge({
    openCodeUrl: `http://127.0.0.1:${address.port}`,
    openCodeUsername: "opencode",
    openCodePassword: "",
    openCodeDirectory: projectDir,
  })
  t.after(() => bridge.stop())
  await bridge.start()
  await waitFor(() => bridge.connected)

  assert.equal(bridge.snapshot().sessions[0].status.type, "busy")
  const messages = await bridge.listMessages("ses_1")
  assert.equal(messages[0].parts[0].text, "Working")
  assert.deepEqual(await bridge.listAgents("ses_1"), [
    { name: "build", description: "Build mode", mode: "primary", color: "" },
    { name: "review", description: "Review changes", mode: "all", color: "" },
  ])
  await bridge.switchAgent("ses_1", "review")
  const agentCall = calls.find((call) => call.path === "/api/session/ses_1/agent")
  assert.deepEqual(agentCall.body, { agent: "review" })
  assert.equal(new URLSearchParams(agentCall.search).get("directory"), projectDir)

  question = {
    id: "que_1",
    sessionID: "ses_1",
    questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }], multiple: false }],
  }
  emitSse(sseClients, { type: "question.asked", properties: question })
  await waitFor(() => bridge.questions.has("que_1"))
  await bridge.replyQuestion("que_1", [["A"]])

  const questionCall = calls.find((call) => call.path === "/question/que_1/reply")
  assert.equal(questionCall.body.answers[0][0], "A")
  assert.equal(new URLSearchParams(questionCall.search).get("directory"), projectDir)

  permission = { id: "per_1", sessionID: "ses_1", title: "bash", pattern: "npm test" }
  emitSse(sseClients, { type: "permission.asked", properties: permission })
  await waitFor(() => bridge.permissions.has("per_1"))
  await bridge.replyPermission("ses_1", "per_1", "once")

  const permissionCall = calls.find((call) => call.path === "/session/ses_1/permissions/per_1")
  assert.equal(permissionCall.body.response, "once")
  assert.equal(new URLSearchParams(permissionCall.search).get("directory"), projectDir)

  await bridge.sendMessage("ses_1", "Continue", "review")
  const promptCall = calls.find((call) => call.path === "/session/ses_1/prompt_async")
  assert.deepEqual(promptCall.body, { parts: [{ type: "text", text: "Continue" }], agent: "review" })
  assert.equal(new URLSearchParams(promptCall.search).get("directory"), projectDir)
})

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) })
  res.end(body)
}

function emitSse(clients, value) {
  const frame = `data: ${JSON.stringify(value)}\n\n`
  for (const res of clients) res.write(frame)
}
