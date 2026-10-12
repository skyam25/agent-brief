# agent-brief

The Agent Brief plugin for Claude Code. It opens the sketch board for a session with `/sketch`, or the board in its Stack layout for screenshots with `/stack`, or a new note with `/write`, or the matching button above the prompt, and delivers what you send. With `/track` it has Claude keep a list of items you answer in the panel. With `/mode` it sets how Claude works in this session. It also picks up feedback sessions exported by the companion Chrome extension. It transcribes them on this machine, writes them into the project, and hands them to Claude.

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
- **Install the mod:** with the Agent Brief app, pick Install Claude Code Plugin… from its menu. Claude Code then reads the plugin from inside the app, so it updates with the app. Without the app, run `claude plugin marketplace add skyam25/agent-brief` once, then `claude plugin install agent-brief@agent-brief`. From a checkout, add the repository folder instead; the plugin is then read from it, so `/reload-plugins` picks up edits.
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
- `/track` sends `PATCH /sessions/<id>` with `{ trackItems }`. Each system prompt reads `GET /sessions/<id>` for `trackItems` and `itemsPath`.
- A mode change sends `PATCH /sessions/<id>` with `{ mode, fidelity? }`, and so does the first registration of a session outside default mode. The app shows the mode; it never sets it.
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

### `/stack [what to capture or ask]`

The Stack button above the prompt does the same. Works like `/sketch`, but sets the board to the Stack layout and replies `Agent Brief open in Stack — drop or paste screenshots, talk, then press Send.`

- Each drop or paste of screenshots becomes a numbered group, one group per row, newest at the bottom.
- Dropping on a group, or pasting while a group is selected, adds to that group. Dragging a picture out to empty space gives it its own group.
- Speech stays on the timeline. Send names each picture by its group, such as `2a`, so Claude can match what was said to what was pasted.
- Needs an Agent Brief app with Stack. An older app opens the board as it is.

### `/write [text | last]`

Works like `/sketch`, but opens Write mode on a new note instead of the board, and replies `Agent Brief open — write, then press Send.`

- Text after `/write` starts the note.
- `/write last` starts it with Claude's newest reply, to edit and send back.
- The note is filed under this session, so it shows on the session's tab in the panel rather than in Notes.
- The **¶ Write** button moves the prompt box's draft into the note and empties the box. Large pastes, which the box shows as `[Pasted text #1 +N lines]`, go in as the text they held. Pasted images stay behind as `[Image #N]`, because the plugin cannot read their bytes.

Starting text needs Agent Brief 0.2.3 or newer.

The band above the prompt has a button for each panel mode, **✎ Sketch** and **¶ Write**, a **☐ Track** toggle that does what a bare `/track` does, and a **◇ Mode** button that picks the session mode.

### Item tracking and `/track [on|off]`

Item tracking is off for every session until you turn it on. While it is off, the mod adds nothing to Claude's prompt.

- Turn it on with the **Track items** switch in the panel, the **☐ Track** button above the prompt, or `/track`. `/track on` and `/track off` set it, and a bare `/track` flips it.
- The button reads **☑ Track** in the accent color while tracking is on. It picks up a change made in the panel on the next prompt.
- `/track` never starts the app. When the app is down it replies `Agent Brief is not running. Start it, then run /track again.`
- With tracking on, each system prompt gets a section that tells Claude to keep `<project>/.feedback/items/<session id>.md`. Claude writes the file only when the work has distinct items, such as several asks, a feedback list or numbered marks on a sketch.
- The mod reads the state with one `GET /sessions/<id>` per prompt while the app is up. If the app stops answering, the mod keeps the last state it read.

Claude writes the file in this format, and never edits a `You:` line:

```markdown
# Items · <short title>

- [ ] #1 <title>
      Claude: <what Claude proposes, a question, or two options>
      You: <your decision>
      Out: <a file Claude is writing for it, relative to the project>
- [x] #2 <title>
      Claude: done · <what changed>
      Out: <path>
```

Claude puts questions on items instead of asking in the chat. It adds an `Out:` line for each file or screenshot it writes for an item as soon as the file exists, and the panel shows those as links. You answer them in the panel, and Send delivers your decisions as a prompt like this:

```text
Decisions on 2 items in .feedback/items/<id>.md:
#2 Sidebar rows too tight: 44 / 12
#3 Confirm copy: Pay $36
```

Every reply that changed an item ends with two lines, `Done: #…` and `Open: #…`, with `none` for an empty list.

Item tracking needs Agent Brief 0.2.6 or newer, which serves `GET` and `PATCH /sessions/<id>`. On an older app, `/track` says to update, and the prompt stays unchanged.

### Outputs and `/outputs`

The panel lists each session's deliverables under that session. The mod records them in `<project>/.feedback/outputs/<session id>.json`, and it is the only writer. It works with the app closed.

- **Declared:** Claude calls the `declare_output` tool with a `title` and either a `path` relative to the project or a `url` for an artifact or published page. It declares with status `drafting` when it starts the deliverable and again with `ready` when it is done. The tool answers with one line and never toasts.
- **Touched:** a hook on Write, Edit and NotebookEdit records every document-type file the session writes, subagents included. The types are Markdown, HTML, PDF, Word, PowerPoint and Excel. Files outside the project, and files under `.feedback/`, `.claude/` or `node_modules/`, are never recorded. A denied or failed write records nothing, and a failure to record never blocks the tool.
- A record marks a file `created` when the session made it or a Write replaced more than half of it, and `edited` otherwise. It also counts the writes.
- A declare on a file the hook already saw moves it from touched to declared and keeps its write count.
- Each system prompt carries a short section that tells Claude when to declare. Claude declares the thing you asked for, one primary output per request, and never code, config or tests.
- `/outputs` prints the declared outputs, newest first, then the touched ones.

### Pictures in the chat

The `show_image` tool draws a picture inline in the transcript, where the terminal can (Ghostty, kitty). Claude uses it after visual work: a Playwright screenshot of a page it changed, a board it drew on, a design it made. The picture goes to the screen, not to Claude, so it costs no tokens.

- The row holds the picture with Open page (or Open), Open board when `board` is set, Show in Finder and Copy path. Open board starts the app when needed, as `/sketch` does.
- `options` with 2 to 4 pictures draws one sheet with the options side by side, lettered A to D, and a Pick button for each. A tab per option shows it alone at full size, and All goes back to the sheet. Pick puts "Go with option B (Title)" in the prompt box, after anything already typed, and you press Enter.
- Each shown file is copied into `<project>/.feedback/shown/`, converted to PNG with `sips` when it is not one, so the row keeps its picture after a temp folder is cleared. The newest 40 copies stay.
- A missing or unreadable file draws a notice with a Copy prompt button. A terminal that cannot draw pictures draws one with the way back, and the system prompt tells Claude the picture was not seen. In tmux, `set -g allow-passthrough on` is needed.
- A wireframe needs no file. Claude passes a wireframe DSL block as `wireframe` (or SVG text as `svg`, or a `.svg` or `.wireframe` path). The mod renders it with `bin/wireframe-render.mjs`, rasterizes the SVG with `rsvg-convert` (`brew install librsvg`) or, without it, a QuickLook thumbnail cropped to the SVG's shape, and keeps the `.wireframe`, `.svg` and `.png` together in `.feedback/shown/`. A block that fails to parse comes back to Claude as an error naming the line. `options` take wireframes too, so a choice of directions draws as tabs with Pick.
- `/show <path>` opens a picture in a pane without asking Claude.

The renderer and the `wireframe` skill are copies from [wireframe-dsl](../../../wireframe-dsl) (`helpers/wireframe-render.mjs` and `skills/wireframe/`, commit ea2b72e). To refresh them, run `npm run build` there and copy both over; the skill's only edits are the renderer path (`bin/`) and the "Show it in the chat first" section.

### Skill

`skills/sketch-board/SKILL.md` teaches Claude to draw on and read the board with the `agent-brief` CLI, and to post a browser session it drives as numbered screenshots with `agent-brief snap`, which needs Agent Brief 0.2.5 or newer.

## Modes

A session mode sets how Claude works in that session. The mod owns it and works without the app, which only shows it.

| Mode | What Claude does | Tools |
| --- | --- | --- |
| `default` | Runs as Claude Code does without the mod | Untouched |
| `product` | Discovery, analysis, specs, acceptance criteria, go-to-market; code investigation and research as needed | Read, search, Bash and Agent stay available. Browser tools, NotebookEdit, LSP and Workflow wait behind ToolSearch. Source edits through Edit, Write and NotebookEdit are denied, including in subagents. |
| `prototype` | Fast, disposable prototypes at a chosen fidelity | Browser tools load up front. NotebookEdit, LSP and Workflow wait behind ToolSearch. |
| `orchestrate` | Splits the work and hands each task to a subagent | Edit, Write and NotebookEdit are denied in the main loop and wait behind ToolSearch. Subagents can still edit. |

Product mode allows implementation recommendations and delegated code analysis. Its prompt keeps application source and configuration unchanged through all tools; builds and tests require a user request. Implementation requires switching modes. The edit hook is an extension-based guardrail, not a filesystem sandbox: Markdown, MDX, text, CSV, JSON, YAML and anything under `.feedback/` pass it, and it does not intercept shell writes. The prompt's source/config restriction still applies to those paths and tools.

Orchestrate delegates all file writes, including item tracking, and keeps the main session read-only across tools.

Prototype takes a fidelity rung:

| Fidelity | Alias | Picker label |
| --- | --- | --- |
| `wireframe` | `wire` | Wireframe |
| `styled` | `html` | Styled HTML |
| `live-patch` | `live` | Live patch |
| `freeze-patch` | `freeze` | Freeze + patch |
| `interactive` | `inter` | Interactive |
| `existing` | `iterate` | Match existing |

- `/mode` reports the current mode. `/mode product`, `/mode orchestrate` and `/mode default` set one. `/mode prototype <fidelity>` sets prototype at that rung.
- The **◇ Mode** button (hotkey `m`) opens a picker row. Prototype opens a second row for the fidelity. The button shows the mode, such as **◇ Prototype · styled HTML**, in the accent color outside default.
- A folder default lives in `.claude/agent-brief.local.md`. The mod looks in the session folder, then each parent up to and including your home folder, and the first file found wins. It reads `mode:` and `fidelity:` from the frontmatter and ignores invalid values. A prototype with no valid fidelity is ignored, so that session opens in default.

  ```markdown
  ---
  mode: prototype
  fidelity: wireframe
  ---
  ```

- A mode set in the session outlives a plugin reload. The folder default applies only to a session that has not set one.
- Default mode is untouched Claude Code. The mode adds no prompt section, moves no tool and denies nothing. The outputs section is separate and always present.
- The mod never changes the project's output style. Mode rules and prototype fidelity remain in the prompt with any output style.
- Each other mode adds one short section to the system prompt, after the prompt cache boundary. Its text depends only on the mode and fidelity. Switching mid-session changes that section and the tool list, so the next turn re-reads the conversation without the cache.

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
