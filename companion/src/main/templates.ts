/** Templates on disk: `<dataDir>/templates/<id>.md`, with the title in front matter. */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { badRequest } from '../board/errors';
import type { Template } from '../shared/ipc';
import { writeAtomic } from './files';

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_BODY = 50_000;

/** Bump when the starters change, so older installs pick up the new set. */
const STARTERS_VERSION = 2;
const STARTERS_MARKER = '.starters';

/** Templates a new install starts with. Delete or edit them like any other. */
export const STARTER_TEMPLATES: Template[] = [
  {
    id: 'one-pager',
    title: 'One-pager',
    body: `# {{name}}

## Problem

{{who is stuck, on what, and what it costs them}}

## Why now

{{the deadline, signal or opening that makes this the right time}}

## Evidence

- {{quote, ticket count or metric}}

## Goal

{{the outcome we want, in the customer's terms}}

Success metric: {{metric, from baseline to target}}

## Non-goals

- {{what this will not do}}

## Approach

{{the rough shape of the solution}}

## Risks and open questions

- {{what could make this wrong}}
`,
  },
  {
    id: 'user-story',
    title: 'User story',
    body: `# {{feature name}}

As a {{user type}}, I want to {{action}} so that {{benefit}}.

## Problem

{{where the workflow breaks today and why it matters}}

## Acceptance criteria

1. {{testable criterion}}

## Edge cases

- {{empty, error or permission state}}

## Out of scope

- {{what this story leaves out}}

Design: {{Figma link or TBD}}
`,
  },
  {
    id: 'decision',
    title: 'Decision',
    body: `# Decision: {{the question}}

Decide by: {{date}} · Decider: {{name}} · Input from: {{people}}

## Context

{{what forced this decision and what we know}}

## Options

| Option       | Pros | Cons | Cost |
| ------------ | ---- | ---- | ---- |
| {{option A}} |      |      |      |
| {{option B}} |      |      |      |

## Recommendation

{{the option and the main reason it wins}}

## What would change our mind

{{evidence that would reopen this}}
`,
  },
  {
    id: 'status-update',
    title: 'Status update',
    body: `# {{project}} update, {{date}}

Status: {{on track, at risk or off track}}

## TL;DR

{{one or two sentences a busy reader can stop after}}

## Since last update

- {{shipped or learned}}

## Next

- {{what lands next, and when}}

## Risks

- {{risk, and what we are doing about it}}

## Asks

- {{decision or help needed, from whom, by when}}
`,
  },
  {
    id: 'interview-notes',
    title: 'Interview notes',
    body: `# Interview: {{customer or company}}

Date: {{date}} · Role: {{their role}} · Segment: {{plan, size or persona}}

## What we wanted to learn

{{the question behind this call}}

## How they work today

{{the job, the tools and the workarounds}}

## Pains

- {{pain, in their words}}

## Quotes

> {{verbatim quote}}

## Surprises

- {{anything that contradicts what we assumed}}

## Follow-ups

- [ ] {{next step and owner}}
`,
  },
  {
    id: 'launch-plan',
    title: 'Launch plan',
    body: `# Launch: {{feature}}

Date: {{launch date}} · Owner: {{name}} · Tier: {{big, medium or quiet}}

## What's launching

{{one paragraph a customer would understand}}

## Rollout

{{who gets it first, flags, ramp and regions}}

## Success metrics

- {{metric, target, and when we check}}

## Readiness

- [ ] Help docs updated
- [ ] Support briefed
- [ ] Sales and CS briefed
- [ ] Release notes written
- [ ] Analytics events verified

## Announcement

{{channels and the message}}

## Rollback

{{what triggers it and how}}
`,
  },
  {
    id: 'prototype',
    title: 'Prototype',
    body: `Prototype {{the idea}} so I can {{show it to or test it with whom}}.

The user is {{who}}, trying to {{get what done}}. The moment to get right is {{the screen or step}}.

Include:

- {{screen or state}}

Use mock data. Skip auth, back ends and edge cases. Make it clickable end to end, then show it to me and list what you faked.
`,
  },
  {
    id: 'bug-report',
    title: 'Bug report',
    body: `What happened: {{what you saw}}

Expected: {{what should happen}}

Steps to reproduce:

1. {{first step}}

Where: {{page, build or account}} · Impact: {{who hits this, and how often}}

Find the cause before changing code. Then fix it and add a test that fails without the fix.
`,
  },
];

/** Starter files earlier versions wrote. Ones still as shipped give way to the current starters. */
const RETIRED_STARTERS: Template[] = [
  {
    id: 'bug-report',
    title: 'Bug report',
    body: `Something is broken: {{what you saw}}

Steps to reproduce:
{{steps}}

Expected: {{what should happen}}

Find the cause before changing code. Then fix it and add a test that fails without the fix.
`,
  },
  {
    id: 'feature',
    title: 'Feature',
    body: `Build {{the feature}}.

Why: {{the problem it solves}}

Done when:
- {{first check}}

Ask me before changing anything outside {{the area}}.
`,
  },
  {
    id: 'plan-first',
    title: 'Plan first',
    body: `I want to {{goal}}.

Read the relevant code and propose a plan before writing any. Call out risks and anything I need to decide.
`,
  },
];

/** `Bug report!` becomes `bug-report`. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'template';
}

/** Splits `---\ntitle: X\n---\nbody` into its title and body. Files without front matter use the id. */
export function parseTemplate(id: string, text: string): Template {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const title = match ? /^title:\s*(.+)$/m.exec(match[1])?.[1].trim() : undefined;
  return { id, title: title || id.replace(/-/g, ' '), body: match ? text.slice(match[0].length) : text };
}

export function formatTemplate(t: { title: string; body: string }): string {
  return `---\ntitle: ${t.title.replace(/\s+/g, ' ').trim()}\n---\n${t.body}`;
}

export class TemplateStore {
  readonly dir: string;

  /**
   * Seeds the starters once per starter version. An older install drops the
   * retired starters it never edited and gains the current ones it lacks.
   */
  constructor(dataDir: string, starters: Template[] = STARTER_TEMPLATES, retired: Template[] = RETIRED_STARTERS) {
    this.dir = join(dataDir, 'templates');
    const marker = join(this.dir, STARTERS_MARKER);
    const fresh = !existsSync(this.dir);
    if (!fresh && existsSync(marker) && Number(readFileSync(marker, 'utf8')) >= STARTERS_VERSION) return;
    mkdirSync(this.dir, { recursive: true });
    for (const t of fresh ? [] : retired) {
      const path = this.path(t.id);
      if (existsSync(path) && readFileSync(path, 'utf8') === formatTemplate(t)) rmSync(path);
    }
    for (const t of starters) if (!existsSync(this.path(t.id))) writeFileSync(this.path(t.id), formatTemplate(t));
    writeFileSync(marker, `${STARTERS_VERSION}\n`);
  }

  private path(id: string): string {
    if (!ID.test(id)) throw badRequest(`bad template id ${JSON.stringify(id)}`);
    return join(this.dir, `${id}.md`);
  }

  /** By title. */
  list(): Template[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.md') && ID.test(f.slice(0, -3)))
      .map((f) => parseTemplate(f.slice(0, -3), readFileSync(join(this.dir, f), 'utf8')))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Creates a template when `id` is absent, under a free id made from the title. */
  save(raw: unknown): Template {
    const t = raw as { id?: unknown; title?: unknown; body?: unknown } | null;
    if (!t || typeof t !== 'object') throw badRequest('template must be an object');
    if (typeof t.title !== 'string' || !t.title.trim() || t.title.length > 80) throw badRequest('template title must be 1 to 80 characters');
    if (typeof t.body !== 'string' || t.body.length > MAX_BODY) throw badRequest('template body must be text under 50,000 characters');
    let id: string;
    if (t.id === undefined) {
      const base = slugify(t.title);
      id = base;
      for (let n = 2; existsSync(this.path(id)); n++) id = `${base}-${n}`;
    } else if (typeof t.id === 'string') {
      id = t.id;
    } else {
      throw badRequest('template id must be a string');
    }
    const path = this.path(id);
    writeAtomic(path, formatTemplate({ title: t.title, body: t.body }));
    return { id, title: t.title.trim(), body: t.body };
  }

  remove(id: string): void {
    rmSync(this.path(id), { force: true });
  }
}
