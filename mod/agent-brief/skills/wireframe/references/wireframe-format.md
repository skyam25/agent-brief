# Wireframe block format

A `wireframe` fenced code block carries a structured UI mockup. The bundled
renderer parses this DSL and renders it as a polished standalone SVG. This file
is the full vocabulary; the common case is in the skill's quick reference. Paths
to the renderer below assume `${CLAUDE_PLUGIN_ROOT}/bin/wireframe-render.mjs`
— adjust if you vendored the helper elsewhere.

## Contents

- Two authoring rules (mirror grounding; vary layout)
- Anatomy of a wireframe block
- Top-level keys
- Canvas sizes (+ shape templates by surface)
- Layouts (`single` / `transformation` / `evolution`)
- Frames
- Content primitives
- Overlays (modal / drawer in context)
- Three shapes for three approaches (worked example)
- Annotations (arrow, transitions, markers + callouts)
- Authoring tips
- Common rendering failures (fence/indent/keys) + lint feedback
- Validating with the helper

## Two authoring rules

Two rules carry the wireframe step; everything else is mechanics.

**(1) Mirror grounding when it exists; sketch schematically when it doesn't.** If
you're sketching a change to a real product or screen — you have its components,
screenshots, or a flow doc — map DSL primitives to the named components
(a toggle row → `row: [toggle, …]`; nav strip → `tabs:`; left rail → `sidebar:`)
and keep the chrome consistent with the product. Without ground truth, use DSL
defaults, label frames generically, and do not fabricate brand specifics.

**(2) Match the layout to what you're proposing; vary it across alternatives.**
New section in an existing surface → `single` showing that surface with the
section landed. Pattern swap → `transformation`. Staged interaction → `evolution`.
Page-level IA shift → `size: page` with `sidebar:` and `topbar:`. Component-local
change → `frame: panel`. When you sketch several alternatives, two landing on the
same shape signal that one is redundant — they should read as distinct structural
choices, not content-only diffs.

See [Three shapes for three approaches](#three-shapes-for-three-approaches) for a
worked counterexample: same problem, three structurally distinct wires.

## Anatomy of a wireframe block

````markdown
```wireframe
layout: transformation
left:
  frame: browser
  label: "current — settings/notifications"
  body:
    - heading: "Notification preferences"
    - para: 3
    - row: [toggle, "Mentions"]
    - row: [toggle, "Threads"]
arrow:
  top: "MOVE"
  bottom: "into project drawer"
right:
  frame: browser
  label: "proposed"
  body:
    - heading: "Project · notifications"
    - row: [toggle, "Mentions"]
    - row: [toggle, "Threads"]
    - button: "Save"
```
````

The parser is line-oriented and indent-sensitive (2 spaces per level). Strings may
be quoted (`"…"`) or unquoted when they contain no commas or brackets. Inline
arrays use `[a, b]`. Comments start with `#`.

## Top-level keys

| Key | Required | Notes |
|---|---|---|
| `layout` | yes | One of `single`, `transformation`, `evolution`. Defaults to `single` when omitted. |
| `size` | optional | One of `sm`, `md` (default), `lg`, `page`. Sets the canvas width per frame. See "Canvas sizes". Override on a child frame to make one side larger in `transformation`/`evolution`. |
| `frame` | when `layout: single` | The frame type — see "Frames". |
| `label` | optional | Mono uppercase label above the frame (filename style: `PRD.MD`, `LOCALHOST:3000`, `current — settings`). |
| `viewport` | optional, frame-level | `mobile`, `tablet`, or `desktop`. Sets the default design grid columns (4 / 8 / 12) and stacks `columns:` regions on mobile. |
| `grid` | optional, frame-level | `{ columns: 12, gap: 16 }`. Use with `columns:` when the idea is about page composition or responsive behavior. |
| `sidebar` | optional, frame-level | Inline list of labels or `{ items, active }`. Renders a left nav rail with an active indicator. Use when the rail is part of the idea (app-shell sketches) — not for in-frame menus. |
| `topbar` | optional, frame-level | `{ title, actions }`. Renders a header above the body. Last action is styled as primary. Use when the page header carries the idea (route-level treatments). |
| `body` | when `layout: single` | Ordered list of content primitives — see "Content primitives". |
| `left`, `right` | when `layout: transformation` | Two child blocks, each with `frame`, `label`, `body` (and optional `size` / `sidebar` / `topbar`). |
| `arrow` | optional under `transformation` | Annotation between left and right with `top` (mono uppercase) and `bottom` (serif italic) labels. |
| `frames` | when `layout: evolution` | Ordered list of frame blocks; inline labels between them go in `transitions`. |
| `transitions` | optional under `evolution` | Ordered inline annotations between evolution frames (e.g. `"make it punchier"`). One fewer entry than `frames`. |
| `overlay` | optional, frame-level | `{ variant: modal \| drawer-right \| drawer-left, label, body }`. Draws a scrim over the frame and the overlay surface on top. See "Overlays". |
| `callouts` | optional, top-level | Ordered list of annotation strings. Renders a numbered legend below the frames; pair each entry with `marker: <n>` on a body entry. See "Annotations". |

## Canvas sizes

Pick the size that lets the wire communicate what the idea is *about*. Render at
whatever fidelity carries the point — not whichever fits in the smallest box.

| `size:` | Frame width | Total canvas (single / transformation / 3-frame evolution) | Use when |
|---|---|---|---|
| `sm` | 280 px | ~350 / ~770 / ~1190 px | Single control, micro-treatment, comparing tiny surfaces, many side-by-side variants |
| `md` (default) | 360 px | ~430 / ~930 / ~1430 px | Tab content, modal, panel — the typical placement sketch where chrome is elided |
| `lg` | 540 px | ~610 / ~1290 / ~1970 px | Drawer, dense settings page, adjacent-region layouts where panel structure matters |
| `page` | 820 px | ~890 / ~1850 / ~2810 px | Full route, dashboard, IA restructure — draw the actual page including chrome, nav, side rails |

Sizes are a hint, not a hard contract: padding and primitive sizes are tuned per
bucket so the wire reads cleanly at thumbnail and at natural size. Smaller is
better when smaller is honest; don't inflate `size:` past what the idea needs.

### Shape templates by surface

Starting points, not a fence — pick the shape from what you're actually showing,
then trim chrome the moment it isn't part of the point.

| Surface | Shape | Notes |
|---|---|---|
| Modal, dialog, drawer, form | `frame: panel`, `size: md` (or `lg` for dense forms), no chrome | Buttons live in `body:` (Save/Cancel). No `sidebar:`/`topbar:`. |
| Component placement (toggle row, callout, inline control) | `frame: panel` or `frame: none`, `size: sm` | One or two body entries. No chrome — the wire is about the component, not the page. |
| Full route / page (list, dashboard, settings root) | `frame: browser`, `size: page`, `viewport: desktop`, optional `grid:`, `sidebar:` + `topbar:` | Page-level CTAs go in `topbar.actions`. Use `columns:` for main/aside, dashboard, multi-region composition. |
| Page section without page chrome (already inside a route) | `frame: browser`, `size: md` or `lg`, no `sidebar:`/`topbar:` | Body buttons are fine. Don't draw chrome you aren't deciding about. |
| Empty / first-run state | `frame: browser`, `size: lg` or `page`, `body: - empty: …` | Include `sidebar:`/`topbar:` only if the empty state sits inside the app shell and the shell is part of the framing. |
| Doc → live treatment (input → output) | `layout: transformation`, `frame: doc` → `frame: browser` | Arrow typically names the transform on top, the steps on the bottom. |

Sidebar and topbar are optional on every shape. Chrome you don't need is visual
noise, not context.

To mix sizes inside one wireframe (e.g., current state at `md`, proposed at
`page`):

```wireframe
layout: transformation
left:
  size: md
  frame: browser
  label: "current — settings tab"
  body:
    - heading: "Notifications"
    - row: [toggle, "Mentions"]
arrow:
  top: PROMOTE
  bottom: to top-level page
right:
  size: page
  frame: browser
  label: "proposed — full notifications page"
  body:
    - heading: "Notifications"
    - para: 2
    - divider
    - heading: "Email"
    - row: [toggle, "Mentions"]
    - row: [toggle, "Threads"]
    - heading: "Push"
    - row: [toggle, "Mentions"]
    - button: "Save preferences"
```

## Layouts

### `single`

One frame, the simplest case. Use for a placement mockup on a single surface.

```wireframe
layout: single
frame: browser
label: Settings · notifications
body:
  - heading: Notifications
  - row: [toggle, "Mentions"]
  - row: [toggle, "Threads"]
  - button: Save
```

### `transformation`

Two frames side by side with an arrow between. Use for *before → after*,
*input → output*, or *current → proposed*.

```wireframe
layout: transformation
left:
  frame: doc
  label: SPEC.MD
  body:
    - accent: "Notification preferences"
    - para: 3
    - heading: "Routing rules"
    - para: 2
arrow:
  top: BUILD
  bottom: scaffold · route · serve
right:
  frame: browser
  label: LOCALHOST:3000
  body:
    - heading: "Notification preferences"
    - para: 2
    - button: "Get started"
```

### `evolution`

Three or more frames in a row showing the same surface evolving. Use for treatment
iteration, scope expansion, or staged rollout.

```wireframe
layout: evolution
frames:
  - frame: browser
    label: "V1 · bland"
    body:
      - para: 1
      - button: ["Click", outlined]
      - para: 1
  - frame: browser
    label: "V2 · bolder"
    body:
      - heading: "Get started"
      - para: 1
      - button: "Get started"
  - frame: browser
    label: "V3 · shipped"
    body:
      - heading: "Get started"
      - para: 1
      - button: "Get started"
      - button: ["Watch demo", outlined]
transitions:
  - "make it punchier"
  - "add some warmth"
```

## Frames

The container around a body. Each frame has its own chrome treatment.

| Frame | Visual | When to use |
|---|---|---|
| `browser` | Light, three dots + URL bar | Web app surfaces, marketing pages |
| `doc` | Sheet of paper, no chrome | Specs, docs, markdown |
| `dark-app` | Dark window | Native app surfaces, "live" indicators |
| `terminal` | Dark with monospaced text | CLI flows, command lists |
| `napkin` | Hand-drawn outline | Sketches, low-fidelity ideation |
| `panel` | Rounded card container, no chrome | Component-level sketches where the surrounding page would distract |
| `none` | Bare content, no chrome | When even the panel outline would distract |

## Content primitives

The `body` is an ordered list. Each entry is one primitive. Keep it short — under
~10 primitives per frame is usually enough.

### Text bars

```
- heading: "Notification preferences"   # dark, bold-weight text bar
- para: 3                               # 3 light text bars (body copy)
- para: "actual text"                   # single bar with real text
- accent: "Notification preferences"    # accent-colored bar (highlight)
- accent: 1                             # 1 generic accent bar
```

**`accent:` is a content highlight, not a section break.** It renders as an
accent bar sized to its text (or ~60% width when bare). Use it to flag a
heading/copy you want to call attention to. To break up sections, use `- divider`
or `- spacer` — a bare `- accent` floating between unrelated rows reads as noise.

### Controls

```
- button: "Save"                        # filled primary button
- button: ["Cancel", outlined]          # outlined secondary button
- buttons:                              # side-by-side button row (one slot, multiple CTAs)
    - "Get started"
    - ["Watch demo", outlined]
- row: [toggle, "Mentions"]             # toggle + label row
- row: [checkbox, "Remember choice"]    # checkbox + label row
- row: [icon, "Settings"]               # icon placeholder + label
- chip: "BETA"                          # pill tag (mono uppercase) — STATUS/TAG/BADGE only
- chip: ["BETA", "NEW"]                 # multiple chips on one row
- chip: [{ label: "LIVE", tone: ok }, "BETA"]  # tone: ok | warn | error | muted | accent
- tabs: ["List", "Calendar", "Search"]  # nav strip with underline indicator
  active: "Calendar"                    # sibling: active label or 0-based index
- breadcrumbs: ["Settings", "Workspace", "Members"]  # path trail; last item bold
- pagination: { page: 2, pages: 9 }     # ‹ 1 [2] 3 … 9 › — collapses long ranges
```

**Use `buttons:` (plural) when CTAs sit side-by-side; use `button:` (singular)
when they stack.** Two `- button:` entries always stack vertically (each is its
own body slot). For a primary + secondary on one line (marketing hero, modal
footer, dialog action row), use `buttons:`. The first entry renders primary; add
`outlined` to mark a secondary.

**Chips are not tabs.** `chip:` renders a small pill — a "BETA" badge, a status
tag, a category label. Do *not* use it for nav strips or segmented controls; those
are `tabs:` and render with the active label underlined.

### Lists and forms

```
- list:                                 # multi-line list items (leading + title + meta + trailing)
    - { leading: icon, title: "Acme Summit", meta: "Apr 22, 10:00 PT" }
    - { leading: avatar, title: "Bob Loblaw", meta: "Online", trailing: "Edit" }
    - { leading: icon, title: "Inbox", badge: "12" }   # trailing count pill
    - "Just a title"                    # bare strings collapse to title-only items
- field:                                # labeled input
    label: "Event title"
    placeholder: "Untitled event"
    variant: input                      # input (default) | select | search | textarea
- field: { label: "Find events", variant: search }
- field: { label: "Event title", value: "Spring Summit 2026" }  # value: = FILLED state (full-ink text)
- accordion:                            # collapsible sections (chevron + title rows)
    - title: "General"
      expanded: true                    # expanded items render their body indented
      body:
        - row: [toggle, "Weekly digest"]
    - title: "Advanced"                 # collapsed items show just the header row
    - title: "Danger zone"
```

`list:` is the right primitive for "list of items with a leading visual and
metadata" — don't stack flat `row:` entries for content lists. Add `badge: "<text>"`
on any item for a small trailing count/status pill. `field:` covers
inputs/selects/search bars/textareas in one primitive; pick the `variant:`.

`accordion:` is for grouped/collapsible sections and master-detail expansion. When
no item sets `expanded: true`, the first item with a body renders open. Items can
omit `body:` to read as collapsed headers.

### Feedback and empty states

```
- banner:                               # full-width notice with icon
    variant: info                       # info | warning | error | success
    text: "Heads up — sending domain changes Apr 22"
- empty:                                # empty-state composite
    heading: "No events yet"
    helper: "Create your first event to start"
    cta: "Create event"
```

`banner:` is the full-width notification bar with an icon glyph (lowercase `i` for
info, `!` for warning/error, `✓` for success). `accent:` (a narrow highlight bar)
is a different primitive — don't substitute one for the other. `empty:` is the
three-part empty-state composite; use it for any "first run" / "no data yet"
treatment.

### People and metrics

```
- avatar: "AB"                          # single circle with initials
- avatar-stack: ["AB", "CD", "EF"]      # overlapping group
- avatar-stack: { count: 3, overflow: "+5" }  # placeholder ring + overflow chip
- stat:                                 # big number + label + optional trend
    value: "1,234"
    label: "Active events"
    trend: "+12%"                       # leading sign infers direction (up=green, down=accent)
- meter: { label: "Storage", value: 7, max: 10, caption: "7 of 10 GB" }  # progress/usage bar
- meter: 70                             # bare number = percent of 100
```

`meter:` is the quota/progress primitive — usage bars, onboarding completion,
capacity. `label` renders uppercase on the left, `caption` right-aligned, and the
track fills `value / max` in the accent color. Pair with `stat:` when the surface
carries both the number and the bar.

### Data

```
- table:                                # bounded data grid
    columns: ["Event", "Status", "Date"]
    weights: [3, 2, 1]                  # optional per-column width ratios; omit = equal split
    rows:
      - ["Acme Summit", { pill: "Live", tone: ok }, "Apr 22"]
      - ["Q2 Demo", { pill: "Draft", tone: muted }, "May 5"]
```

Table is heavy — use it only when the data shape *is* the point. Most "list of
records" ideas read better as `list:` with `meta:` carrying secondary fields.

**Status columns are pill cells, not text.** A cell is a plain string or
`{ pill: "<short label>", tone: ok | warn | error | muted | accent }`. Tone
aliases `success`/`good` → `ok`, `warning` → `warn`, `danger` → `error`; the same
tones and aliases apply to `chip:` items.

**Column widths.** Without `weights:` every column gets an equal share, which
truncates long cells in tables of 4+ columns below `size: page`. Give long columns
more weight (`weights: [3, 4, 3, 2, 2]` — one entry per column, positive
integers), step up to `size: page`, or fall back to `list:`. A lint flags wide
tables that would truncate.

### Media, cards, and steps

```
- media: { label: "Hero image", ratio: "16:9", variant: image } # image | video | illustration | chart
- media: { label: "Signups by week", variant: chart }           # chart = bar-silhouette placeholder
- card-grid:
    columns: 3
    cards:
      - { title: "Starter", meta: "Free" }
      - { title: "Team", meta: "$20" }
- steps: ["Describe", "Review", "Publish"]
  active: "Review"                      # sibling, like tabs:; earlier steps render completed, later upcoming
```

Use `media:` for screenshots, hero imagery, thumbnails, or visual references —
`variant: chart` when the region holds a trend/bar/analytics visual (pair with
`stat:` for the KPI number). Use `card-grid:` when the point is card density,
plan/package selection, or dashboard tiles. Use `steps:` for onboarding, setup,
or staged-review concepts; set `active:` when *where the user is* matters.

### Page regions and responsive grids

`columns:` is the page-layout primitive. It uses the frame's `grid:` (or
`viewport:` default) to draw side-by-side regions; on `viewport: mobile`, regions
stack automatically.

```wireframe
layout: single
frame: browser
size: page
viewport: desktop
grid: { columns: 12, gap: 16 }
topbar: { title: "Projects", actions: ["Export", "New project"] }
body:
  - columns:
      - label: "Main"
        span: 8
        body:
          - heading: "Projects"
          - table:
              columns: ["Project", "Status"]
              rows:
                - ["Migration", "Active"]
      - label: "Inspector"
        span: 4
        body:
          - stat: { value: "12", label: "Open items" }
          - list:
              - "Decision needed"
              - "Follow-up queued"
```

Defaults: `viewport: mobile` = 4 columns, `tablet` = 8, `desktop` = 12. Override
`grid.columns` for product-specific grids. Use spans to communicate relative
region weight, not pixels. For responsive behavior, use `layout: evolution` with a
desktop frame and a mobile frame rather than writing CSS.

For repeated dashboards or quick main/aside splits, `ratio:` is a span shorthand —
list the spans positionally and drop the per-region `span:`:

```wireframe
- columns:
    ratio: [8, 4]                       # region 0 → span 8, region 1 → span 4
    gap: 24                             # override the frame grid gap
    regions:
      - body:
          - heading: "Main"
          - table: { columns: ["X", "Y"], rows: [["a", "b"]] }
      - body:
          - stat: { value: "12", label: "Open items" }
```

Regions accept `title:` as an alias for `label:` when that reads more naturally.

### Layout dividers

```
- divider                               # horizontal rule
- spacer                                # vertical gap
```

### Popovers (overlay menus / callouts)

```
- popover:
    anchor: bottom                      # top | bottom | left | right (where the arrow notch sits)
    width: 200                          # optional, defaults to a sensible bucket
    body:
      - row: [icon, "Profile"]
      - row: [icon, "Settings"]
      - divider
      - row: [icon, "Sign out"]
```

`popover:` renders a small overlay card with a directional arrow notch — for a
menu, action callout, or contextual panel hanging off an anchor in the surface
above. Body entries follow the same grammar as a frame body. Keep popovers short
(3–6 entries); a long popover means the surface should be a panel or drawer.

### Frame-level chrome (sidebar, topbar)

When the point is route-level — IA shift, dashboard restructure, full-shell
treatment — draw the app shell. `sidebar:` and `topbar:` go at the *frame* level
(sibling of `body:`), not in the body, because they're chrome, not content.

```wireframe
layout: single
frame: browser
size: page
label: "/events page"
sidebar:
  items: ["Home", "Events", "Team", "Settings"]
  active: "Events"
topbar:
  title: "Events"
  actions: ["Export", "Create event"]
body:
  - tabs: ["List", "Calendar", "Search"]
    active: "List"
  - list:
      - { leading: icon, title: "Acme Summit", meta: "Apr 22, 10:00 PT · Live" }
      - { leading: icon, title: "Q2 customer demo", meta: "May 5 · Draft" }
```

Use `sidebar` / `topbar` only when the rail or header is part of the point. For
local component changes, drop them and use `frame: panel` or `frame: none`.

**Sidebar items can carry badges and nested sub-items.** Switch from the
inline-list shorthand to the object form:

```wireframe
sidebar:
  items:
    - { label: "Home" }
    - { label: "Inbox", badge: "12" }              # trailing count pill
    - label: "Settings"                            # nested items expand into the rail
      items:
        - { label: "Profile" }
        - { label: "Notifications" }
        - { label: "Billing" }
  active: "Inbox"
```

**Topbar actions can carry badges** the same way:

```wireframe
topbar:
  title: "Events"
  actions:
    - "Export"
    - { label: "Set up with AI", badge: "NEW" }    # last entry still renders primary
```

The rail auto-fits to the longest visible label up to a cap, so long item names
don't truncate.

**Where buttons live depends on the surface.** Two `- button:` entries always
stack vertically. When CTAs sit on the same line, pick the right primitive:

- *Modal, drawer, or form (`frame: panel`, no `topbar:`)* — stacked `- button:`
  reads as a commit footer (Save above Cancel); use `buttons:` for side-by-side.
- *Page with a header (`topbar:` set)* — page-level CTAs belong in
  `topbar: { actions: [...] }`; the last entry renders primary.
- *Component placement, no chrome* — body buttons are fine; `buttons:` for a
  "Get started · Watch demo" pair.

When in doubt: if a real product shipped this, where would the button physically
sit? That's where it goes in the DSL.

### Overlays (modal / drawer in context)

When the point is *"modal vs. drawer vs. inline"* — or the overlay's placement
over a real page is part of the argument — don't draw the overlay as a bare
`frame: panel`. Use the frame-level `overlay:` key: the renderer dims the base
page with a scrim (sidebar and topbar included) and draws the overlay on top.

```wireframe
layout: single
frame: browser
size: lg
label: "/events — create with AI"
sidebar:
  items: ["Home", "Events", "Team"]
  active: "Events"
topbar:
  title: "Events"
  actions: ["Create event"]
body:
  - tabs: ["List", "Calendar"]
    active: "List"
  - para: 4
overlay:
  variant: modal                        # modal | drawer-right | drawer-left ("drawer" aliases drawer-right)
  label: "Set up with AI"               # renders as the overlay header with a divider
  body:
    - field: { label: "Describe your event", variant: textarea }
    - buttons:
        - "Generate"
        - ["Cancel", outlined]
```

Rules of thumb:

- **`modal`** centers a card at ~68% of the frame width with a drop shadow;
  **`drawer-right` / `drawer-left`** run full height under the chrome.
- **The base body is dimmed context, not content** — keep it skeletal (`tabs:`,
  `para:` bars, a `heading:`). A lint flags an overlay over an *empty* base.
- **Size up.** Overlays need room for the base page to read as context: `lg` or
  `page`. A lint warns at `sm`.
- Overlay body entries use the same grammar and get their own ~10-entry budget.
- A bare overlay surface with no in-context question is still `frame: panel` —
  cheaper and more focused.

## Three shapes for three approaches

The single biggest authoring mistake is making alternatives structurally identical
— same `transformation`, same frames, same body shape — so structural difference
reads as content noise. Pick the form per approach.

Worked example: a product is adding an "AI setup" affordance and considering three
placements. Same problem, three structurally distinct wires.

### A — On the existing /events page (`single` + page chrome)

````markdown
```wireframe
layout: single
frame: browser
size: page
label: "/events — toolbar button added"
sidebar:
  items: ["Home", "Events", "Team", "Settings"]
  active: "Events"
topbar:
  title: "Events"
  actions: ["Set up with AI", "Create event"]
body:
  - tabs: ["List", "Calendar", "Search"]
    active: "List"
  - list:
      - { leading: icon, title: "Acme Summit", meta: "Apr 22 · Live" }
      - { leading: icon, title: "Q2 customer demo", meta: "May 5 · Draft" }
```
````

### B — Replace the existing create flow (`transformation` showing the swap)

````markdown
```wireframe
layout: transformation
size: md
left:
  frame: panel
  label: "current chooser"
  body:
    - heading: "Choose event type"
    - chip: ["SINGLE", "MULTI-SESSION", "RECURRING", "WEBINAR"]
    - spacer
    - button: ["Cancel", outlined]
    - button: "Save and continue"
arrow:
  top: REPLACE
  bottom: AI card supersedes chooser
right:
  frame: panel
  label: "proposed chooser"
  body:
    - heading: "Choose event type"
    - banner: { variant: info, text: "New — set up with AI" }
    - chip: ["SINGLE", "MULTI-SESSION", "RECURRING", "WEBINAR"]
    - spacer
    - button: ["Cancel", outlined]
    - button: "Set up with AI"
```
````

### C — New empty state for first-run users (`single` + empty composite)

````markdown
```wireframe
layout: single
frame: browser
size: lg
label: "/events — empty workspace"
sidebar:
  items: ["Home", "Events", "Team", "Settings"]
  active: "Events"
topbar:
  title: "Events"
body:
  - empty:
      heading: "Start your first event"
      helper: "Describe the event in a sentence and we'll draft the agenda, invites, and follow-ups."
      cta: "Set up with AI"
  - spacer
  - row: [icon, "Or create event manually"]
```
````

Three approaches, three structurally distinct wires. The structural differences
(toolbar entry vs. chooser swap vs. empty state) carry the comparison; the reader
doesn't have to scan for content deltas inside near-identical frames.

## Annotations

### Arrow (between frames in `transformation`)

```yaml
arrow:
  top: BUILD                            # mono uppercase, ~12px, spaced letters
  bottom: scaffold · route · serve      # serif italic, smaller, muted
```

### Transitions (between frames in `evolution`)

```yaml
transitions:
  - "make it punchier"                  # serif italic, inline between adjacent frames
  - "add some warmth"
```

### Markers + callouts (numbered annotations)

The classic "① this is the change" affordance. Put `marker: <n>` as a sibling key
on any body entry (works inside `columns:` regions and `overlay:` bodies too) and
pair it with a top-level `callouts:` list; the renderer draws a numbered badge in
the frame's right gutter and a matching legend below the frames.

```wireframe
layout: single
frame: browser
callouts:
  - "New AI entry point — primary slot"
  - "Existing list unchanged"
body:
  - heading: "Events"
  - button: "Set up with AI"
    marker: 1
  - list:
      - { leading: icon, title: "Acme Summit", meta: "Apr 22 · Live" }
    marker: 2
```

Use markers when an idea changes *one or two things* on an otherwise familiar
surface. Two or three markers is the sweet spot; if everything is annotated,
nothing is. A lint flags a `marker:` with no matching `callouts:` entry and
callouts with no markers.

## Authoring tips

- **Pick `size:` from what you have to communicate.** Component placement at `md`;
  full page chrome at `page`. Don't compress a page-level idea into a thumbnail.
- **Pick the layout from the decision shape.** Side-by-side change →
  `transformation`. Iterative refinement → `evolution`. One placement → `single`.
- **Use `columns:` for page composition.** `size: page` makes the canvas wider,
  but `columns:` is what communicates main/aside, card bands, dashboard regions.
- **Match body density to the size.** ~4–8 entries at `md`, ~10–20 at `lg`/`page`
  with dividers grouping regions. Lints warn at the hard caps (sm > 6, md > 12,
  lg > 18, page > 28).
- **Use real copy.** `heading: "Notification preferences"` beats
  `heading: "Section title"` — the renderer draws the actual text.
- **Don't over-specify.** The DSL carries no pixel sizes or colors — the renderer
  applies the theme. Use the `accent` primitive instead of overriding colors.

## Common rendering failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Block renders as plain text | Fence info string is missing/misspelled, **or the DSL failed to parse** (consumers that auto-render fall back to text silently) | Use exactly `` ```wireframe `` (no language alias); run the helper with `--check` to see the parse error |
| Table cells truncate (`j.ellis@…`) | 4+ equal-split columns below `size: page` | Add `weights: [..]`, use `size: page`, or switch to `list:` |
| "Could not parse wireframe" | Indent is tabs, or mixed with spaces | Use 2 spaces per level, no tabs |
| Empty right frame | `right:` block has no `body` | Add at least one body entry |
| Arrow text not appearing | `arrow:` keys are `from`/`to` instead of `top`/`bottom` | Use `top` and `bottom` |
| Evolution renders only first frame | `frames:` is a single object instead of a list | Each frame entry needs a leading `-` |
| Tabs render as pill chips | Used `chip:` for a nav strip / segmented control | Use `tabs:` with optional `active:` sibling |
| Body content overlaps the left rail | `sidebar:` is in the body instead of frame-level | Move `sidebar:` up to be a sibling of `body:` |
| Tab indicator on the wrong item | `active:` is a string that doesn't match any label | Match `active:` exactly, or use a 0-based numeric index |
| Stray wide accent band floating in the body | Bare `- accent` (no text) used as a section break | Use `- divider` or `- spacer`; reserve `accent:` for highlighting copy |
| Two CTAs stack when they should sit side-by-side | Page-level actions modelled as two `- button:` entries | Page action → `topbar: { actions: [...] }`; otherwise use the `buttons:` row |
| Overlay doesn't render / parse error names overlay | `overlay:` is in the body, or `variant:` is misspelled | `overlay:` is frame-level; variant is `modal` \| `drawer-right` \| `drawer-left` |
| Numbered badges but no legend (or vice versa) | `marker:` without a `callouts:` list, or callouts with no markers | Pair them: `marker: <n>` + entry *n* in `callouts:` |

### Parser errors and lint feedback

**Validate before sharing:**

```
node ${CLAUDE_PLUGIN_ROOT}/bin/wireframe-render.mjs --in <file> --check
```

This runs the same parser + lints the renderer uses and exits 1 on a parse error.
A block that fails to parse renders **silently as plain text** in consumers that
auto-render markdown — `--check` is how you catch it.

The parser reports errors with line numbers and, where the value is a typo of a
known enum, a "did you mean" hint (`Unknown frame: "browse". Did you mean
"browser"?`). Read the line number first — most failures are an indent that lost a
level or a key that drifted from the vocabulary.

After a clean parse, non-fatal **lint warnings** flag common mistakes (they don't
block rendering):

- *Transformation with no arrow labels* — add `arrow.top` / `arrow.bottom`.
- *Body density exceeds the size bucket* (sm > 6, md > 12, lg > 18, page > 28) —
  step the size up or split into two frames.
- *Evolution `transitions:` count ≠ frames − 1* — one transition renders between
  each adjacent pair; add or drop entries to match.
- *Page-size frame with `sidebar:` but no `topbar:`* — add the topbar or drop the
  sidebar.
- *`frame: panel` with `sidebar:` or `topbar:`* — use `frame: browser` for page
  chrome, `frame: panel` for modal/drawer content.
- *Table with 4+ columns below `size: page` and no `weights:`* — equal-split
  columns truncate. Add `weights:`, step up to `size: page`, or switch to `list:`.
- *Overlay at `size: sm`* — use `lg` or `page`.
- *Overlay over an empty base body* — sketch a skeletal base or use `frame: panel`.
- *`marker:` with no matching `callouts:` (or callouts with no markers)* — pair
  them.

## Validating with the helper

```
# render one block to an SVG
node ${CLAUDE_PLUGIN_ROOT}/bin/wireframe-render.mjs --in sketch.wireframe --out sketch.svg

# render with a custom theme
node ${CLAUDE_PLUGIN_ROOT}/bin/wireframe-render.mjs --in sketch.md --out sketch.svg --theme brand-theme.json

# parse + lint only, no file written (exit 1 on a hard error)
node ${CLAUDE_PLUGIN_ROOT}/bin/wireframe-render.mjs --in sketch.md --check

# print the SVG to stdout
node ${CLAUDE_PLUGIN_ROOT}/bin/wireframe-render.mjs --in sketch.wireframe --stdout
```

A file with multiple ```` ```wireframe ```` fences renders each block: block 1 →
`--out`, block 2 → `<out>.2.svg`, and so on. A file with no fence is treated as a
single raw DSL block.
