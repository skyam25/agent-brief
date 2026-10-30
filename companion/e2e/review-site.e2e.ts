import { expect, test, type Locator } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deliveriesFor, launch, type Launched, RESULTS, showPanel, sock, tempDataDir } from './helpers';

let ctx: Launched;
let socketPath: string;
let server: Server;
let origin: string;

/** A one-file app with two routes, as a dev server serves it: every path gets the same page, and links route without a load. */
const APP = `<!doctype html>
<html>
<head><title>Shop</title></head>
<body>
  <nav><a id="home" href="/">Home</a> <a id="about" href="/about">About</a></nav>
  <main id="root"></main>
  <script>
    const views = {
      '/': '<h1>Home</h1><h2>Featured</h2>',
      '/about': '<h1>About us</h1><h2>Our team</h2>',
    };
    const render = () => (document.getElementById('root').innerHTML = views[location.pathname] ?? '<h1>Missing</h1>');
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a');
      if (!link || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      history.pushState(null, '', link.getAttribute('href'));
      render();
    });
    addEventListener('popstate', render);
    render();
  </script>
</body>
</html>
`;

test.beforeEach(async () => {
  const dataDir = tempDataDir();
  socketPath = join(dataDir, 'companion.sock');
  server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(APP));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  ctx = await launch(dataDir);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
});

test.afterEach(async () => {
  await ctx.app.close();
  server.close();
});

/**
 * ⌘-clicks a link in the frame through the panel's mouse, and lets go of ⌘ once the next page shows `heading`.
 * A key sent while the frame is between pages never comes back.
 */
async function metaClick(page: Launched['page'], target: Locator, heading: Locator, text: string): Promise<void> {
  await expect(page.getByTestId('review-hint')).toBeVisible();

  // A page the pane has just reloaded may not listen yet, so the click waits for one that has been up a while.
  await expect.poll(() => target.evaluate(() => performance.now())).toBeGreaterThan(1000);

  // The frame moves while the list folds away, so the link's box must hold still first.
  let box = (await target.boundingBox())!;
  await expect
    .poll(async () => {
      const last = box;
      box = (await target.boundingBox())!;
      return box.x === last.x && box.y === last.y;
    })
    .toBe(true);
  await page.keyboard.down('Meta');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(heading).toHaveText(text);
  await page.keyboard.up('Meta');
}

function put(cwd: string, path: string, text: string): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
}

test('a dev server opens in the review pane, and pins keep the route they were made on', async () => {
  const { app, page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Shop' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1' });
  await showPanel(app, page);
  await page.getByTestId('mode-review').click();

  // A typed address without its scheme opens the running app, and comment mode starts on.
  await page.getByTestId('review-url').fill(origin.replace('http://', ''));
  await page.getByTestId('review-url').press('Enter');
  const frame = page.frameLocator('[data-testid="review-frame"]');
  await expect(frame.locator('h1')).toHaveText('Home');
  await expect(page.getByTestId('review-comment')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('review-edit')).toHaveCount(0);
  await expect(page.getByTestId('feedback-tab')).toHaveCount(0);

  await frame.locator('h2').click();
  const cards = page.getByTestId('review-card');
  await expect(cards).toHaveCount(1);
  await expect(cards.nth(0).getByTestId('review-text')).toBeFocused();
  await page.keyboard.type('Show three products.');

  // ⌘-click follows a link in comment mode instead of pinning it, and comments go on.
  await metaClick(page, frame.locator('#about'), frame.locator('h1'), 'About us');
  await expect(cards).toHaveCount(1);
  await expect(page.getByTestId('review-comment')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.review-title')).toContainText('/about');
  await frame.locator('h2').click();
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1).getByTestId('review-card-page')).toHaveText('on /about');
  await expect(cards.nth(1).getByTestId('review-text')).toBeFocused();
  await page.keyboard.type('Add photos.');
  await page.screenshot({ path: join(RESULTS, 'review-site.png') });

  // A pin on another route brings its page back.
  await cards.nth(0).getByTestId('review-pin').click();
  await expect(frame.locator('h1')).toHaveText('Home');

  // With comment mode off, the app routes as it does in a browser, and the pane follows the route.
  await page.getByTestId('review-comment').click();
  await frame.locator('#about').click();
  await expect(frame.locator('h1')).toHaveText('About us');
  await expect(page.locator('.review-title')).toContainText('/about');
  await expect(cards).toHaveCount(2);
  await page.getByTestId('review-comment').click();
  await frame.locator('h1').click();
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(2).getByTestId('review-card-page')).toHaveText('on /about');
  await expect(cards.nth(2).getByTestId('review-text')).toBeFocused();
  await page.keyboard.type('Warmer headline.');

  // Send asks Claude to find the source of each pin, and review.md names each page.
  await page.getByTestId('send').click();
  await expect.poll(async () => (await deliveriesFor(socketPath, 's1')).length).toBe(1);
  const [delivery] = await deliveriesFor(socketPath, 's1');
  expect(delivery!.draft).toContain(`Review of the running app at ${origin}/ from Agent Brief, 3 comments pinned to the pages.`);
  const md = readFileSync(join(delivery!.dir, 'review.md'), 'utf8');
  expect(md).toContain(`# Review of ${origin}/`);
  expect(md).toMatch(/## 1\. h2 “Featured”\n\nShow three products\.\n\n- Element:/);
  expect(md).toMatch(/## 2\. h2 “Our team”\n\nAdd photos\.\n\n- Page: \/about\n/);
  expect(md).toMatch(/## 3\. h1 “About us”\n\nWarmer headline\.\n\n- Page: \/about\n/);
});

test('in an HTML review, ⌘-click follows a project link and comment mode goes on there', async () => {
  const { app, page } = ctx;
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  put(cwd, 'site/index.html', '<!doctype html><html><head><title>A</title></head><body><h1>Index</h1><a href="about.html">About</a></body></html>');
  put(cwd, 'site/about.html', '<!doctype html><html><head><title>B</title></head><body><h1>About page</h1></body></html>');
  await sock(socketPath, 'POST', '/sessions', { sessionId: 's1', cwd, title: 'Site' });
  await sock(socketPath, 'POST', '/open', { sessionId: 's1', output: { path: 'site/index.html' } });
  await showPanel(app, page);

  const frame = page.frameLocator('[data-testid="review-frame"]');
  await expect(frame.locator('h1')).toHaveText('Index');
  await expect(page.getByTestId('review-comment')).toHaveAttribute('aria-pressed', 'true');
  await metaClick(page, frame.locator('a'), frame.locator('h1'), 'About page');
  await expect(page.getByTestId('review-card')).toHaveCount(0);
  await expect(page.getByTestId('review-comment')).toHaveAttribute('aria-pressed', 'true');
  await frame.locator('h1').click();
  await expect(page.getByTestId('review-card')).toHaveCount(1);
  await expect(page.getByTestId('review-card-page')).toHaveText('on site/about.html');
});
