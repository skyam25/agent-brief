---
name: feedback-items
description: Catalog feedback rounds (SME, customer or stakeholder transcripts and notes) as tracked items beside an output such as a prototype or PRD, in Agent Brief's <output>.feedback.md. Use when the user hands over feedback, interview transcripts or review notes about an output, asks to log or triage feedback, or sends "Feedback decisions" from Agent Brief.
---

# Feedback items

Each output can carry a feedback file beside it: `prototype/checkout.html` → `prototype/checkout.html.feedback.md`. Every point from every round becomes an item there. The user decides on each item in Agent Brief's Review pane, and the items outlast sessions.

Write the file only through `agent-brief feedback`. The app checks versions, adds dates and keeps the file add-only. If `agent-brief` is not on PATH, use `"/Applications/Agent Brief.app/Contents/Resources/bin/agent-brief"`. The app must be running and the session registered. Commands use `CLAUDE_CODE_SESSION_ID`, or `--session <id>`. If the app is down, say the items were not recorded, and do not claim they were.

Run each `agent-brief` command on its own, with no shell loops, variables or `&&` chains, so the user can allow it once.

## Catalog first

Change nothing in the output until the user decides. A round is cataloged, not applied.

1. Run `agent-brief feedback list` and `agent-brief feedback show <output>` to see what exists.
2. List the output in this session's Outputs, even when you only catalog against it: call `declare_output`, or run `agent-brief output "<title>" --path <output> --status ready`. Review shows the session's outputs, and this puts the feedback in reach.
3. Check every point for look-alikes in one call: `agent-brief feedback related <output> --text "<point 1>" --text "<point 2>"`.
   - The same point seen again is the same item. Join it with `"same": <n>`, never a new item.
   - A near-repeat, or the same point on another output, is a new item with a `related` link.
4. Catalog the round and all its points in one call. Write the points as JSON with your Write tool to a new file named after the transcript, such as `.feedback/catalog-sme-2.json`, then pass the file. A heredoc makes the command unique each time, so the user can't allow it once. The call adds the round unless the file has it, skips points already cataloged, and names look-alikes it finds:

```json
[
  {"title": "Hard to find the filters", "src": ["Ana · 03:02 · \"Where do I filter?\""],
   "change": "Move the filter row above the results.", "where": "#filters", "related": ["pricing.html #3"]},
  {"title": "Empty saved box is confusing", "src": ["Ben · 05:40 · \"It says \"Nothing yet\" and then what?\""],
   "options": ["A · Explain how to save an item", "B · Hide the box until something is saved"]},
  {"same": 2, "src": ["Maya · 00:14 · \"Still no filters\""], "change": "Make the filter row sticky too."}
]
```

```bash
agent-brief feedback catalog prototype/checkout.html --label SME --source transcripts/sme-2.md --date 2026-10-18 --items .feedback/catalog-sme-2.json
```

5. Reply with how many items the round added or joined, and mention any praise. End with: Press ▣ Brief, then In Agent Brief on `<output>`.

What goes in:

- Every point, quick ones included. Pure praise is not an item; mention it in the reply instead.
- `--date` is the transcript's date, from its header or name. Leave it off when the transcript has none.
- `title`: the problem as the speaker felt it, in a few words.
- `src`: `<speaker> · <time> · "<quote>"`, in the catalog's round. Quote word for word, inner quotes as said. Only JSON escapes them; the file keeps them raw. The time is the transcript timestamp, or `-`.
- `change`: the change you propose. One line, concrete.
- `options`: `<letter> · <text>` when a point has real alternatives. The user picks one when they accept.
- `where`: a unique CSS selector for an HTML output, such as `#filters`; a heading (`## Pricing`) or line (`L42`) for a text output. Optional. Show on page uses it.
- `related`: `<output path relative to this file's folder> #N`.
- `same`: the item a repeat joins. Its `src` lines go on that item, and a `change` revises it.

When a later round changes what an item asks for, revise it: `agent-brief feedback change <output> <n> "<the revised change>"`. Earlier `Change:` lines stay as history.

Round numbers are project-wide. One transcript has one number in every file, so a file's numbers may skip. `round` and `catalog` say when the round already exists. For a single point, `agent-brief feedback add <output> --title … --src '<round> · <speaker> · <time> · "<quote>"' [--change …] [--where …] [--option "A · …"]… [--related …] [--round N]` adds it.

## The file

```
# Feedback · checkout.html

## Round 2 · SME · 2026-10-18 · transcripts/sme-2.md
## Round 1 · customers · 2026-10-12 · transcripts/cust-1.md

- [ ] #6 Hard to find the filters
    Round: 1
    Src: 1 · Ana · 03:02 · "Where do I filter?"
    Src: 2 · Maya · 00:14 · "I couldn't find the filters"
    Change: Move the filter row above the results.
    Change: Make the filter row sticky too.
    Option: A · Above the results
    Option: B · In a side panel
    Where: #filters
    Claude: 2026-10-12 · cataloged
    You: 2026-10-12 · accept · option A · keep it sticky on scroll
    Claude: 2026-10-12 · done · commit 3f2a91c
```

- Rounds are a registry, newest first. Items follow in the order they came in. Item numbers never repeat.
- The last `Change:` is the item's proposed change. An accept may pick an option, as `accept · option A`.
- The file is add-only. Writes append a line, add an item or round, or flip a checkbox. Never edit or delete a past line, even a wrong one. Correct it with a new line.
- `Claude:`, `You:`, `Workspace:` and `Review:` lines are dated events. You write `Claude:` lines; `You:` lines come only from the user in the panel.
- State comes from the last state verb: open (`cataloged`, `reopen`), accepted (`accept`), rejected (`reject`, `rejected`), done (`done`, or `closed` unless the item was rejected). `[x]` marks done or rejected. The close and open ops date a `closed` or `reopen` line when they change the state.
- `You: … · sent · through N` marks what the user already sent you: the item's first N dated events. Events after it are still unsent. An old `You: … · sent` without `through` covers the events above it.

## Act on decisions

The user's Send decisions message starts with `@<output>.feedback.md` and lists the items decided since the last send. An item can also list a saved workspace, with its board and picture.

1. Read the file with `agent-brief feedback show <output>`. The newest `You:` lines on each item are the decision and its reasons.
   - For each saved workspace, look at the picture it names (a project path), then run `agent-brief read --board <board>`. The drawing is the user's answer, as much as a note is.
2. Accepted: make the change, within what the user authorized. `accept · option B` means build option B.
   - Anything you would add beyond the accepted change is a new proposed item, added with `feedback add`. Never fold it in silently.
   - Commit the output with `<output>.feedback.md` and the `<output>.feedback/` folder, then log the change: `agent-brief feedback done <output> <n> "<what changed, briefly>" --commit <sha>`. Once every item is logged, commit `<output>.feedback.md` again, such as `Log feedback #1, #3 done`, so the tree is clean. Outside a git repo, leave `--commit` off.
3. Rejected: change nothing. The item is already closed.
4. Notes and voice notes: answer with `agent-brief feedback log <output> <n> Claude "note · <answer>"`. Reopened items get a fresh look and a `Claude` line.
5. Log what you did not do, too, such as `Claude "note · blocked on the pricing API"`. Every change gets a dated line.
6. The before and after pictures show on the item cards. To show one in the chat too, call `show_image` with its `path`, once per picture. Its `options` are for choices the user picks between.
7. Say which items you closed and which still wait on the user. End with: Press ▣ Brief, then In Agent Brief on `<output>`.

A closed item that a later round's `Src:` line names again shows as raised again. Give it a fresh look and a `Claude` line; the user decides whether to reopen it.

## Review pins on an output with feedback

A review.md from the Review pane can tie a pin to feedback items, with a line like `- Feedback: item #3 in checkout.html.feedback.md`.

- Make the change the pin asks for, as with any review.
- For each named item, log the pin: `agent-brief feedback log <output> 3 Review 'pin 2 · "<the pin's words, short>"'`.
- `- Feedback: no item matches this element` means the pin is not on any item's `Where:`. If it is new feedback, catalog it as a new item with the pin's element as `Where:`, in a `review` round whose source is the review.md path. If it is only a small fix, make it and say so.

## Item workspaces

Each item has one Sketch board, `fb-<output stem>-<n>`, with a `Round N` frame per round. The user opens it from the item card, draws, pins comments and talks, then saves it to the item. Saving sends you nothing. Each save adds:

- a `You: … · note · pin <k> on <element> · <words>` line per pin, numbered as the badges on the picture, and one for the overall note
- `Workspace: <date> · saved · <board> · <output>.feedback/<n>-workspace-<k>.png`, a new picture each time, so older lines keep theirs

`You: … · note · Write note "<title>"` means the user opened a Write note for the item. The note reaches you only when they send it.

- To draw options on an item, run `agent-brief feedback workspace <output> <n>`. It prints the board name first, making the board or any missing round frame.
- To see a saved workspace, read the PNG its latest `Workspace:` line names, beside the output.
- Draw inside that round's frame with `agent-brief draw --board <name>`. Read it with `agent-brief read --board <name>`.
- Never save for the user or write `Workspace:` lines yourself.

On a conflict the CLI reads the file again and retries once. If it still fails, run `show` and repeat only your own line.

## Before and after pictures

For an HTML output, picture the item before you change it and again after:

- `agent-brief feedback snap <output> <n> --before`, then make the change, then `--after`.
- It captures the section or card around the item's `Where:` element, with the element outlined, or the whole page without one, into `<output>.feedback/<n>-r<round>-<side>.png` and appends the `Before:` or `After:` line. The round defaults to the item's latest. Pass `--round N` for another.
- Pictures taller than 10000 CSS pixels keep only their top, and the line ends `· clipped to the top 10000px`. Say so when you report it.
- Pictures never change. A retake writes `<n>-r<round>-<side>-2.png` and its own line. Picture the before once per round; snap `--after` again for each later fix. Other outputs return an error; skip pictures for them.
- The item card's slider shows each round's first before against its latest after.

## Project graph

`agent-brief feedback graph` lists every item by output with the sources that raised it, its `Related:` links both ways, and its workspaces. Add `--json` for nodes and edges. Use it to see how a transcript spread across outputs.
