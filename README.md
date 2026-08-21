# OpenCode Pocket

A mobile-first web control surface for OpenCode. It talks to OpenCode's HTTP API and event stream instead of emulating a terminal.

Current features:

- discovers multiple local OpenCode instances through the optional TUI plugin or mDNS
- keeps sessions and requests isolated by OpenCode instance
- shows working, retry, idle, and needs-input states
- streams conversation history, reasoning, tool details, and diffs
- answers structured questions and permission requests
- sends follow-up prompts and aborts running sessions
- optionally follows the active session in each OpenCode TUI
- preserves drafts per instance and session
- installs as a PWA and shows browser notifications while running
- keeps OpenCode on localhost; only Pocket needs to be exposed to your phone

## Requirements

- Node.js 20 or newer
- OpenCode 1.18.20 or newer for optional TUI synchronization

Install Pocket's dependencies:

```bash
npm install
```

## 1. Start OpenCode

With the TUI plugin configured in step 3, start each interactive TUI with an ephemeral HTTP port:

```bash
opencode --port 0
```

`--port 0` gives each TUI its own port. OpenCode 1.18.20 defaults to `--hostname 127.0.0.1`, so the API remains available only on the local machine. The authenticated plugin report tells Pocket which loopback port belongs to that TUI.

A shell wrapper keeps the port flag consistent:

```bash
op() {
  command opencode --port 0 "$@"
}
```

Each running TUI appears as a separate instance in Pocket. Session and request IDs are namespaced by instance, so overlapping IDs do not collide.

### mDNS fallback

Without the plugin, Pocket can still discover TUI instances over mDNS:

```bash
opencode --port 0 --mdns --hostname 127.0.0.1
```

Keep the explicit hostname when using `--mdns`. OpenCode changes the mDNS hostname default to `0.0.0.0`, which would otherwise listen on every network interface.

### Static server fallback

Discovery is optional. Pocket can also connect to a fixed server:

```bash
# Terminal 1
opencode serve --hostname 127.0.0.1 --port 4096

# Terminal 2
OPENCODE_URL=http://127.0.0.1:4096 npm start
```

Set `OPENCODE_DISCOVERY=false` to use only the configured URL. A server started with `opencode serve` has no interactive TUI, so session selection remains independent.

If OpenCode uses Basic auth, configure the same credentials in Pocket:

```bash
# Terminal 1
OPENCODE_SERVER_PASSWORD='strong-password' opencode --port 0

# Terminal 2
OPENCODE_PASSWORD='strong-password' npm start
```

## 2. Configure Pocket

Copy the example and adjust it if needed:

```bash
cp .env.example .env
node --env-file=.env src/server.mjs
```

Node does not load `.env` automatically. You can also export variables or run `npm start` when defaults are sufficient.

Open <http://127.0.0.1:8787>. Pocket listens only on loopback by default.

## 3. Enable TUI synchronization

This step is optional. Without the plugin, Pocket still discovers instances and controls sessions, but Pocket and each TUI choose sessions independently.

Pocket creates a private shared token on startup at:

```text
~/.local/state/opencode-pocket/plugin-token
```

When `XDG_STATE_HOME` is set, Pocket uses `$XDG_STATE_HOME/opencode-pocket/plugin-token` instead.

Add the TUI plugin to `~/.config/opencode/tui.json`. While working from this checkout, use an absolute file URL:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///absolute/path/to/opencode-pocket/packages/opencode-pocket-plugin/tui.js",
      {
        "pocketUrl": "http://127.0.0.1:8787"
      }
    ]
  ]
}
```

If the package is installed from npm, replace the file URL with `"opencode-pocket-plugin"`.

The plugin and Pocket use the same default token path. To override it, set `OPENCODE_POCKET_TOKEN_FILE` for both processes or add `"tokenFile"` to the plugin options. You may instead provide the token directly through `OPENCODE_POCKET_TOKEN` to both processes.

Quit and restart OpenCode after changing `tui.json`; OpenCode loads TUI plugins only at startup. Start the TUI with `--port 0`. The plugin registers its loopback server directly with Pocket, so `--mdns` is not required.

When synchronization is active:

- the TUI-selected session is marked `In TUI`
- opening a Pocket session selects it in that TUI
- TUI navigation updates Pocket only while Pocket is following that instance
- opening an instance follows its current TUI session, or its session list when the TUI is home
- background instances update their markers without taking over Pocket navigation

## 4. Use Pocket on Android through Tailscale

The recommended deployment is:

```text
Android Chrome/PWA
       |
   Tailscale HTTPS
       |
OpenCode Pocket :8787
       |
 localhost only
       |
OpenCode instances
```

Keep Pocket and OpenCode bound to `127.0.0.1`, then expose Pocket with Tailscale Serve. This avoids exposing OpenCode's powerful API directly to the LAN or internet.

After opening the HTTPS Pocket URL in Chrome on Android, use "Add to Home screen" or "Install app". Tap the bell button once to grant browser notifications.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_DISCOVERY` | `true` | Enable mDNS discovery as a plugin-independent fallback |
| `OPENCODE_URL` | empty | Add a fixed OpenCode server alongside discovered instances |
| `OPENCODE_USERNAME` | `opencode` | OpenCode Basic auth username |
| `OPENCODE_PASSWORD` | empty | OpenCode Basic auth password |
| `OPENCODE_DIRECTORY` | empty | Optional directory override for a fixed server |
| `OPENCODE_POCKET_TOKEN` | empty | Explicit TUI plugin bearer token |
| `OPENCODE_POCKET_TOKEN_FILE` | XDG state path | Shared TUI plugin token file |
| `HOST` | `127.0.0.1` | Pocket listen address |
| `PORT` | `8787` | Pocket listen port |

Herdr is not required. It can be added later as an optional source of process metadata without replacing direct OpenCode discovery or control.

## Pocket API

```text
GET  /api/health
GET  /api/state
GET  /api/events                                      SSE
POST /api/refresh

GET  /api/instances/:instance/sessions/:session/messages
POST /api/instances/:instance/sessions/:session/messages
GET  /api/instances/:instance/sessions/:session/changes
GET  /api/instances/:instance/sessions/:session/diff?messageId=:message
GET  /api/instances/:instance/sessions/:session/agents
POST /api/instances/:instance/sessions/:session/agent
POST /api/instances/:instance/sessions/:session/abort
POST /api/instances/:instance/sessions/:session/select

POST /api/instances/:instance/questions/:request/reply
POST /api/instances/:instance/questions/:request/reject
POST /api/instances/:instance/permissions/:session/:request/reply

POST   /api/plugin/tui-state
DELETE /api/plugin/tui-state
```

The browser never receives the OpenCode password or plugin token. The plugin endpoint requires its bearer token.

## OpenCode compatibility notes

OpenCode is actively changing its server protocol. Pocket keeps OpenCode-facing code isolated in `src/opencode.mjs`, accepts both `properties` and `data` event envelopes, and accepts several request ID spellings.

Directory routing matters. Question and permission replies include the directory learned from the session. Some OpenCode builds can return 200 without unblocking the correct project instance when the directory is omitted.

Some OpenCode 1.17.x builds cannot reliably resolve permissions created by an interactive TUI turn through a separate HTTP server because the paths can use separate pending stores. Running the TUI itself with the Pocket wrapper flags avoids that split by exposing the same process Pocket controls.

## Deliberately not in v0.1

- Herdr metadata enrichment
- Web Push when the PWA is fully closed
- authentication on Pocket's browser-facing UI
- terminal fallback
- todos
- file uploads
- markdown rendering

## Development

```bash
npm test
npm run check
npm run dev
```

Plugin package checks:

```bash
npm --prefix packages/opencode-pocket-plugin test
npm --prefix packages/opencode-pocket-plugin run check
```

`npm run dev` restarts the Node server when backend modules change and reloads connected browsers when backend or `public/` files change.
