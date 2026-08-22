import { homedir } from "node:os"
import { join, resolve } from "node:path"

function optionValue(args, name) {
  const equals = args.find((arg) => arg.startsWith(`${name}=`))
  if (equals) {
    const value = equals.slice(name.length + 1)
    if (!value) throw new Error(`${name} requires a value`)
    return value
  }
  const index = args.indexOf(name)
  if (index < 0) return ""
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

export function resolveConfigProfile(args = [], env = process.env, home = homedir()) {
  const cliConfig = optionValue(args, "--config")
  const cliProfile = optionValue(args, "--profile")
  const explicit = cliConfig || (!cliProfile && !args.includes("--dev") ? env.OPENCODE_POCKET_CONFIG : "") || ""
  if (explicit) return { path: resolve(explicit), required: true }

  const profile = cliProfile || (args.includes("--dev") ? "dev" : env.OPENCODE_POCKET_PROFILE || "")
  if (profile && !/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error(`Invalid configuration profile: ${profile}`)
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config")
  return { path: join(configHome, "opencode-pocket", profile ? `env.${profile}` : "env"), required: false }
}
