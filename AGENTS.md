# Repository instructions

## Worktree hygiene

- Before starting a new feature, check `git status`. If the worktree already has changes, ask whether they should be committed separately before making new changes; do not silently mix unrelated work.

## Verification

- Use Bun 1.3 or newer and install with `bun install --frozen-lockfile`.
- Run `make verify` before finishing. It runs the root and TUI plugin tests, checks syntax for both packages, builds the standalone executable, and smoke-tests it without Bun or Node.js on `PATH`.
- Run one test file with `bun test test/opencode.test.mjs`. Run one named test with `bun test --test-name-pattern="pattern" test/opencode.test.mjs`.
- Run plugin-only verification with `bun run --cwd packages/opencode-pocket-plugin test` and `bun run --cwd packages/opencode-pocket-plugin check`.
- There is no linter, formatter, type checker, or browser automation. `bun run check` is syntax checking only. Manually exercise browser interactions, PWA caching, dictation, and notifications when changing them.

## Runtime layout

- `bin/opencode-pocket.mjs` resolves and loads an XDG environment profile before dynamically importing `src/server.mjs`. `bun run start` uses `~/.config/opencode-pocket/env`; `bun run dev` passes `--dev` and uses `env.dev`.
- `src/server.mjs` is the executable hand-written HTTP server: static files, browser API routes, SSE broadcasting, live reload, and shutdown. Importing it starts the service.
- `src/instances.mjs` owns multi-instance discovery and namespaces OpenCode state. Never treat a session or request ID as globally unique; keep the instance ID in API paths and browser state keys.
- Keep OpenCode protocol compatibility in `src/opencode.mjs`. It normalizes changing event envelopes and ID spellings and adds directory query parameters required for correctly routing questions and permissions.
- `public/` is served directly as native browser modules in source mode and embedded unchanged in the standalone executable through `src/public-assets.mjs`. `public/app.js` uses delegated events and string rendering; pure browser-state logic lives in small sibling modules so Bun tests can cover it.
- `packages/opencode-pocket-plugin/` is a separate publishable package. Its TUI reporter and tests have their own scripts even though the root test command also includes `tui.test.js`.

## Frontend and PWA traps

- When adding a browser module or shell asset, add it to `ASSETS` in `public/sw.js`, bump the `opencode-pocket-vN` cache, and embed it through `src/public-assets.mjs`. The root syntax check discovers JavaScript files through globs.
- Browser drafts, model choices, sorting, and quick messages use `localStorage`; notification subscriptions and mutable server state use private XDG state files. Do not move one category to the other without an explicit product decision.
- The browser-facing UI/API has no authentication. Keep production defaults loopback-only; `.env.dev.example` intentionally uses `HOST=0.0.0.0` and must not be copied into production blindly.

## Packaging and generated output

- `make package` runs verification and packages the current working tree, not only committed files. Outputs under `dist/arch/` are generated; edit `packaging/arch/PKGBUILD` or `packaging/systemd/` instead.
- The Arch package installs a Bun-compiled executable and has no Bun or Node.js runtime dependency. Keep `options=('!strip')`; stripping removes Bun's embedded application payload.
- `make config` creates missing profile files with mode `0600` and preserves existing files. Keep credentials and generated tokens out of the repository.
