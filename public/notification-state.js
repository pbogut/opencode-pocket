export function completionTag(instanceId, sessionId) {
  return `completed:${instanceId}:${sessionId}`
}

export function completionId(instanceId, sessionId, completedAt) {
  return completedAt ? `${instanceId}:${sessionId}:${completedAt}` : ""
}

export function isVisibleSession(visibilityState, routeInstanceId, routeSessionId, instanceId, sessionId) {
  return visibilityState === "visible"
    && Boolean(instanceId && sessionId)
    && routeInstanceId === instanceId
    && routeSessionId === sessionId
}
