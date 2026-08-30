const patterns = process.argv.slice(2)
if (patterns.length === 0) throw new Error("At least one JavaScript glob is required")

const files = new Set()
for (const pattern of patterns) {
  for await (const file of new Bun.Glob(pattern).scan({ cwd: process.cwd(), onlyFiles: true })) files.add(file)
}
if (files.size === 0) throw new Error(`No JavaScript files matched: ${patterns.join(", ")}`)

const transpiler = new Bun.Transpiler({ loader: "js" })
let failed = false
for (const file of [...files].sort()) {
  try {
    transpiler.scan(await Bun.file(file).text())
  } catch (error) {
    failed = true
    console.error(`${file}: ${error.message}`)
  }
}

if (failed) process.exit(1)
console.log(`Checked ${files.size} JavaScript files`)
