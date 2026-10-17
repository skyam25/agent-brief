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
| `align` | `left` or `center`: how a label lines up inside its shape or sticky. A label with `- ` or `• ` lines is left by default, any other is centered |
| `frameId` | Puts the element inside that frame |
| `file` | An `image` element's picture: a png, jpeg, gif or webp path. Give a `width` or `height` and the other keeps the proportions; give neither and it is 720 wide |

Notes on types.

- Use `sticky` for short notes and questions to the user. A note with a heading and several points reads best as a list, one `- ` line per point.
- Use `frame` to group a region. Give it a `label` as its title and size it to hold its children.
- Bind arrows by id so they follow the shapes when the user moves them. Use free points only for callouts.
- Colours are names, not hex values.
- Shapes, arrows and lines draw in violet unless you give a `color`. Text and labels draw in a neutral sans font, which the dark theme shows as near-white. A `color` on a `text` element tints it.

### Example

Three boxes in a row, joined by arrows, inside a frame. The plain arrow gets a 60 px gap. The arrow labelled `ok` gets 100 px, 12 per character plus 60, rounded up to 20.

```bash
agent-brief draw <<'JSON'
{"elements": [
  {"id": "f", "type": "frame", "x": 0, "y": 0, "width": 840, "height": 160, "label": "Signup flow"},
  {"id": "a", "type": "rectangle", "x": 40,  "y": 40, "width": 200, "height": 80, "label": "Form",        "color": "blue",   "frameId": "f"},
  {"id": "b", "type": "rectangle", "x": 300, "y": 40, "width": 200, "height": 80, "label": "Validate",    "color": "orange", "frameId": "f"},
  {"id": "c", "type": "rectangle", "x": 600, "y": 40, "width": 200, "height": 80, "label": "Create user", "color": "green",  "frameId": "f"},
  {"type": "arrow", "start": {"id": "a"}, "end": {"id": "b"}},
  {"type": "arrow", "start": {"id": "b"}, "end": {"id": "c"}, "label": "ok"}
]}
JSON
```

The call prints the batch id, then one line per new element in the format `read` uses, then any warnings.

```
drew 6 elements, batch b_k2x9
f frame "Signup flow" at 0,0 840×160 black (claude)
a rectangle "Form" at 40,40 200×80 blue (claude)
…
q81mz0d2kw4a arrow "ok" b → c violet (claude)
```

Take ids from these lines, not from their order. Elements you gave no `id` get a generated one. Agent Brief before 0.3.1 prints only an `ids:` line. Run `read` then to match ids to elements. Each line shows the element's final size, so a height larger than the one you sent means a label took more lines than you counted. After a big draw, run `agent-brief png` and Read it to check the result.

### Warnings

| Warning | Fix |
|---|---|
| `arrow … is N px long, so its label … hides it` | Move the shapes it joins apart by the amount it names |
| `rectangle … grew from A to B px tall … and now overlaps …` | Move the named elements down by the amount it names, or widen the box. A `sticky` gets the same warning |
| `frame … grew to W×H … and now overlaps …` | Move the named frame down by the amount it names. Its contents move with it |

`update` also warns when a new label grows a box over a neighbour.

### Changing and removing

```bash
echo '[{"id": "b", "label": "Check input", "color": "violet", "x": 340}]' | agent-brief update
agent-brief delete c
```

An update can set `x`, `y`, `width`, `height`, `label` and `color`. A new `x` or `y` on a frame moves everything in it by the same amount, labels and arrows included. Arrows bound to those shapes from outside the frame re-route.

## Layout

Work out every size before you draw. A box or sticky grows taller to hold its label, and then it can cover what sits below it. When the sizes come from the rules below, nothing grows and the first draw is clean.

### Height of a box or sticky

- A label line takes 27 px. The box adds 16 px above the label and 16 px below.
- The height a label needs is 27 × lines + 32. Round it up to the grid of 20.

| Lines | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| Height | 60 | 100 | 120 | 140 | 180 | 200 | 220 |

- Count lines after wrapping. A line holds about (width − 40) ÷ 10 characters. A label in capitals holds about two thirds as many.

| Width | 200 | 260 | 300 | 380 | 460 |
|---|---|---|---|---|---|
| Characters per line | 16 | 22 | 26 | 34 | 42 |

- Each line of the label starts a new line on the board, so a heading and three `- ` points start four lines. A line longer than the width holds wraps onto more lines. The `- ` counts as two characters.
- For example, a sticky 260 wide holds 22 characters a line. A heading and three points of about 30 characters each take 1 + 3 × 2 = 7 lines, so the sticky needs a height of 220.
- Give long text more width rather than more lines. A 380 px box holds a 34-character label on one line.
- Make plain boxes 200×80. That holds one line of 16 characters. Two lines need 200×100.
- Give boxes in a row the same width, and the height of the tallest.

### Spacing

- Leave 60 px between boxes in a row when the arrow between them has no label. A row of 200-wide boxes then steps by 260 px.
- A labelled arrow needs 12 px per character of its label plus 60 between the boxes it joins, rounded up to 20. `ok` needs 100, `submit` 140, and `POST /login` 200.
- Keep arrow labels to 20 characters or fewer. A longer label wraps and needs more room still.
- Leave 60 px between boxes in a column, or 100 px when a labelled arrow joins them. A column steps by the box height plus that gap, so 80-tall boxes step by 140 px.
- Snap positions to a grid of 20.
- Flow left to right, or top to bottom for long chains.
- Label every shape and every arrow that is not obvious.

### Frames

- Leave 40 px between a frame's edges and its content.
- Size a frame from the heights its children need. Its height runs from its top to the lowest child's bottom, plus 40.
- A frame's title sits above its top edge. Leave 60 px between one frame's bottom and the next frame's top.
- A frame still grows to hold children that outgrew it, and `draw` warns when it then overlaps another frame.

### Placing on a board with content

Run `agent-brief read` before drawing on a board that has content. Place new elements in empty space, using the `bounds` line. Start below or to the right of it.

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
