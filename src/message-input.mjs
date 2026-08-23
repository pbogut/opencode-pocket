export const IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"])
export const MAX_IMAGE_COUNT = 4
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024
export const MAX_MESSAGE_BODY_BYTES = 14 * 1024 * 1024
export const MAX_MESSAGE_TEXT_BYTES = 1_000_000

function inputError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode })
}

function validateModel(model) {
  if (model == null) return null
  if (!model || typeof model !== "object" || Array.isArray(model)) throw inputError("Model must be an object")
  const providerID = typeof model.providerID === "string" ? model.providerID.trim() : ""
  const modelID = typeof model.modelID === "string" ? model.modelID.trim() : ""
  const variant = typeof model.variant === "string" ? model.variant.trim() : ""
  if (!providerID || !modelID) throw inputError("Model providerID and modelID are required")
  if (providerID.length > 200 || modelID.length > 500 || variant.length > 200) throw inputError("Model selection is too long")
  if (/\p{Cc}/u.test(providerID + modelID + variant)) throw inputError("Model selection contains invalid characters")
  return { providerID, modelID, ...(variant && variant !== "default" ? { variant } : {}) }
}

function decodedBase64Size(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return value.length / 4 * 3 - padding
}

function validBase64(value) {
  if (!value || value.length % 4 !== 0) return false
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  const body = value.slice(0, value.length - padding)
  if (body.length % 4 !== (padding === 2 ? 2 : padding === 1 ? 3 : 0)) return false
  return !/[^A-Za-z0-9+/]/.test(body)
}

function validateImage(image, index) {
  if (!image || typeof image !== "object" || Array.isArray(image)) throw inputError(`Image ${index + 1} is invalid`)
  const mime = typeof image.mime === "string" ? image.mime : ""
  if (!IMAGE_MIME_TYPES.has(mime)) throw inputError(`Image ${index + 1} has an unsupported type`)

  const filename = typeof image.filename === "string" ? image.filename.trim() : ""
  if (!filename || filename.length > 255 || /[\u0000-\u001f\u007f]/.test(filename)) {
    throw inputError(`Image ${index + 1} has an invalid filename`)
  }

  const url = typeof image.url === "string" ? image.url : ""
  const prefix = `data:${mime};base64,`
  if (!url.startsWith(prefix)) throw inputError(`Image ${index + 1} has an invalid data URL`)
  const base64 = url.slice(prefix.length)
  if (!validBase64(base64)) {
    throw inputError(`Image ${index + 1} has invalid base64 data`)
  }

  const size = decodedBase64Size(base64)
  if (size > MAX_IMAGE_BYTES) throw inputError(`Image ${index + 1} exceeds the 5 MiB limit`, 413)
  return { mime, filename, url, size }
}

export function validateMessageInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw inputError("Message body must be an object")
  if (input.text != null && typeof input.text !== "string") throw inputError("Message text must be a string")
  if (input.agent != null && typeof input.agent !== "string") throw inputError("Agent must be a string")
  if (input.model != null && (!input.model || typeof input.model !== "object" || Array.isArray(input.model))) throw inputError("Model must be an object")
  if (input.images != null && !Array.isArray(input.images)) throw inputError("Images must be an array")

  const text = (input.text || "").trim()
  const agent = (input.agent || "").trim()
  const model = validateModel(input.model)
  if (Buffer.byteLength(text) > MAX_MESSAGE_TEXT_BYTES) throw inputError("Message text exceeds the 1 MB limit", 413)
  if (agent.length > 200) throw inputError("Agent name is too long")
  const sourceImages = input.images || []
  if (sourceImages.length > MAX_IMAGE_COUNT) throw inputError(`A message can include at most ${MAX_IMAGE_COUNT} images`, 413)

  let totalSize = 0
  const images = sourceImages.map((image, index) => {
    const valid = validateImage(image, index)
    totalSize += valid.size
    return { mime: valid.mime, filename: valid.filename, url: valid.url }
  })
  if (totalSize > MAX_IMAGE_TOTAL_BYTES) throw inputError("Images exceed the 10 MiB total limit", 413)
  if (!text && images.length === 0) throw inputError("Message text or an image is required")
  return { text, agent, images, model }
}

export function validateImageModelSupport(input, models) {
  if (!input.model || input.images.length === 0) return
  const selected = models.find((model) => model.providerID === input.model.providerID && model.modelID === input.model.modelID)
  if (selected?.supportsImages === false) throw inputError("This model does not support image attachments.")
}
