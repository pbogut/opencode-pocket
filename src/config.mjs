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
    pushPublicKey: env.OPENCODE_POCKET_VAPID_PUBLIC_KEY || "",
    pushPrivateKey: env.OPENCODE_POCKET_VAPID_PRIVATE_KEY || "",
    pushSubject: env.OPENCODE_POCKET_VAPID_SUBJECT || "mailto:opencode-pocket@localhost",
    pushVapidFile: env.OPENCODE_POCKET_VAPID_FILE || join(stateHome, "opencode-pocket", "push-vapid.json"),
    pushSubscriptionsFile: env.OPENCODE_POCKET_PUSH_SUBSCRIPTIONS_FILE || join(stateHome, "opencode-pocket", "push-subscriptions.json"),
    notificationSettingsFile: env.OPENCODE_POCKET_NOTIFICATION_SETTINGS_FILE || join(stateHome, "opencode-pocket", "notification-settings.json"),
    ntfyTopic: env.OPENCODE_POCKET_NTFY_TOPIC || "",
    ntfyUrl: (env.OPENCODE_POCKET_NTFY_URL || "https://ntfy.sh").replace(/\/$/, ""),
    ntfyToken: env.OPENCODE_POCKET_NTFY_TOKEN || "",
    publicUrl: (env.OPENCODE_POCKET_PUBLIC_URL || "").replace(/\/$/, ""),
    host: env.HOST || "127.0.0.1",
    port: Number.parseInt(env.PORT || "8787", 10),
  }
}
