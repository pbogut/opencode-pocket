import assert from "node:assert/strict"
import test from "node:test"
import { isStaleObservation, latestModels, reconcileSelection, supportsImages } from "../public/model-state.js"

test("latest models are tracked independently per mode", () => {
  const models = latestModels([
    { info: { id: "msg_1", role: "user", agent: "build", model: { providerID: "openai", modelID: "gpt" }, variant: "high", time: { created: 1 } } },
    { info: { id: "msg_2", role: "user", agent: "plan", model: { providerID: "moonshot", modelID: "kimi" }, time: { created: 2 } } },
    { info: { id: "msg_3", role: "user", agent: "build", model: { providerID: "openai", modelID: "sol" }, time: { created: 3 } } },
  ])
  assert.deepEqual(models.get("build"), { providerID: "openai", modelID: "sol", messageId: "msg_3", created: 3 })
  assert.deepEqual(models.get("plan"), { providerID: "moonshot", modelID: "kimi", messageId: "msg_2", created: 2 })
})

test("message variants are preserved from the OpenCode user message shape", () => {
  const models = latestModels([
    { info: { id: "msg_1", role: "user", agent: "build", model: { providerID: "openai", modelID: "gpt" }, variant: "high", time: { created: 1 } } },
  ])
  assert.deepEqual(models.get("build"), { providerID: "openai", modelID: "gpt", variant: "high", messageId: "msg_1", created: 1 })
})

test("legacy mode and top-level model fields are supported", () => {
  const models = latestModels([
    { info: { id: "msg_1", role: "user", mode: "plan", providerID: "openai", modelID: "gpt", time: { created: 1 } } },
  ])
  assert.deepEqual(models.get("plan"), { providerID: "openai", modelID: "gpt", messageId: "msg_1", created: 1 })
})

test("an unsent local selection survives old history but yields to a new message", () => {
  const local = { providerID: "openai", modelID: "sol", observedMessageId: "msg_1", local: true }
  const old = { providerID: "moonshot", modelID: "kimi", messageId: "msg_1", created: 1 }
  assert.equal(reconcileSelection(local, old, old), local)

  const next = reconcileSelection(local, { providerID: "moonshot", modelID: "kimi", messageId: "msg_2", created: 2 }, old)
  assert.deepEqual(next, {
    providerID: "moonshot",
    modelID: "kimi",
    observedMessageId: "msg_2",
    observedCreated: 2,
    local: false,
  })
})

test("delayed model observations cannot replace newer messages", () => {
  const current = { messageId: "msg_2", created: 2 }
  assert.equal(isStaleObservation({ messageId: "msg_1", created: 1 }, current), true)
  assert.equal(isStaleObservation({ messageId: "msg_3", created: 3 }, current), false)
  assert.equal(isStaleObservation(current, current), false)
})

test("image support only rejects explicit unsupported models", () => {
  assert.equal(supportsImages({ supportsImages: true }), true)
  assert.equal(supportsImages({ supportsImages: false }), false)
  assert.equal(supportsImages(null), true)
})
