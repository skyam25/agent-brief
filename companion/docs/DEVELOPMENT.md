# Development

How the app is built, tested and packaged. For what it does, see the [project README](../../README.md).

## Scripts

| Script | Does |
|---|---|
| `pnpm dev` | Vite dev server, main and preload rebuilt on change, Electron restarted |
| `pnpm build` | Builds `out/` (main, preload, the panel, Excalidraw fonts) and the CLI, `bin/agent-brief.mjs` |
| `pnpm start` | Runs the built app |
| `pnpm test` | Vitest unit suites (board, main, server, voice, web, cli) |
| `pnpm test:e2e` | Builds, then runs Playwright `_electron` tests in `e2e/` |
| `pnpm compile` | Type check |
| `pnpm dist` | Builds `dist/mac-arm64/Agent Brief.app`, signed with the Developer ID cert |
| `pnpm dist:notarize` | The same, notarized and stapled |

On a fresh checkout, Electron fetches its binary on first use. `node node_modules/electron/install.js` does it up front.

## Paths

| What | Where |
|---|---|
| Boards | `<data>/boards/<name>.excalidraw`, notes in `<name>.notes.md` |
| Settings | `<data>/state.json`: board, panel size, hotkey, delivery mode, open at login, recent projects |
| History | `<data>/history/`: the last 10 sends, each with its PNG and scene |
| Drafts | `<data>/drafts/<id>.json`, pasted pictures inline as data URLs under `attachments` |
| Data folder | `~/Library/Application Support/Agent Brief`, or `COMPANION_DATA_DIR` |
| Socket | `~/Library/Application Support/AgentBrief/agent-brief.sock` (mode 0600), or `COMPANION_SOCKET` |
| Deliveries | `<session cwd>/.feedback/sketches/<id>/` |
| Items | `<session cwd>/.feedback/items/<session id>.md`, written by Claude, appended to by Send in Review mode |
| Outputs | `<session cwd>/.feedback/outputs/<session id>.json`, written by the mod, read by the app |

## Sending

- `/sketch` in Claude Code opens the panel bound to that session, and Send reads "Send to <session>". The session's tab is active; clicking it again brings its terminal forward.
- Main remembers each session's latest board and note in `state.json` (`sessionBriefs`, 30 days, at most 100). `/sketch` reopens the remembered board. The first time, it takes the current board if it is empty and no other session holds it, else it makes a board named after the session's title or folder (`Beta`, then `Beta 2`). `/write` without text reopens the session's note until it is sent. A board switch in the panel updates the record of the Send target's session; a History restore does not.
- The session sidebar (`SessionSidebar.tsx`) starts with a fixed Notes tab, then one tab per record, newest first: running sessions, then ended ones in an Ended group that folds away. A filled dot marks a running session, a hollow one an ended session, and • unsent content. Each tab's second line shows its folder, cut to the last two folders when long. The folded group still shows the active ended session. Below 720px the sidebar opens as a drawer over the work. Notes is active when no session is the target; clicking it clears the target. Closing a session tab forgets the record and keeps the board and note. The sidebar's hidden state and the Ended group's fold persist in `localStorage`. ⌃1 is Notes, ⌃2 onward are sessions in sidebar order, ⌃Tab cycles; ⌘1, ⌘2 and ⌘3 stay on Sketch, Write and Review.
- A draft carries `sessionId` when it is filed under a session. Write lists the active tab's drafts only; Notes lists the unfiled ones, plus drafts whose session tab was closed. `/write` files the note it opens, and File under… moves one between tabs.
- An ended session's brief keeps its `cwd` and `host`. The tab shows `cd <cwd> && claude --resume <id>` with Copy and Open in Ghostty, Terminal or herdr (`resumeSession` in `launch.ts`). Resuming re-registers the same session id, so the tab goes live without a new record.
- Opening the panel any other way (hotkey, tray, Dock) binds no session. The composer's target chip reads "Choose a session", and Send lists the running sessions or starts a new one in a project folder.
- A draft's Markdown references a picture as `![alt](att:<id>)`. Send writes each one to `<bundle>/images/<id>.<ext>` and turns the reference into an `@` line for that file, in `prompt.md`, `draft.md` and the history entry alike.
- A new session opens in Ghostty, Terminal or a herdr tab, running `claude` on the bundle's `prompt.md`. Copy command puts the same start line on the clipboard instead.
- The target clears when its session exits. The app never picks a session on its own.
- Jumping back is exact for herdr panes and for the Ghostty terminal `/sketch` ran in. Other apps come forward as a whole.

## Notes from Claude

- `POST /notes` (`NoteRequest` in `src/protocol.ts`) saves a draft with `title` and Markdown `text`. It never shows or focuses the panel and never changes the Send target.
- A `sessionId` must name a live session, else 404. The note is filed under it, and the session gets a tab if it had none. Without one, the note goes to Notes.
- Main sends `drafts:changed`, and an open panel reloads its list. The open note and the mode stay.
- `agent-brief note "<title>"` reads Markdown from stdin, `--text` or `--file`. It files under `--session`, else `CLAUDE_CODE_SESSION_ID`, which Claude Code sets in its shells. A session from the environment the app does not know gets its note under Notes. When the app is not running it exits 3 and tells Claude to print the text.
- The outputs prompt section tells Claude to use it for text the user will paste elsewhere.
- A draft's `title` is one line, at most 200 characters. The list shows it over the body's first line, and the editor shows it above the text.
- Copy in the note footer renders the Markdown with the editor's schema (`src/renderer/editor/rich-copy.ts`) and writes `text/html` and `text/plain` in one `clipboard.write`. Pictures go in as data URLs. Test runs record the write as `__companion.richClipboard()`.

## Items

- `trackItems` lives on the session's brief in `state.json`. The mod reads it through `GET /sessions/:id` and adds the items instructions to Claude's prompt only while it is true. `PATCH /sessions/:id` flips it from `/track`.
- `src/main/items-watch.ts` watches each tracked session's file and pushes `items:changed` to the panel. It polls every 1.5 s until the folder exists.
- `src/shared/items.ts` parses and serializes the file. `withDecisions` appends `You:` lines and leaves every other byte as it was.

## Outputs

- The mod records each session's documents in `.feedback/outputs/<session id>.json` (`OutputsFile` in `src/protocol.ts`). Claude's `declare_output` calls add declared records. The hook on Write, Edit and NotebookEdit adds detected ones. The app never writes the file.
- Every session answer carries `outputsPath`, tracked or not.
- A second `ItemsWatcher` watches the file of every live session with a brief and pushes `outputs:changed` with `OutputsInfo`. `src/shared/outputs.ts` parses the file and sorts declared records first, each tier newest on top.
- Dismiss stores `dismissedOutputs[ref]` on the session's brief as the record's `outputTouchedAt`, the later of `declaredAt` and `lastWriteAt`. The row stays hidden until a later write or declaration moves it past that time.
- Opening an output:
  - An http(s) link opens in the browser. Other schemes are refused.
  - A Markdown file (`.md`, `.markdown`, `.mdx`, up to 4 MB) opens in Write as a note filed under the session, with `source: { path }`. A note the session already has on that file reopens instead.
  - An HTML file (`.html`, `.htm`) opens in the review pane as a draft with `review: { path, comments }`. A review the session already has on that file reopens instead.
- Review mode (`ReviewMode.tsx`) lists a session's outputs and its review drafts on the left, with its items or the open review on the right. Write lists notes alone, so a draft with `review` always opens in Review mode. A saved `mode: "items"` in `state.json` loads as `review`.
  - Any other file opens in its default app.
  - Files get the same check as item outputs. They must exist inside the session's folder, symlinks resolved.
  - Tests record opened files and links in `openedOutputs`.
- Send with a note that has `source` writes the edited text to `draft.md`, and the prompt is two lines:

  ```
  @.feedback/sketches/<id>/draft.md
  My edited copy of <path> from Agent Brief. Apply the changes to <path>, keep what I did not touch, then say what changed.
  ```

  With a sketch, those lines come first and the sketch lines follow. A source path that is absolute, multi-line or climbs out with `..` is dropped, and the text goes out word for word.

## Review pane

- Main serves project files over `agent-brief-review://<token>/<path>` (`src/main/review-protocol.ts`). Each project folder gets a random token, so each is its own origin, apart from the panel's.
- The handler refuses paths outside the folder, links that leave it, and dot files and folders such as `.env` and `.git`. Responses are `no-store`, so Reload shows Claude's latest write.
- HTML responses get `<script src="/__agent-brief__/overlay.js">` as the first script in `<head>`. The overlay (`src/review/overlay.ts`, built to `out/review/overlay.js`) runs in the page's main world. It draws in a closed shadow root and talks to the pane only by `postMessage`, with the types in `src/review/messages.ts`.
- The frame is `sandbox="allow-scripts allow-same-origin allow-forms"`. The page keeps its own origin, so its storage works, and it still cannot reach the panel. The panel CSP allows `frame-src agent-brief-review:`. `will-frame-navigate` keeps the frame on the scheme. The permission handler refuses every request from it.
- A pin's anchor holds a unique CSS selector, the tag, the element's text, any selected text, the nearest heading above, and the pin's spot as fractions of the element box. Main crops the panel with `capturePage` at the element's visible box, and the crop is saved as a draft attachment. A draft keeps 40 attachments, so pins past 36 go without a picture.
- Voice: `ReviewVoice` records one clip at a time, and each clip belongs to the selected comment or the overall note. Selecting or pinning another comment ends the clip, and main turns it into text through ffmpeg and yap (`review:transcribe`). Send waits for pending text.
- Send writes `review.md` and points the prompt at it:

  ```
  @.feedback/sketches/<id>/review.md
  Review of <path> from Agent Brief, <n> comments pinned to the page. Make the changes in <path>, then say what changed.
  ```

## Session mode

- The mod owns each session's mode. It sends a `ModePatch` (`{ mode, fidelity? }`) on `PATCH /sessions/:id`, alone or with `trackItems` in the same body.
- `fidelity` goes only with `mode: 'prototype'`. Another mode drops it, and `mode: 'default'` clears the record.
- `src/main/session-modes.ts` keeps the mode in memory and forgets it when the session leaves. `SessionInfo` carries `mode` and `fidelity` on every session answer and `onSessionsChange`.
- The app only mirrors the mode. A live session's tab shows it as a chip, such as `Prototype · Wireframe`, and the panel has no control to change it.

## Pen

- Excalidraw stores real `PointerEvent.pressure` per point. A flat 0.5 means a mouse-like pen, and Excalidraw then simulates pressure from speed.
- `PRESSURE_GAMMA` in `src/renderer/pen.ts` sets a curve on the light half of the pressure range: `p < 0.5 → 0.5·(2p)^γ`. It is 1.6.
  - Stock Excalidraw draws 0.2 vs 1.0 pressure at 1.97× width. With the curve it is 2.32×.
  - 0.5 and above pass through unchanged, so the mouse-like detection still works.
  - Raise γ for thinner light strokes. Set it to 1 to turn the curve off.
- The eraser end (`button 5`, or `buttons & 32`) erases while held.
- Touch is ignored while a pen hovers or touched within the last second.

## Voice

- The mic button records WebM/Opus in 30 s clips. Each clip is a separate recording, so every file decodes on its own.
- The panel logs board changes as stroke events. Send numbers the user's strokes on the PNG.
- Main transcribes the clips with ffmpeg and yap, which it finds in Homebrew or on PATH. It writes `timeline.md`, `transcript.json` and `audio/` into the bundle.
- If either tool is missing, the sketch and audio still go out, and a message at the foot of the panel says so.

## Tests

- `COMPANION_TEST=1` runs the app off screen, unfocused, out of the Dock, without a tray, and with a fake hotkey registrar. It exposes `globalThis.__companion` in main and `window.__board`/`window.__excalidraw` in the renderer.
- `COMPANION_TEST_VISIBLE=1` shows the window for debugging.
- `COMPANION_TEST_MIC=denied` fakes a refused microphone.
- `COMPANION_TEST_AUDIO=<file.wav>` makes Chromium's fake microphone play that file.
- In off-screen mode, CDP pen input stops creating strokes after the panel has been hidden and shown again. This comes from the test window (`showInactive`, not focusable), not from the app, so tests that hide the panel change the scene directly afterwards.

## Packaging

`pnpm dist` uses `electron-builder.yml`. The app bundles `out/`, the tray icons, the CLI (`Resources/bin/agent-brief`, plus a `companion` alias) and the Claude Code plugin (`Resources/plugin/`). It does not bundle ffmpeg or yap, which it finds at runtime. Nothing is installed into /Applications.

- `bin/agent-brief` is a shell wrapper. Inside the bundle it runs `agent-brief.mjs` with the app's Electron as Node (`ELECTRON_RUN_AS_NODE=1`). In a checkout it uses `node`.
- Install Command Line Tool… links `~/.local/bin/agent-brief` to that wrapper.
- `Resources/plugin/` is a marketplace laid out like the repo: `.claude-plugin/marketplace.json` and `mod/agent-brief/` without `tests/` or the generated `.claude-plugin/types/`.
- Install Claude Code Plugin… runs `claude plugin marketplace add <Resources/plugin>`, then `claude plugin install agent-brief@agent-brief` if it is not installed. In a checkout it adds the repo root instead.
- Both installs refuse while macOS runs the app from a translocated copy, before the user moves it into Applications.
- `pnpm dist` signs with the Developer ID cert and the hardened runtime. `build/entitlements.mac.plist` grants JIT, the mic and Apple Events.
- `pnpm dist:notarize` also notarizes, using the `companion-notary` keychain profile from `xcrun notarytool store-credentials`.

## Releases and updates

Installed copies update themselves from GitHub releases with electron-updater. They check 10 s after launch and every 6 hours, download a newer build in the background, and install it when the app quits. Settings and the menus offer Check for Updates and, once a download is ready, Restart to Update. Development and test runs never update.

To release:

1. Bump `version` in `package.json`, commit and push `main`.
2. Run `pnpm release`, or `pnpm release --notes-file notes.md`.

The script builds, notarizes and verifies the app. It then creates the `v<version>` release with three files: `Agent-Brief-<version>-arm64.zip`, its `.blockmap`, and `latest-mac.yml`, which is the file installed copies read. A release without `latest-mac.yml` is invisible to the updater.

### The CLI and the plugin follow the app

- The CLI link and the plugin registration both point into the bundle. An update replaces the bundle in place, so both pick up the new version with no extra step.
- Claude Code reads a directory marketplace's plugin in place, not from its cache. New sessions load the new plugin. Open sessions keep the old hooks until `/reload-plugins` or a restart.
- `claude plugin marketplace add` under the existing name `agent-brief` re-points the registration and keeps the installed plugin and its options. `claude plugin marketplace remove` deletes the options, so the app never removes.
- 15 s after a packaged launch, the app repairs both if the app moved. It re-points the CLI link when its target is gone. It re-points the plugin when it is registered from an app bundle that no longer exists. Checkouts, GitHub sources and copies that still exist stay as they are.
- `COMPANION_TEST_CLAUDE` names a stand-in `claude` for test runs.

`COMPANION_UPDATE_URL=<url>` points a packaged build at a folder served over HTTP that holds those files. It also turns updates on in test mode, which is how an update is tried locally before a release.
