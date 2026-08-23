export function modelRef(info) {
  const model = info?.model || info
  const providerID = typeof model?.providerID === "string" ? model.providerID : ""
  const modelID = typeof model?.modelID === "string" ? model.modelID : ""
  if (!providerID || !modelID) return null
  const rawVariant = typeof info?.variant === "string" ? info.variant : model.variant
  const variant = typeof rawVariant === "string" && rawVariant !== "default" ? rawVariant : ""
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

export function visibleMessageParts(message) {
  return (Array.isArray(message?.parts) ? message.parts : []).filter((part) => part?.synthetic !== true)
}

export function isSyntheticUserMessage(message) {
  const info = message?.info || message
  const parts = Array.isArray(message?.parts) ? message.parts : []
  return info?.role === "user" && parts.length > 0 && visibleMessageParts(message).length === 0
}

export function latestModels(messages) {
  const result = new Map()
  for (const message of messages || []) {
    const info = message?.info || message
    const agent = info?.agent || info?.mode
    if (info?.role !== "user" || !agent || !info.id || isSyntheticUserMessage(message)) continue
    const model = modelRef(info)
    if (!model) continue
    const created = Number(info.time?.created || 0)
    const previous = result.get(agent)
    if (!previous || created > previous.created || (created === previous.created && info.id > previous.messageId)) {
      result.set(agent, { ...model, messageId: info.id, created })
    }
  }
  return result
}

export function reconcileSelection(selected, observed, previousObserved) {
  if (!observed) return selected
  if (selected?.local && selected.observedMessageId === observed.messageId) return selected
  if (selected?.local && selected.observedMessageId && selected.observedMessageId === previousObserved?.messageId) {
    if (observed.messageId === previousObserved.messageId) return selected
  }
  const { messageId, created, ...model } = observed
  return { ...model, observedMessageId: messageId, observedCreated: created, local: false }
}

export function isStaleObservation(observed, previous) {
  if (!previous) return false
  if (observed.created !== previous.created) return observed.created < previous.created
  return observed.messageId < previous.messageId
}

export function supportsImages(model) {
  return model?.supportsImages !== false
}
