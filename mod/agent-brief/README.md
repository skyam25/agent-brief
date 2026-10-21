# agent-brief

The Agent Brief plugin for Claude Code. It opens the sketch board for a session with `/sketch`, or the board in its Stack layout for screenshots with `/stack`, or a new note with `/write`, or the matching button above the prompt, and delivers what you send. With `/track` it has Claude keep a list of items you answer in the panel. With `/mode` it sets how Claude works in this session. With `/initiative` it attaches the session to an initiative whose brief Claude reads and keeps current. It also picks up feedback sessions exported by the companion Chrome extension. It transcribes them on this machine, writes them into the project, and hands them to Claude.

## How it works

1. The extension drops `<session>.zip` into `~/Downloads/feedback-inbox/` when a recording stops. It waits there.
2. Run `/apply-feedback [name]` in the project the recording belongs to. The mod claims each waiting zip by moving it to `processing/`. A failed move means another Claude Code session claimed it, so this one skips it.
3. The mod runs `bin/ingest.mjs`. The CLI unzips the file, converts each audio chunk to WAV with ffmpeg, transcribes it with yap, splits it into one line per sentence, and re-renders `report.md`. A line above the prompt shows progress.
4. The output lands in `<project>/.feedback/<session>/`, and `.feedback/` is added to the project's `.gitignore`.
5. The zip moves to `done/`, or to `failed/` with a toast saying why.
6. The mod submits a prompt that applies the newest session, or the named one.

Recordings never land in a project on their own, so a session open in another project cannot pick them up. `/apply-feedback` with nothing in the inbox applies the newest unapplied session already in `.feedback/`. Claude can also read sessions through the `feedback_latest` and `feedback_list` tools.

## Setup

Install the mod one of three ways.

- **With the Agent Brief app.** Pick Install Claude Code Plugin… from the Agent Brief menu or the menu bar icon. It registers the plugin and links the `agent-brief` command into `~/.local/bin`. Claude Code reads both from inside the app, so they update with it. The [project README](../../README.md#set-up) walks through first run.
- **Without the app.** Run `/plugin marketplace add skyam25/agent-brief`, then `/plugin install agent-brief@agent-brief`. Talk, `/mode`, `/grill` and `/apply-feedback` work alone. The panel commands need the app.
- **From a checkout.** `claude --plugin-dir <checkout>/mod/agent-brief` loads it for one session. For every session, run `/plugin marketplace add <checkout>`, then `/plugin install agent-brief@agent-brief` if the plugin is not installed yet. `/reload-plugins` then picks up edits. Adding the checkout replaces the app's registration until you pick Install Claude Code Plugin… again.

New sessions load the mod. In a session that is already open, run `/reload-plugins`.

Some features need more:

| Feature | Needs |
| --- | --- |
| 🎙 Talk | yap (`brew install yap`) |
| `/apply-feedback` | yap and ffmpeg (`brew install yap ffmpeg`), since yap refuses WebM. Node 20 or newer on `PATH`, or set `nodePath` |
| Browser recordings | The companion Chrome extension, not public yet. Turn off Chrome's Settings › Downloads › "Ask where to save each file before downloading", or every export opens a save dialog |

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
2. If the app never answers, replies with the launch command and the socket path, points at the `companionLaunch` and `companionSocket` settings, and links the app download.
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
- The **¶ Write** button moves the prompt box's draft into the note and empties the box. Large pastes, which the box shows as `[Pasted text #1 +N lines]`, go in as the text they held. Pasted images stay behind as `[Image #N]`, because the plugin cannot read their bytes. With the box empty, it takes Claude's last reply, as `/write last` does, and opens an empty note before Claude has replied.
- Under the last block of each finished reply of more than one line, a quiet row offers **Copy**, which puts the reply on the clipboard, and **Open as note**, which starts a note with it.
- The same row offers **Review** for each HTML page the reply names that exists, **Open** for each Markdown output it names, and **Open** for each note the turn filed with `agent-brief note`, up to three pages. A one-line reply carries only these opens.
- For text you will paste elsewhere, such as a message, an email or a post, the outputs prompt section tells Claude to run `agent-brief note "<title>"` with the Markdown on stdin. The note lands under this session without opening the panel, and its Copy button puts it on the clipboard as rich text. The command prints an `agent-brief open --note <id>` line, which Claude runs when you ask to see the note. When you ask for changes, Claude replaces the note in place with `agent-brief note --id <id>`, so you keep one copy. If the command fails, Claude prints the text.
- When you ask to see an output in Agent Brief, the outputs prompt section tells Claude to run `agent-brief open --output <path>`. A Markdown file opens as a note in Write and an HTML file in the review pane. Declaring a Markdown or HTML output answers with that command, so Claude learns it when it needs it. A bare `agent-brief open` from a session reopens the board or note that session last had open. A session with neither leaves the panel as it is, and no new board is made.

Starting text needs Agent Brief 0.2.3 or newer.

The band above the prompt has a button for each panel mode, **✎ Sketch**, **▤ Stack** and **¶ Write**, a **🎙 Talk** button for dictation, a **◇ Mode** button that picks the session mode until the session's first prompt, and a **▣ Brief** button that opens the Brief pane. While the session is attached to an initiative, the band ends with **Attached Pricing · change**. Without one, it ends with **attach initiative** whenever there are initiatives to pick.

### Dictation

**🎙 Talk** puts what you say into the prompt box. It needs no app, only yap (`brew install yap`). Speech is transcribed on this Mac with Apple's on-device model.

- Press ctrl+x then Tab to focus the band, then `v`. The button turns to **■ Stop** and a timer shows **Listening 0:07**.
- Press `v` again to stop. The words go in at the cursor, with a space where they meet a word, as typing would. Edit them, then press Enter. Nothing is sent on its own.
- yap prints its transcript only once it stops, so nothing shows while you talk.
- Dictation stops itself after 5 minutes.
- The first run asks for microphone access on behalf of your terminal app.
- If the box refuses the text, as under a dialog, it goes on the clipboard instead.
- yap hears the whole room, so other voices and video audio land in the transcript too.

### The Brief pane

**▣ Brief** (hotkey `b`) opens a pane beside the transcript, and a second press closes it. The pane never opens on its own. It is a place to look things up and make short decisions; the app stays the place to sketch and write.

- The button counts the Ready outputs, the items waiting on you and Claude's open questions, and names the mode outside default, such as **▣ Brief 3 · Prototype**.
- The header reads **Brief · <project folder>**, with a Mode Select at the right. Prototype adds a second Select for the fidelity, and the mode applies once you pick one. It does what `/mode` does, so the app's chip follows.
- **Outputs** lists the declared outputs with their status, Drafting or Ready, and folds the touched files under **Touched (n)**, last written first. Each row says how long ago it was last declared or written, such as `4m ago`. **Open** opens a file in its default app, or a link in the browser. **In Agent Brief** opens a Markdown file as a note in Write, or an HTML file in the review pane. It needs Agent Brief 0.3.1 or newer; an older app opens the board and the mod says to update.
- **Questions** shows up between Outputs and Items when Claude asks something. See [Questions and `/grill`](#questions-and-grill-onoff).
- **Items** lists the open items from the items file, with **☑ Track** or **☐ Track** in its header and the done items folded under **Done (n)**. Each row shows Claude's latest line, a control to answer it, and your latest answer.
- The control follows Claude's line. `A or B?` with two short clauses, or `A / B` with up to four short options, gives a button each. Any other question gives a text field, and Enter holds what you typed. A line that asks nothing is a proposal, with **Agree** beside a field.
- Answers wait in the pane until **Send answers**. Send appends your `You:` lines to the items file and sends the decisions as one prompt, as the app's Send does. An item answered in the app in the meantime keeps that answer, and the pane drops its own.
- Seated inline above the prompt on a narrow terminal, the pane draws one line, such as `▣ Brief · 2 ready · 1 drafting · 2 items waiting · Prototype`, with **Open** for the Ready outputs only. Open shows a Markdown or HTML output in Agent Brief, and any other file in its default app. **▸ Expand** draws the full Brief there, and **▾ Collapse** returns to the line. A round of `ask_questions` expands it.
- The pane redraws when Claude writes the outputs or the items file, and reads the items file again after each turn, so answers from the app show up too.

### Questions and `/grill [on|off]`

Claude can ask a short round of questions with the `ask_questions` tool. Each question is one of three kinds, and the pane draws a control for each.

| Kind | Control |
|---|---|
| `options` | A button per option |
| `select` | A Select, or buttons on mobile |
| `text` | A text field. Enter holds what you typed |

- A round holds 1 to 8 questions. `options` and `select` take 2 to 6 choices.
- The section reads **Questions · from Claude · N**. A held answer shows on its row with **Clear**.
- The section has its own **Send answers**. It sends one prompt that starts `Answers to your questions:`, with a `- <question>: <answer>` line each, then clears the section. A question you skipped goes out as `(no answer)`. Items keep their own Send.
- Asking again replaces the questions you have not answered yet. Answered ones stay until Send.
- The tool opens the Brief pane from 144 columns, or from 110 once you have opened it before. Below that a toast says the questions wait and to press `b`. Over an empty prompt the pane takes the keyboard, so Up and Down walk the options.
- `/grill` tells Claude to interview you before it starts on an underspecified request. It asks three to five questions a round, with choices where the answer space is small, and starts as soon as it can. `/grill off` stops it. Both reply with the state they leave.
- When a policy refuses plugin tools, `/grill` still works and Claude asks its questions in the reply instead.

### Item tracking and `/track [on|off]`

Item tracking is off for every session until you turn it on. While it is off, the mod adds nothing to Claude's prompt.

- Turn it on with the **Track items** switch in the panel, the **☐ Track** button in the Brief pane's Items header, or `/track`. `/track on` and `/track off` set it, and a bare `/track` flips it.
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

Claude puts questions on items instead of asking in the chat. It adds an `Out:` line for each file or screenshot it writes for an item as soon as the file exists, and the panel shows those as links. You answer them in the panel or the Brief pane, and Send delivers your decisions as a prompt like this:

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

### Initiatives and `/initiative`

An initiative is work that runs across many sessions, such as a pricing change. Its brief is a Markdown file in the initiative's folder, `<Title> brief.md`, which the app indexes. Claude keeps the brief current and you edit it in the app's Initiative tab. Nothing reaches Claude until the session is attached.

| Command | Does |
|---|---|
| `/initiative` | Claude drafts an initiative from this session: a title, Understanding, Working rows from the Ready outputs and a folder map. It creates the brief, then attaches the session. |
| `/initiative <name>` | Claude attaches the session to the initiative you name. Your choice wins over its own match. |
| `/initiative off` | Detaches the session, and tells Claude to stop maintaining the brief. No model turn. |
| `/initiative refresh` | Hands Claude the current snapshot now, without a model turn. |
| `/initiative discover` | Claude surveys this folder and lists likely initiatives. It creates nothing until you pick. |

- `/initiative` never starts the app. Every form but `discover` needs it running, and says so otherwise.
- When the session registers, the mod reads the three initiatives touched most recently. While the session has none attached, its first prompt carries one line after your text: `Agent Brief · recent initiatives: Pricing, Onboarding, Checkout. If this work belongs to one, run agent-brief initiative attach <name>.` Claude attaches when the work clearly belongs to one. The line comes once per session, and not in a resumed one.
- Once attached, a typed prompt carries the initiative's snapshot after your text, between `--- Agent Brief initiative ---` lines: Understanding (at most 2,400 characters), Decisions, Open and the folder map. It goes only when the token `attachmentRevision:id:revision` changed since the last one, so an unchanged brief costs nothing. It never goes in the system prompt, and slash commands carry none.
- A compaction drops the snapshot, so the next prompt carries it again. Where an organization manages Claude Code, the compaction event passes over plugins a person installs; run `/initiative refresh` after a compaction there.
- A detach, from the band, the app or the CLI, gets one note to Claude with the next prompt.
- **change** or **attach initiative** on the band (hotkey `i`) swaps the row for a pick of three, the attached initiative first and then the most recent, with **Detach** while one is attached, and **Cancel**. A pick attaches the session at once.
- The Brief pane's header has an **Initiative** Select that lists **None** and up to 20 initiatives, most recent first. A pick attaches the session, and **None** detaches it. A pick the app refuses toasts why and goes back to the attachment the app holds. The pane reads the list and the attachment again when it opens and each minute while it stays open. On a surface without fields, or with no initiatives, the line reads the title and revision, or **Initiative · none**.
- When Claude runs an `agent-brief initiative` command, the band reads the attachment again.
- The `initiative-brief` skill tells Claude when to attach, how to keep the brief short and current, how to draft one and how to run Discover. In the brief and in its replies, Claude names folders by role (Sources, Decisions, Working, Grounding, Outputs), not by their names.

Claude works through these CLI verbs:

```sh
agent-brief initiative list
agent-brief initiative recent [--limit 3]
agent-brief initiative find <words>
agent-brief initiative show <id or title>
agent-brief initiative attach <id or title> [--session <id>]
agent-brief initiative detach [--session <id>]
agent-brief initiative create <title> --folder <path> [--file draft.json]
agent-brief initiative update <id> --file <json>
```

Reads work with the app closed. Writes exit 3 while it is down.

The mod's socket calls: `GET /initiatives/recent?limit=20` at registration, when the pick row opens and when the Brief pane draws, with `GET /sessions/<id>/initiative` beside it, `GET /sessions/<id>/initiative` on each typed prompt while the app is up, `PUT /sessions/<id>/initiative` with `{ initiativeId }` from the pick row and the pane's Select, and `DELETE /sessions/<id>/initiative` from **Detach**, **None** and `/initiative off`. Every failure is silent, and the prompt goes in as typed. The types are in `hooks/companion-protocol.ts`. Initiatives need an Agent Brief app with the Initiative tab; an older app answers 404 and the mod adds nothing.

### Pictures in the chat

The `show_image` tool draws a picture inline in the transcript, where the terminal can (Ghostty, kitty). Claude uses it after visual work: a Playwright screenshot of a page it changed, a board it drew on, a design it made. The picture goes to the screen, not to Claude, so it costs no tokens.

An organization policy can refuse plugin tools, which removes `show_image`, `declare_output` and `ask_questions`. The commands stay. Claude then runs `agent-brief show <file>` and `agent-brief output <title> --path <file>` with Bash, and the plugin draws or records them from the command's result. The transcript normally folds shell commands into one count line. A run that holds a picture stays unfolded, so the picture shows without ctrl+o.

- The row holds the picture with Open page (or Open), Open board when `board` is set, Show in Finder and Copy path. Open board starts the app when needed, as `/sketch` does.
- `options` with 2 to 4 pictures draws one sheet with the options side by side, lettered A to D, and a Pick button for each. A tab per option shows it alone at full size, and All goes back to the sheet. Pick puts "Go with option B (Title)" in the prompt box, after anything already typed, and you press Enter.
- Each shown file is copied into `<project>/.feedback/shown/`, converted to PNG with `sips` when it is not one, so the row keeps its picture after a temp folder is cleared. The newest 40 of each kind (`.png`, `.svg`, `.wireframe`) stay. A `.gitignore` of `*` in `.feedback/` keeps the folder out of git.
- A missing or unreadable file draws a notice with a Copy prompt button. A terminal that cannot draw pictures draws one with the way back, and the system prompt tells Claude the picture was not seen. In tmux, `set -g allow-passthrough on` is needed.
- A wireframe needs no file. Claude passes a wireframe DSL block as `wireframe` (or SVG text as `svg`, or a `.svg` or `.wireframe` path). The mod renders it with `bin/wireframe-render.mjs`, rasterizes the SVG with `rsvg-convert` (`brew install librsvg`) or, without it, a QuickLook thumbnail cropped to the SVG's shape, and keeps the `.wireframe`, `.svg` and `.png` together in `.feedback/shown/`. A block that fails to parse comes back to Claude as an error naming the line. `options` take wireframes too, so a choice of directions draws as tabs with Pick.
- `/show <path>` opens a picture in a pane without asking Claude.

The renderer and the `wireframe` skill are copies from [wireframe-dsl](../../../wireframe-dsl) (`helpers/wireframe-render.mjs` and `skills/wireframe/`, commit ec57f61). To refresh them, run `npm run build` there and copy both over; the skill's only edits are the renderer path (`bin/`) and the "Show it in the chat first" section.

### Skills

`skills/initiative-brief/SKILL.md` teaches Claude to attach a session to an initiative and keep its brief, as above.

`skills/sketch-board/SKILL.md` teaches Claude to draw on and read the board with the `agent-brief` CLI, and to post a browser session it drives as numbered screenshots with `agent-brief snap`, which needs Agent Brief 0.2.5 or newer.

## Modes

A session mode sets how Claude works in that session. The mod owns it and works without the app, which only shows it.

| Mode | What Claude does | Tools |
| --- | --- | --- |
| `default` | Runs as Claude Code does without the mod | Untouched |
| `product` | Discovery, analysis, specs, acceptance criteria, go-to-market; code investigation and research as needed | Every tool stays where Claude Code puts it. An Edit, Write or NotebookEdit on a source file asks you first, in the main loop and in subagents. Documents write freely. |
| `prototype` | Fast, disposable prototypes at a chosen fidelity | Untouched |
| `orchestrate` | Splits the work and hands each task to a subagent | Edit, Write and NotebookEdit are denied in the main loop. Subagents can still edit. |

Product mode is a posture with one soft guard. Its prompt leans Claude toward documents and delegated implementation, and a source edit goes to the permission dialog with the reason `Product mode: this edits app.ts, which is source, not a document.` Approve it when you asked for that file, such as a generated HTML page, and refuse it when Claude wandered into the app. No mode switch is needed. The guard is extension-based, not a filesystem sandbox: Markdown, MDX, text, CSV, JSON, YAML and anything under `.feedback/` pass without asking, and it does not intercept shell writes. In a permission mode that skips dialogs, an ask becomes an allow and the posture is the only brake.

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
- The **◇ Mode** button (hotkey `m`) shows until the session's first prompt, and a resumed session starts without it. After that, the Brief pane's Mode Select and `/mode` set the mode. The button opens a picker row. Prototype opens a second row for the fidelity. The button shows the mode, such as **◇ Prototype · styled HTML**, in the accent color outside default.
- A folder default lives in `.claude/agent-brief.local.md`. The mod looks in the session folder, then each parent up to and including your home folder, and the first file found wins. It reads `mode:` and `fidelity:` from the frontmatter and ignores invalid values. A prototype with no valid fidelity is ignored, so that session opens in default.

  ```markdown
  ---
  mode: prototype
  fidelity: wireframe
  ---
  ```

- A mode set in the session outlives a plugin reload. The folder default applies only to a session that has not set one.
- Default mode is untouched Claude Code. The mode adds no prompt section and guards nothing. The outputs section is separate and always present.
- The mod never changes the project's output style. Mode rules and prototype fidelity remain in the prompt with any output style.
- Each other mode adds one short section to the system prompt, after the prompt cache boundary. Its text depends only on the mode and fidelity. No mode moves tools behind ToolSearch, since Claude Code defers the rarely used ones itself. Switching mid-session changes that section, so the next turn re-reads the conversation without the cache.

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
- `node tests/live/initiative.mjs` checks the band's **Attached · change** and **attach initiative**, the pick row, the Brief pane's Initiative Select and `/initiative off` and `refresh` against a stub app, then stops the stub and checks `/initiative` still answers. `COLS=110` sets the width. It sends nothing to the model, and stops a model turn if one starts.
