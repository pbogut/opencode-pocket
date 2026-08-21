export function loadConfig(env = process.env) {
  return {
    openCodeUrl: (env.OPENCODE_URL || "").replace(/\/$/, ""),
    openCodeUsername: env.OPENCODE_USERNAME || "opencode",
    openCodePassword: env.OPENCODE_PASSWORD || "",
    openCodeDirectory: env.OPENCODE_DIRECTORY || "",
    discovery: !["0", "false", "off"].includes((env.OPENCODE_DISCOVERY || "true").toLowerCase()),
    host: env.HOST || "127.0.0.1",
    port: Number.parseInt(env.PORT || "8787", 10),
  }
}
