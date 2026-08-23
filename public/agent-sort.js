const SORT_MODES = new Set(["path", "recent", "status"])
const STATUS_ORDER = new Map([
  ["attention", 0],
  ["busy", 1],
  ["retry", 1],
  ["idle", 2],
  ["offline", 3],
])

export function normalizeAgentSort(value) {
  return SORT_MODES.has(value) ? value : "path"
}

function compareText(left, right) {
  const a = String(left || "")
  const b = String(right || "")
  return a === b ? 0 : a < b ? -1 : 1
}

export function sortAgentItems(items, mode) {
  const selected = normalizeAgentSort(mode)
  return [...items].sort((a, b) => {
    if (selected === "status") {
      const status = (STATUS_ORDER.get(a.status) ?? STATUS_ORDER.get("idle")) - (STATUS_ORDER.get(b.status) ?? STATUS_ORDER.get("idle"))
      if (status) return status
    }
    if (selected === "recent" || selected === "status") {
      const recency = Number(b.updated || 0) - Number(a.updated || 0)
      if (recency) return recency
    }
    return compareText(a.path, b.path) || compareText(a.id, b.id)
  })
}
