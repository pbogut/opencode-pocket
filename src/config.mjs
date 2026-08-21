import { homedir } from "node:os"
import { join } from "node:path"

export function loadConfig(env = process.env) {
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return {
    openCodeUrl: (env.OPENCODE_URL || "").replace(/\/$/, ""),
    openCodeUsername: env.OPENCODE_USERNAME || "opencode",
    openCodePassword: env.OPENCODE_PASSWORD || "",
    openCodeDirectory: env.OPENCODE_DIRECTORY || "",
    discovery: !["0", "false", "off"].includes((env.OPENCODE_DISCOVERY || "true").toLowerCase()),
    pluginToken: env.OPENCODE_POCKET_TOKEN || "",
    pluginTokenFile: env.OPENCODE_POCKET_TOKEN_FILE || join(stateHome, "opencode-pocket", "plugin-token"),
    host: env.HOST || "127.0.0.1",
    port: Number.parseInt(env.PORT || "8787", 10),
  }
}
