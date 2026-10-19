import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { outputsFile, type SessionInfo } from '../protocol';
import { Briefs, type BriefsDeps } from './briefs';
import { workspaceBinding } from '../shared/feedback-workspace';
import type { SessionBriefs } from './session-briefs';
import { BoardStore } from './store';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'briefs-'));
  mkdirSync(join(cwd, '.feedback', 'outputs'), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function briefsWith(sessionBriefs: SessionBriefs, live: SessionInfo[] = []): Briefs {
  const state = { state: { sessionBriefs }, update: (patch: { sessionBriefs: SessionBriefs }) => Object.assign(state.state, patch) };
  const deps = {
    state,
    store: { exists: () => false, isEmpty: () => true, list: () => [] },
    drafts: { get: () => undefined },
    sessions: () => ({ sessions: live }),
    send: () => undefined,
    onPublish: () => undefined,
  } as unknown as BriefsDeps;
  return new Briefs(deps);
}

function outputsFor(sessionId: string): string {
  const path = outputsFile(cwd, sessionId);
  writeFileSync(path, '{}');
  return path;
}

describe('Briefs', () => {
  it("deletes an ended session's outputs record when its brief goes", () => {
    const path = outputsFor('ended');
    briefsWith({ ended: { cwd, at: 1 } }).forget('ended');
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a live session's outputs record", () => {
    const path = outputsFor('live');
    briefsWith({ live: { cwd, at: 1 } }, [{ sessionId: 'live', cwd, title: 'x' }]).forget('live');
    expect(existsSync(path)).toBe(true);
  });

  it('keeps the records of briefs that stay', () => {
    const path = outputsFor('stays');
    briefsWith({ stays: { cwd, at: 1 }, ended: { cwd, at: 2 } }).forget('ended');
    expect(existsSync(path)).toBe(true);
  });

  it('lists every board for the socket and keeps bound workspaces out of the panel only', () => {
    const store = new BoardStore(cwd);
    for (const name of ['fb-planning', 'fb-checkout-1', 'scratch', 'notes-say-fb']) store.create(name);
    store.saveNotes('fb-checkout-1', `${workspaceBinding('/p/checkout.html', 1)}\n`);
    store.saveNotes('notes-say-fb', 'Feedback workspace · not a binding\n');
    const briefs = new Briefs({ state: { state: { sessionBriefs: {} } }, store, drafts: { get: () => undefined }, sessions: () => ({ sessions: [] }), send: () => undefined, onPublish: () => undefined } as unknown as BriefsDeps);
    expect(briefs.boardsWithHolders().map((b) => b.name)).toEqual(['fb-checkout-1', 'fb-planning', 'notes-say-fb', 'scratch']);
    expect(briefs.panelBoards().map((b) => b.name)).toEqual(['fb-planning', 'notes-say-fb', 'scratch']);
  });
});
