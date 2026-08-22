# OpenCode Pocket

A mobile-first web control surface for OpenCode. It talks to OpenCode's HTTP API and event stream instead of emulating a terminal.

Current features:

- discovers multiple local OpenCode instances through the optional TUI plugin or mDNS
- keeps sessions and requests isolated by OpenCode instance
- shows working, retry, idle, blocked, and offline states in an agent dashboard and drawer
- receives live conversation updates and shows history, reasoning, tool details, and diffs
- answers structured questions and permission requests
- sends follow-up prompts and aborts running sessions
- creates and switches sessions, with optional OpenCode TUI synchronization
- cycles directly through agents blocked on questions or permissions
- selects OpenCode modes and accepts browser voice dictation when supported
- preserves drafts per instance and session
- installs as a PWA and shows blocker notifications while the page remains loaded
- supports keeping OpenCode on localhost so only Pocket needs to be exposed to your phone

## Requirements

- Node.js 20.12 or newer
- OpenCode 1.18.20 or newer for optional TUI synchronization
- a modern browser with EventSource support; service workers are needed for PWA shell caching
- HTTPS or another secure context for phone-side PWA installation, notifications, and microphone access

Voice dictation additionally requires the browser Web Speech API. The microphone button is hidden when that API is unavailable.

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

Set `OPENCODE_DISCOVERY=false` to disable mDNS. Authenticated reports from the optional TUI plugin are independent of this setting; omit the plugin as well if Pocket should use only `OPENCODE_URL`. A server started with `opencode serve` has no interactive TUI, so session selection remains independent.

If OpenCode uses Basic auth, configure the same credentials in Pocket:

```bash
# Terminal 1
OPENCODE_SERVER_PASSWORD='strong-password' opencode --port 0

# Terminal 2
OPENCODE_PASSWORD='strong-password' npm start
```

## 2. Configure Pocket

Create dedicated production and development profiles without overwriting existing files:

```bash
make config
$EDITOR ~/.config/opencode-pocket/env
$EDITOR ~/.config/opencode-pocket/env.dev
```

`npm start` and the installed `opencode-pocket` command load `env`. `npm run dev` and `make dev` load `env.dev` and enable watch/live-reload mode. Existing process environment variables take precedence over values from the profile.

Set `OPENCODE_POCKET_PROFILE=test` or pass `--profile test` to load `env.test`. Set `OPENCODE_POCKET_CONFIG=/path/to/file` or pass `--config /path/to/file` to use an explicit file; an explicit file must exist. Missing default or named profile files are allowed and leave the built-in defaults in effect.

Open <http://127.0.0.1:8787>. Pocket listens only on loopback by default.

## 3. Enable TUI synchronization

This step is optional. Without the plugin, Pocket can use mDNS or `OPENCODE_URL` to control sessions, but Pocket and each TUI choose sessions independently.

Unless `OPENCODE_POCKET_TOKEN` is set, Pocket creates a private shared token on startup at:

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

To report the same TUI to production and development Pocket processes, use `pocketUrls` instead:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///absolute/path/to/opencode-pocket/packages/opencode-pocket-plugin/tui.js",
      {
        "pocketUrls": [
          "http://127.0.0.1:8787",
          "http://127.0.0.1:8788"
        ]
      }
    ]
  ]
}
```

Each target has an independent queue, timeout, and retry schedule, so an unavailable development server does not interrupt production reports. The existing singular `pocketUrl` and `url` options remain supported.

If the package is installed from npm, replace the file URL with `"opencode-pocket-plugin/tui"`.

The plugin and Pocket use the same default token path. To override it, set `OPENCODE_POCKET_TOKEN_FILE` for both processes or add `"tokenFile"` to the plugin options. You may instead provide the token directly through `OPENCODE_POCKET_TOKEN` to both processes.

Quit and restart OpenCode after changing `tui.json`; OpenCode loads TUI plugins only at startup. Start the TUI with `--port 0`. The plugin registers its loopback server directly with Pocket, so `--mdns` is not required. If the TUI exposes only its internal URL, the plugin shows one warning and waits instead of sending invalid reports to Pocket.

When synchronization is active:

- the TUI-selected session is marked `In TUI`
- opening a Pocket session selects it in that TUI
- the session drawer lists the 10 newest root sessions and creates sessions in the current session's directory when that metadata is available, otherwise using `OPENCODE_DIRECTORY` or OpenCode's default
- TUI navigation updates Pocket only while Pocket is following that instance
- opening an instance follows its current TUI session, or selects its newest root session when the TUI is home
- returning a followed TUI to its home screen returns Pocket to the Agents dashboard
- background instances update their markers without taking over Pocket navigation

## Using Pocket

The Agents dashboard shows one card per OpenCode instance. Each card represents that instance's active root session: the session selected in a connected TUI when available, otherwise its newest root session. These cards are distinct from OpenCode's selectable modes in the conversation composer.

From a conversation:

- open the agent drawer with the menu button or a swipe from the left edge
- use the drawer refresh button to refresh sessions, statuses, questions, and permissions for known instances
- read green `idle`, yellow `working` or `retry`, red `blocked`, and gray `offline` status indicators
- tap the right-aligned `N blocked` button to open the next agent needing an answer; repeated taps cycle through blocked agents
- open the session drawer to switch among the 10 newest root sessions or create a session
- select an OpenCode mode in the composer; the selection is used for subsequent prompts
- open the changes view to inspect changed turns and load file diffs on demand
- tap the microphone button for live dictation when the browser supports the Web Speech API

Dictation appends interim and final speech to the current draft and never sends automatically. Sending a message or changing sessions stops recognition. Android uses non-continuous recognition, and microphone denial or recognition failures appear as a toast.

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

Keep Pocket and OpenCode bound to `127.0.0.1`, then expose Pocket with Tailscale Serve. This is the recommended architecture and avoids exposing OpenCode's powerful API directly to the LAN or internet. A manually configured `OPENCODE_URL` is not restricted to loopback, so secure any remote OpenCode server separately.

After opening the HTTPS Pocket URL in Chrome on Android, use "Add to Home screen" or "Install app". Tap the bell button once to grant browser notifications.

Notifications are sent only for questions and permission requests, only while Pocket remains loaded but is not visible. Pocket does not currently use Web Push, so it cannot notify after the page or installed PWA has been fully closed. Browser support for page-level notifications varies on mobile.

The service worker caches the application shell for reloads with a network-first strategy. API responses are never cached, and Pocket does not provide offline OpenCode control, background synchronization, or background push delivery.

## Arch Linux Package

The included `opencode-pocket-git` PKGBUILD installs Pocket as a per-user service while preserving host loopback, mDNS, and the shared plugin token path. Build and install it with:

```bash
make arch-install
make config
systemctl --user enable --now opencode-pocket
```

`make arch-install` builds the package before installing it. To build without installing, use `make package`. Packages are written to `dist/arch/packages`. `make package` builds the current working tree through a temporary source archive. The `-git` PKGBUILD defaults to the latest GitHub commit when used directly or published to AUR. `make arch-check` additionally validates the PKGBUILD and built package with `namcap`.

Inspect the service with:

```bash
systemctl --user status opencode-pocket
journalctl --user -u opencode-pocket -f
```

The package installs the TUI plugin at `/usr/lib/opencode-pocket/plugin/tui.js`. Use this file URL in `tui.json`:

```json
"file:///usr/lib/opencode-pocket/plugin/tui.js"
```

The service and direct launcher both load `~/.config/opencode-pocket/env`. The package only installs examples under `/usr/share/doc/opencode-pocket/`; it never writes into a user's home directory. `make config` creates user copies with mode `0600` and preserves any existing files.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_DISCOVERY` | `true` | Enable mDNS discovery; `0`, `false`, and `off` disable it |
| `OPENCODE_URL` | empty | Add a fixed OpenCode server alongside discovered instances |
| `OPENCODE_USERNAME` | `opencode` | Basic auth username used for all OpenCode instances |
| `OPENCODE_PASSWORD` | empty | Basic auth password used for all OpenCode instances |
| `OPENCODE_DIRECTORY` | empty | Global directory default/fallback for OpenCode requests |
| `OPENCODE_POCKET_TOKEN` | empty | Explicit TUI plugin bearer token |
| `OPENCODE_POCKET_TOKEN_FILE` | XDG state path | Shared TUI plugin token file |
| `OPENCODE_POCKET_CONFIG` | empty | Explicit launcher environment file; otherwise use the selected XDG profile |
| `OPENCODE_POCKET_PROFILE` | empty | Load `env.NAME` instead of `env` |
| `XDG_STATE_HOME` | `~/.local/state` | Base directory for the default plugin token path |
| `XDG_CONFIG_HOME` | `~/.config` | Base directory for launcher environment profiles |
| `HOST` | `127.0.0.1` | Pocket listen address |
| `PORT` | `8787` | Pocket listen port |

The TUI plugin accepts `OPENCODE_POCKET_URL`, which defaults to `http://127.0.0.1:8787`, or a comma-separated `OPENCODE_POCKET_URLS` list. Plugin options override these with `pocketUrls`, singular `pocketUrl`, or the `url` alias. The `tokenFile` option overrides the shared token path.

Basic auth and `OPENCODE_DIRECTORY` are global Pocket settings; per-instance credentials and directory defaults are not currently supported. Session metadata still takes precedence when Pocket knows the session's directory.

Herdr is not required. It can be added later as an optional source of process metadata without replacing direct OpenCode discovery or control.

## Pocket API

```text
GET  /api/health
GET  /api/state
GET  /api/events                                      SSE
POST /api/refresh

POST /api/instances/:instance/sessions
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

Important request and response details:

- `POST /api/refresh` refreshes known instances; it does not restart or force an mDNS scan
- `POST .../sessions` accepts optional `{ "directory": "..." }`, selects the created session in OpenCode, and returns `201`
- `GET .../messages?limit=N` defaults to 100 messages and caps the limit at 300
- `POST .../messages` accepts `{ "text": "...", "agent": "optional-mode" }` and returns `202`
- `GET .../diff` requires the `messageId` query parameter
- `POST .../agent` requires `{ "agent": "mode-name" }`
- question replies require `{ "answers": [...] }`
- permission replies require `{ "response": "once" }`, `"always"`, or `"reject"`
- `/api/events` emits state snapshots and normalized OpenCode agent and TUI events over SSE

The browser never receives the OpenCode password or plugin token. The plugin endpoint requires its bearer token, but the browser-facing UI and API have no authentication. Do not bind Pocket to an untrusted network; keep `HOST=127.0.0.1` and expose it through an authenticated private HTTPS layer such as Tailscale Serve.

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
make help
make config
make verify
make dev
```

The equivalent npm commands are:

```bash
npm test
npm run check
npm run dev
```

`npm test` runs the backend, discovery, instance lifecycle, token, launcher-profile, and bridge tests. `npm run check` performs JavaScript syntax checks; it is not a linter or type checker. Browser interactions, dictation, notifications, and PWA behavior still require manual browser testing.

Plugin package checks:

```bash
npm --prefix packages/opencode-pocket-plugin test
npm --prefix packages/opencode-pocket-plugin run check
```

`npm run dev` restarts the Node server when backend modules change and reloads connected browsers when backend or `public/` files change.

Arch package helpers:

```bash
make package
make arch-install
make arch-check
make package-clean
```
