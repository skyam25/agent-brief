/** Templates on disk: `<dataDir>/templates/<id>.md`, with the title in front matter. */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { badRequest } from '../board/errors';
import type { Template } from '../shared/ipc';

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_BODY = 50_000;

/** Templates a new install starts with. Delete or edit them like any other. */
export const STARTER_TEMPLATES: Template[] = [
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

  constructor(dataDir: string, starters: Template[] = STARTER_TEMPLATES) {
    this.dir = join(dataDir, 'templates');
    if (existsSync(this.dir)) return;
    mkdirSync(this.dir, { recursive: true });
    for (const t of starters) writeFileSync(this.path(t.id), formatTemplate(t));
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
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, formatTemplate({ title: t.title, body: t.body }));
    renameSync(tmp, path);
    return { id, title: t.title.trim(), body: t.body };
  }

  remove(id: string): void {
    rmSync(this.path(id), { force: true });
  }
}
