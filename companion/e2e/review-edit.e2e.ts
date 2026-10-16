import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OutputRecord } from '../src/protocol';
import { deliveriesFor, launch, type Launched, RESULTS, showPanel, sock, tempDataDir } from './helpers';

let ctx: Launched;
let socketPath: string;

test.beforeEach(async () => {
  const dataDir = tempDataDir();
  socketPath = join(dataDir, 'companion.sock');
  ctx = await launch(dataDir);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
});

test.afterEach(async () => {
  await ctx.app.close();
});

const T = Date.now();
const PAGE: OutputRecord = { ref: 'site/index.html', title: 'Landing page', kind: 'html', tier: 'declared', status: 'ready', declaredAt: T };

const HTML = `<!doctype html>
<html>
<head><title>Acme</title><style>body { font-family: sans-serif; margin: 24px } ul { display: flex; flex-direction: column; gap: 4px; padding: 0 } li { list-style: none; padding: 8px; border: 1px solid #999 }</style></head>
<body>
  <h1>Acme analytics</h1>
  <p class="lede">Every plan includes exports.</p>
  <ul id="plans">
    <li>Starter</li>
    <li>Team</li>
    <li>Enterprise</li>
  </ul>
  <section id="board" data-x="0">
    <button id="nudge" data-ab-pass type="button">Nudge</button>
  </section>
  <script>
    // A page's own edit, the way a canvas reports a dragged frame.
    document.getElementById('nudge').addEventListener('click', () => {
      const board = document.getElementById('board');
      board.dataset.x = '40';
      document.dispatchEvent(new CustomEvent('agent-brief:edit', { detail: { target: board, set: { 'data-x': '40' } } }));
    });
  </script>
</body>
</html>
`;

function put(cwd: string, path: string, text: string): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
}

async function openReview(page: Page, app: Launched['app'], cwd: string): Promise<FrameLocator> {
  put(cwd, 'site/index.html', HTML);
  put(cwd, '.feedback/outputs/s1.json', JSON.stringify({ version: 1, sessionId: 's1', outputs: [PAGE] }));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Landing' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await showPanel(app, page);
  await page.getByTestId('mode-review').click();
  await page.getByTestId('output-row-0').click();
  const frame = page.frameLocator('[data-testid="review-frame"]');
  await expect(frame.locator('h1')).toHaveText('Acme analytics');
  return frame;
}

test('edit mode changes the page and saves each change to the file, with undo', async () => {
  const { app, page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  const frame = await openReview(page, app, cwd);
  const file = () => readFileSync(join(cwd, 'site/index.html'), 'utf8');

  // E turns edit mode on and comment mode off, and the inspector replaces the cards.
  await expect(page.getByTestId('review-edit')).toBeEnabled();
  await page.keyboard.press('e');
  await expect(page.getByTestId('review-edit')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('review-comment')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('inspector')).toBeVisible();

  // A click selects; an inspector field saves an inline style.
  await frame.locator('h1').click();
  await expect(page.getByTestId('inspector-label')).toHaveText('h1 “Acme analytics”');
  await page.getByTestId('field-color').fill('rgb(200, 0, 0)');
  await page.getByTestId('field-color').press('Enter');
  await expect.poll(file).toContain('<h1 style="color: rgb(200, 0, 0)">Acme analytics</h1>');
  await expect(frame.locator('h1')).toHaveCSS('color', 'rgb(200, 0, 0)');

  // A double click retypes the words in place.
  await frame.locator('p.lede').dblclick();
  await page.keyboard.type('Every plan ships with exports.');
  await page.keyboard.press('Enter');
  await expect.poll(file).toContain('<p class="lede">Every plan ships with exports.</p>');

  // A drag moves an element to another place in its container.
  const enterprise = frame.locator('li', { hasText: 'Enterprise' });
  const starter = frame.locator('li', { hasText: 'Starter' });
  const from = (await enterprise.boundingBox())!;
  const to = (await starter.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + 4, { steps: 8 });
  await page.screenshot({ path: join(RESULTS, 'review-edit-drag.png') });
  await page.mouse.up();
  await expect.poll(file).toContain('<ul id="plans">\n    <li>Enterprise</li>\n    <li>Starter</li>\n    <li>Team</li>\n  </ul>');

  // The moved element stays selected, and the inspector duplicates and deletes.
  await expect(page.getByTestId('inspector-label')).toHaveText('li “Enterprise”');
  await page.getByTestId('inspector-duplicate').click();
  await expect.poll(file).toContain('<li>Enterprise</li>\n    <li>Enterprise</li>');
  await page.getByTestId('inspector-remove').click();
  await expect.poll(() => file().match(/<li>Enterprise<\/li>/g)?.length).toBe(1);

  // Add inside puts ready-made markup into the selected container.
  await frame.locator('li', { hasText: 'Team' }).click();
  await page.getByTestId('inspector-parent').click();
  await expect(page.getByTestId('inspector-label')).toHaveText(/^ul/);
  await page.getByTestId('insert-text').click();
  await expect.poll(file).toContain('<li>Team</li>\n    <p>Text</p>\n  </ul>');

  // A page's own edit event saves attributes.
  await frame.locator('#nudge').click();
  await expect.poll(file).toContain('<section id="board" data-x="40">');
  await page.screenshot({ path: join(RESULTS, 'review-edit-inspector.png') });

  // ⌘Z puts back the last edit and reloads the page.
  await page.keyboard.press('Meta+z');
  await expect.poll(file).toContain('<section id="board" data-x="0">');
  await expect(frame.locator('h1')).toHaveText('Acme analytics');
  await expect(page.getByTestId('review-edits-count')).toContainText('edits saved to the file');

  // An edit made against a file that changed on disk is refused, and the page reloads.
  writeFileSync(join(cwd, 'site/index.html'), file().replace('Acme analytics', 'Acme metrics'));
  await frame.locator('h1').click();
  await page.getByTestId('field-color').fill('blue');
  await page.getByTestId('field-color').press('Enter');
  await expect(page.getByTestId('send-status')).toContainText('changed since the page loaded');
  await expect(frame.locator('h1')).toHaveText('Acme metrics');
  expect(file()).not.toContain('color: blue');

  // Send lists the edits in review.md, already saved in the file.
  await page.keyboard.press('Escape');
  await page.getByTestId('send').click();
  await expect.poll(async () => (await deliveriesFor(socketPath, 's1')).length).toBe(1);
  const [delivery] = await deliveriesFor(socketPath, 's1');
  expect(delivery!.draft).toContain('edits made in the pane, already saved in the file');
  const md = readFileSync(join(delivery!.dir, 'review.md'), 'utf8');
  expect(md).toContain('## Edited in the pane');
  expect(md).toContain('- Changed the text of p “Every plan includes exports.” to “Every plan ships with exports.”');
  expect(md).toContain('- Moved li “Enterprise” into ul');
  expect(md).toContain('- Undid: Set data-x="40" on section “Nudge”');
});
