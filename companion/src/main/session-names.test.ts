import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectSlug, SessionNames, titlesIn } from './session-names';

const ai = (title: string) => `${JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: 's' })}\n`;
const custom = (title: string) => `${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: 's' })}\n`;
const user = (text: string) => `${JSON.stringify({ type: 'user', message: { content: text } })}\n`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'names-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function transcript(dir: string, sessionId: string, text: string): string {
  mkdirSync(join(root, dir), { recursive: true });
  const path = join(root, dir, `${sessionId}.jsonl`);
  writeFileSync(path, text);
  return path;
}

describe('projectSlug', () => {
  it('turns each character other than a letter or digit into a dash', () => {
    expect(projectSlug('/Users/me/Projects/agent-brief')).toBe('-Users-me-Projects-agent-brief');
    expect(projectSlug('/Users/me/app/.claude/worktrees/x')).toBe('-Users-me-app--claude-worktrees-x');
  });
});

describe('titlesIn', () => {
  it('keeps the last title of each kind and skips lines it cannot read', () => {
    const text = ai('First') + user('the word -title" in a prompt') + '{"type":"ai-title",' + '\n' + ai('Second') + custom('Mine');
    expect(titlesIn(text)).toEqual({ ai: 'Second', custom: 'Mine' });
  });
});

describe('SessionNames', () => {
  it("reads the title from the folder's own project", async () => {
    transcript(projectSlug('/w/app'), 's1', user('hi') + ai('Fix the login bug'));
    const names = new SessionNames(root);
    expect(await names.update([{ sessionId: 's1', cwd: '/w/app' }])).toBe(true);
    expect(names.name('s1')).toBe('Fix the login bug');
  });

  it('finds a transcript under another project', async () => {
    transcript('-elsewhere', 's1', ai('Moved'));
    const names = new SessionNames(root);
    await names.update([{ sessionId: 's1', cwd: '/w/app' }]);
    expect(names.name('s1')).toBe('Moved');
  });

  it("prefers the user's rename and follows later lines", async () => {
    const path = transcript(projectSlug('/w/app'), 's1', ai('Claude title'));
    const names = new SessionNames(root);
    await names.update([{ sessionId: 's1', cwd: '/w/app' }]);
    appendFileSync(path, user('go on') + custom('My name'));
    expect(await names.update([{ sessionId: 's1', cwd: '/w/app' }])).toBe(true);
    expect(names.name('s1')).toBe('My name');
    appendFileSync(path, ai('Newer Claude title'));
    expect(await names.update([{ sessionId: 's1', cwd: '/w/app' }])).toBe(false);
    expect(names.name('s1')).toBe('My name');
  });

  it('waits for a line still being written', async () => {
    const path = transcript(projectSlug('/w/app'), 's1', '{"type":"ai-title","aiTi');
    const names = new SessionNames(root);
    await names.update([{ sessionId: 's1', cwd: '/w/app' }]);
    expect(names.name('s1')).toBeUndefined();
    writeFileSync(path, ai('Done now'));
    await names.update([{ sessionId: 's1', cwd: '/w/app' }]);
    expect(names.name('s1')).toBe('Done now');
  });

  it('skips a line longer than a read', async () => {
    transcript(projectSlug('/w/app'), 's1', user('x'.repeat(3 << 20)) + ai('After the image'));
    const names = new SessionNames(root);
    await names.update([{ sessionId: 's1', cwd: '/w/app' }]);
    expect(names.name('s1')).toBe('After the image');
  });

  it('runs overlapping updates one at a time', async () => {
    transcript(projectSlug('/w/app'), 's1', ai('Once'));
    const names = new SessionNames(root);
    const both = await Promise.all([names.update([{ sessionId: 's1', cwd: '/w/app' }]), names.update([{ sessionId: 's1', cwd: '/w/app' }])]);
    expect(both).toEqual([true, false]);
    expect(names.name('s1')).toBe('Once');
  });

  it('names nothing without a transcript, and picks one up once it appears', async () => {
    const names = new SessionNames(root);
    expect(await names.update([{ sessionId: 's1', cwd: '/w/app' }])).toBe(false);
    transcript(projectSlug('/w/app'), 's1', ai('Later'));
    await names.update([{ sessionId: 's1', cwd: '/w/app' }]);
    expect(names.name('s1')).toBe('Later');
  });
});
