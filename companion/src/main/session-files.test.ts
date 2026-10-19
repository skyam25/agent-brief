import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { outputsFile, type SessionsResponse } from '../protocol';
import { CH } from '../shared/ipc';
import { Briefs } from './briefs';
import { DraftStore } from './drafts';
import { SessionFiles } from './session-files';
import { BoardStore, StateFile } from './store';

let cwd: string;
let sent: { channel: string; args: unknown[] }[];
let opened: string[];
let sessions: SessionsResponse;
let briefs: Briefs;
let drafts: DraftStore;
let files: SessionFiles;

const last = (channel: string) => sent.filter((s) => s.channel === channel).at(-1)?.args[0] as Record<string, unknown> | undefined;

const writeOutputs = (outputs: object[]) => {
  const path = outputsFile(cwd, 's1');
  mkdirSync(join(cwd, '.feedback/outputs'), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, sessionId: 's1', outputs }));
};

beforeEach(() => {
  const data = mkdtempSync(join(tmpdir(), 'session-files-'));
  cwd = mkdtempSync(join(tmpdir(), 'project-'));
  sent = [];
  opened = [];
  sessions = { sessions: [{ sessionId: 's1', cwd, title: 'Project' }], targetSessionId: 's1' };
  const state = new StateFile(data);
  drafts = new DraftStore(data);
  const send = (channel: string, ...args: unknown[]) => sent.push({ channel, args });
  briefs = new Briefs({ state, store: new BoardStore(data), drafts, sessions: () => sessions, send, onPublish: () => files.sync() });
  files = new SessionFiles({
    briefs,
    drafts,
    send,
    opener: { openPath: async (p) => void opened.push(p), openExternal: async (u) => void opened.push(u) },
    reviewUrlFor: (root, path) => `review://${root}/${path}`,
  });
});

describe('Briefs', () => {
  it('moves a tab to the front only when Claude Code opened it', () => {
    briefs.remember('s1', { board: 'a' });
    const first = briefs.get('s1')!.at;
    briefs.remember('s1', { board: 'b' }, false);
    expect(briefs.get('s1')).toMatchObject({ board: 'b', at: first, title: 'Project', cwd });
    expect(last(CH.briefs)).toBeDefined();
  });

  it("reopens the session's kept note, and starts a new one when text comes", () => {
    briefs.openNote('s1', undefined);
    const id = briefs.get('s1')!.draftId!;
    expect(last(CH.newNote)).toMatchObject({ id, sessionId: 's1' });
    drafts.save({ id, body: 'kept', status: 'note', rank: 0, createdAt: 1, updatedAt: 1, sessionId: 's1' });

    briefs.openNote('s1', undefined);
    expect(last(CH.openDraft)).toEqual({ id, sessionId: 's1' });

    briefs.openNote('s1', 'from Claude');
    expect(last(CH.newNote)).toMatchObject({ text: 'from Claude', sessionId: 's1' });
    expect(briefs.get('s1')!.draftId).not.toBe(id);
  });
});

describe('SessionFiles', () => {
  it('opens Markdown as a note once, HTML in the review pane, and other files in their app', async () => {
    writeFileSync(join(cwd, 'plan.md'), '# Plan');
    writeFileSync(join(cwd, 'page.html'), '<p>hi</p>');
    writeFileSync(join(cwd, 'deck.pdf'), '');

    await files.openOutput('s1', 'plan.md');
    const note = last(CH.newNote)!;
    expect(note).toMatchObject({ text: '# Plan', sessionId: 's1', source: { path: 'plan.md' } });
    drafts.save({ id: note.id, body: '# Plan', status: 'note', rank: 0, createdAt: 1, updatedAt: 1, sessionId: 's1', source: { path: 'plan.md' } });
    await files.openOutput('s1', 'plan.md');
    expect(last(CH.openDraft)).toEqual({ id: note.id, sessionId: 's1' });

    await files.openOutput('s1', 'page.html');
    expect(last(CH.newNote)).toMatchObject({ sessionId: 's1', review: { path: 'page.html', comments: [] } });

    await files.openOutput('s1', 'deck.pdf');
    await files.openOutput('s1', 'https://example.com/doc');
    expect(opened).toEqual([join(cwd, 'deck.pdf'), 'https://example.com/doc']);
  });

  it('refuses files outside the project and links that are not http', async () => {
    await expect(files.openOutput('s1', '../escape.md')).rejects.toThrow('outside the project');
    await expect(files.openOutput('s1', 'file:///etc/hosts')).rejects.toThrow('only http and https');
    expect(() => files.reviewUrl('s1', 'missing.html')).toThrow('does not exist yet');
  });

  it('opens a Markdown or HTML document for POST /open and says where', async () => {
    writeFileSync(join(cwd, 'plan.MD'), '# Plan');
    writeFileSync(join(cwd, 'page.htm'), '<p>hi</p>');
    writeFileSync(join(cwd, 'deck.pdf'), '');
    expect(await files.openDocument('s1', 'plan.MD')).toBe('note');
    expect(last(CH.newNote)).toMatchObject({ text: '# Plan', source: { path: 'plan.MD' } });
    expect(await files.openDocument('s1', 'page.htm')).toBe('review');
    expect(last(CH.newNote)).toMatchObject({ review: { path: 'page.htm' } });
    await expect(files.openDocument('s1', 'deck.pdf')).rejects.toThrow('not a Markdown or HTML file');
    expect(opened).toEqual([]);
  });

  it('carries the Feedback tab to a new or reopened review', async () => {
    writeFileSync(join(cwd, 'page.html'), '<p>hi</p>');
    await files.openDocument('s1', 'page.html', 'feedback');
    const review = last(CH.newNote)!;
    expect(review).toMatchObject({ review: { path: 'page.html' }, tab: 'feedback' });
    drafts.save({ id: review.id as string, body: '', status: 'note', rank: 0, createdAt: 1, updatedAt: 1, sessionId: 's1', review: { path: 'page.html', comments: [] } });
    await files.openDocument('s1', 'page.html', 'feedback');
    expect(last(CH.openDraft)).toEqual({ id: review.id, sessionId: 's1', tab: 'feedback' });
    await files.openDocument('s1', 'page.html');
    expect(last(CH.openDraft)).toEqual({ id: review.id, sessionId: 's1' });
  });

  it('refuses a document that is missing, outside the project, or a symlink out of it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    writeFileSync(join(outside, 'secret.md'), 'no');
    symlinkSync(join(outside, 'secret.md'), join(cwd, 'link.md'));
    await expect(files.openDocument('s1', 'missing.md')).rejects.toThrow('does not exist yet');
    await expect(files.openDocument('s1', '../escape.md')).rejects.toThrow('outside the project');
    await expect(files.openDocument('s1', 'link.md')).rejects.toThrow('outside the project');
    await expect(files.openDocument('gone', 'plan.md')).rejects.toThrow('does not know session gone');
  });

  it('hides a dismissed output until a later write', () => {
    writeOutputs([{ ref: 'plan.md', kind: 'markdown', tier: 'detected', lastWriteAt: 10 }]);
    files.dismissOutput('s1', 'plan.md');
    expect(files.outputs('s1')!.outputs).toEqual([]);
    expect(last(CH.outputs)).toMatchObject({ sessionId: 's1', outputs: [] });

    writeOutputs([{ ref: 'plan.md', kind: 'markdown', tier: 'detected', lastWriteAt: 20 }]);
    expect(files.outputs('s1')!.outputs.map((o) => o.ref)).toEqual(['plan.md']);
  });
});
