# Agent Brief

Sketch, talk and paste screenshots on your Mac, then hand all of it to Claude Code in one press. Claude sees what you drew, hears what you said, and can draw back on the same board.

## Sketch

- A floating whiteboard sits above your other windows and appears with a hotkey.
- Pen pressure sets stroke width, the eraser end erases, and touch is ignored while the pen is near.
- A pasted screenshot lands ready to mark up, with the pen still in hand.
- Each board keeps its own notes, and you can keep several named boards.
- The same board opens on an iPad on your local network, and strokes sync both ways as you draw.
- Click the tablet icon (**Open on iPad**) in the Mac board's top bar and scan the QR code to join it. The Claude Code session already selected stays selected.

## Talk while you draw

- The mic button records your voice alongside the sketch.
- Speech and strokes share one clock, so "this one" points at what you drew while you said it.
- Transcription runs on your Mac. Audio never leaves it.

## Hand it to Claude Code

- `/sketch` in a Claude Code session, or the Sketch button above its prompt, opens the board for that session.
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

## Choose where it goes

- Opened from Claude Code, the board is bound to that session. A chip by Send names it, and clicking the chip brings its terminal forward.
- Opened on its own, Send asks where to go. It lists running sessions and can start a new one in Ghostty, Terminal or herdr, or copy a start command.
- The app never guesses a session. If the bound session exits, Send asks again.

## Claude draws back

- Claude draws labelled shapes, sticky notes, arrows and frames with the `agent-brief` command line tool.
- Claude reads the board as text and exports PNGs of any region.
- Its changes appear live, and one undo removes a whole batch.

## History

- The last 10 sends are kept with thumbnails and notes.
- Any of them reopens on a new board, and its prompt copies with one click.

## Browser feedback

- The Claude Code side also takes recordings from the companion Chrome extension, which lives in its own repository.
- `/apply-feedback` transcribes the waiting recordings and hands them to the session you run it in.

## Private by default

- Everything runs on your Mac, and only what you send to Claude leaves it.
- The app's socket is readable by your user alone.
- The iPad server listens only on your private network, and each device pairs once with a code you scan.

## Get it

- **App.** Download the latest [release](https://github.com/skyam25/agent-brief/releases/latest), unzip it, and move Agent Brief.app into Applications. It needs macOS on Apple Silicon.
- **Claude Code side.** In Claude Code, run `/plugin marketplace add skyam25/agent-brief`, then `/plugin install agent-brief@agent-brief`.
- **Voice.** Transcription uses [yap](https://github.com/finnvoor/yap) and ffmpeg: `brew install yap ffmpeg`.

## In this repository

| Folder | Holds |
|---|---|
| [`companion/`](companion) | The macOS app, the `agent-brief` command line tool and the iPad client |
| [`mod/agent-brief/`](mod/agent-brief) | The Claude Code plugin: `/sketch`, the Sketch button, delivery and the feedback inbox |

Building the app, tests and packaging are in [companion/docs/DEVELOPMENT.md](companion/docs/DEVELOPMENT.md).

## License

MIT. See [LICENSE](LICENSE).
