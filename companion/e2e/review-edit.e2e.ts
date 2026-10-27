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
  // Review opens the session's newest Ready page by itself.
  await page.getByTestId('mode-review').click();
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

  // Add inside puts ready-made markup into the selected container. A list takes only list items, so it offers none.
  await frame.locator('li', { hasText: 'Team' }).click();
  await page.getByTestId('inspector-parent').click();
  await expect(page.getByTestId('inspector-label')).toHaveText(/^ul/);
  await expect(page.getByTestId('insert-text')).toHaveCount(0);
  await frame.locator('#board').click({ position: { x: 300, y: 10 } });
  await expect(page.getByTestId('inspector-label')).toHaveText(/^section/);
  await page.getByTestId('insert-text').click();
  await expect.poll(file).toContain('<button id="nudge" data-ab-pass type="button">Nudge</button>\n    <p>Text</p>\n  </section>');

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
  expect(md).toContain('- Undid: Set data-x="40" on section “Nudge Text”');
});

const MIXED = `<!doctype html>
<html>
<head><style>td { border: 1px solid #999; padding: 6px } li { padding: 4px }</style></head>
<body>
  <p id="ent">Fish &amp; chips&nbsp;daily</p>
  <table id="t">
    <tr id="r1"><td id="a1">A1</td><td>B1</td></tr>
    <tr id="r2"><td id="a2">A2</td><td>B2</td></tr>
  </table>
  <ul id="fruit">
    <li id="apple">Apple</li>
    <li id="pear">Pear</li>
  </ul>
  <div id="box"><p id="loose">No end tag
  </div>
  <textarea id="notes">Notes</textarea>
  <input id="email">
</body>
</html>
`;

test('edit mode handles keys after a click, tables, lists, form fields and loose markup', async () => {
  const { app, page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  put(cwd, 'site/index.html', MIXED);
  put(cwd, '.feedback/outputs/s1.json', JSON.stringify({ version: 1, sessionId: 's1', outputs: [PAGE] }));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Mixed' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await showPanel(app, page);
  await page.getByTestId('mode-review').click();
  const frame = page.frameLocator('[data-testid="review-frame"]');
  await expect(frame.locator('#a1')).toHaveText('A1');
  const file = () => readFileSync(join(cwd, 'site/index.html'), 'utf8');
  const label = page.getByTestId('inspector-label');
  await page.keyboard.press('e');

  // A click puts the keys in the page, so Delete, ⌘D and Enter act on the selection.
  await frame.locator('#pear').click();
  await expect(label).toHaveText('li “Pear”');
  await page.keyboard.press('Meta+d');
  await expect.poll(() => file().match(/>Pear</g)?.length).toBe(2);
  await page.keyboard.press('Delete');
  await expect.poll(() => file().match(/>Pear</g)?.length).toBe(1);
  await frame.locator('#apple').click();
  await expect(label).toHaveText('li “Apple”');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Green apple');
  await page.keyboard.press('Enter');
  await expect.poll(file).toContain('<li id="apple">Green apple</li>');

  // Add stays away from a list, where a paragraph or button cannot go.
  await expect(page.getByTestId('insert-text')).toHaveCount(0);

  // A retyped line keeps its entities.
  await frame.locator('#ent').dblclick();
  await page.keyboard.press('Meta+ArrowRight');
  await page.keyboard.type('!');
  await page.keyboard.press('Enter');
  await expect.poll(file).toContain('<p id="ent">Fish &amp; chips&nbsp;daily!</p>');

  // A selected row drags from inside it, and lands beside the other row, not in it.
  await frame.locator('#a2').click();
  await page.getByTestId('inspector-parent').click();
  await expect(label).toHaveText('tr “A2 B2”');
  const from = (await frame.locator('#a2').boundingBox())!;
  const to = (await frame.locator('#r1').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(file).toContain('<table id="t">\n    <tr id="r2"><td id="a2">A2</td><td>B2</td></tr>\n    <tr id="r1">');

  // A textarea retypes in place and saves. An input takes no typing that the file would never hold.
  await frame.locator('#notes').dblclick();
  await page.keyboard.type('Agenda');
  await page.keyboard.press('Enter');
  await expect.poll(file).toContain('<textarea id="notes">Agenda</textarea>');
  await page.getByTestId('inspector-text').fill('Minutes');
  await page.getByTestId('inspector-text').press('Enter');
  await expect.poll(file).toContain('<textarea id="notes">Minutes</textarea>');
  await expect(frame.locator('#notes')).toHaveValue('Minutes');
  await frame.locator('#email').dblclick();
  await expect(label).toHaveText('input');
  await expect(page.getByTestId('inspector-text')).toHaveCount(0);
  await expect(frame.locator('#email')).not.toBeFocused();

  // An element with no end tag stays put, and the pane says why.
  const before = file();
  await frame.locator('#loose').click();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('send-status')).toContainText("has no end tag in the file, so it can't be moved, copied or removed here");
  await expect(frame.locator('#loose')).toBeVisible();
  expect(file()).toBe(before);
});

const COPY = `<!doctype html>
<html>
<body>
  <p id="rich">Every <b>plan</b> has <a href="https://example.com/x">exports</a>.</p>
  <p id="plain">Fish and chips</p>
  <p id="paste">Paste here</p>
</body>
</html>
`;

test('retyping keeps inline tags, takes bold, pastes plain words and cancels with Esc', async () => {
  const { app, page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  put(cwd, 'site/index.html', COPY);
  put(cwd, '.feedback/outputs/s1.json', JSON.stringify({ version: 1, sessionId: 's1', outputs: [PAGE] }));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Copy' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await showPanel(app, page);
  await page.getByTestId('mode-review').click();
  const frame = page.frameLocator('[data-testid="review-frame"]');
  await expect(frame.locator('#plain')).toHaveText('Fish and chips');
  const file = () => readFileSync(join(cwd, 'site/index.html'), 'utf8');
  await page.keyboard.press('e');

  // A double click on a bold word retypes its whole paragraph, and the bold and the link stay.
  await frame.locator('#rich b').dblclick();
  await expect(page.getByTestId('inspector-label')).toHaveText('p “Every plan has exports.”');
  await page.keyboard.press('End');
  await page.keyboard.type(' Today');
  await page.keyboard.press('Enter');
  await expect.poll(file).toContain('<p id="rich">Every <b>plan</b> has <a href="https://example.com/x">exports</a>. Today</p>');

  // ⌘B bolds the selected word.
  await frame.locator('#plain').dblclick();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+Alt+ArrowRight');
  await page.keyboard.press('Meta+b');
  await page.keyboard.press('Enter');
  await expect.poll(file).toContain('<p id="plain"><b>Fish</b> and chips</p>');

  // A paste brings words, not the other page's markup.
  await frame.locator('#paste').dblclick();
  await frame.locator('#paste').evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/html', '<div style="color: red"><h2>Big</h2></div>');
    data.setData('text/plain', 'Plain words');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.keyboard.press('Enter');
  await expect.poll(file).toContain('<p id="paste">Plain words</p>');

  // Esc puts the words back and saves nothing, and the next edit still lands.
  const before = file();
  await frame.locator('#rich').dblclick();
  await page.keyboard.type('Gone');
  await page.keyboard.press('Escape');
  await expect(frame.locator('#rich')).toHaveText('Every plan has exports. Today');
  expect(file()).toBe(before);
  await frame.locator('#rich a').dblclick();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('Enter');
  await expect.poll(file).toContain('<a href="https://example.com/x">exports</a>. Today!</p>');
  await page.screenshot({ path: join(RESULTS, 'review-edit-copy.png') });
});
