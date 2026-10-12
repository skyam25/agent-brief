---
name: sketch-board
description: Draw on and read the user's Agent Brief sketch board. Use when the user mentions the Agent Brief board, the companion board, the sketch panel, sketching, drawing a diagram or flow for them, wireframing, or asks what they drew or sketched. Also use to look at their sketch before answering a question about it, and to post screenshots of a browser session you drive so the user can follow it and mark it up.
---

# Sketch board

Agent Brief is a floating sketch panel on the user's Mac. You draw on it and read from it with the `agent-brief` CLI. The user sees your changes live and can draw back.

If `agent-brief` is not on PATH, use the copy inside the app in its place. Quote it, because the path has spaces.

```bash
"/Applications/Agent Brief.app/Contents/Resources/bin/agent-brief" status
```

If the app is in `~/Applications`, use that path instead. The app's menu item Install Command Line Tool… puts `agent-brief` on PATH.

## When to use it

- The user asks for a diagram, flow, layout or wireframe.
- The user says they sketched something, or asks you to look at the board.
- A picture would explain your answer better than text.
- You drive a browser for the user and they want to follow along or review the steps. See [Following a browser session](#following-a-browser-session).

Run `agent-brief status` first if you are unsure the app is up. Exit code 3 means it is not running. Tell the user to start it. Do not retry in a loop.

## Commands

All board commands take `--board <name>`. The default is `current`, the board the panel shows now. `--json` prints the raw response.

| Command | Does |
|---|---|
| `agent-brief status` | Shows whether the app runs |
| `agent-brief sessions` | Lists Claude Code sessions. A `*` marks where Send delivers |
| `agent-brief boards` | Lists boards |
| `agent-brief open [--board] [--prompt <text>] [--session <id>]` | Shows the panel. `--prompt` puts a note at the top of it |
| `agent-brief read [--board] [--region x,y,w,h]` | Prints the elements as text |
| `agent-brief png [--board] [--region x,y,w,h] [--max-edge 1400] [--out <path>]` | Writes a PNG and prints its path |
| `agent-brief draw [--board] [--file f.json]` | Adds elements from JSON on stdin or in a file |
| `agent-brief snap <image> [--board] [--caption <text>] [--note <text>] [--width 720]` | Adds a screenshot as the next numbered step |
| `agent-brief update [--board] [--file f.json]` | Changes elements by id |
| `agent-brief delete [--board] <id>...` | Removes elements by id |

Exit codes are 0 ok, 1 server error, 2 bad input, 3 app not running. Input errors name the element index, for example `elements[2]: "x" must be a number`.

## Looking at the board

Run `agent-brief read` first. It costs few tokens and gives you ids, positions, labels and who drew each element.

```
board "current" · 7 elements · bounds 0,0 1200×800
r1 rectangle "Header" at 40,40 400×80 blue (claude)
a1 arrow r1 → r2 (claude)
f3 freedraw at 300,420 120×60 (user)
```

`read` gives structure, not appearance. Run `agent-brief png --region x,y,w,h` and Read the file it prints when any of these hold.

- The board has `freedraw` elements. Strokes have no label, so only the picture shows what they mean, such as a circle around a button or a cross through a field.
- The user drew on or near an `image`. Text cannot tell you which part of the screenshot they marked.
- You need to check your own drawing looks right. `read` reports an arrow as present even when something covers it.

An image costs about 1 to 2k tokens, so crop to the area you need. A frame's line in `read` gives its region. Use the full board only for a first look at a messy one.

Elements marked `(user)` are the user's. Elements marked `(claude)` are yours.

## Drawing

Send a JSON object `{"elements": [...]}` or a bare array. Each element is a skeleton. Every field except `type` is optional.

| Field | Meaning |
|---|---|
| `type` | `rectangle`, `ellipse`, `diamond`, `text`, `sticky`, `arrow`, `line`, `frame`, `image` |
| `id` | Your own id. Arrows in the same call can bind to it |
| `x`, `y`, `width`, `height` | Position and size in board pixels |
| `label` | Text inside a shape or sticky, the title of a frame, or the content of a `text` |
| `color` | `black`, `gray`, `red`, `orange`, `yellow`, `green`, `blue`, `violet`, `pink` |
| `start`, `end` | Arrow and line ends. `{"id": "r1"}` binds to an element. `{"x": 0, "y": 0}` is a free point |
| `points` | Line points `[[0,0],[100,40]]`, relative to `x`,`y` |
| `frameId` | Puts the element inside that frame |
| `file` | An `image` element's picture: a png, jpeg, gif or webp path. Give a `width` or `height` and the other keeps the proportions; give neither and it is 720 wide |

Notes on types.

- Use `sticky` for short notes and questions to the user.
- Use `frame` to group a region. Give it a `label` as its title and size it to hold its children.
- Bind arrows by id so they follow the shapes when the user moves them. Use free points only for callouts.
- Colours are names, not hex values.

### Example

Three boxes in a row, joined by arrows, inside a frame.

```bash
agent-brief draw <<'JSON'
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

The call prints the new ids and a batch id, then any warnings. A warning names an arrow whose label hides it. Move the shapes apart with `update` when you get one. After a big draw, run `agent-brief png` and Read it to check the result.

### Changing and removing

```bash
echo '[{"id": "b", "label": "Check input", "color": "violet", "x": 340}]' | agent-brief update
agent-brief delete c
```

An update can set `x`, `y`, `width`, `height`, `label` and `color`.

## Layout

- Make boxes 200×80.
- Leave 60 px between boxes. A row steps by 260 px, a column by 140 px.
- A labelled arrow needs room for its label. Leave about 10 px per character of the label, plus 40 px, between the boxes it joins.
- Snap positions to a grid of 20.
- Flow left to right, or top to bottom for long chains.
- Label every shape and every arrow that is not obvious.
- Keep frames 40 px larger than their content on each side, with room for the title.
- Run `agent-brief read` before drawing on a board that has content. Place new elements in empty space, using the `bounds` line. Start below or to the right of it.

## Stack boards

A board in the Stack layout files screenshots for the user. Each drop or paste becomes a numbered group, one group per row, newest at the bottom. `agent-brief boards` marks such a board `stack`. The user opens one with `/stack`, the Stack button above the prompt, or the Stack button in the panel.

- Each group is a frame titled `1`, `2`, and so on. A group's only picture is named after it, such as `2`. Pictures that share a group are `2a`, `2b` and so on, left to right.
- The Send timeline uses those names, such as `pasted image 2a` and `on image 2a, top right`. Speech lines say which screenshot was pasted nearest in time. Use the names when you answer.
- The layout moves pictures itself. Do not place images on a Stack board by hand. An `image` you draw there becomes a new group at the bottom.
- `agent-brief snap` steps keep their own frames, and the layout leaves them alone. Post a browser run on a freeform board instead.

## Following a browser session

When you drive a browser for the user, with Playwright or another browser tool, post a screenshot to the board after each step that matters. The user opens the board, sees each step, marks up what is wrong and sends it back to you.

`snap` and `image` elements need Agent Brief 0.2.5 or newer. If `agent-brief snap` is an unknown command, tell the user to update the app from its menu with Check for Updates.

1. Pick a board name for the run, such as `checkout-run`, and open it with your own session as the Send target:

   ```bash
   agent-brief open --board checkout-run --session "$CLAUDE_CODE_SESSION_ID" --prompt "Steps of the checkout run. Mark anything wrong, then Send."
   ```
2. After each meaningful step, save a screenshot and post it:

   ```bash
   agent-brief snap /tmp/step-2.png --board checkout-run --caption "Added two items to the cart" --note "Total shows $40, expected $36"
   ```

   `snap` puts the picture in a frame titled with the step number and caption, three steps to a row. Use `--note` for a question or anything you are unsure about. Post steps, not every click. Five to ten snapshots make a readable run.
3. Tell the user the board is ready, and that they can mark it up, add notes or record voice, then press Send. Their Send arrives in this session as your next prompt, with a PNG of the board and the user's notes. Send also empties the board, and History keeps a copy, so start the next round of snapshots on a fresh board.
4. When you read their feedback, run `agent-brief read --board <run>`. The user's strokes inside a step's frame list under that frame. Crop each marked frame with `png --region` and Read it, because a stroke only means something against the screenshot under it.

## Showing a picture in the chat

The `show_image` tool draws a picture inline in the user's terminal, in Ghostty or kitty. The picture goes to their screen, not to you, so it costs no tokens. Use it so the user sees what you did without opening a file.

- After you draw on a board, run `agent-brief png --out /tmp/board.png` and call `show_image` with that path and `board` set to the board's name. The row gets an Open board button.
- After each `agent-brief snap`, also show the screenshot with `show_image`, with `url` set to the page it is of.
- To offer directions, call `show_image` once with a `title` and `options`, 2 to 4 pictures each with a `title` and no letter. They draw side by side as one sheet lettered A to D, and the user presses Pick. The pick lands in their prompt box as "Go with option B (Title)".
- When `show_image` is not in your tools, as under an organization policy that refuses plugin tools, run `agent-brief show <file>` with Bash instead. It takes `--title`, `--board`, `--url`, and 2 to 4 files with `--labels "A|B"` for options. The picture draws in the command's result.
- The tool answers "Not shown" when the terminal cannot draw pictures. Then the user saw a notice, not the picture. Do not say they saw it.

## Rules

- Never delete or move the user's elements unless they ask. Elements marked `(user)` are theirs.
- Change your own elements freely.
- One `draw`, `update` or `delete` call is one undo step. Send related shapes together in one call so the user can undo them with one keystroke.
- Prefer a few clear calls over many tiny ones.
- Do not redraw the whole board to make a small change. Use `update`.
