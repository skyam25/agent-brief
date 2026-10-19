---
name: feedback-items
description: Catalog feedback rounds (SME, customer or stakeholder transcripts and notes) as tracked items beside an output such as a prototype or PRD, in Agent Brief's <output>.feedback.md. Use when the user hands over feedback, interview transcripts or review notes about an output, asks to log or triage feedback, or sends "Feedback decisions" from Agent Brief.
---

# Feedback items

Each output can carry a feedback file beside it: `prototype/checkout.html` → `prototype/checkout.html.feedback.md`. Every point from every round becomes an item there. The user decides on each item in Agent Brief's Review pane, and the items outlast sessions.

Write the file only through `agent-brief feedback`. The app checks versions, adds dates and keeps the file add-only. If `agent-brief` is not on PATH, use `"/Applications/Agent Brief.app/Contents/Resources/bin/agent-brief"`. The app must be running and the session registered. Commands use `CLAUDE_CODE_SESSION_ID`, or `--session <id>`. If the app is down, say the items were not recorded, and do not claim they were.

## Catalog first

Change nothing in the output until the user decides. A round is cataloged, not applied.

1. Run `agent-brief feedback list` and `agent-brief feedback show <output>` to see what exists.
2. Add the round: `agent-brief feedback round <output> --label <SME|customers|…> --source <transcript path>`.
3. Go through the source in order. For each point, quick ones included, check for a match first:
   - `agent-brief feedback related <output> --text "<the point in a few words>"` lists look-alike items across the project.
   - The same point seen again is the same item. Add a `Src:` line to it, never a new item:
     `agent-brief feedback log <output> 6 Src '2 · Maya · 00:14 · "Still no filters"'`
   - A near-repeat, or the same point on another output, is a new item with a `Related:` line.
   - Otherwise add the item:

```bash
agent-brief feedback add prototype/checkout.html \
  --title "Hard to find the filters" \
  --src '1 · Ana · 03:02 · "Where do I filter?"' \
  --change "Move the filter row above the results. Sort stays on the right." \
  --where '#filters' \
  --related 'pricing.html #3'
```

4. Tell the user how many items the round added or joined, and that they decide in Agent Brief, Review → the output → Feedback.

Item fields:

- Title: the problem as the speaker felt it, in a few words.
- `Src`: `<round> · <speaker> · <time> · "<quote>"`. Quote the speaker word for word; the time is the transcript timestamp, or `-` without one. Repeat `--src` for several speakers.
- `Change`: the change you propose. One line, concrete.
- `Where`: a unique CSS selector for an HTML output, such as `#filters` or `[data-ui="filters"]`; a heading (`## Pricing`) or line (`L42`) for a text output. Optional. The panel's Show on page uses it.
- `Related`: `<output path relative to this file's folder> #N`.
- `--round N` files the item under an earlier round. It defaults to the newest.

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
    Where: #filters
    Claude: 2026-10-12 · cataloged
    You: 2026-10-12 · accept · keep it sticky on scroll
    Claude: 2026-10-12 · done · commit 3f2a91c
```

- Rounds are a registry, newest first. Items follow in the order they came in. Numbers never repeat.
- The file is add-only. Writes append a line, add an item or round, or flip a checkbox. Never edit or delete a past line, even a wrong one. Correct it with a new line.
- `Claude:`, `You:`, `Workspace:` and `Review:` lines are dated events. You write `Claude:` lines; `You:` lines come only from the user in the panel.
- State comes from the last state verb: open (`cataloged`, `reopen`), accepted (`accept`), rejected (`reject`, `rejected`), done (`done`). `[x]` marks done or rejected.
- `You: … · sent` marks decisions the user already sent you.

## Act on decisions

The user's Send decisions message starts with `@<output>.feedback.md` and lists the items decided since the last send.

1. Read the file with `agent-brief feedback show <output>`. The newest `You:` lines on each item are the decision and its reasons.
2. Accepted: make the change, within what the user authorized. Then log it:
   `agent-brief feedback done <output> <n> "<what changed, briefly>" --commit <sha>`
   In a git repo, commit first and pass the hash. Outside one, leave `--commit` off.
3. Rejected: change nothing. The item is already closed.
4. Notes and voice notes: answer with `agent-brief feedback log <output> <n> Claude "note · <answer>"`. Reopened items get a fresh look and a `Claude` line.
5. Log what you did not do, too, such as `Claude "note · blocked on the pricing API"`. Every change gets a dated line.
6. Say which items you closed and which still wait on the user.

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
- It captures the item's `Where:` element, or the visible page without one, into `<output>.feedback/<n>-r<round>-<side>.png` and appends the `Before:` or `After:` line. The round defaults to the item's latest. Pass `--round N` for another.
- A retake replaces the picture and keeps its one line. Other outputs return an error; skip pictures for them.
- The item card shows the pair as a slider.

## Project graph

`agent-brief feedback graph` lists every item by output with the sources that raised it, its `Related:` links both ways, and its workspaces. Add `--json` for nodes and edges. Use it to see how a transcript spread across outputs.
