// Renders the icon SVGs to PNG, builds icon.icns and the preview contact sheet.
// Run with `node build/icons/render.mjs` from the companion package (needs @playwright/test and macOS iconutil).

import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(dir, f));
const dataUrl = (buf, type) => `data:${type};base64,${buf.toString('base64')}`;

// Falls back to the newest cached headless shell when the pinned Playwright browser is not installed

async function launch() {
  try {
    return await chromium.launch();
  } catch (err) {
    const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
    const shells = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')) : [];
    const newest = shells.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
    if (!newest) throw err;
    const arch = process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
    return chromium.launch({ executablePath: path.join(cache, newest, `chrome-headless-shell-${arch}`, 'chrome-headless-shell') });
  }
}

const browser = await launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function renderSvg(svgFile, size, outFile) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">` +
      `<img src="${dataUrl(read(svgFile), 'image/svg+xml')}" width="${size}" height="${size}" style="display:block">` +
      `</body></html>`,
  );
  await page.locator('img').evaluate((img) => img.decode());
  await page.screenshot({ path: path.join(dir, outFile), omitBackground: true });
}

// App icon

await renderSvg('icon.svg', 1024, 'icon-1024.png');
await renderSvg('icon-dark.svg', 1024, 'icon-dark-1024.png');

const iconset = path.join(dir, 'icon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset);

// Pixel sizes up to 32 use the small-size master, which drops the gap and shadows and thickens the stroke

const master = (base, px) => (px <= 32 ? `${base}-small.svg` : `${base}.svg`);
for (const pt of [16, 32, 128, 256, 512]) {
  await renderSvg(master('icon', pt), pt, `icon.iconset/icon_${pt}x${pt}.png`);
  await renderSvg(master('icon', pt * 2), pt * 2, `icon.iconset/icon_${pt}x${pt}@2x.png`);
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(dir, 'icon.icns')]);

// Menu bar template

await renderSvg('tray.svg', 18, 'trayTemplate.png');
await renderSvg('tray.svg', 36, 'trayTemplate@2x.png');

// Contact sheet

await renderSvg('icon-dark.svg', 128, 'icon-dark-128.tmp.png');
await renderSvg(master('icon-dark', 32), 32, 'icon-dark-32.tmp.png');
await renderSvg(master('icon-dark', 16), 16, 'icon-dark-16.tmp.png');

const png = (f) => dataUrl(read(f), 'image/png');
const sets = {
  light: {
    1024: png('icon-1024.png'),
    128: png('icon.iconset/icon_128x128.png'),
    32: png('icon.iconset/icon_32x32.png'),
    16: png('icon.iconset/icon_16x16.png'),
  },
  dark: {
    1024: png('icon-dark-1024.png'),
    128: png('icon-dark-128.tmp.png'),
    32: png('icon-dark-32.tmp.png'),
    16: png('icon-dark-16.tmp.png'),
  },
};
const tray1x = png('trayTemplate.png');
const tray2x = png('trayTemplate@2x.png');

const iconRow = (name, s) => `
  <div class="row">
    <div class="cell"><img src="${s[1024]}" width="256" height="256"><span>${name} 1024 (at 25%)</span></div>
    <div class="cell"><img src="${s[128]}" width="128" height="128"><span>128</span></div>
    <div class="cell"><img src="${s[32]}" width="32" height="32"><span>32</span></div>
    <div class="cell"><img src="${s[16]}" width="16" height="16"><span>16</span></div>
    <div class="cell"><img class="px" src="${s[32]}" width="128" height="128"><span>32 ×4</span></div>
    <div class="cell"><img class="px" src="${s[16]}" width="128" height="128"><span>16 ×8</span></div>
  </div>`;

const trayBar = (bg, invert) => `
  <div class="bar" style="background:${bg}">
    <span class="clock" style="color:${invert ? '#fff' : '#000'}">Fri 10:41</span>
    <img src="${tray1x}" width="18" height="18" style="${invert ? 'filter:invert(1)' : ''}">
    <img class="px" src="${tray2x}" width="72" height="72" style="${invert ? 'filter:invert(1)' : ''}">
  </div>`;

const panel = (bg, fgColor, invert) => `
  <section style="background:${bg};color:${fgColor}">
    ${iconRow('light', sets.light)}
    ${iconRow('dark', sets.dark)}
    ${trayBar(invert ? '#2c2c2e' : '#f2f2f4', invert)}
  </section>`;

await page.setViewportSize({ width: 1200, height: 800 });
await page.setContent(`<html><head><style>
  body { margin: 0; font: 12px -apple-system, system-ui, sans-serif; }
  section { padding: 24px 32px; }
  .row { display: flex; align-items: flex-end; gap: 40px; margin-bottom: 20px; }
  .cell { display: flex; flex-direction: column; align-items: center; gap: 6px; opacity: 0.95; }
  .cell span { opacity: 0.6; }
  .px { image-rendering: pixelated; }
  .bar { display: flex; align-items: center; gap: 16px; padding: 3px 12px; border-radius: 6px; }
  .clock { font-size: 13px; }
</style></head><body>
  ${panel('#ffffff', '#000', false)}
  ${panel('#1e1e1e', '#fff', true)}
</body></html>`);
for (const img of await page.locator('img').all()) await img.evaluate((i) => i.decode());
await page.screenshot({ path: path.join(dir, 'preview.png'), fullPage: true });

for (const f of fs.readdirSync(dir)) if (f.endsWith('.tmp.png')) fs.rmSync(path.join(dir, f));
await browser.close();
