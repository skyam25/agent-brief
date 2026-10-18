---
name: behavior-review
description: Create and maintain behavior rules alongside an interactive HTML prototype in Agent Brief, review assumptions, apply behavior decisions sent from Review, and export acceptance criteria for an engineering handoff.
---

# Behavior review

The Review pane shows a prototype's Behavior tab beside its comments. Rules live in `<prototype.html>.behavior.json`, independent of the session. The app owns revision checking and decision history. Use the CLI to update the specification, not direct file edits.

If `agent-brief` is not on PATH, use `"/Applications/Agent Brief.app/Contents/Resources/bin/agent-brief"`. The app must be running and the session registered. Commands use `CLAUDE_CODE_SESSION_ID`, or explicit `--session <id>`. If the app is down, explain that the rules could not be saved; continue authorized prototype work and do not claim they were recorded.

## Create the prototype and rules

- Follow the user's scope and the project's visual conventions. For an interactive prototype, make relevant states reachable and use realistic domain data. Mark simulated actions in the page itself; do not imply backend effects are working.
- Give controls stable, unique `data-ui` attributes. A rule can target `[data-ui="invite-back"]` and name the state in which it appears. Flow-wide rules need no target. Keep static wireframes static unless interaction is needed for the user's task.
- Record consequential behavior: triggers, conditions, effects, errors, empty states, navigation and persistence. Avoid rules for cosmetic details or every DOM element.
- Explicit requirements may start `confirmed`, with a source reference to the brief, sketch or user instruction. Inferences start `proposed`, with `source.kind: "assumption"`. Confirmation records agreement; it does not claim implementation or verification.

Read first (a missing specification returns an empty document with `version: "missing"`):

```bash
agent-brief behavior show prototypes/onboarding.html --json
```

Write a patch to a temporary JSON file, copying the returned `version` exactly:

```json
{
  "version": "missing",
  "upsert": [
    {
      "id": "invite-back",
      "text": "Returning to the invite step preserves entered addresses during this onboarding session.",
      "status": "proposed",
      "source": { "kind": "assumption", "ref": "The brief does not specify navigation persistence." },
      "target": { "selector": "[data-ui=\"invite-back\"]", "state": "Invite teammates" },
      "delivery": "planned"
    }
  ],
  "limitations": ["Sending invitations is simulated; no invitations are delivered."]
}
```

```bash
agent-brief behavior update prototypes/onboarding.html --file /tmp/behavior-patch.json --json
agent-brief output "Onboarding prototype" --path prototypes/onboarding.html --status ready
```

`upsert` changes only named rules. Keep IDs stable. `limitations`, when provided, replaces the whole list. Keep rules scoped to this prototype. Do not delete a specification at implementation time.

## Apply a review

1. Read the delivered `review.md`, then read the current specification with `behavior show`. The delivered snapshot records what the user reviewed; the current document may be newer.
2. Apply confirmed behaviors within the authorized task. Product approval alone does not request production implementation. Leave proposed rules open and keep working on independent, settled behavior.
3. Treat appearance feedback as ordinary edits. When a comment introduces behavior, capture it as a rule with a source reference to the review bundle and comment. Ambiguous interpretations remain proposed.
4. The panel confirms existing proposals. Do not promote them yourself. Changing an existing rule's text or target returns it to proposed and clears implementation evidence. The history preserves its previous decision.
5. Use `note` on a rule for an unresolved question. Keep prototype limitations accurate. `delivery` is `planned`, `implemented`, or `verified`; use the latter two only for the actual product implementation, and include `evidence` for verification (test command/result or an inspectable check). A clickable mock is not an implemented product.
6. On a version conflict, read again, merge only your intended changes, and retry. Never overwrite a newer PM decision. Check important interactions in the preview after changes.

## Handoff

```bash
agent-brief behavior export prototypes/onboarding.html --out acceptance.md
```

This exports confirmed acceptance criteria, open assumptions, delivery evidence and simulated actions. Keep the specification and prototype with the handoff. When the session belongs to an initiative, link the specification from its working documents and record material decisions or open questions in its brief. Existing tracked items may reference rule IDs; do not maintain a duplicate editable requirements list there.
