import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

const output = resolve("dist/opencode-pocket")
await mkdir(resolve("dist"), { recursive: true })

const result = await Bun.build({
  entrypoints: [resolve("bin/opencode-pocket.mjs")],
  compile: {
    outfile: output,
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  minify: true,
  sourcemap: "linked",
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log(`Built ${output}`)
