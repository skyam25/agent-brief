import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIATIVE_UNDERSTANDING_CAP } from '../protocol';
import { InitiativeStore, resolveInitiative, terms } from './initiatives';
import { ItemsWatcher } from './items-watch';

let root: string;
let dataDir: string;
let clock: { t: number };
const tick = () => new Date((clock.t += 60_000));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ini-'));
  dataDir = join(root, 'data');
  clock = { t: Date.parse('2026-10-17T10:00:00Z') };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const store = (readOnly = false) => new InitiativeStore(dataDir, { now: tick, readOnly, home: root });

describe('create', () => {
  it('writes the brief in the folder and indexes it', () => {
    const s = store();
    const folder = join(root, 'PM', 'Pricing');
    const i = s.create({ title: 'Pricing', folder, understanding: 'Monthly-first. Legal next.' });
    expect(i.path).toBe(join(folder, 'Pricing brief.md'));
    expect(i).toMatchObject({ title: 'Pricing', revision: 1, updatedBy: 'PM', folders: [{ path: '~/PM/Pricing', role: 'working' }] });
    expect(readFileSync(i.path, 'utf8')).toContain(`agent_brief_id: "${i.id}"`);
    const index = JSON.parse(readFileSync(join(dataDir, 'initiatives.json'), 'utf8'));
    expect(index.initiatives[0]).toMatchObject({ id: i.id, path: i.path, revision: 1 });
    expect(s.list()).toEqual([{ id: i.id, title: 'Pricing', lastActiveAt: i.lastActiveAt, line: 'Monthly-first.' }]);
  });

  it('refuses a brief that already exists', () => {
    const s = store();
    s.create({ title: 'Pricing', folder: root });
    expect(() => s.create({ title: 'Pricing', folder: root })).toThrow(expect.objectContaining({ code: 'conflict' }));
  });
});

describe('update', () => {
  it('writes the changed fields and records a revision', () => {
    const s = store();
    const i = s.create({ title: 'Pricing', folder: root });
    const next = s.update(i.id, { revision: 1, understanding: 'Annual is out.', updatedBy: 'Claude · s1' });
    expect(next).toMatchObject({ revision: 2, updatedBy: 'Claude · s1', understanding: 'Annual is out.' });
    expect(s.history(i.id)).toEqual([
      { revision: 2, updatedAt: next.updatedAt, updatedBy: 'Claude · s1', changed: ['understanding'] },
      { revision: 1, updatedAt: i.updatedAt, updatedBy: 'PM', changed: ['created'] },
    ]);
  });

  it('refuses a stale revision with a conflict', () => {
    const s = store();
    const i = s.create({ title: 'Pricing', folder: root });
    s.update(i.id, { revision: 1, open: ['Legal'], updatedBy: 'PM' });
    expect(() => s.update(i.id, { revision: 1, open: ['Other'], updatedBy: 'Claude · s1' })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    expect(s.get(i.id).open).toEqual(['Legal']);
  });

  it('records no revision when nothing changed', () => {
    const s = store();
    const i = s.create({ title: 'Pricing', folder: root, open: ['Legal'] });
    expect(s.update(i.id, { revision: 1, open: ['Legal'], updatedBy: 'PM' }).revision).toBe(1);
  });
});

describe('edits outside the app', () => {
  it('records an edit to the file as a revision by PM, once', () => {
    const s = store();
    const i = s.create({ title: 'Pricing', folder: root });
    writeFileSync(i.path, readFileSync(i.path, 'utf8').replace('## Open\n', '## Open\n- Added by hand\n'));
    const read = s.get(i.id);
    expect(read).toMatchObject({ revision: 2, updatedBy: 'PM', open: ['Added by hand'] });
    expect(s.history(i.id)[0]).toEqual({ revision: 2, updatedAt: read.updatedAt, updatedBy: 'PM' });
    expect(s.get(i.id).revision).toBe(2);
  });

  it('makes a write against the revision before the edit a conflict', () => {
    const s = store();
    const i = s.create({ title: 'Pricing', folder: root });
    writeFileSync(i.path, readFileSync(i.path, 'utf8').replace('## Open\n', '## Open\n- By hand\n'));
    expect(() => s.update(i.id, { revision: 1, understanding: 'x', updatedBy: 'Claude · s1' })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
  });

  it('follows a renamed brief and a renamed folder by its id', () => {
    const s = store();
    const folder = join(root, 'projects', 'Pricing');
    const i = s.create({ title: 'Pricing', folder });
    renameSync(i.path, join(folder, 'Pricing v2 brief.md'));
    expect(s.get(i.id).path).toBe(join(folder, 'Pricing v2 brief.md'));
    renameSync(folder, join(root, 'projects', 'Pricing 2027'));
    expect(s.get(i.id)).toMatchObject({ path: join(root, 'projects', 'Pricing 2027', 'Pricing v2 brief.md') });
    expect(s.get(i.id).missing).toBeUndefined();
  });

  it('tells listeners about a rename, so an edit after it reaches them through the file watch', async () => {
    const s = store();
    const folder = join(root, 'Pricing');
    const i = s.create({ title: 'Pricing', folder });
    // Wired the way main wires them.
    let reports = 0;
    const watch = new ItemsWatcher(
      (id) => {
        reports++;
        s.refresh(id);
      },
      { debounceMs: 30, pollMs: 40 },
    );
    const heard: string[] = [];
    s.onChange(() => {
      heard.push(s.files().get(i.id)!);
      watch.sync(s.files());
    });

    // fs.watch misses events right after it starts. Rewriting the file unchanged until the watch reports it proves the watch is live.
    const live = async (path: string) => {
      const seen = reports;
      const text = readFileSync(path, 'utf8');
      await vi.waitFor(() => {
        writeFileSync(path, text);
        expect(reports).toBeGreaterThan(seen);
      }, { timeout: 2000, interval: 60 });
    };

    watch.sync(s.files());
    try {
      await live(i.path);
      const renamed = join(folder, 'Pricing v2 brief.md');
      renameSync(i.path, renamed);
      await vi.waitFor(() => expect(heard).toContain(renamed), { timeout: 2000 });
      expect(watch.watched().get(i.id)).toBe(renamed);
      await live(renamed);
      writeFileSync(renamed, readFileSync(renamed, 'utf8').replace('## Open\n', '## Open\n- By hand\n'));
      await vi.waitFor(() => expect(s.get(i.id)).toMatchObject({ revision: 2, updatedBy: 'PM', open: ['By hand'] }), { timeout: 2000 });
    } finally {
      watch.close();
    }
  });

  it('marks a brief it cannot find as missing', () => {
    const s = store();
    const i = s.create({ title: 'Pricing', folder: join(root, 'a') });
    rmSync(join(root, 'a'), { recursive: true });
    expect(s.get(i.id)).toMatchObject({ missing: true, understanding: '' });
  });
});

describe('sessions', () => {
  it('attaches, bumps attachmentRevision and lastActiveAt, and detaches', () => {
    const s = store();
    const a = s.create({ title: 'Pricing', folder: join(root, 'a') });
    const b = s.create({ title: 'Onboarding', folder: join(root, 'b') });
    expect(s.list().map((x) => x.title)).toEqual(['Onboarding', 'Pricing']);
    expect(s.attach('s1', a.id)).toMatchObject({ id: a.id, attachmentRevision: 1, revision: 1 });
    expect(s.list().map((x) => x.title)).toEqual(['Pricing', 'Onboarding']);
    expect(s.get(a.id).sessions).toEqual(['s1']);
    expect(s.attach('s1', b.id).attachmentRevision).toBe(2);
    expect(s.detach('s1')).toBe(true);
    expect(s.snapshot('s1')).toBeUndefined();
    expect(s.detach('s1')).toBe(false);
    expect(s.attach('s1', a.id).attachmentRevision).toBe(3);
  });

  it('caps the Understanding a snapshot carries', () => {
    const s = store();
    const i = s.create({ title: 'Long', folder: root, understanding: 'word '.repeat(1000) });
    s.attach('s1', i.id);
    const snap = s.snapshot('s1')!;
    expect(snap.understanding.length).toBeLessThanOrEqual(INITIATIVE_UNDERSTANDING_CAP);
    expect(snap.understanding.endsWith('…')).toBe(true);
  });

  it('lists only live sessions as attached when it knows them', () => {
    let live = ['s1', 's2'];
    const s = new InitiativeStore(dataDir, { now: tick, home: root, liveSessions: () => live });
    const i = s.create({ title: 'Pricing', folder: root });
    s.attach('s1', i.id);
    s.attach('s2', i.id);
    expect(s.get(i.id).sessions).toEqual(['s2', 's1']);
    live = ['s2'];
    expect(s.get(i.id).sessions).toEqual(['s2']);
    live = [];
    expect(s.get(i.id).sessions).toBeUndefined();
    expect(s.snapshot('s1')).toMatchObject({ id: i.id });
  });

  it('keeps bindings across a restart', () => {
    const i = store().create({ title: 'Pricing', folder: root });
    store().attach('s1', i.id);
    expect(store().snapshot('s1')).toMatchObject({ id: i.id, attachmentRevision: 1 });
  });
});

describe('find', () => {
  it('ranks by term overlap on title, Understanding and decisions, then by lastActiveAt', () => {
    const s = store();
    const pricing = s.create({ title: 'Pricing', folder: join(root, 'p'), understanding: 'Monthly plans and trials.' });
    const checkout = s.create({ title: 'Checkout', folder: join(root, 'c'), understanding: 'Card form and trial upsell.' });
    s.create({ title: 'Onboarding', folder: join(root, 'o'), decisions: ['2026-10-01 Email first'] });
    expect(s.find('pricing for the trial').map((m) => [m.title, m.score])).toEqual([
      ['Pricing', 4],
      ['Checkout', 1],
    ]);
    s.attach('s1', pricing.id);
    s.attach('s2', checkout.id);
    expect(s.find('trial').map((m) => m.title)).toEqual(['Checkout', 'Pricing']);
    expect(s.find('email').map((m) => m.title)).toEqual(['Onboarding']);
    expect(s.find('nothing here')).toEqual([]);
  });

  it('drops a plural s and stop words', () => {
    expect([...terms('The trials of pricing')]).toEqual(['trial', 'pricing']);
  });

  it('resolves an id, a title or a unique prefix', () => {
    const list = [
      { id: 'aa', title: 'Pricing' },
      { id: 'bb', title: 'Pricing page' },
      { id: 'cc', title: 'Onboarding' },
    ];
    expect(resolveInitiative(list, 'bb')?.title).toBe('Pricing page');
    expect(resolveInitiative(list, 'pricing')?.id).toBe('aa');
    expect(resolveInitiative(list, 'onb')?.id).toBe('cc');
    expect(resolveInitiative(list, 'pri')).toBeUndefined();
  });
});

describe('read-only', () => {
  it('reads the briefs without writing the index', () => {
    const i = store().create({ title: 'Pricing', folder: root });
    writeFileSync(i.path, readFileSync(i.path, 'utf8').replace('## Open\n', '## Open\n- By hand\n'));
    const before = readFileSync(join(dataDir, 'initiatives.json'), 'utf8');
    const r = store(true);
    expect(r.get(i.id)).toMatchObject({ revision: 1, open: ['By hand'] });
    expect(() => r.attach('s1', i.id)).toThrow(expect.objectContaining({ code: 'unavailable' }));
    expect(readFileSync(join(dataDir, 'initiatives.json'), 'utf8')).toBe(before);
  });

  it('reads an empty list when there is no index', () => {
    mkdirSync(dataDir, { recursive: true });
    expect(store(true).list()).toEqual([]);
  });
});
