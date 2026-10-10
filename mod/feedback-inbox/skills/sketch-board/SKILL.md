---
name: sketch-board
description: Draw on and read the user's Web Agent Companion sketch board. Use when the user mentions the companion board, the sketch panel, sketching, drawing a diagram or flow for them, wireframing, or asks what they drew or sketched. Also use to look at their sketch before answering a question about it.
---

# Sketch board

The Web Agent Companion is a floating sketch panel on the user's Mac. You draw on it and read from it with the `companion` CLI. The user sees your changes live and can draw back.

If `companion` is not on PATH, use the copy inside the app in its place. Quote it, because the path has spaces.

```bash
"/Applications/Web Agent Companion.app/Contents/Resources/bin/companion" status
```

If the app is in `~/Applications`, use that path instead. The app's menu item Install Command Line Tool… puts `companion` on PATH.

## When to use it

- The user asks for a diagram, flow, layout or wireframe.
- The user says they sketched something, or asks you to look at the board.
- A picture would explain your answer better than text.

Run `companion status` first if you are unsure the app is up. Exit code 3 means it is not running. Tell the user to start it. Do not retry in a loop.

## Commands

All board commands take `--board <name>`. The default is `current`, the board the panel shows now. `--json` prints the raw response.

| Command | Does |
|---|---|
| `companion status` | Shows whether the app runs |
| `companion sessions` | Lists Claude Code sessions. A `*` marks where Send delivers |
| `companion boards` | Lists boards |
| `companion open [--board] [--prompt <text>] [--session <id>]` | Shows the panel. `--prompt` puts a note at the top of it |
| `companion read [--board] [--region x,y,w,h]` | Prints the elements as text |
| `companion png [--board] [--region x,y,w,h] [--max-edge 1400] [--out <path>]` | Writes a PNG and prints its path |
| `companion draw [--board] [--file f.json]` | Adds elements from JSON on stdin or in a file |
| `companion update [--board] [--file f.json]` | Changes elements by id |
| `companion delete [--board] <id>...` | Removes elements by id |

Exit codes are 0 ok, 1 server error, 2 bad input, 3 app not running. Input errors name the element index, for example `elements[2]: "x" must be a number`.

## Looking at the board

Run `companion read` first. It costs few tokens and gives you ids, positions, labels and who drew each element.

```
board "current" · 7 elements · bounds 0,0 1200×800
r1 rectangle "Header" at 40,40 400×80 blue (claude)
a1 arrow r1 → r2 (claude)
f3 freedraw at 300,420 120×60 (user)
```

Freehand strokes have no label, so text cannot tell you what they show. When shapes matter, run `companion png --region x,y,w,h`, then Read the file it prints. An image costs about 1 to 2k tokens, so crop to the area you need. Use the full board only for a first look at a messy one.

Elements marked `(user)` are the user's. Elements marked `(claude)` are yours.

## Drawing

Send a JSON object `{"elements": [...]}` or a bare array. Each element is a skeleton. Every field except `type` is optional.

| Field | Meaning |
|---|---|
| `type` | `rectangle`, `ellipse`, `diamond`, `text`, `sticky`, `arrow`, `line`, `frame` |
| `id` | Your own id. Arrows in the same call can bind to it |
| `x`, `y`, `width`, `height` | Position and size in board pixels |
| `label` | Text inside a shape or sticky, the title of a frame, or the content of a `text` |
| `color` | `black`, `gray`, `red`, `orange`, `yellow`, `green`, `blue`, `violet`, `pink` |
| `start`, `end` | Arrow and line ends. `{"id": "r1"}` binds to an element. `{"x": 0, "y": 0}` is a free point |
| `points` | Line points `[[0,0],[100,40]]`, relative to `x`,`y` |
| `frameId` | Puts the element inside that frame |

Notes on types.

- Use `sticky` for short notes and questions to the user.
- Use `frame` to group a region. Give it a `label` as its title and size it to hold its children.
- Bind arrows by id so they follow the shapes when the user moves them. Use free points only for callouts.
- Colours are names, not hex values.

### Example

Three boxes in a row, joined by arrows, inside a frame.

```bash
companion draw <<'JSON'
{"elements": [
  {"id": "f", "type": "frame", "x": 0, "y": 0, "width": 920, "height": 220, "label": "Signup flow"},
  {"id": "a", "type": "rectangle", "x": 60,  "y": 70, "width": 200, "height": 80, "label": "Form",      "color": "blue",   "frameId": "f"},
  {"id": "b", "type": "rectangle", "x": 320, "y": 70, "width": 200, "height": 80, "label": "Validate",  "color": "orange", "frameId": "f"},
  {"id": "c", "type": "rectangle", "x": 580, "y": 70, "width": 200, "height": 80, "label": "Create user", "color": "green", "frameId": "f"},
  {"type": "arrow", "start": {"id": "a"}, "end": {"id": "b"}},
  {"type": "arrow", "start": {"id": "b"}, "end": {"id": "c"}, "label": "ok"}
]}
JSON
```

The call prints the new ids and a batch id. Run `companion read` after a big draw to check the result.

### Changing and removing

```bash
echo '[{"id": "b", "label": "Check input", "color": "violet", "x": 340}]' | companion update
companion delete c
```

An update can set `x`, `y`, `width`, `height`, `label` and `color`.

## Layout

- Make boxes 200×80.
- Leave 60 px between boxes. A row steps by 260 px, a column by 140 px.
- Snap positions to a grid of 20.
- Flow left to right, or top to bottom for long chains.
- Label every shape and every arrow that is not obvious.
- Keep frames 40 px larger than their content on each side, with room for the title.
- Run `companion read` before drawing on a board that has content. Place new elements in empty space, using the `bounds` line. Start below or to the right of it.

## Rules

- Never delete or move the user's elements unless they ask. Elements marked `(user)` are theirs.
- Change your own elements freely.
- One `draw`, `update` or `delete` call is one undo step. Send related shapes together in one call so the user can undo them with one keystroke.
- Prefer a few clear calls over many tiny ones.
- Do not redraw the whole board to make a small change. Use `update`.
