import agentSort from "../public/agent-sort.js" with { type: "file" }
import app from "../public/app.js" with { type: "file" }
import icon from "../public/icon.svg" with { type: "file" }
import index from "../public/index.html" with { type: "file" }
import manifest from "../public/manifest.webmanifest" with { type: "file" }
import modelState from "../public/model-state.js" with { type: "file" }
import notificationState from "../public/notification-state.js" with { type: "file" }
import permissionState from "../public/permission-state.js" with { type: "file" }
import quickMessageState from "../public/quick-message-state.js" with { type: "file" }
import serviceWorker from "../public/sw.js" with { type: "file" }
import styles from "../public/styles.css" with { type: "file" }

export const publicAssets = new Map([
  ["agent-sort.js", agentSort],
  ["app.js", app],
  ["icon.svg", icon],
  ["index.html", index],
  ["manifest.webmanifest", manifest],
  ["model-state.js", modelState],
  ["notification-state.js", notificationState],
  ["permission-state.js", permissionState],
  ["quick-message-state.js", quickMessageState],
  ["styles.css", styles],
  ["sw.js", serviceWorker],
])
