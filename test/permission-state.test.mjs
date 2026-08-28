import assert from "node:assert/strict"
import test from "node:test"
import { permissionPresentation } from "../public/permission-state.js"

test("explains current external directory permission requests", () => {
  assert.deepEqual(permissionPresentation({
    permission: "external_directory",
    patterns: ["/home/user/private/*"],
    always: ["/home/user/private/*"],
    metadata: { filepath: "/home/user/private/notes.txt", parentDir: "/home/user/private" },
  }), {
    title: "Access outside the project",
    description: "OpenCode wants to access this path outside the current project.",
    targetLabel: "Requested path",
    targets: ["/home/user/private/notes.txt"],
    always: ["/home/user/private/*"],
  })
})

test("explains legacy permission requests", () => {
  assert.deepEqual(permissionPresentation({ title: "bash", pattern: "npm test" }), {
    title: "Run a command",
    description: "OpenCode wants to run this command.",
    targetLabel: "Requested access",
    targets: ["npm test"],
    always: [],
  })
})

test("falls back to readable copy for unknown permissions", () => {
  assert.deepEqual(permissionPresentation({ permission: "custom_tool", patterns: ["input"] }), {
    title: "Custom Tool",
    description: "OpenCode needs your approval for this action.",
    targetLabel: "Requested access",
    targets: ["input"],
    always: [],
  })
})
