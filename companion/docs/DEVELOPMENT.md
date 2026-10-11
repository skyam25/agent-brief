# Development

How the app is built, tested and packaged. For what it does, see the [project README](../../README.md).

## Scripts

| Script | Does |
|---|---|
| `pnpm dev` | Vite dev server, main and preload rebuilt on change, Electron restarted |
| `pnpm build` | Builds `out/` (main, preload, the panel and the iPad client, Excalidraw fonts) and the CLI, `bin/agent-brief.mjs` |
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
| Data folder | `~/Library/Application Support/Agent Brief`, or `COMPANION_DATA_DIR` |
| Socket | `~/Library/Application Support/AgentBrief/agent-brief.sock` (mode 0600), or `COMPANION_SOCKET` |
| Deliveries | `<session cwd>/.feedback/sketches/<id>/` |

## Sending

- `/sketch` in Claude Code opens the panel bound to that session. A chip by Send names it, and clicking the chip brings its terminal forward.
- Opening the panel any other way (hotkey, tray, Dock) binds no session. Send reads "Send to…" and lists the running sessions, or starts a new one in a project folder.
- A new session opens in Ghostty, Terminal or a herdr tab, running `claude` on the bundle's `prompt.md`. Copy command puts the same start line on the clipboard instead.
- The target clears when its session exits. The app never picks a session on its own.
- Jumping back is exact for herdr panes and for the Ghostty terminal `/sketch` ran in. Other apps come forward as a whole.

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
- If either tool is missing, the sketch and audio still go out, and the status line says so.

## iPad

- The board's Open on iPad button (or File > Open on iPad…) starts a web server on the Mac's private LAN address, port 47613, and shows a QR code. The board button preserves the current session target. It never binds to a public address.
- The QR code holds a one-use pairing code in the URL fragment, good for 10 minutes. A new code cancels the old one. The page trades the code for a device credential at `POST /api/pair`, keeps it in localStorage, and clears the fragment.
- The credential travels as `Authorization: Bearer` on HTTP and as a second WebSocket subprotocol, `auth.<credential>`, next to `agent-brief`. There are no cookies, so other services on the Mac's address never receive it. The client files are open to the allowed subnet; the API and the WebSocket need the credential.
- A device unused for 30 days is forgotten and must pair again. The sheet lists paired devices, and each can be revoked. `devices.json` stores only a hash of each secret.
- The iPad shows the session Send goes to, and the server pushes changes over the WebSocket. Send names that session. If the Mac's choice changed, the server answers 409 with the new destination and the iPad shows it, so the next Send goes there.
- `src/web/limits.ts` caps HTTP requests and WebSocket messages per device, Sends per device, open sockets per device, and each board's size. Real drawing stays well under each.
- The iPad client is a second Vite entry, `src/web-client/`, built into `out/web`. It reuses the board canvas, picker and strip through a `BoardHost` built on fetch and WebSocket.
- One `SyncHub` in main joins the Mac panel, Claude's draws and every iPad client. Changes from an iPad reach the panel without entering its undo history, and the Mac saves them.
- Traffic is plain HTTP and ws on the LAN, so use iPad sharing only on networks you trust.
- The server stops after 8 hours with no client, and on quit.

## Tests

- `COMPANION_TEST=1` runs the app off screen, unfocused, out of the Dock, without a tray, and with a fake hotkey registrar. It exposes `globalThis.__companion` in main and `window.__board`/`window.__excalidraw` in the renderer.
- `COMPANION_TEST_VISIBLE=1` shows the window for debugging.
- `COMPANION_TEST_MIC=denied` fakes a refused microphone.
- `COMPANION_TEST_AUDIO=<file.wav>` makes Chromium's fake microphone play that file.
- In off-screen mode, CDP pen input stops creating strokes after the panel has been hidden and shown again. This comes from the test window (`showInactive`, not focusable), not from the app, so tests that hide the panel change the scene directly afterwards.
- The iPad server binds to `127.0.0.1` on a free port in test mode (`COMPANION_WEB_HOST`, `COMPANION_WEB_PORT`). The web-client e2e uses Playwright's headless Chromium, falling back to the newest cached one.

## Packaging

`pnpm dist` uses `electron-builder.yml`. The app bundles `out/`, the tray icons and the CLI (`Resources/bin/agent-brief`, plus a `companion` alias). It does not bundle ffmpeg or yap, which it finds at runtime. Nothing is installed into /Applications.

- `bin/agent-brief` is a shell wrapper. Inside the bundle it runs `agent-brief.mjs` with the app's Electron as Node (`ELECTRON_RUN_AS_NODE=1`). In a checkout it uses `node`.
- Install Command Line Tool… links `~/.local/bin/agent-brief` to that wrapper.
- `pnpm dist` signs with the Developer ID cert and the hardened runtime. `build/entitlements.mac.plist` grants JIT, the mic and Apple Events.
- `pnpm dist:notarize` also notarizes, using the `companion-notary` keychain profile from `xcrun notarytool store-credentials`.

## Releases and updates

Installed copies update themselves from GitHub releases with electron-updater. They check 10 s after launch and every 6 hours, download a newer build in the background, and install it when the app quits. Settings and the menus offer Check for Updates and, once a download is ready, Restart to Update. Development and test runs never update.

To release:

1. Bump `version` in `package.json`, commit and push `main`.
2. Run `pnpm release`, or `pnpm release --notes-file notes.md`.

The script builds, notarizes and verifies the app. It then creates the `v<version>` release with three files: `Agent-Brief-<version>-arm64.zip`, its `.blockmap`, and `latest-mac.yml`, which is the file installed copies read. A release without `latest-mac.yml` is invisible to the updater.

`COMPANION_UPDATE_URL=<url>` points a packaged build at a folder served over HTTP that holds those files. It also turns updates on in test mode, which is how an update is tried locally before a release.
