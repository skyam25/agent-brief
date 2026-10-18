import { expect, test } from '@playwright/test';
import { launchShown, type Launched } from './helpers';

let ctx: Launched;

test.beforeEach(async () => { ({ ctx } = await launchShown()); });
test.afterEach(async () => { await ctx.app.close(); });

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
