import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { loadPluginToken } from "../src/plugin-token.mjs"

test("creates and reuses a private plugin token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-pocket-"))
  const pluginTokenFile = join(directory, "state", "plugin-token")
  const config = { pluginToken: "", pluginTokenFile }
  const first = await loadPluginToken(config)
  await chmod(pluginTokenFile, 0o644)
  const second = await loadPluginToken(config)

  assert.equal(first, second)
  assert.equal((await readFile(pluginTokenFile, "utf8")).trim(), first)
  assert.equal((await stat(pluginTokenFile)).mode & 0o777, 0o600)
})
