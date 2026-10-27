---
name: outline-first
description: Shape a document or page as an outline of points, cites, sources and open questions in Agent Brief's <name>.outline.md before writing it, then generate the target from the outline and fold comments back in as a proposed direction. Use when the user asks to outline first, plan a memo, PRD, doc or page before drafting, runs /outline, or sends any prompt containing "(outline-first)", such as Check the cites, Generate, an Ask from the outline, comments on a target with an outline, or "Direction accepted".
---

# Outline first

The user and Claude shape an outline in Agent Brief's Write view. Generate writes the target (a document or page) from it. Comments on the target come back into the same outline as a proposed direction, and the user accepts it before the target changes.

Change the outline only through `agent-brief outline`. Never edit a `.outline.md` file directly. The app checks versions and the Write view reloads live. If `agent-brief` is not on PATH, use `"/Applications/Agent Brief.app/Contents/Resources/bin/agent-brief"`. Commands use `CLAUDE_CODE_SESSION_ID`, or `--session <id>`. If the app is down, say the outline was not changed.

Run each `agent-brief` command on its own, with no shell loops, variables or `&&` chains, so the user can allow it once.

## Commands

| Command | Does |
|---|---|
| `agent-brief outline list` | Outlines in the project, with counts |
| `agent-brief outline new "<title>" [--target <path>] [--kind document\|page]` | Makes the file and opens it in Write. Prints the path first |
| `agent-brief outline show <path> [--json]` | The outline and its ids |
| `agent-brief outline apply <path> --ops .feedback/outline-ops.json` | Applies ops. Prints the ids it added |

Write the ops with your Write tool to `.feedback/outline-ops.json`, then run `apply`. Ops target ids (`s1`, `p3`, `S2`), so run `show` first when you need existing ones. Give an add op a `label`, and later ops in the same batch can name its new id as `@<label>`. Labels share one namespace across sources, sections and points, so use distinct ones such as `src-pilot` and `sec-pilot`. A cite must name a source that exists, so add sources first. `show` prints points in order with their ids, so read it rather than piping `--json` through a script.

```json
[
  {"op": "addSource", "title": "CS ops dashboard export, Oct 2026", "ref": "data/cs-ops.csv", "label": "ops"},
  {"op": "addSection", "title": "Why change onboarding now", "label": "why"},
  {"op": "addPoint", "section": "@why", "text": "New accounts wait a median 6 business days for kickoff.",
   "cites": [{"source": "@ops", "location": "wait times"}], "guide": "State it as today's baseline"},
  {"op": "addPoint", "section": "@why", "kind": "open", "text": "Can support absorb async Q&A without a hire?",
   "default": "Assume no new hire and flag it as a risk"}
]
```

Later batches use the ids that `apply` printed or `show` lists:

```json
[
  {"op": "editPoint", "id": "p1", "cites": [{"source": "S1", "location": "wait times", "mark": "partly", "note": "Q3 accounts only"}]},
  {"op": "setDirection", "direction": {"state": "proposed", "scope": "sections", "from": "3 comments on docs/memo.md",
   "bullets": ["The memo asks leadership to choose among three options"], "changes": ["removed · section Recommendation"]}}
]
```

Other ops: `setMeta` (title, target, kind), `setIntent` (`lines` of `{key, text}`), `editSection`, `moveSection`, `removeSection`, `movePoint`, `removePoint`, `editSource` (`checked` among its fields), `removeSource`, `clearDirection`. An `editPoint` field replaces the old one whole, and `null` clears it. So `cites` lists every cite on the point.

## Start

On `/outline` or an outline-first ask:

1. Run `outline new "<title>"`, with `--target` when the path is known and `--kind page` for a page.
2. Seed it in one apply. Add the intent (Reader, Goal, Message, Guide), sections with substantive points, and the sources you know.
   - Include external sources beside project files. A Slack thread, Google Doc, ticket or web page you read or the user named goes in with its URL as `ref`.
   - Give every source a `ref` when one exists. The user opens sources from the outline by their ref.
3. Keep it to about one page. Add at most three open points, each with a `default`.
4. Do not write the target yet. Tell the user the outline is open in Write.

## Generate

1. Check the cites. Open and read each source, through a connector or web fetch when its ref is a URL. Mark each cite `supports`, `partly`, `not` or `unknown` (could not open it), with a note when the mark needs one. Record what the source establishes in `supports` and `notShown`, and set `checked` to today with `editSource`. Skip a source already checked today.
2. Write the target fresh from the outline and its sources. Without a target, pick a path beside the outline and set it with `setMeta`.
3. Honor every Guide, Keep and Default. Add no claim the outline lacks. Flag a gap instead of filling it. Soften or drop a point whose cite came back `not`, and tell the user which.
4. Check the result. Each point and each Keep is present. No outline language leaks into the prose, such as "the outline", "per the plan" or "judging by".
5. If the prose says a point differently from the outline, for example to soften a cite marked `partly`, edit that point in the same turn. The outline stays the record the next round builds on.
6. Declare the output with `declare_output`, or `agent-brief output "<title>" --path <target> --status ready`.

An Ask from the outline says "Update the outline only". Change the outline and leave the target alone, and name the outline's path in your reply. A request to check the cites alone runs step 1 and stops.

## Feedback on a target with an outline

Leave the target alone.

1. Read the comments together.
2. Replace superseded content in the outline rather than adding beside it.
3. Run `setDirection` with state `proposed`, a scope (`edit`, `sections` or `regenerate`), `from`, 3 to 6 bullets, and one `changes` line per outline change.
4. Reply in two or three lines, and name the outline's path so the row under the reply offers to open it. The user accepts the direction in Agent Brief, where your changes show marked.

When "Direction accepted" arrives, revise the target at that scope, check it as Generate does, then run `clearDirection`.

A review can also list edits the user made in Review's Edit mode. They are already saved in the target, so keep them. Write each one's wording back into its point with `editPoint`, and the next Generate keeps it. In your reply, flag any edit that changes a claim, number or cite.

## Pages

- Sections are screens or regions.
- Points are content and behavior.
- Sources may be boards (`Ref: board:<name>`, read with `agent-brief read --board <name>`) or screenshots.
- Write every visible word as static markup. Text a script shows, such as modal captions, goes in hidden elements the script reads, so Review's Edit mode can retype it.
