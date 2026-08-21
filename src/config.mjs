export function loadConfig(env = process.env) {
  return {
    openCodeUrl: (env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/$/, ""),
    openCodeUsername: env.OPENCODE_USERNAME || "opencode",
    openCodePassword: env.OPENCODE_PASSWORD || "",
    openCodeDirectory: env.OPENCODE_DIRECTORY || "",
    host: env.HOST || "127.0.0.1",
    port: Number.parseInt(env.PORT || "8787", 10),
  }
}
