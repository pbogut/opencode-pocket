const PERMISSION_COPY = {
  bash: ["Run a command", "OpenCode wants to run this command."],
  doom_loop: ["Repeat a tool call", "OpenCode wants to repeat a tool call with the same input."],
  edit: ["Modify files", "OpenCode wants to modify the listed files."],
  external_directory: ["Access outside the project", "OpenCode wants to access this path outside the current project."],
  glob: ["Search for files", "OpenCode wants to search for files matching this pattern."],
  grep: ["Search file contents", "OpenCode wants to search file contents using this pattern."],
  read: ["Read a file or directory", "OpenCode wants to read the listed path."],
  skill: ["Load a skill", "OpenCode wants to load this skill."],
  task: ["Start a subagent", "OpenCode wants to start this type of subagent."],
  webfetch: ["Fetch a URL", "OpenCode wants to fetch content from this URL."],
  websearch: ["Search the web", "OpenCode wants to search the web for this query."],
}

function stringList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item)
  return typeof value === "string" && value ? [value] : []
}

function readableName(value) {
  if (!value) return "Permission request"
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase())
}

export function permissionPresentation(request) {
  const permission = request?.permission || request?.type || request?.title || ""
  const copy = PERMISSION_COPY[permission]
  const requested = stringList(request?.patterns ?? request?.pattern)
  const always = stringList(request?.always)
  const filepath = typeof request?.metadata?.filepath === "string" ? request.metadata.filepath : ""

  return {
    title: copy?.[0] || readableName(permission),
    description: copy?.[1] || "OpenCode needs your approval for this action.",
    targetLabel: filepath ? "Requested path" : requested.length ? "Requested access" : "",
    targets: filepath ? [filepath] : requested,
    always,
  }
}
