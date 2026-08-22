import test from "node:test"
import assert from "node:assert/strict"
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  MAX_MESSAGE_TEXT_BYTES,
  validateMessageInput,
} from "../src/message-input.mjs"

function image(mime = "image/png", bytes = Buffer.from("image")) {
  return {
    mime,
    filename: "sample.png",
    url: `data:${mime};base64,${bytes.toString("base64")}`,
  }
}

test("message input accepts text, images, or both", () => {
  assert.deepEqual(validateMessageInput({ text: " Continue ", agent: " build " }), {
    text: "Continue",
    agent: "build",
    images: [],
  })

  const attachment = image()
  assert.deepEqual(validateMessageInput({ images: [attachment] }), {
    text: "",
    agent: "",
    images: [attachment],
  })
  assert.deepEqual(validateMessageInput({ text: "Inspect this", images: [attachment] }).images, [attachment])
})

test("message input rejects empty and malformed payloads", () => {
  assert.throws(() => validateMessageInput({}), /text or an image is required/)
  assert.throws(() => validateMessageInput({ text: {} }), /text must be a string/)
  assert.throws(() => validateMessageInput({ text: "hello", images: {} }), /Images must be an array/)
  assert.throws(() => validateMessageInput({ images: [image("image/svg+xml")] }), /unsupported type/)
  assert.throws(() => validateMessageInput({ images: [{ ...image(), url: "data:image/jpeg;base64,aW1hZ2U=" }] }), /invalid data URL/)
  assert.throws(() => validateMessageInput({ images: [{ ...image(), url: "data:image/png;base64,not base64" }] }), /invalid base64/)
  assert.throws(() => validateMessageInput({ images: [{ ...image(), filename: "bad\nname.png" }] }), /invalid filename/)
  assert.throws(
    () => validateMessageInput({ text: "x".repeat(MAX_MESSAGE_TEXT_BYTES + 1) }),
    (error) => error.statusCode === 413 && /1 MB/.test(error.message),
  )
})

test("message input enforces image count and size limits", () => {
  assert.throws(
    () => validateMessageInput({ images: Array.from({ length: MAX_IMAGE_COUNT + 1 }, () => image()) }),
    (error) => error.statusCode === 413 && /at most/.test(error.message),
  )

  const oversized = image("image/png", Buffer.alloc(MAX_IMAGE_BYTES + 1))
  assert.throws(
    () => validateMessageInput({ images: [oversized] }),
    (error) => error.statusCode === 413 && /5 MiB/.test(error.message),
  )

  const fourMiB = image("image/png", Buffer.alloc(4 * 1024 * 1024))
  assert.throws(
    () => validateMessageInput({ images: [fourMiB, fourMiB, fourMiB] }),
    (error) => error.statusCode === 413 && /10 MiB/.test(error.message),
  )
})
