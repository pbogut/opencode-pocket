import assert from "node:assert/strict"
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

const binary = resolve(process.argv[2] || "")
if (!process.argv[2]) throw new Error("Usage: bun scripts/test-binary.mjs PATH")

const directory = await mkdtemp(join(tmpdir(), "opencode-pocket-binary-"))
const configHome = join(directory, "config")
const stateHome = join(directory, "state")
const profileDir = join(configHome, "opencode-pocket")
await mkdir(profileDir, { recursive: true })

const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = reservation.port
await reservation.stop(true)
await writeFile(join(directory, ".env"), "PORT=1\n")
await writeFile(join(profileDir, "env"), `HOST=127.0.0.1\nPORT=${port}\nOPENCODE_DISCOVERY=false\nOPENCODE_URL=\n`)

const child = Bun.spawn([binary], {
  cwd: directory,
  env: {
    HOME: join(directory, "home"),
    PATH: "",
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
  },
  stdout: "pipe",
  stderr: "pipe",
})
const stdout = new Response(child.stdout).text()
const stderr = new Response(child.stderr).text()

try {
  const healthUrl = `http://127.0.0.1:${port}/api/health`
  const deadline = Date.now() + 5_000
  let health
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      health = await fetch(healthUrl)
      if (health.ok) break
    } catch {}
    await Bun.sleep(25)
  }
  assert.equal(health?.status, 200, "compiled server did not become healthy")

  const assets = [
    "/", "/index.html", "/styles.css", "/app.js", "/agent-sort.js", "/model-state.js",
    "/notification-state.js", "/permission-state.js", "/quick-message-state.js", "/sw.js",
    "/manifest.webmanifest", "/icon.svg",
  ]
  for (const path of assets) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`)
    assert.equal(response.status, 200, `${path} was not embedded`)
    assert.ok((await response.arrayBuffer()).byteLength > 0, `${path} was empty`)
  }

  const token = join(stateHome, "opencode-pocket", "plugin-token")
  assert.equal((await stat(token)).mode & 0o777, 0o600)

  const events = await fetch(`http://127.0.0.1:${port}/api/events`)
  assert.equal(events.status, 200)
  child.kill("SIGTERM")
  const exitCode = await Promise.race([child.exited, Bun.sleep(3_000).then(() => "timeout")])
  await events.body.cancel()
  assert.equal(exitCode, 0, "compiled server did not stop cleanly")
} finally {
  if (child.exitCode === null) child.kill("SIGKILL")
  await child.exited
}

const output = `${await stdout}${await stderr}`
assert.match(output, new RegExp(`OpenCode Pocket: http://127\\.0\\.0\\.1:${port}`))
console.log(`Verified standalone ${basename(binary)} without Bun or Node on PATH`)
