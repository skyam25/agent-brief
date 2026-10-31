import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { outputsFile, type Initiative } from '../protocol';
import { itemsFile } from '../server/index';
import { tempDir } from '../server/testkit';
import type { Draft } from '../shared/ipc';
import { Cleanup } from './cleanup';
import type { SessionBriefs } from './session-briefs';

const draft = (id: string, sessionId: string, extra: Partial<Draft> = {}): Draft => ({ id, body: `# ${id}`, status: 'note', sessionId, rank: 0, createdAt: 1, updatedAt: 1, ...extra });

function setup(opts: { live?: string[]; tracked?: string[]; initiativeOutput?: string } = {}) {
  const dataDir = tempDir('cleanup-data');
  const cwd = tempDir('cleanup-project');
  const drafts = [draft('n1', 'ended'), draft('r1', 'ended', { review: { path: 'proto/a.html', comments: [] } }), draft('n2', 'other')];
  const write = (path: string, text = 'x') => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };
  for (const d of drafts) write(join(dataDir, 'drafts', `${d.id}.json`), JSON.stringify(d));
  for (const b of ['solo', 'shared', 'current']) write(join(dataDir, 'boards', `${b}.excalidraw`), '{}');
  write(itemsFile(cwd, 'ended'));
  write(outputsFile(cwd, 'ended'), JSON.stringify({ version: 1, sessionId: 'ended', outputs: [{ ref: 'proto/b.html', kind: 'html', tier: 'declared' }, { ref: 'docs/prd.md', kind: 'markdown', tier: 'declared' }] }));
  for (const out of ['proto/a.html', 'proto/b.html', 'docs/prd.md']) {
    write(join(cwd, out));
    write(join(cwd, `${out}.feedback.md`), '# Feedback\n');
  }
  write(join(cwd, 'proto/b.html.feedback/1-r1-before-1.png'), 'png');
  const briefs: SessionBriefs = {
    ended: { cwd, boards: ['solo', 'shared', 'current'], at: 1 },
    other: { cwd, boards: ['shared'], at: 1 },
  };
  const gone = { drafts: [] as string[], boards: [] as string[], feedback: [] as string[] };
  const cleanup = new Cleanup({
    dataDir,
    briefs: () => briefs,
    isLive: (id) => (opts.live ?? []).includes(id),
    drafts: () => drafts.filter((d) => existsSync(join(dataDir, 'drafts', `${d.id}.json`))),
    draftFile: (id) => join(dataDir, 'drafts', `${id}.json`),
    boardFiles: (name) => [join(dataDir, 'boards', `${name}.excalidraw`)].filter(existsSync),
    currentBoard: () => 'current',
    initiatives: () => (opts.initiativeOutput ? [{ outputs: [`PRD [prd.md](<file:${join(cwd, opts.initiativeOutput)}>)`] } as Initiative] : []),
    tracked: async (_cwd, files) => new Set(files.filter((f) => (opts.tracked ?? []).some((t) => f === join(cwd, t)))),
    trash: async (path) => rmSync(path, { recursive: true, force: true }),
    forgetDraft: (id) => gone.drafts.push(id),
    forgetBoard: (name) => gone.boards.push(name),
    feedbackGone: (_cwd, output) => gone.feedback.push(output),
  });
  return { cleanup, cwd, dataDir, gone };
}

describe('Clean up', () => {
  it('lists what an ended session left, and why anything stays', async () => {
    const { cleanup, cwd } = setup({ tracked: ['proto/a.html'], initiativeOutput: 'docs/prd.md' });
    const plan = await cleanup.plan(['ended', 'other']);
    const byId = Object.fromEntries(plan.map((i) => [i.id, i]));
    expect(plan.map((i) => i.id).sort()).toEqual(
      ['note:n1', 'note:r1', 'board:solo', 'board:shared', 'board:current', 'items:ended', `feedback:${join(cwd, 'proto/a.html')}`, `feedback:${join(cwd, 'proto/b.html')}`, `feedback:${join(cwd, 'docs/prd.md')}`, 'note:n2'].sort(),
    );
    expect(byId['note:n1'].keep).toBeUndefined();
    expect(byId['note:r1'].label).toBe('Review · proto/a.html');
    expect(byId['board:shared'].keep).toBe('shared');
    expect(byId['board:current'].keep).toBe('open');
    expect(byId[`feedback:${join(cwd, 'proto/a.html')}`].keep).toBe('git');
    expect(byId[`feedback:${join(cwd, 'docs/prd.md')}`].keep).toBe('initiative');
    expect(byId[`feedback:${join(cwd, 'proto/b.html')}`]).toMatchObject({ label: 'Feedback on proto/b.html', detail: '0 items · 1 picture' });
  });

  it('lists nothing for a live session', async () => {
    const { cleanup } = setup({ live: ['ended'] });
    expect(await cleanup.plan(['ended'])).toEqual([]);
  });

  it('moves what you discard to the Trash, skips anything kept, and remembers what you keep', async () => {
    const { cleanup, cwd, dataDir, gone } = setup();
    const b = join(cwd, 'proto/b.html');
    const result = await cleanup.run(['note:n1', 'board:solo', 'board:current', 'items:ended', `feedback:${b}`], ['note:r1']);
    expect(result.trashed).toBe(4);
    expect(existsSync(join(dataDir, 'drafts', 'n1.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'boards', 'current.excalidraw'))).toBe(true);
    expect(existsSync(`${b}.feedback.md`) || existsSync(`${b}.feedback`)).toBe(false);
    expect(existsSync(b)).toBe(true);
    expect(gone).toEqual({ drafts: ['n1'], boards: ['solo'], feedback: ['proto/b.html'] });
    expect(JSON.parse(readFileSync(join(dataDir, 'kept.json'), 'utf8'))).toEqual(['note:r1']);
    expect((await cleanup.plan(['ended'])).find((i) => i.id === 'note:r1')?.keep).toBe('kept');
  });
});
