# Agent Brief

Brief Claude Code the way you would brief a person. Sketch on a board, paste screenshots, point and talk, or write a note, then hand it all to the session in one press. Claude works on the same surfaces. It draws back on your board, hands you what it made to review, and asks for the decisions it needs.

Agent Brief is a Mac panel and a Claude Code plugin. Everything runs on your Mac.

## How it works

1. **Capture.** Open the panel from a session with `/sketch`, `/write` or the buttons above the prompt. Draw, talk, paste or write.
2. **Send.** Send writes a bundle into the project and puts a prompt that points at it into the session.
3. **Claude works.** It reads the bundle, draws on the board, writes outputs and keeps a list of open items.
4. **Review and answer.** You comment on what it made, answer its questions, and Send again.

## Set up

You need a Mac with Apple Silicon and [Claude Code](https://claude.com/claude-code).

1. Download the latest [release](https://github.com/skyam25/agent-brief/releases/latest), unzip it, and move Agent Brief.app into Applications. Open it from there. It updates itself.
2. Pick **Install Claude Code Plugin…** from the Agent Brief menu or the menu bar icon. It registers the plugin with Claude Code and links the `agent-brief` command into `~/.local/bin`. Both load from inside the app, so they update with it. If the dialog says `~/.local/bin` is not on your PATH, add the line it shows to `~/.zshrc`.
3. Start a new Claude Code session, or run `/reload-plugins` in one that is open. Buttons for Sketch, Stack, Write, Talk, Mode and Brief appear above the prompt.
4. Run `/sketch`, draw something, and press Send. The drawing lands in the session as a prompt.

Optional extras:

- **Voice.** Run `brew install yap ffmpeg`. Talk above the prompt needs yap. Voice in the panel needs both.
- **Herdr.** Claude Code skips pictures inside [Herdr](https://herdr.dev). Run `agent-brief herdr-pictures on` once, then start Claude in a new pane.
- **Plugin without the app.** Run `/plugin marketplace add skyam25/agent-brief`, then `/plugin install agent-brief@agent-brief`. Talk, `/mode`, `/grill` and `/apply-feedback` work alone. The panel commands need the app and say where to get it.
- **Browser recordings.** `/apply-feedback` reads recordings from the companion Chrome extension, which is not public yet.

## The panel

| Mode | Key | For |
|---|---|---|
| Sketch | ⌘1 | A whiteboard for strokes, screenshots, voice and comment pins |
| Write | ⌘2 | Notes and briefs, with templates |
| Review | ⌘3 | Claude's outputs, your reviews of them, feedback on them, and the session's items |
| Initiative | ⌘4 | Standing briefs for work that runs across many sessions |

- The sidebar lists Unfiled, then one entry per Claude Code session. Each session holds its own boards, notes and items.
- Send goes to the session you are on. On Unfiled or an ended session, Send asks where to go. The app never guesses.
- An ended session keeps its work and offers a command to resume it.
- The last 10 sends stay in History, ready to reopen.

## Sketch and talk

- The board floats above your other windows on a hotkey. Pen pressure sets the stroke, and a pasted screenshot lands ready to mark up.
- **Talk and annotate** (⌥T) opens the mic and the comment tool together. Click a shape to pin a comment, and what you say lands on that pin.
- Turn the comment tool off with C to record plain voice. Speech and strokes share one clock, so "this one" points at what you drew as you said it.
- **Stack** lays pasted screenshots out in numbered groups, so you can drop screens and talk without arranging them.
- Transcription runs on your Mac. Audio never leaves it.

## Write

- A note saves as you type and can hold headings, tables, screenshots and a board.
- Templates are Markdown files with `{{slots}}`. Pick one with `/`.
- Copy puts a note on the clipboard as rich text for Slack, Mail or Docs.
- When Claude drafts a message or an email for you, it lands as a note under the session, ready to edit and copy.

## What Claude receives

Send writes a folder under `<project>/.feedback/sketches/`:

| File | Holds |
|---|---|
| `sketch.png` | The board, with strokes numbered, screenshots lettered and pins badged |
| `board.excalidraw` | The full scene, so Claude can read every element |
| `timeline.md` | Strokes, pastes and speech in order, each tied to what it was about |
| `comments.md` | Each pin's words and the element it marks |
| `transcript.json`, `audio/` | The speech with its timing, and the clips |

A timeline reads like this:

```
[00:03] pasted image A · top left · large
[00:12–00:19] 🎙️ "I don't like that icon style." — nearest: image A, pasted 9s before
```

## Claude answers back

- **On the board.** Claude draws shapes, notes, arrows and frames with the `agent-brief` command line tool. It reads the board as text, and posts the steps of a browser session as numbered screenshots you can mark up.
- **Outputs.** Claude declares the doc, page or prototype you asked for, and Review lists it as Drafting or Ready.
- **Items.** With `/track` on, Claude keeps the work's open items in a file. You answer them in Review and send your decisions back.
- **Questions.** Claude can ask a short round of questions, each with its own answer control.
- **Pictures.** Claude shows screenshots, boards and wireframes inline in Ghostty and kitty.

## Review

- A Markdown output opens as a note. Edit it and press Send, and Claude applies your changes to the file.
- An HTML output opens live. Pin comments to its elements, or talk instead of typing. Edit mode moves, resizes and retypes elements in the file itself. Send hands Claude a `review.md`.
- A prototype can carry behavior rules. Confirm or reword them in the Behavior tab, then export acceptance criteria for engineering.

## Feedback rounds

For a research loop on a prototype or a doc, with SME or customer feedback over several rounds and sessions.

- Hand Claude a transcript and the output. Claude catalogs every point as an item in `<output>.feedback.md` beside the output, with the quote, the speaker and the time. It changes nothing yet.
- Press ▣ Brief, then In Agent Brief on the output. Review opens it on the Feedback tab. Accept, reject or pick an option for each item. Add a note, a voice note or pins, or open the item's workspace to draw. Then press Send decisions.
- Claude makes the accepted changes, takes before and after pictures of the element, commits, and logs each item as done with its commit.
- A later transcript joins repeats to their items, flags closed items that come up again, and links related items across outputs. If Claude changes a proposal after you accept it, you decide again.
- Every decision and change is a dated line in the file, so you can trace any change back to the quote that asked for it.
- The Graph view links sources, items, outputs and workspaces across the project.

## Initiatives

- Work that runs for weeks gets a standing brief, a plain Markdown file in its own folder, so a new session starts from where things stand.
- `/initiative` attaches a session to an initiative. Claude then reads the brief and keeps it current.

## Inside Claude Code

Buttons above the prompt open Sketch, Stack and Write, dictate with Talk, set the Mode, and open the Brief pane.

| Command | Does |
|---|---|
| `/sketch`, `/stack`, `/write` | Opens the panel bound to this session |
| `/track` | Turns item tracking on or off |
| `/mode` | Sets how Claude works: default, product, prototype or orchestrate |
| `/grill` | Has Claude interview you before it starts on a vague request |
| `/initiative` | Attaches this session to an initiative |
| `/outputs` | Lists this session's outputs |
| `/apply-feedback` | Applies recordings from the companion Chrome extension |

- **🎙 Talk** dictates into the prompt box, with no panel.
- **▣ Brief** opens a pane with the session's outputs and their open feedback, Claude's open questions, the items and the mode, for quick decisions without leaving the terminal.
- Under each longer reply, Copy and Open in Agent Brief take the reply with you.

The [plugin README](mod/agent-brief/README.md) covers each command in full.

## Private by default

- Everything runs on your Mac, and only what you send to Claude leaves it.
- The app's socket is readable by your user alone.

## In this repository

| Folder | Holds |
|---|---|
| [`companion/`](companion) | The macOS app and the `agent-brief` command line tool |
| [`mod/agent-brief/`](mod/agent-brief) | The Claude Code plugin: commands, buttons, the Brief pane, delivery and the feedback inbox |

Building, tests and releases are in [companion/docs/DEVELOPMENT.md](companion/docs/DEVELOPMENT.md).

## License

MIT. See [LICENSE](LICENSE).
