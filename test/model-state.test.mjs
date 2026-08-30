import assert from "node:assert/strict"
import { test } from "bun:test"
import { conversationUsage, isStaleObservation, isSyntheticUserMessage, latestModels, reconcileSelection, supportsImages, visibleMessageParts } from "../public/model-state.js"

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

test("synthetic compaction continuations are hidden and do not switch models", () => {
  const synthetic = {
    info: { id: "msg_2", role: "user", agent: "plan", model: { providerID: "openai", modelID: "new" }, time: { created: 2 } },
    parts: [{
      type: "text",
      text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
      synthetic: true,
      metadata: { compaction_continue: true },
    }],
  }
  const models = latestModels([
    { info: { id: "msg_1", role: "user", agent: "plan", model: { providerID: "openai", modelID: "original" }, time: { created: 1 } }, parts: [{ type: "text", text: "Start" }] },
    synthetic,
  ])

  assert.equal(isSyntheticUserMessage(synthetic), true)
  assert.deepEqual(visibleMessageParts(synthetic), [])
  assert.deepEqual(models.get("plan"), { providerID: "openai", modelID: "original", messageId: "msg_1", created: 1 })
})

test("synthetic parts do not hide user-authored parts in the same message", () => {
  const message = {
    info: { id: "msg_1", role: "user" },
    parts: [{ type: "text", text: "Internal", synthetic: true }, { type: "text", text: "Visible" }],
  }
  assert.equal(isSyntheticUserMessage(message), false)
  assert.deepEqual(visibleMessageParts(message), [{ type: "text", text: "Visible" }])
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

test("conversation usage matches the latest completed OpenCode assistant response", () => {
  const messages = [
    { info: { role: "assistant", providerID: "openai", modelID: "old", tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } },
    { info: { role: "assistant", providerID: "openai", modelID: "gpt", tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 10 } } } },
    { info: { role: "assistant", providerID: "openai", modelID: "gpt", tokens: { input: 999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } },
  ]
  const models = [{ providerID: "openai", modelID: "gpt", contextLimit: 200 }]

  assert.deepEqual(conversationUsage(messages, models, 1.26927), { tokens: 175, percent: 88, cost: 1.26927 })
})

test("conversation usage tolerates missing responses and model limits", () => {
  assert.deepEqual(conversationUsage([], [], 0), { tokens: 0, percent: null, cost: 0 })
  assert.deepEqual(conversationUsage([
    { info: { role: "assistant", providerID: "openai", modelID: "gpt", tokens: { input: 10, output: 2 } } },
  ], [], "invalid"), { tokens: 12, percent: null, cost: 0 })
})
