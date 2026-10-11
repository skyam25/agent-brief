# Agent Brief

macOS sketch, notes and voice panel that hands work to Claude Code. User-facing overview in `README.md`. Build, paths, test hooks and release steps in `companion/docs/DEVELOPMENT.md`.

## Layout

| Path | Holds |
|---|---|
| `companion/` | Electron app (pnpm, React 19, Excalidraw) and the `agent-brief` CLI |
| `companion/src/main/` | Electron main: panel window, store, session briefs, drafts, history, updater |
| `companion/src/renderer/` | Panel UI: board, Write view, tabs, popovers |
| `companion/src/server/` | HTTP-over-Unix-socket server and delivery bundles |
| `companion/src/protocol.ts` | Socket protocol shared by app, CLI and plugin |
| `companion/src/{board,voice,shared}/` | Board geometry and summaries, timeline and transcription, shared types |
| `companion/cli/` | CLI source, built to `bin/agent-brief.mjs` |
| `mod/agent-brief/` | Claude Code plugin: `/sketch`, `/write`, delivery, feedback inbox, `sketch-board` skill |
| `.claude-plugin/marketplace.json` | Marketplace entry pointing at `mod/agent-brief` |
| `extension/` | Separate repo (gitignored), the companion Chrome extension |

## How the app and plugin connect

- The app serves HTTP over a Unix socket at `~/Library/Application Support/AgentBrief/agent-brief.sock` (`COMPANION_SOCKET` overrides).
- The plugin registers each Claude Code session with `POST /sessions` and removes it at session end.
- `/sketch` and `/write` ask the app to open the panel bound to that session.
- Send writes a bundle to `<session cwd>/.feedback/sketches/<id>/`. The plugin long-polls `GET /deliveries` and puts the prompt into the session.
- Claude draws on and reads the board through the `agent-brief` CLI, not MCP tools.
- The plugin works without the app running. Its socket calls fail silently.

## Commands

Run from `companion/`.

| Command | Does |
|---|---|
| `pnpm test` | Vitest unit suites |
| `pnpm compile` | Type check |
| `pnpm test:e2e` | Build, then Playwright `_electron` tests in `e2e/` |
| `pnpm dev` | Dev server with Electron restart |
| `node live/full-loop.mjs` | Real Claude sessions in tmux, no model calls |
| `pnpm release` | Notarize and publish a GitHub release (bump `version` first) |

Plugin, from `mod/agent-brief/`:

- `claude plugin test .` runs `tests/`
- `claude plugin validate .` checks the manifest
- `node tests/live/run-live.mjs` runs the live tmux check

## Rules

- Protocol changes are add-only. Never rename or remove fields or routes.
- `mod/agent-brief/hooks/companion-protocol.ts` is a copy of `companion/src/protocol.ts`. Change both together.
- E2E runs only with `COMPANION_TEST=1`, which keeps windows off screen. No visible pop-ups during tests.
- Verify UI headlessly through Playwright `_electron`, not the browser extension.
- The app never guesses a send target. A standalone open makes the user pick a session.
- No ambient nags. Hand-offs are explicit, one step, user-triggered.
- Bump `companion/package.json` `version` for app releases and `mod/agent-brief/.claude-plugin/plugin.json` `version` for plugin changes.
- Commit as `1623428+skyam25@users.noreply.github.com` (set in repo config).
- `PLAN*.md` are untracked working notes.
