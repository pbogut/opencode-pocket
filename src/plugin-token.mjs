import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export async function loadPluginToken(config) {
  if (config.pluginToken) return config.pluginToken
  try {
    const token = (await readFile(config.pluginTokenFile, "utf8")).trim()
    if (token) {
      await chmod(config.pluginTokenFile, 0o600)
      return token
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }

  await mkdir(dirname(config.pluginTokenFile), { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString("base64url")
  try {
    await writeFile(config.pluginTokenFile, `${token}\n`, { flag: "wx", mode: 0o600 })
    return token
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    const existing = (await readFile(config.pluginTokenFile, "utf8")).trim()
    await chmod(config.pluginTokenFile, 0o600)
    if (!existing) throw new Error(`Plugin token file is empty: ${config.pluginTokenFile}`)
    return existing
  }
}
