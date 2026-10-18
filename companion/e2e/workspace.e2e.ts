import { expect, test } from '@playwright/test';
import type { SessionsResponse } from '../src/protocol';
import { briefTab, draftBody, launchShown, type Launched, openPanelFor, registerSession, sock } from './helpers';

let ctx: Launched;
let socketPath: string;

test.beforeEach(async () => { ({ ctx, socketPath } = await launchShown()); });
test.afterEach(async () => { await ctx.app.close(); });

test('mode and session transitions keep each note scoped and Unfiled clears the target', async () => {
  const { app, page } = ctx;
  await registerSession(socketPath, 's1', 'Alpha');
  await registerSession(socketPath, 's2', 'Beta');
  await openPanelFor(socketPath, { sessionId: 's1', mode: 'write', text: 'Alpha note' });
  await expect.poll(() => draftBody(page)).toBe('Alpha note');
  await expect.poll(() => app.evaluate(() => globalThis.__companion.drafts.list().some((d) => d.body === 'Alpha note'))).toBe(true);
  await openPanelFor(socketPath, { sessionId: 's2', mode: 'write', text: 'Beta note' });
  await expect.poll(() => draftBody(page)).toBe('Beta note');
  await expect.poll(() => app.evaluate(() => globalThis.__companion.drafts.list().some((d) => d.body === 'Beta note'))).toBe(true);

  await briefTab(page, 'Alpha').getByRole('tab').click();
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => draftBody(page)).toBe('Alpha note');
  await page.getByTestId('mode-initiative').click();
  await briefTab(page, 'Beta').getByRole('tab').click();
  await expect(page.getByTestId('mode-initiative')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('mode-write').click();
  await expect.poll(() => draftBody(page)).toBe('Beta note');

  await page.getByTestId('mode-review').click();
  await expect(page.getByTestId('mode-review')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('notes-tab').getByRole('tab').click();
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('notes-tab')).toHaveAttribute('aria-current', 'true');
  await expect.poll(async () => (await sock<SessionsResponse>(socketPath, 'GET', '/sessions')).body.targetSessionId).toBeUndefined();
  const selected = await page.evaluate(() => window.__drafts.selected);
  expect(selected?.sessionId).toBeUndefined();
});

test('panel hide flushes the current draft before its debounce expires', async () => {
  const { app, page } = ctx;
  await page.getByTestId('mode-write').click();
  const id = await page.evaluate(() => {
    const draft = window.__drafts.selected!;
    window.__drafts.edit(draft.id, 'Saved on hide');
    window.companion.hidePanel();
    return draft.id;
  });
  await expect.poll(() => app.evaluate((_electron, draftId) => globalThis.__companion.drafts.get(draftId)?.body, id)).toBe('Saved on hide');
});
