# Agent Brief

Sketch, write, talk and paste screenshots on your Mac, then hand all of it to Claude Code in one press. Claude sees what you drew, hears what you said, draws back on the same board, and keeps a list of the work's items that you answer from the panel instead of the chat.

## Three modes

| Mode | Key | Holds |
|---|---|---|
| Sketch | ⌘1 | A whiteboard for strokes, screenshots and voice |
| Write | ⌘2 | Notes and briefs, with templates and a Ready queue |
| Review | ⌘3 | What Claude hands back to the active session: its outputs, your reviews of them, and its items |

## Notes and sessions

- The sidebar on the left starts with **Unfiled**, then one entry per Claude Code session, running ones first. The sidebar button hides it, and a narrow panel opens it as a drawer.
- Each session holds its boards, its notes and its items. The active entry lists its boards underneath, then a line counting its notes. A board opens in Sketch, and the count opens Write.
- Unfiled holds what belongs to no session yet, such as a scratch board or a thought captured with the hotkey. Switching to Unfiled opens the unfiled board you last used, else a new `scratch`.
- The breadcrumb at the top names where you are, the session or Unfiled, then the board in Sketch or the note in Write. Clicking a running session's name brings its terminal forward.
- A note is filed under a session or unfiled. `/write` files the note it opens under that session. Any note can be moved with **File under…** in its ⋯ menu, and an unfiled note stays in Unfiled until you file it or send it.
- Send on a running session goes to that session. On Unfiled or an ended session, a **Send to…** chip appears beside Send and asks where to go.
- A session that has ended moves to the folded **Ended** group, with a hollow dot. Opening it shows a resume command, `cd <project> && claude --resume <id>`, with **Copy** and **Open in** Ghostty, Terminal or herdr. Resume it and the tab goes live again on its own, with its boards, notes and items where you left them.
- Click an entry or press ⌃1 for Unfiled and ⌃2 onward for sessions. ⌃Tab cycles.

## Sketch

- A floating whiteboard sits above your other windows and appears with a hotkey.
- Pen pressure sets stroke width, the eraser end erases, and touch is ignored while the pen is near.
- A pasted screenshot lands ready to mark up, with the pen still in hand.
- Each board keeps its own notes, and you can keep several named boards. A session's new board is named by the date, such as `Oct 16`.
- The board menu lists only the boards of the session you are on. **New board** adds one to the session. On a running session the menu also lists unfiled boards under **Attach**, and picking one adds it to the session. **Detach** on a board's row moves it to Unfiled.

## Talk while you draw

- **Talk** (⌥T) records your voice alongside the sketch. While it records, the footer shows a clock, a live level meter, Discard and Stop. A chip then shows the take Send will carry, and its ✕ drops it.
- Speech and strokes share one clock, so "this one" points at what you drew while you said it.
- Transcription runs on your Mac. Audio never leaves it.
- In Claude Code, the **🎙 Talk** button above the prompt dictates straight into the prompt box, with no panel.

## Write

- A note saves as you type. Mark it Ready to queue it, and Send uses up the first in the queue.
- Notes hold headings, bullets, tables and pasted screenshots, and the screenshots go to Claude with the text.
- Templates are markdown files with `{{slots}}`. Pick one with `/`, Tab between slots, and Send warns once about a slot left empty.
- A note can carry a board, so its text leads the prompt and the sketch follows.
- Copy puts a note on the clipboard as rich text, so bold, lists and links paste into Slack, Mail or Docs. Apps that take plain text get the Markdown.
- Ask Claude for a message, an email or a post and it lands as a note under the session, titled, with no panel popping up. Edit it there and press Copy. Without the app, Claude prints the text as before.

## Hand it to Claude Code

- `/sketch` in a Claude Code session, or the Sketch button above its prompt, opens the board for that session. `/write`, or the Write button, opens a note for it instead. The button carries over what you typed in the prompt box. With the box empty, it takes Claude's last reply, as `/write last` does.
- Under each finished reply of more than one line, Copy puts the reply on the clipboard and Open in Agent Brief starts a note with it.
- Run `/sketch` or `/write` again and the board or note you left unsent comes back.
- Send writes a bundle into the project and gives Claude a prompt that points at it.
- The prompt goes in by itself, or waits in the prompt box if you prefer to add to it first.
- The panel closes and the board clears, ready for the next idea.

## What Claude receives

| File | Holds |
|---|---|
| `sketch.png` | The board, with your strokes numbered and screenshots lettered |
| `board.excalidraw` | The full scene, so Claude can read every element |
| `timeline.md` | Strokes, pastes and speech in order, each linked to what it was about |
| `transcript.json` | Each spoken sentence with its time and audio clip |
| `audio/` | The voice clips |
| `notes.md` | The board's notes |

A timeline reads like this:

```
[00:03] pasted image A · top left · large
[00:12–00:19] 🎙️ "I don't like that icon style." — nearest: image A, pasted 9s before
[00:33–00:35] pasted image B · right · large
[00:37–00:42] 🎙️ "The left panel needs to be wider." — nearest: image B, pasted 2s before
```

A send of item decisions from Review mode is text alone, such as `Decisions on 2 items in .feedback/items/<session>.md:` followed by one line per item.

## Track items

- Flip **Track items** in Review mode, or run `/track` in the session. Nothing changes until you do.
- With it on, Claude keeps the work's items in `<project>/.feedback/items/<session>.md`. Each item carries Claude's note, a proposal, a question or two options, an `Out:` line for every file it writes, and a done line saying what changed. Claude writes the file only when the work has several parts.
- Review mode shows that list beside the session's outputs. Open items that wait on you are marked. Type your call and press Send. The panel adds your answers to the file as `You:` lines and sends Claude a short message listing them.
- Every `Out:` line is a link that opens the file, so you can see what Claude is working on and what it finished.
- Claude ends a reply that touched items with `Done:` and `Open:` lines, so the chat and the panel agree.

## Review Claude's outputs

- Review mode lists each session's deliverables under **Outputs**, and Write keeps only your notes. Claude declares the thing you asked for, such as a strategy doc, a brief or a page, with the `declare_output` tool, and the row shows Drafting until Claude marks it Ready. Files Claude only touched sit under **Touched**, folded away. `/outputs` in the session prints the same list.
- Review lists the session's outputs, its reviews and its items, and shows the one you pick beside the list. With nothing picked it opens your newest review that holds comments, else the newest Ready page, and shows the items while one waits on you. A narrow panel gives the page the room, and the list button in the review bar brings the list back.
- Click a Markdown output and it opens in Write as a note filed under the session. Edit it, then press Send. Claude gets your copy and a prompt to apply the changes to the file.
- Click an HTML output and it opens live in the review pane. A review you leave unsent waits under **Reviews**. Scroll and click through it as usual. Press C, or the Comment button, then click any element to pin a comment to it, or drag across text to quote it. Turn on the mic to talk instead of type, and what you say goes to the selected pin. Send hands Claude a `review.md` with each pin's element, quote and picture.
- Press E, or the Edit button, to change the page itself. Click to select an element, drag it to move it within or between containers, drag its corner to resize it, and double-click to retype its words. The inspector edits layout, size, spacing, type and fill, and adds text, rows, columns and buttons. Each change saves to the HTML file as you make it, ⌘Z undoes, and Send lists the edits in `review.md`. Edit mode changes markup written in the file. Anything a script draws stays as it is.
- Other files open in their app, and an artifact or published page opens in the browser.
- Hide hides a row until Claude writes or declares it again.
- The mod keeps the list in `<project>/.feedback/outputs/<session>.json`. The app only reads it.

## Behavior review

- An interactive prototype can carry a behavior specification beside its HTML file. Review's **Behavior** tab shows proposed and confirmed rules, their sources, implementation evidence, and simulated actions.
- **Confirm** records your decision. **Edit** lets you change the wording or leave a question open. Decisions save immediately; **Send** hands the rules and your comments to Claude. Save or cancel an open edit before sending.
- **Show element** highlights a rule's control when it is visible. Rules can also describe a whole flow. A state label tells you where a hidden control appears.
- Rules belong to the prototype, so they survive restarts and new sessions. Decision history keeps previous wording and sources. Concurrent changes require reviewing the latest revision before saving your edit.
- Confirmation means agreement, not implementation. Changing a rule's meaning returns it to proposed and clears implementation evidence. Simulated actions stay listed separately.
- Ask Claude to add behavior rules to a prototype, or use `agent-brief behavior show|update|export <prototype.html>`. Export produces acceptance criteria with open assumptions and limitations for the engineering handoff.

## Initiatives

- Work that runs for weeks gets a short standing brief, its initiative, so a new session starts from where things stand instead of from cold.
- The brief is a plain Markdown file in the initiative's own folder. Edit it in any editor, and the panel picks up the change.
- The Initiative tab (⌘4) shows the brief, the sessions working on it, its decisions and open questions, and a map of your folders with Reveal in Finder on each. Edit the Understanding in place, and the history shows who changed what.
- Nothing starts on its own. With no initiatives yet, Discover asks a session to look through its folder and suggest some, and New initiative starts an empty brief in a folder you pick.

## Choose where it goes

- Opened from Claude Code, the board is bound to that session. Its tab is selected, and clicking the tab again brings its terminal forward.
- Send sits in the composer under the board or note. On a running session it goes there, and its tooltip names the session. Elsewhere a **Send to…** chip beside Send picks one.
- Opened on its own, Send asks where to go. It lists running sessions and can start a new one in Ghostty, Terminal or herdr, or copy a start command.
- The app never guesses a session. If the bound session exits, Send asks again.

## Claude draws back

- Claude draws labelled shapes, sticky notes, arrows, frames and screenshots with the `agent-brief` command line tool. When it drives a browser for you, `agent-brief snap` posts each step as a numbered screenshot you can mark up and Send back.
- Claude reads the board as text and exports PNGs of any region.
- `agent-brief note "<title>"` saves Markdown from stdin as a note filed under the Claude Code session that runs it. The panel stays as it is.
- Its changes appear live, and one undo removes a whole batch.

## Pictures in Herdr

- Claude shows screenshots, boards and wireframes inline in Ghostty and kitty.
- Inside [Herdr](https://herdr.dev), Claude Code skips pictures unless `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` is set, though Herdr draws them fine.
- Run `agent-brief herdr-pictures on` once. It adds a marked block to your zsh and bash startup files, and a fish `conf.d` file, which set that variable only inside Herdr panes.
- Restart Claude in a new Herdr pane afterwards. `agent-brief herdr-pictures off` removes the block, and `status` shows where it is.

## History

- The last 10 sends are kept with thumbnails and notes.
- Any of them reopens on a new board, and its prompt copies with one click.

## Browser feedback

- The Claude Code side also takes recordings from the companion Chrome extension, which lives in its own repository.
- `/apply-feedback` transcribes the waiting recordings and hands them to the session you run it in.

## Private by default

- Everything runs on your Mac, and only what you send to Claude leaves it.
- The app's socket is readable by your user alone.

## Get it

- **App.** Download the latest [release](https://github.com/skyam25/agent-brief/releases/latest), unzip it, and move Agent Brief.app into Applications. It needs macOS on Apple Silicon.
- **Claude Code side.** Pick Install Claude Code Plugin… from the app's menu. Claude Code then loads the plugin from inside the app, so it updates with the app. To use the plugin without the app, run `/plugin marketplace add skyam25/agent-brief`, then `/plugin install agent-brief@agent-brief`.
- **Voice.** Transcription uses [yap](https://github.com/finnvoor/yap) and ffmpeg: `brew install yap ffmpeg`.

## In this repository

| Folder | Holds |
|---|---|
| [`companion/`](companion) | The macOS app and the `agent-brief` command line tool |
| [`mod/agent-brief/`](mod/agent-brief) | The Claude Code plugin: `/sketch`, `/write`, `/track`, their buttons, the Copy and Open in Agent Brief row under replies, delivery and the feedback inbox |

Building the app, tests and packaging are in [companion/docs/DEVELOPMENT.md](companion/docs/DEVELOPMENT.md).

## License

MIT. See [LICENSE](LICENSE).
