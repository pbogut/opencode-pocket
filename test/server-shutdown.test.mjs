import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, test } from "bun:test"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const children = new Set()

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL")
  }
  children.clear()
})

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Pocket exited before startup with code ${child.exitCode}`)
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Pocket did not start in time")
}

for (const shutdownSignal of ["SIGTERM", "SIGINT"]) {
  test(`${shutdownSignal} closes an active SSE connection and exits promptly`, async () => {
    const port = await availablePort()
    const stateHome = await mkdtemp(join(tmpdir(), "opencode-pocket-shutdown-"))
    const url = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, ["src/server.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        XDG_STATE_HOME: stateHome,
        OPENCODE_DISCOVERY: "false",
        OPENCODE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    children.add(child)
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk })
    child.stderr.on("data", (chunk) => { output += chunk })
    await waitForServer(url, child)
    const request = http.get(`${url}/api/events`)
    const [response] = await once(request, "response")
    await once(response, "data")

    const startedAt = Date.now()
    child.kill(shutdownSignal)
    const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000)
    const [code, signal] = await once(child, "exit")
    children.delete(child)
    clearTimeout(timeout)
    request.destroy()

    assert.equal(signal, null, output)
    assert.equal(code, 0, output)
    assert.ok(Date.now() - startedAt < 2_000, `shutdown took ${Date.now() - startedAt}ms`)
  })
}
