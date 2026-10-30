---
name: initiative-brief
description: Attach this session to the user's Agent Brief initiative and keep its brief current. Use when a prompt carries an "Agent Brief · recent initiatives" line or a "--- Agent Brief initiative ---" snapshot, when the user names an initiative, a project or workstream they track across sessions, or runs /initiative. Also use to draft a new initiative from the session, or to survey a product folder for likely initiatives (Discover).
---

# Initiative

An initiative is the user's unit of work above the session: a launch, a pricing change, an onboarding rework. It runs for weeks across many sessions. Agent Brief keeps one short standing brief for it, a Markdown file named `<Title> brief.md` in the initiative's folder. You read it, you keep it current, and the user reviews and edits it.

Once a session is attached, each prompt that follows a change carries a snapshot between `--- Agent Brief initiative ---` lines. The latest snapshot is the truth. Nothing is injected until the session is attached.

If `agent-brief` is not on PATH, use the copy inside the app, quoted because the path has spaces.

```bash
"/Applications/Agent Brief.app/Contents/Resources/bin/agent-brief" initiative recent
```

## Commands

| Command | Does |
|---|---|
| `agent-brief initiative recent [--limit 3]` | The initiatives touched most recently, one line each |
| `agent-brief initiative find <words>` | The top three by term overlap on title, Understanding and decisions |
| `agent-brief initiative list` | Every initiative. For Discover and the panel, not for matching |
| `agent-brief initiative show <id or title>` | The whole initiative with its revision |
| `agent-brief initiative attach <id or title> [--session <id>]` | Attaches the session |
| `agent-brief initiative detach [--session <id>]` | Detaches it |
| `agent-brief initiative create <title> --folder <path> [--file draft.json]` | Writes the brief file in `<path>` and indexes it |
| `agent-brief initiative update <id> --file <json>` | Changes the brief at a revision |

Reads work with the app closed. Writes need the app and exit 3 when it is down; tell the user to start Agent Brief and do not retry in a loop. Without `--session`, attach and detach use this shell's Claude Code session.

## Attaching

- When the user names an initiative, attach that one. Their choice wins over your match.
- Otherwise match the first prompt against the recent line it carries. Attach only when the work clearly belongs to one.
- When none fits but the work looks like a tracked initiative, run `find` with a few words from the prompt. Attach a clear winner. Otherwise ask once, naming the candidates.
- When nothing fits, work without one. Do not create an initiative unasked.
- Attach before you start the work, so the next prompt carries the snapshot and the brief guides what you do.
- Say in one line what you attached, so the user can correct it. Never hide the command's output.

## Keeping the brief

The brief says where the work stands, not what happened. Update it when something a later session needs has changed:

- A decision was made or reversed. Add a dated line. Name what it supersedes, and link the decision record when the folder map has a decisions folder.
- A question opened or closed. Add it to Open, or remove it.
- The understanding moved. Rewrite Understanding in a few sentences, as you would brief a colleague joining tomorrow.

Do not update it for routine progress, for tool output, or for what the folder's CLAUDE.md already says. The brief complements CLAUDE.md, which holds how to work; the brief holds where this initiative stands. Keep Understanding short, a few hundred words at most.

Write the change as JSON with the revision you read and only the fields you change. Write the file with the Write tool, then run `update` as its own command. A heredoc in the same command needs a permission prompt each time.

```json
{ "revision": 7, "decisions": ["2026-10-14 Monthly-first (B over A); supersedes 2026-09-30 annual-first. → [D-012](<file:/Users/me/PM/Product/07-decisions/D-012.md>)"], "open": ["Legal review of trial terms"] }
```

`decisions` and `open` replace the whole list, so send every line you keep. Agent Brief adds a row under Outputs itself when an attached session declares an output Ready, so leave Outputs alone. The snapshot lists those rows. Look there for the latest deliverables before you search the folder. A conflict means the user or another session changed the brief. Run `show`, merge your change into what is there, and update at the new revision.

## New initiative

When `/initiative` asks you to draft one from the session:

1. Title it as the user would say it, in two or three words.
2. Write Understanding from what this session established.
3. Turn each Ready output into a Working row: `<title> [<file name>](<file:<absolute path>>) current`.
4. Propose a folder map from the folders the session used. Give each a role: `working`, `sources`, `decisions`, `grounding` or `outputs`.
5. Put the brief in the folder the work lives in. Ask only when that is unclear.
6. Write `{ "understanding", "folders": [{ "path", "role" }], "working": [...], "decisions": [...], "open": [...] }` to a temp file. Run `create`, then `attach` with the id it prints.

## Discover

When `/initiative discover` asks you to survey a product folder:

1. Run `agent-brief initiative list` and leave out initiatives that already exist.
2. Look at the folder's top two levels and its CLAUDE.md. Read file names and headings, not whole documents.
3. List each likely initiative with a title, one line on why, and its folders by role.
4. Create nothing until the user picks. Then follow New initiative.

## Talking about folders

The user's folders are theirs. The initiative maps them and never moves anything. When you talk to the user about the brief, speak in roles: Sources, Decisions, Working, Grounding, Outputs. Say "the decisions folder", not `07-decisions`. A folder's own name appears only as a row of the map, where the user sees what it points at.
