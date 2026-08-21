# OpenCode Pocket

A mobile-first web control surface for OpenCode. It does not emulate a terminal. It talks to OpenCode's HTTP API and event stream.

Current MVP:

- lists OpenCode sessions as agents
- shows working, retry, idle and needs-input states
- shows conversation history and updates it while the agent writes
- shows reasoning stages and collapsible tool inputs, outputs and errors
- renders structured `question.asked` prompts as native mobile controls
- replies to and rejects questions
- renders permission requests with Allow once, Always allow and Reject
- sends normal follow-up prompts through `prompt_async`
- aborts a running session
- installable PWA
- browser notifications for questions and permissions while the PWA is running in the background
- keeps OpenCode itself on localhost; only Pocket needs to be exposed to your phone

## Requirements

- Node.js 20 or newer
- OpenCode with its HTTP server available

The code intentionally uses only Node built-ins, so there is no `npm install` step.

## 1. Start OpenCode

For the cleanest MVP, use OpenCode server mode in the project you want to control:

```bash
cd /path/to/project
opencode serve --hostname 127.0.0.1 --port 4096
```

OpenCode publishes a health endpoint at `/global/health`, an SSE stream at `/event`, sessions under `/session`, messages under `/session/:id/message`, and an OpenAPI description at `/doc`.

If you protect OpenCode with Basic auth:

```bash
OPENCODE_SERVER_PASSWORD='strong-password' opencode serve --hostname 127.0.0.1 --port 4096
```

Then configure the same password in Pocket.

## 2. Configure Pocket

```bash
cp .env.example .env
```

Node does not load `.env` by itself in this zero-dependency version. Either export the values or use Node's env-file option:

```bash
node --env-file=.env src/server.mjs
```

Or:

```bash
OPENCODE_URL=http://127.0.0.1:4096 \
HOST=127.0.0.1 \
PORT=8787 \
node src/server.mjs
```

With OpenCode auth:

```bash
OPENCODE_PASSWORD='strong-password' node --env-file=.env src/server.mjs
```

Open http://127.0.0.1:8787.

## 3. Create or use a session

This MVP displays the sessions returned by the configured OpenCode server. Use an existing session, or create one with another OpenCode client. Once a session exists, open it in Pocket and send messages from the browser.

To test structured questions, tell the agent to use its question tool and ask you a multiple-choice question. The `question.asked` event should appear as buttons in Pocket. Your answer is posted to `/question/:id/reply` with the session's directory routing preserved.

## 4. Put it on Android through Tailscale

The recommended first deployment is:

```text
Android Chrome/PWA
       |
   Tailscale HTTPS
       |
OpenCode Pocket :8787
       |
 localhost only
       |
OpenCode :4096
```

Keep both Pocket and OpenCode bound to `127.0.0.1`, then expose Pocket with Tailscale Serve on the host. This avoids exposing OpenCode's powerful API directly to the LAN or internet.

After opening the HTTPS Pocket URL in Chrome on Android, use "Add to Home screen" or "Install app". Tap the bell button once to grant browser notifications.

## API exposed by Pocket

```text
GET  /api/health
GET  /api/state
GET  /api/events                       SSE
POST /api/refresh

GET  /api/sessions/:id/messages
POST /api/sessions/:id/messages
GET  /api/sessions/:id/agents
POST /api/sessions/:id/agent
POST /api/sessions/:id/abort

POST /api/questions/:id/reply
POST /api/questions/:id/reject
POST /api/permissions/:session/:id/reply
```

The browser never needs the OpenCode password.

## Important OpenCode compatibility notes

OpenCode is actively changing its server protocol. Pocket therefore keeps the OpenCode-facing code isolated in `src/opencode.mjs`, accepts both `properties` and `data` event envelopes, and accepts several request ID spellings.

Directory routing matters. Question and permission replies are sent with the directory learned from the session. Older/current OpenCode builds have had bugs where a request appears to return 200 but does not unblock the correct project instance when `directory` is omitted.

There is also a known issue in some OpenCode 1.17.x builds where permissions created by a turn started inside the interactive TUI cannot reliably be resolved through the HTTP API because the interactive and HTTP paths can hit separate pending stores. For this MVP, the reliable path is to start the controlled turn through Pocket/API against `opencode serve`. Questions are less affected, but directory routing is still important.

## What is deliberately not in v0.1

- Herdr process discovery and agent naming
- multiple OpenCode servers
- Web Push when the PWA is fully closed
- authentication on Pocket itself
- terminal fallback
- diffs and todos
- file uploads
- markdown rendering

Those are next-layer features. The first goal is to prove the terminal-free question, permission and messaging loop.

## Development

```bash
npm test
npm run check
npm run dev
```

`npm run dev` restarts the Node server when backend modules change and reloads connected browsers when backend or `public/` files change.

No third-party runtime dependencies are used.
