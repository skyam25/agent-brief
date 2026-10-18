import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BehaviorDocument } from '../src/protocol';
import { deliveriesFor, launch, launchShown, RESULTS, showPanel, sock, tempDataDir, type Launched } from './helpers';

const rule = { id: 'back', text: 'Back preserves entered addresses.', status: 'proposed', source: { kind: 'assumption', ref: 'Navigation persistence is not specified in the brief.' }, target: { selector: '[data-ui="back"]', state: 'Invite teammates' }, delivery: 'planned' };
let ctx: Launched;
test.afterEach(async () => { await ctx?.app.close(); });

async function setup() {
  const h = await launchShown();
  ctx = h.ctx;
  const cwd = tempDataDir();
  writeFileSync(join(cwd, 'onboarding.html'), '<!doctype html><html><head><title>Onboarding</title><style>body{font-family:system-ui;padding:24px}button{padding:12px}</style></head><body><h1>Invite teammates</h1><label>Email <input type="email"></label><p><button data-ui="back">Back</button></p><p>Sending invitations is simulated.</p></body></html>');
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'behavior-1', cwd, title: 'Onboarding' });
  const route = '/sessions/behavior-1/behavior?path=onboarding.html';
  await sock(h.socketPath, 'PUT', route, { version: 'missing', upsert: [rule], limitations: ['Invitations are simulated; no email is sent.'] });
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'behavior-1', output: { path: 'onboarding.html' } });
  await expect(ctx.page.getByTestId('review')).toBeVisible();
  await ctx.page.getByTestId('behavior-tab').click();
  return { ...h, cwd, route };
}

test('reviews behavior, sends acceptance criteria, and retains decisions after restart in a new session', async () => {
  const h = await setup();
  const { page } = ctx;
  const card = page.getByTestId('behavior-rule-back');
  await expect(card).toContainText('Proposed');
  await expect(page.getByTestId('behavior-panel')).toContainText('Invitations are simulated');
  await card.getByRole('button', { name: 'Show element' }).click();
  await card.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(card).toContainText('Confirmed');
  await expect(card).toContainText('Not implemented');
  const confirmed = JSON.parse(readFileSync(join(h.cwd, 'onboarding.html.behavior.json'), 'utf8'));
  expect(confirmed.history.at(-1).by).toBe('PM');
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await card.getByLabel('Behavior', { exact: true }).fill('Back preserves entered addresses until onboarding ends.');
  await card.getByLabel('Question or note').fill('Should addresses survive a browser restart?');
  await page.getByTestId('send').click();
  await expect(page.getByText('Save or cancel the behavior edit before sending.')).toBeVisible();
  await card.getByRole('button', { name: 'Leave open' }).click();
  await expect(card).toContainText('Proposed');
  await expect(card).toContainText('Should addresses survive a browser restart?');
  await card.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(card).toContainText('Confirmed');
  await page.screenshot({ path: join(RESULTS, 'behavior-review.png') });
  await page.getByTestId('send').click();
  await expect.poll(async () => (await deliveriesFor(h.socketPath, 'behavior-1')).length).toBe(1);
  const delivery = (await deliveriesFor(h.socketPath, 'behavior-1'))[0];
  const markdown = readFileSync(join(delivery.dir, 'review.md'), 'utf8');
  expect(markdown).toContain('Confirmed acceptance criteria');
  expect(markdown).toContain('Back preserves entered addresses until onboarding ends.');
  expect(markdown).toContain('Should addresses survive a browser restart?');
  expect(markdown).toContain('Delivery: planned');
  expect(delivery.draft).toContain('behavior-review skill');

  await ctx.app.close();
  ctx = await launch(h.dataDir);
  await showPanel(ctx.app, ctx.page);
  await expect.poll(() => existsSync(h.socketPath)).toBe(true);
  await sock(h.socketPath, 'POST', '/sessions', { sessionId: 'behavior-2', cwd: h.cwd });
  await sock(h.socketPath, 'POST', '/open', { sessionId: 'behavior-2', output: { path: 'onboarding.html' } });
  await ctx.page.getByTestId('behavior-tab').click();
  await expect(ctx.page.getByTestId('behavior-rule-back')).toContainText('Confirmed');
  await expect(ctx.page.getByTestId('behavior-rule-back')).toContainText('until onboarding ends');
  await ctx.page.getByText('Decision history', { exact: true }).click();
  await expect(ctx.page.getByTestId('behavior-panel')).toContainText('Revision 4 · PM');
});

test('preserves an unsaved PM edit when an agent changes the same rule and requires reviewing the new revision', async () => {
  const h = await setup();
  const card = ctx.page.getByTestId('behavior-rule-back');
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await card.getByLabel('Behavior', { exact: true }).fill('My pending decision');
  const doc = (await sock(h.socketPath, 'GET', h.route)).body as BehaviorDocument;
  await sock(h.socketPath, 'PUT', h.route, { version: doc.version, upsert: [{ ...rule, text: 'The agent changed this rule.' }] });
  await expect(card.getByRole('alert')).toContainText('The agent changed this rule.');
  await expect(card.getByLabel('Behavior', { exact: true })).toHaveValue('My pending decision');
  await expect(card.getByRole('button', { name: 'Save and confirm' })).toBeDisabled();
  await card.getByRole('button', { name: 'Use current revision for my edit' }).click();
  await card.getByRole('button', { name: 'Save and confirm' }).click();
  await expect(card).toContainText('My pending decision');
  await expect(card).toContainText('Confirmed');
  const saved = JSON.parse(readFileSync(join(h.cwd, 'onboarding.html.behavior.json'), 'utf8'));
  expect(saved.history.at(-1).before[0].text).toBe('The agent changed this rule.');
});

test('shows missing targets and recovers from a hand-edited specification conflict without losing the PM text', async () => {
  const h = await setup();
  const card = ctx.page.getByTestId('behavior-rule-back');
  await ctx.page.frameLocator('[data-testid="review-frame"]').locator('[data-ui="back"]').evaluate((el) => el.remove());
  await card.getByRole('button', { name: 'Show element' }).click();
  await expect(ctx.page.getByText('That element is not visible.', { exact: false })).toBeVisible();
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await card.getByLabel('Behavior', { exact: true }).fill('Preserve my wording');
  const path = join(h.cwd, 'onboarding.html.behavior.json');
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, original + '\n');
  await card.getByRole('button', { name: 'Save and confirm' }).click();
  await expect(ctx.page.getByTestId('behavior-panel').getByRole('alert').first()).toContainText('changed since');
  await expect(card.getByLabel('Behavior', { exact: true })).toHaveValue('Preserve my wording');
  expect(readFileSync(path, 'utf8')).toBe(original + '\n');
});
