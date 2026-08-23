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
  const createdSession = { id: "ses_created", title: "New session", directory: projectDir, time: { created: Date.now() } }
  let question = null
  let permission = null

  const fake = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost")
    calls.push({ method: req.method, path: url.pathname, search: url.search, body: req.method === "POST" ? await readJson(req) : undefined })

    if (url.pathname === "/global/health") return sendJson(res, { healthy: true, version: "test" })
    if (url.pathname === "/session" && req.method === "GET") return sendJson(res, [session])
    if (url.pathname === "/session" && req.method === "POST") return sendJson(res, createdSession)
    if (url.pathname === "/session/status") return sendJson(res, { ses_1: { type: "busy" } })
    if (url.pathname === "/question" && req.method === "GET") return sendJson(res, question ? [question] : [])
    if (url.pathname === "/permission" && req.method === "GET") return sendJson(res, permission ? [permission] : [])
    if (url.pathname === "/agent" && req.method === "GET") {
      return sendJson(res, [
        { name: "build", description: "Build mode", mode: "primary", model: { providerID: "openai", modelID: "gpt-5.6-sol" }, permission: [], options: {} },
        { name: "review", description: "Review changes", mode: "all", permission: [], options: {} },
        { name: "explore", mode: "subagent", permission: [], options: {} },
        { name: "summary", mode: "primary", hidden: true, permission: [], options: {} },
      ])
    }
    if (url.pathname === "/provider" && req.method === "GET") {
      return sendJson(res, {
        connected: ["openai"],
        all: [
          {
            id: "openai",
            name: "OpenAI",
            secret: "must-not-leak",
            models: {
              "gpt-5.6-sol": {
                id: "gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                status: "active",
                capabilities: { input: { image: true } },
                variants: { high: {} },
                options: { apiKey: "must-not-leak" },
              },
            },
          },
          { id: "disconnected", models: { hidden: { id: "hidden" } } },
        ],
      })
    }
    if (url.pathname === "/session/ses_1/message" && req.method === "GET") {
      return sendJson(res, [
        { info: { id: "msg_user", role: "user" }, parts: [{ type: "text", text: "Update the app" }] },
        {
          info: { id: "msg_assistant", parentID: "msg_user", role: "assistant", time: { created: 123 } },
          parts: [
            { type: "text", text: "Working" },
            { id: "prt_patch", type: "patch", files: [`${projectDir}/public/app.js`] },
          ],
        },
      ])
    }
    if (url.pathname === "/session/ses_1/diff" && req.method === "GET") {
      return sendJson(res, [{ file: "public/app.js", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }])
    }
    if (url.pathname === "/session/ses_1/prompt_async" && req.method === "POST") {
      res.writeHead(204); return res.end()
    }
    if (url.pathname === "/api/session/ses_1/agent" && req.method === "POST") {
      res.writeHead(204); return res.end()
    }
    if (url.pathname === "/tui/select-session" && req.method === "POST") {
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
  emitSse(sseClients, {
    type: "session.updated",
    properties: { sessionID: session.id, info: { ...session, title: "OpenCode Pocket development" } },
  })
  await waitFor(() => bridge.sessions.get(session.id)?.title === "OpenCode Pocket development")

  const temporary = { ...session, id: "ses_temporary", title: "Temporary", parentID: session.id }
  emitSse(sseClients, { type: "session.created", properties: { sessionID: temporary.id, info: temporary } })
  await waitFor(() => bridge.sessions.has(temporary.id))
  emitSse(sseClients, { type: "session.deleted", properties: { sessionID: temporary.id, info: temporary } })
  await waitFor(() => !bridge.sessions.has(temporary.id))

  const messages = await bridge.listMessages("ses_1")
  assert.equal(messages[1].parts[0].text, "Working")
  assert.deepEqual(await bridge.listChangeTurns("ses_1"), [{
    messageId: "msg_user",
    assistantMessageId: "msg_assistant",
    title: "Update the app",
    time: 123,
    files: ["public/app.js"],
  }])
  assert.deepEqual(await bridge.getMessageDiff("ses_1", "msg_user"), [{
    file: "public/app.js",
    status: "modified",
    additions: 3,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-old\n+new",
  }])
  const diffCall = calls.find((call) => call.path === "/session/ses_1/diff")
  assert.equal(new URLSearchParams(diffCall.search).get("messageID"), "msg_user")
  assert.equal(new URLSearchParams(diffCall.search).get("directory"), projectDir)
  assert.deepEqual(await bridge.listAgents("ses_1"), [
    { name: "build", description: "Build mode", mode: "primary", color: "", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
    { name: "review", description: "Review changes", mode: "all", color: "", model: null },
  ])
  assert.deepEqual(await bridge.listModels("ses_1"), [{
    providerID: "openai",
    providerName: "OpenAI",
    modelID: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    status: "active",
    supportsImages: true,
    variants: ["high"],
  }])
  await bridge.switchAgent("ses_1", "review")
  const agentCall = calls.find((call) => call.path === "/api/session/ses_1/agent")
  assert.deepEqual(agentCall.body, { agent: "review" })
  assert.equal(new URLSearchParams(agentCall.search).get("directory"), projectDir)

  const created = await bridge.createSession(projectDir)
  assert.deepEqual(created, createdSession)
  assert.equal(bridge.sessions.get(createdSession.id), created)
  const createCall = calls.find((call) => call.path === "/session" && call.method === "POST")
  assert.deepEqual(createCall.body, {})
  assert.equal(new URLSearchParams(createCall.search).get("directory"), projectDir)
  await bridge.selectSession(createdSession.id)
  const selectCall = calls.find((call) => call.path === "/tui/select-session")
  assert.deepEqual(selectCall.body, { sessionID: createdSession.id })
  assert.equal(new URLSearchParams(selectCall.search).get("directory"), projectDir)

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

  const image = { type: "file", mime: "image/png", filename: "screen.png", url: "data:image/png;base64,aW1hZ2U=" }
  await bridge.sendMessage("ses_1", "Continue", "review", [image], { providerID: "opencode-go", modelID: "kimi-k3", variant: "max" })
  await bridge.sendMessage("ses_1", "", "", [image])
  const promptCalls = calls.filter((call) => call.path === "/session/ses_1/prompt_async")
  assert.deepEqual(promptCalls[0].body, {
    parts: [
      { type: "text", text: "Continue" },
      { type: "file", mime: "image/png", filename: "screen.png", url: "data:image/png;base64,aW1hZ2U=" },
    ],
    agent: "review",
    model: { providerID: "opencode-go", modelID: "kimi-k3" },
    variant: "max",
  })
  assert.deepEqual(promptCalls[1].body, {
    parts: [{ type: "file", mime: "image/png", filename: "screen.png", url: "data:image/png;base64,aW1hZ2U=" }],
  })
  const promptCall = promptCalls[0]
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
