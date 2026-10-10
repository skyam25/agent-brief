# agent-brief

The Agent Brief plugin for Claude Code. It opens the sketch board for a session with `/sketch` or the Sketch button above the prompt, and delivers what you send. It also picks up feedback sessions exported by the companion Chrome extension. It transcribes them on this machine, writes them into the project, and hands them to Claude.

## How it works

1. The extension drops `<session>.zip` into `~/Downloads/feedback-inbox/` when a recording stops. It waits there.
2. Run `/apply-feedback [name]` in the project the recording belongs to. The mod claims each waiting zip by moving it to `processing/`. A failed move means another Claude Code session claimed it, so this one skips it.
3. The mod runs `bin/ingest.mjs`. The CLI unzips the file, converts each audio chunk to WAV with ffmpeg, transcribes it with yap, splits it into one line per sentence, and re-renders `report.md`. A line above the prompt shows progress.
4. The output lands in `<project>/.feedback/<session>/`, and `.feedback/` is added to the project's `.gitignore`.
5. The zip moves to `done/`, or to `failed/` with a toast saying why.
6. The mod submits a prompt that applies the newest session, or the named one.

Recordings never land in a project on their own, so a session open in another project cannot pick them up. `/apply-feedback` with nothing in the inbox applies the newest unapplied session already in `.feedback/`. Claude can also read sessions through the `feedback_latest` and `feedback_list` tools.

## Setup

- **Chrome:** turn off Settings › Downloads › "Ask where to save each file before downloading". Otherwise every export opens a save dialog.
- **Transcription:** install yap and ffmpeg (`brew install yap ffmpeg`). yap refuses WebM, so ffmpeg always runs first.
- **Node:** Node 20 or newer must be on `PATH`, or set `nodePath`.
- **Install the mod:** run `claude plugin marketplace add skyam25/agent-brief` once, then `claude plugin install agent-brief@agent-brief`. From a checkout, add the repository folder instead; the plugin is then read from it, so `/reload-plugins` picks up edits.
- **Load it for one session:** run `claude --plugin-dir <checkout>/mod/agent-brief`.

### Optional: whisper.cpp

Set `transcriber` to `whisper`, and set `whisperModel` to a downloaded ggml model:

```sh
brew install whisper-cpp
curl -L -o ~/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

## Options

Set these in `/config`, or under `pluginConfigs["agent-brief"].options` in settings.

| Option | Default | Meaning |
| --- | --- | --- |
| `inboxDir` | `~/Downloads/feedback-inbox` | Folder to watch |
| `nodePath` | `node` | Node binary that runs the CLI |
| `transcriber` | `yap` | `yap` or `whisper` |
| `whisperModel` | empty | ggml model path for whisper |
| `companionSocket` | empty | Companion socket. Empty means `~/Library/Application Support/AgentBrief/agent-brief.sock` |
| `companionLaunch` | `open -a "Agent Brief"` | Shell command (`sh -c`) that starts Agent Brief |

## The Agent Brief app

The mod links each session to the Agent Brief sketch panel over a Unix socket. It speaks the protocol in `hooks/companion-protocol.ts`, which is copied from `companion/src/protocol.ts`. Nothing here needs the app to run. Every failure is silent apart from the debug log.

### Session link

- At `session.start` the mod registers the session (`POST /sessions` with id, folder and title) once `/health` answers. It registers again every 60 s, and again whenever the app comes back after being down.
- At `session.end` it sends `DELETE /sessions/<id>`.
- A loop long-polls `GET /deliveries?session=<id>&wait=25`. While the app is down, the loop checks `/health` after 5 s, then 10 s, 20 s and 30 s, and keeps checking every 30 s.
- A delivery is acknowledged after it lands. The mod remembers delivered ids, so a delivery the app lists twice (for example after a failed ack) is never filled or sent twice.

### Delivery modes

| Mode | What happens | Toast |
| --- | --- | --- |
| `fill` | The draft goes into the prompt box. You edit it and press Enter. | Sketch from Agent Brief is ready — press Enter |
| `submit` | The draft is sent at once as if you typed it. | Sent sketch to Claude |

A fill never replaces the box. If the box is empty, the draft goes in as it is. If you have typed something, the draft is appended after a blank line, and your text stays where it is. If the box refuses the fill (a dialog is open, or the session is headless), the mod does not acknowledge the delivery and tries again every 2 s until the box accepts it.

### `/sketch [what to draw or ask]`

1. Checks `/health`. If the app is down, runs `companionLaunch` and checks `/health` every 250 ms for 10 s.
2. If the app never answers, replies with the launch command and the socket path, and points at the `companionLaunch` and `companionSocket` settings.
3. Registers the session, then opens the panel with this session as the Send target. Any text after `/sketch` shows at the top of the panel.
4. Replies `Agent Brief open — sketch, then press Send.`

### Skill

`skills/sketch-board/SKILL.md` teaches Claude to draw on and read the board with the `agent-brief` CLI.

## Command line

The mod's CLI also works on its own:

```sh
node bin/ingest.mjs <zip> --project <dir> [--transcriber yap|whisper] \
  [--whisper-model <path>] [--yap <bin>] [--ffmpeg <bin>] [--whisper <bin>]
```

It prints one JSON line, either `{ ok: true, name, dir, reportPath, screenshots, counts }` or `{ ok: false, error }` with exit code 1.

## Development

- Rebuild the CLI from the extension repo with `pnpm build:mod`. It bundles `extension/tools/ingest` with the extension's own renderer.
- `claude plugin validate .` checks the mod.
- `claude plugin test .` runs the tests in `tests/`.
- `node tests/live/run-live.mjs` runs a live check. It starts a real companion server and an interactive Claude Code in tmux, and checks registration, fill delivery, typed-text safety, `/sketch` and exit. It needs tmux and the companion repo's esbuild, and it sends nothing to the model. It uses a temp inbox so it never touches `~/Downloads/feedback-inbox`.
