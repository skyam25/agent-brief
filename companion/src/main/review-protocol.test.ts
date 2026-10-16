import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { injectOverlay, OVERLAY_PATH, resolveReviewPath, ReviewRoots, serveReview } from './review-protocol';

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-')));
  mkdirSync(join(root, 'site'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'site', 'index.html'), '<!doctype html><html><head><title>P</title></head><body><h1>Hi</h1></body></html>');
  writeFileSync(join(root, 'site', 'a b.css'), 'h1{}');
  writeFileSync(join(root, '.git', 'config'), 'secret');
  writeFileSync(join(root, '.env'), 'KEY=1');
  return root;
}

describe('resolveReviewPath', () => {
  it('finds files under the project, spaces and all', () => {
    const root = project();
    expect(resolveReviewPath(root, '/site/index.html')).toBe(join(root, 'site', 'index.html'));
    expect(resolveReviewPath(root, '/site/a%20b.css')).toBe(join(root, 'site', 'a b.css'));
  });

  it('refuses dot files, parent steps and links that leave the project', () => {
    const root = project();
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    writeFileSync(join(outside, 'x.html'), 'x');
    symlinkSync(outside, join(root, 'away'));
    for (const p of ['/.env', '/.git/config', '/site/../../etc/hosts', '/%2e%2e/x', '/away/x.html', '/', '/missing.html', '/%E0%A4%A']) {
      expect(resolveReviewPath(root, p), p).toBeUndefined();
    }
  });
});

describe('injectOverlay', () => {
  it('puts the script first in the head, or as early as the page allows', () => {
    const tag = `<script src="${OVERLAY_PATH}"></script>`;
    expect(injectOverlay('<html lang="en"><HEAD class="x"><title>t</title></head></html>')).toBe(`<html lang="en"><HEAD class="x">${tag}<title>t</title></head></html>`);
    expect(injectOverlay('<html><body>x</body></html>')).toBe(`<html>${tag}<body>x</body></html>`);
    expect(injectOverlay('<!DOCTYPE html>\n<p>x')).toBe(`<!DOCTYPE html>${tag}\n<p>x`);
    expect(injectOverlay('<p>x</p>')).toBe(`${tag}<p>x</p>`);
  });
});

describe('serveReview', () => {
  it('serves project files by token, adds the overlay to HTML, and refuses unknown tokens', async () => {
    const root = project();
    const overlay = join(root, 'overlay.js');
    writeFileSync(overlay, '/* overlay */');
    const roots = new ReviewRoots();
    const url = roots.urlFor(root, 'site/index.html');
    expect(url).toMatch(/^agent-brief-review:\/\/[0-9a-f]{24}\/site\/index\.html$/);
    expect(roots.urlFor(root, 'site/a b.css')).toBe(url.replace('index.html', 'a%20b.css'));

    const page = await serveReview(roots, overlay, new Request(url));
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-store');
    // The overlay carries the file's version, and each body element its offset in the file.
    const text = await page.text();
    expect(text).toMatch(new RegExp(`<head><script src="${OVERLAY_PATH}" data-ab-version="[0-9a-f]{16}"></script><title>P</title>`));
    expect(text).toMatch(/<h1 data-ab-at="\d+">/);

    const css = await serveReview(roots, overlay, new Request(url.replace('index.html', 'a%20b.css')));
    expect(await css.text()).toBe('h1{}');
    const script = await serveReview(roots, overlay, new Request(url.replace('/site/index.html', OVERLAY_PATH)));
    expect(await script.text()).toBe('/* overlay */');

    expect((await serveReview(roots, overlay, new Request(url.replace('index.html', '../.env')))).status).toBe(404);
    expect((await serveReview(roots, overlay, new Request('agent-brief-review://nope/site/index.html'))).status).toBe(404);
    expect((await serveReview(roots, overlay, new Request(url, { method: 'POST', body: 'x' }))).status).toBe(405);
  });
});
