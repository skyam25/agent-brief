# Agent Brief

Sketch, write, talk and paste screenshots on your Mac, then hand all of it to Claude Code in one press. Claude sees what you drew, hears what you said, draws back on the same board, and keeps a list of the work's items that you answer from the panel instead of the chat.

## Three modes

| Mode | Key | Holds |
|---|---|---|
| Sketch | ⌘1 | A whiteboard for strokes, screenshots and voice |
| Write | ⌘2 | Notes and briefs, with templates and a Ready queue |
| Items | ⌘3 | The active session's items, with your call on each one |

## Notes and sessions

- The sidebar on the left starts with a fixed **Notes** entry, then one entry per Claude Code session, running ones first. The sidebar button in the toolbar hides it, and a narrow panel opens it as a drawer. Notes holds what belongs to no session yet, such as a thought captured with the hotkey. A session tab holds that session's board, its notes and its items.
- A note is filed under a session or unfiled. `/write` files the note it opens under that session. Any note can be moved with **File under…**, and an unfiled note sits in Notes until you file it or send it.
- Send from a session tab goes to that session. Send from Notes asks where to go.
- A session that has ended moves to the folded **Ended** group, with a hollow dot. Opening it shows a resume command, `cd <project> && claude --resume <id>`, with **Copy** and **Open in** Ghostty, Terminal or herdr. Resume it and the tab goes live again on its own, with its board, notes and items where you left them.
- Click a tab or press ⌃1 for Notes and ⌃2 onward for sessions. ⌃Tab cycles.

## Sketch

- A floating whiteboard sits above your other windows and appears with a hotkey.
- Pen pressure sets stroke width, the eraser end erases, and touch is ignored while the pen is near.
- A pasted screenshot lands ready to mark up, with the pen still in hand.
- Each board keeps its own notes, and you can keep several named boards.

## Talk while you draw

- The mic button records your voice alongside the sketch.
- Speech and strokes share one clock, so "this one" points at what you drew while you said it.
- Transcription runs on your Mac. Audio never leaves it.

## Write

- A note saves as you type. Mark it Ready to queue it, and Send uses up the first in the queue.
- Notes hold headings, bullets, tables and pasted screenshots, and the screenshots go to Claude with the text.
- Templates are markdown files with `{{slots}}`. Pick one with `/`, Tab between slots, and Send warns once about a slot left empty.
- A note can carry a board, so its text leads the prompt and the sketch follows.

## Hand it to Claude Code

- `/sketch` in a Claude Code session, or the Sketch button above its prompt, opens the board for that session. `/write`, or the Write button, opens a note for it instead. The button carries over what you typed in the prompt box, and `/write last` starts the note with Claude's last reply.
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

A send from Items mode is text alone, such as `Decisions on 2 items in .feedback/items/<session>.md:` followed by one line per item.

## Track items

- Flip **Track items** in Items mode, or run `/track` in the session. Nothing changes until you do.
- With it on, Claude keeps the work's items in `<project>/.feedback/items/<session>.md`. Each item carries Claude's note, a proposal, a question or two options, an `Out:` line for every file it writes, and a done line saying what changed. Claude writes the file only when the work has several parts.
- Items mode shows that list. Open items that wait on you are marked. Type your call and press Send. The panel adds your answers to the file as `You:` lines and sends Claude a short message listing them.
- Every `Out:` line is a link that opens the file, so you can see what Claude is working on and what it finished.
- Claude ends a reply that touched items with `Done:` and `Open:` lines, so the chat and the panel agree.

## Review Claude's outputs

- Write mode lists each session's deliverables above its notes. Claude declares the thing you asked for, such as a strategy doc, a brief or a page, with the `declare_output` tool, and the row shows Drafting until Claude marks it Ready. Files Claude only touched sit under **Touched**, folded away. `/outputs` in the session prints the same list.
- Click a Markdown output and it opens as a note filed under the session. Edit it, then press Send. Claude gets your copy and a prompt to apply the changes to the file.
- Click an HTML output and it opens live in the review pane. Scroll and click through it as usual. Press C, or the Comment button, then click any element to pin a comment to it, or drag across text to quote it. Turn on the mic to talk instead of type, and what you say goes to the selected pin. Send hands Claude a `review.md` with each pin's element, quote and picture.
- Other files open in their app, and an artifact or published page opens in the browser.
- Hide hides a row until Claude writes or declares it again.
- The mod keeps the list in `<project>/.feedback/outputs/<session>.json`. The app only reads it.

## Choose where it goes

- Opened from Claude Code, the board is bound to that session. Its tab is selected, and clicking the tab again brings its terminal forward.
- Send sits in the composer under the board or note. The chip beside Send names where it goes, and clicking the chip picks another session.
- Opened on its own, Send asks where to go. It lists running sessions and can start a new one in Ghostty, Terminal or herdr, or copy a start command.
- The app never guesses a session. If the bound session exits, Send asks again.

## Claude draws back

- Claude draws labelled shapes, sticky notes, arrows, frames and screenshots with the `agent-brief` command line tool. When it drives a browser for you, `agent-brief snap` posts each step as a numbered screenshot you can mark up and Send back.
- Claude reads the board as text and exports PNGs of any region.
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
| [`mod/agent-brief/`](mod/agent-brief) | The Claude Code plugin: `/sketch`, `/write`, `/track`, their buttons, delivery and the feedback inbox |

Building the app, tests and packaging are in [companion/docs/DEVELOPMENT.md](companion/docs/DEVELOPMENT.md).

## License

MIT. See [LICENSE](LICENSE).
