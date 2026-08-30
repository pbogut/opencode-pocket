#!/usr/bin/env bun

import { existsSync } from "node:fs"
import { loadConfigProfile, resolveConfigProfile } from "../src/config-profile.mjs"

const args = process.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: opencode-pocket [--profile NAME] [--config PATH] [--dev]

Configuration defaults to ~/.config/opencode-pocket/env. A profile selects
env.NAME from the same directory. OPENCODE_POCKET_CONFIG and
OPENCODE_POCKET_PROFILE provide equivalent environment overrides.`)
  process.exit(0)
}

const config = resolveConfigProfile(args)
if (existsSync(config.path)) {
  await loadConfigProfile(config.path)
}
else if (config.required) throw new Error(`Configuration file not found: ${config.path}`)

await import("../src/server.mjs")
