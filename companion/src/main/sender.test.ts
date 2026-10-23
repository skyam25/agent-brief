import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Outgoing } from '../shared/ipc';
import { Sender, type SenderDeps } from './sender';

function setup() {
  const alpha = mkdtempSync(join(tmpdir(), 'send-alpha-'));
  const beta = mkdtempSync(join(tmpdir(), 'send-beta-'));
  const roots: Record<string, string> = { alpha, beta };
  const deliver = vi.fn(async (input) => ({ id: 'delivery', sessionId: input.sessionId, createdAt: 1, dir: join(alpha, 'bundle'), draft: 'prompt' }));
  const deps = {
    briefs: { cwdOf: (id: string) => roots[id], touched: vi.fn() },
    drafts: { get: vi.fn(), remove: vi.fn() },
    server: { sessions: () => ({ targetSessionId: 'beta', sessions: [] }), deliver },
    state: { state: { deliveryMode: 'fill' } },
    history: { add: vi.fn() },
    terminals: { copy: vi.fn(), start: vi.fn() },
  } as unknown as SenderDeps;
  return { alpha, beta, roots, deliver, deps, sender: new Sender(deps) };
}

const note: Outgoing = { text: 'Edits', sourcePath: 'plan.md', fileSessionId: 'alpha' };

it('refuses to send a file review into another project through every handoff', async () => {
  const { sender, beta, deliver } = setup();
  expect(await sender.send(note)).toMatchObject({ ok: false, message: expect.stringContaining('another project') });
  expect(await sender.sendNew(note, { cwd: beta, via: 'copy' })).toMatchObject({ ok: false, message: expect.stringContaining('another project') });
  expect(await sender.copyPrompt(note, beta)).toMatchObject({ ok: false, message: expect.stringContaining('another project') });
  expect(deliver).not.toHaveBeenCalled();
});

it('allows another session in the same canonical project', async () => {
  const { sender, alpha, beta, roots, deliver } = setup();
  const alias = join(beta, 'alpha-alias');
  symlinkSync(alpha, alias);
  roots.beta = alias;
  expect(await sender.send(note)).toMatchObject({ ok: true });
  expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: 'plan.md', sessionId: 'beta' }));
});

it('keeps the checked destination if the target changes while composing', async () => {
  const { sender, alpha, roots, deps, deliver } = setup();
  roots.beta = alpha;
  vi.spyOn(sender, 'compose').mockImplementationOnce(async () => {
    deps.server.sessions = () => ({ targetSessionId: 'alpha', sessions: [] });
    return { input: { boardName: '', text: 'Edits' }, warnings: [] };
  });
  expect(await sender.send(note)).toMatchObject({ ok: true });
  expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'beta' }));
});

it('refuses an unknown source owner rather than interpreting its relative path in the destination', async () => {
  const { sender } = setup();
  expect(await sender.send({ ...note, fileSessionId: 'gone' })).toMatchObject({ ok: false, message: expect.stringContaining('unavailable') });
});

it('delivers to an explicit destination even when another session is the current target', async () => {
  const { sender, deliver } = setup();
  expect(await sender.send({ text: 'For alpha' }, 'alpha')).toMatchObject({ ok: true });
  expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'alpha' }));
});

it('preserves a newer draft autosave when the older revision finishes sending', async () => {
  const { sender, deps } = setup();
  vi.mocked(deps.drafts.get).mockReturnValue({ updatedAt: 20 } as ReturnType<typeof deps.drafts.get>);
  expect(await sender.send({ text: 'Old text', draftId: 'd', draftRevision: 10 })).toMatchObject({ ok: true });
  expect(deps.drafts.remove).not.toHaveBeenCalled();
});

it('consumes the saved draft when it is the revision that was sent', async () => {
  const { sender, deps } = setup();
  vi.mocked(deps.drafts.get).mockReturnValue({ updatedAt: 10 } as ReturnType<typeof deps.drafts.get>);
  expect(await sender.send({ text: 'Text', draftId: 'd', draftRevision: 10 })).toMatchObject({ ok: true });
  expect(deps.drafts.remove).toHaveBeenCalledWith('d');
});
