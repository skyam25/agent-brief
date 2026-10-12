---
name: wireframe
description: "This skill should be used when the user wants a UI wireframe, mockup, or schematic of a screen, page, modal, or flow — \"wireframe this\", \"sketch the UI\", \"mock up a screen\", \"show me a layout for…\", \"draw a before/after of this interaction\", or when proposing a UI change that's easier to see than to describe. Authors a compact `wireframe` DSL block and renders it to a polished standalone SVG with the bundled offline helper. Product-agnostic: works in any repo or doc, no workspace or services required."
---

# Wireframe

Turn a UI idea into a clean SVG mockup. You write a small, line-oriented
`wireframe` DSL block (YAML-like), then render it to an SVG with the bundled
helper — which runs on bare `node`, reaches no network, and writes only the SVG
file you name.

## Where files go

Keep the source DSL and its rendered output together in a `wireframes/` folder at
the project root, so a repo never gets littered with loose `.svg`/`.html` files:

```
wireframes/
  <slug>/                 # one folder per thing you're sketching
    <slug>.wireframe      # single mockup — or <slug>.md for a multi-block / options set
    <slug>.svg            # rendered output, co-located with its source
    <slug>.html           # options page, when there are alternatives
  themes/
    <brand>.json          # custom themes, reused across sketches
```

For a quick one-off, `wireframes/<slug>.wireframe` + `wireframes/<slug>.svg`
(no per-slug subfolder) is fine. Create the folder if it doesn't exist, name the
slug after the screen/flow (`notification-settings`, not `sketch1`), and **always
keep the `.wireframe`/`.md` source next to the render** — it's the editable
original; the SVG/HTML is regenerated from it. If the project already has a
convention (a `docs/`, `design/`, or `.wireframes/` dir), follow that instead.

## Show it in the chat first

The `show_image` tool draws a wireframe inline in the user's terminal (Ghostty or kitty). Pass the DSL block as `wireframe`, with a short `title`. The tool checks and renders it, keeps the `.wireframe` and `.svg` in `<project>/.feedback/shown/`, and draws the picture in the chat with Open and Copy path buttons. A block that fails to parse comes back as an error naming the line, so fix the block and call again.

To offer alternatives, call `show_image` once with a `title` for the choice and `options`, 2 to 4 entries each with `wireframe` and a `title`. Leave letters out of the option titles, because the sheet letters them A to D. The user sees them side by side, opens one alone from its tab, and presses Pick, which puts "Go with option B (Title)" in their prompt box. Vary the layout across options, not only the copy.

Write files under `wireframes/` (the loop below) when the user wants to keep the mockup, drop it in a doc or PR, or asked for a file. For a quick look, or a choice between directions, show it in the chat and skip the files.

## The loop

1. **Write** a `wireframe` block to its source file (e.g.
   `wireframes/notification-settings/notification-settings.wireframe`). Use the
   quick reference below.
2. **Check + render** in ONE call, writing the output beside the source:
   `node ${CLAUDE_PLUGIN_ROOT}/bin/wireframe-render.mjs --in wireframes/notification-settings/notification-settings.wireframe --out wireframes/notification-settings/notification-settings.svg --strict`
   — `--strict` lints first and refuses to write on any warning, printing the
   line-numbered problem to fix (a block that fails to parse would otherwise
   render as plain text). No separate `--check` pass needed. Optionally
   `--theme wireframes/themes/brand.json` to restyle (see the `wireframe-theme`
   skill), or `--stdout` to print the SVG instead of writing a file.

Then show the user the SVG path (or open it). The renderer draws the real text
you put in the block, so use real copy, not lorem ipsum.

**Presenting several options.** When you're offering alternatives, put each in its
own ```` ```wireframe ```` fence in one `.md` file (e.g.
`wireframes/<slug>/<slug>.md`) and render them to a single self-contained HTML
page of lettered tabs (A · B · C) beside it, each embedding its SVG:

```
node ${CLAUDE_PLUGIN_ROOT}/bin/wireframe-render.mjs --in wireframes/<slug>/<slug>.md --html --out wireframes/<slug>/<slug>.html --title "…"
```

Annotate each block with leading `#` comment lines (the parser ignores comments):
`# option: <title>`, `# best-when: <when it's the right call>`, `# risk: <the cost>`,
and a bare `# suggested` on the one you recommend (it opens first). Then give the
user the HTML path. Use this whenever you'd otherwise paste several SVGs — one
portable file reads better and prints cleanly.

## Two authoring rules

1. **Mirror what exists; sketch schematically when it doesn't.** If you're
   sketching a change to a real product/screen, map DSL primitives to its actual
   components and keep the chrome consistent. With no ground truth, use defaults,
   label frames generically, and don't fabricate brand specifics.
2. **Match the layout to the change.** A section landing on one surface →
   `single`. A pattern swap or before→after → `transformation`. A staged
   evolution of one surface → `evolution`.

## DSL quick reference

YAML-like, **2-space indent, no tabs**. Quotes optional unless the string has
commas/brackets. Inline arrays use `[a, b]`. Comments start with `#`. Fence (in
markdown) is exactly ```` ```wireframe ```` — no language alias.

**Top-level:** `layout: single | transformation | evolution` (default single) ·
`size: sm | md | lg | page` (default md; `page` = full route with chrome) ·
`callouts: ["note", …]` (numbered legend below frames; pair with `marker:`).

- `single` — frame keys at top level.
- `transformation` — `left:` / `right:` child frames + `arrow: { top: "MOVE", bottom: "into the drawer" }`:

```wireframe
layout: transformation
left:
  frame: browser
  label: "current"
  body:
    - heading: "Notifications"
    - row: [toggle, "Mentions"]
arrow:
  top: MOVE
  bottom: into drawer
right:
  frame: panel
  body:
    - heading: "Project · notifications"
    - button: "Save"
```

- `evolution` — `frames:` list (each a frame block) + `transitions: ["make it punchier", …]`.

**Frame keys:** `frame: browser | doc | dark-app | terminal | napkin | panel | none`
· `label: "…"` (caption above) · `viewport: desktop | mobile | tablet` ·
`grid: { columns: 12, gap: 16 }` · `sidebar: { items: ["Home", { label: "Inbox", badge: "3" }], active: "Home" }`
(left nav rail) · `topbar: { title: "…", actions: ["Export", "Create"] }` (last
action renders primary) · `overlay: { variant: modal | drawer-right | drawer-left, label: "…", body: [...] }`
(dims the base page with a scrim, draws the surface on top — keep the dimmed base
skeletal, size lg/page) · `body:` (ordered entry list).

**Body entries:**

- `heading: "…"` · `para: 3` (3 placeholder bars) or `para: "real text"` · `accent: "…"` (highlight bar) · `divider` · `spacer`
- `button: "Save"` · `button: ["Cancel", outlined]` — two `button:` entries stack vertically. Side-by-side CTAs are ONE `buttons:` list (same item shapes):

```
  - buttons:
      - "Save"
      - ["Cancel", outlined]
```
- `row: [toggle, "Mentions"]` (also `checkbox` | `icon`)
- tabs with active state — `active:` is an indented sibling line, never its own `- ` item:

```
  - tabs: ["List", "Calendar", "Search"]
    active: "List"
```

  Nav/segmented strips are tabs, never chips. `steps:` takes the same sibling `active:`.
- `chip: ["BETA", { label: "LIVE", tone: ok }]` — status/tag pills only
- `breadcrumbs: ["Settings", "Billing"]` · `pagination: { page: 2, pages: 9 }`
- `list:` of `{ leading: icon | avatar, title: "…", meta: "…", badge: "3" }`
- `field: { label: "…", placeholder: "…", variant: input | select | search | textarea }` — `value:` instead of placeholder = filled state
- `banner: { variant: info | warning | error | success, text: "…" }` · `empty: { heading, helper, cta }`
- `stat: { value: "1,234", label: "…", trend: "+12%" }` · `meter: { label: "Storage", value: 7, max: 10, caption: "7 of 10 GB" }`
- `avatar: "AB"` · `avatar-stack: ["AB", "CD"]`
- `table: { columns: ["A", "B"], weights: [3, 2], rows: [["x", { pill: "Live", tone: ok }]] }` — status cells are pills, not text; give long columns more weight
- `media: { label: "…", variant: image | chart }` · `card-grid: { columns: 3, cards: [{ title: "…", meta: "…" }] }`
- `accordion:` of `{ title: "…", expanded: true, body: [...] }` · `popover: { anchor: bottom, body: [...] }`
- `columns:` of `{ label: "Main", span: 8, body: [...] }` — page-grid regions, use inside `size: page`
- any entry + sibling line `marker: 1` → numbered badge, pairs with `callouts:`

**Rules:** real copy, never placeholders. Page-level CTAs go in `topbar.actions`,
not body buttons. Density per size: ~6 entries at `sm`, ~12 at `md`, ~18 at `lg`,
~28 at `page`. When sketching alternatives, vary the *layout* across them — they
should read as distinct structural choices, not content-only diffs. Validate and
render in ONE call: `--out <file.svg> --strict` (lint warnings are fatal and the
message tells you what to fix — no separate `--check` pass needed).

## Full catalog

The cheat sheet above covers the common case — **including overlays, page grids,
markers/callouts, and every body entry listed; do not re-read those elsewhere**.
Read `references/wireframe-format.md` only for what the cheat sheet genuinely
lacks: `evolution` transition details, edge-case primitive options, worked
examples, or the rendering-failure troubleshooting table.

## Restyling

The default theme is a clean white-and-blue palette. To match a brand or product, see
the `wireframe-theme` skill (or pass `--theme path/to/theme.json` to the helper).
The DSL itself never carries colors or pixel sizes — those live in the theme.
