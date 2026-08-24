const MAX_QUICK_MESSAGES = 50

export function normalizeQuickMessages(value) {
  if (!Array.isArray(value)) return []
  const messages = []
  const names = new Set()
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 100) : ""
    const message = typeof item.message === "string" ? item.message.trim().slice(0, 10_000) : ""
    const mode = typeof item.mode === "string" ? item.mode.trim().slice(0, 200) : ""
    const normalizedName = name.toLocaleLowerCase()
    if (!name || !message || !mode || names.has(normalizedName)) continue
    names.add(normalizedName)
    messages.push({ name, message, mode })
    if (messages.length === MAX_QUICK_MESSAGES) break
  }
  return messages
}

export function quickMessageModeAvailable(message, agents) {
  return Boolean(message?.mode && agents?.some((agent) => agent?.name === message.mode))
}
