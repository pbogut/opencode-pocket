import assert from "node:assert/strict"
import test from "node:test"
import { resolveConfigProfile } from "../src/config-profile.mjs"

test("resolves default and named user configuration profiles", () => {
  assert.deepEqual(resolveConfigProfile([], {}, "/home/test"), {
    path: "/home/test/.config/opencode-pocket/env",
    required: false,
  })
  assert.deepEqual(resolveConfigProfile(["--profile", "dev"], { XDG_CONFIG_HOME: "/config" }, "/home/test"), {
    path: "/config/opencode-pocket/env.dev",
    required: false,
  })
  assert.equal(resolveConfigProfile(["--dev"], {}, "/home/test").path, "/home/test/.config/opencode-pocket/env.dev")
})

test("explicit configuration takes precedence and must exist", () => {
  assert.deepEqual(resolveConfigProfile(["--config=./custom.env", "--profile", "dev"], {}, "/home/test"), {
    path: `${process.cwd()}/custom.env`,
    required: true,
  })
  assert.equal(resolveConfigProfile(["--profile", "test"], { OPENCODE_POCKET_CONFIG: "/env/config" }, "/home/test").path, "/home/test/.config/opencode-pocket/env.test")
  assert.equal(resolveConfigProfile(["--dev"], { OPENCODE_POCKET_PROFILE: "production" }, "/home/test").path, "/home/test/.config/opencode-pocket/env.dev")
})

test("rejects unsafe configuration profile names", () => {
  assert.throws(() => resolveConfigProfile(["--profile", "../secret"], {}, "/home/test"), /Invalid configuration profile/)
  assert.throws(() => resolveConfigProfile(["--profile"], {}, "/home/test"), /--profile requires a value/)
  assert.throws(() => resolveConfigProfile(["--config="], {}, "/home/test"), /--config requires a value/)
})
