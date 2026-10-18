/**
 * Before and after pictures for feedback items. A hidden offscreen window loads the
 * HTML output the way the review pane does and captures the item's `Where:` element,
 * or the visible page. The picture goes in the output's sibling folder and the item
 * gains a `Before:` or `After:` line.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrowserWindow as ElectronWindow, Rectangle } from 'electron';
import type { FeedbackSnapRequest, FeedbackSnapResult } from '../protocol';
import { feedbackAssets, type FeedbackActor } from '../shared/feedback';
import { snapLine, snapName } from '../shared/feedback-pictures';
import type { FeedbackStore } from './feedback';
import { OFFSCREEN } from './window-options';

class SnapError extends Error {
  constructor(readonly code: 'bad_request', message: string) { super(message); }
}
const bad = (s: string): never => { throw new SnapError('bad_request', s); };

/** Captures `selector`'s element on the page at `url`, or the visible page. Throws SnapError when the element is not there. */
export type PageCapture = (url: string, selector: string | undefined) => Promise<Buffer>;

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const MAX_PICTURE = 15 * 1024 * 1024;

const within = (root: string, p: string) => { const rel = relative(root, p); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

export class FeedbackSnaps {
  constructor(private readonly deps: { store: Pick<FeedbackStore, 'read' | 'update'>; urlFor: (root: string, path: string) => string; capture: PageCapture }) {}

  async snap(root: string, output: unknown, raw: unknown, by: FeedbackActor): Promise<FeedbackSnapResult> {
    const req = raw as FeedbackSnapRequest | undefined;
    if (!req || typeof req !== 'object' || !Number.isInteger(req.item) || (req.side !== 'before' && req.side !== 'after') || (req.round !== undefined && !Number.isInteger(req.round))) {
      return bad('Expected item, side "before" or "after", and an optional round');
    }
    const doc = this.deps.store.read(root, output);
    if (!/\.html?$/i.test(doc.output)) return bad(`Snapshots need an HTML output, and ${doc.output} is not one`);
    const item = doc.items.find((i) => i.n === req.item) ?? bad(`${doc.path} has no item #${req.item}`);
    const round = req.round ?? item.rounds.at(-1) ?? bad(`#${item.n} has no round. Pass --round`);
    if (!doc.rounds.some((r) => r.n === round)) return bad(`There is no round ${round}`);

    const png = await this.deps.capture(this.deps.urlFor(root, doc.output), item.where);
    const realRoot = realpathSync(root);
    const dir = join(realRoot, feedbackAssets(doc.output));
    if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !statSync(dir).isDirectory())) return bad(`${feedbackAssets(doc.output)} must be a folder`);
    mkdirSync(dir, { recursive: true });
    const name = snapName(item.n, round, req.side);
    const tmp = join(dir, `.${name}.${randomUUID()}.tmp`);
    try { writeFileSync(tmp, png, { flag: 'wx' }); renameSync(tmp, join(dir, name)); }
    finally { if (existsSync(tmp)) unlinkSync(tmp); }

    const picture = `${feedbackAssets(doc.output)}/${name}`;
    const key = req.side === 'before' ? 'Before' : 'After';
    const text = snapLine(doc.output, item.n, round, req.side);
    // A retake replaces the picture and keeps the one line that names it.
    const current = this.deps.store.read(root, doc.output);
    if (current.items.find((i) => i.n === item.n)?.lines.some((l) => l.key === key && l.text === text)) return { ...current, picture };
    const next = this.deps.store.update(root, doc.output, { version: current.version, ops: [{ op: 'append', item: item.n, key, text }] }, by);
    return { path: next.path, output: next.output, version: next.version, title: next.title, rounds: next.rounds, items: next.items, picture };
  }

  /** A picture a `Before:` or `After:` line names, as a data URL, or undefined when it is not there. */
  picture(root: string, output: unknown, rel: unknown): string | undefined {
    if (typeof output !== 'string' || typeof rel !== 'string') return bad('Expected an output and a picture path');
    const parts = [...output.split('/').slice(0, -1), ...rel.split('/')];
    if (isAbsolute(rel) || parts.some((p) => !p || p.startsWith('.'))) return bad('Pictures sit beside the output, without dot folders');
    const type = IMAGE_TYPES[rel.split('.').at(-1)!.toLowerCase()] ?? bad('Pictures are PNG, JPEG, WebP or GIF');
    const realRoot = realpathSync(root);
    const target = resolve(realRoot, ...parts);
    if (!existsSync(target)) return undefined;
    const real = realpathSync(target);
    if (!within(realRoot, real) || !statSync(real).isFile()) return bad('Pictures must be files inside the project');
    if (statSync(real).size > MAX_PICTURE) return bad(`${rel} is over 15 MB`);
    return `data:${type};base64,${readFileSync(real).toString('base64')}`;
  }
}

const VIEW = { width: 1280, height: 800 };
const MAX_HEIGHT = 4000;
const LOAD_TIMEOUT = 15_000;
/** Room around the element, in CSS pixels. */
const PAD = 8;

type Measured = { rect: Rectangle; full: number } | { error: 'missing' | 'invalid' | 'empty' } | null;

/** Runs in the page. Scrolls the element to the top, waits two frames, and gives its padded box in the viewport. */
function measure(selector: string | null, pad: number): Promise<Measured> {
  return (async () => {
    await document.fonts?.ready;
    let el: Element | null = null;
    if (selector) {
      try { el = document.querySelector(selector); } catch { return { error: 'invalid' as const }; }
      if (!el) return { error: 'missing' as const };
      el.scrollIntoView({ block: 'start', inline: 'nearest' });
      scrollBy(0, -pad);
    }
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.floor(r.left - pad));
    const y = Math.max(0, Math.floor(r.top - pad));
    const width = Math.min(innerWidth, Math.ceil(r.right + pad)) - x;
    const height = Math.min(innerHeight, Math.ceil(r.bottom + pad)) - y;
    if (width <= 0 || height <= 0) return { error: 'empty' as const };
    return { rect: { x, y, width, height }, full: Math.ceil(r.height + pad * 2) };
  })();
}

/**
 * Captures pages in a window that is never shown. It renders offscreen, sits off
 * every display, takes no focus, and cannot navigate or open windows.
 */
export function offscreenCapture(Window: typeof ElectronWindow): PageCapture {
  return async (url, selector) => {
    const win = new Window({
      show: false,
      ...OFFSCREEN,
      ...VIEW,
      useContentSize: true,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      paintWhenInitiallyHidden: true,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The page took too long to load')), LOAD_TIMEOUT); });
      await Promise.race([wc.loadURL(url), timeout]);
      const run = () => Promise.race([wc.executeJavaScript(`(${measure.toString()})(${JSON.stringify(selector ?? null)}, ${PAD})`) as Promise<Measured>, timeout]);
      let measured = await run();
      // A tall element gets a taller window, up to a limit.
      if (measured && 'rect' in measured && measured.full > VIEW.height) {
        win.setContentSize(VIEW.width, Math.min(measured.full, MAX_HEIGHT));
        measured = await run();
      }
      if (measured && 'error' in measured) {
        if (measured.error === 'invalid') return bad(`Where: ${selector} is not a CSS selector`);
        return bad(measured.error === 'missing' ? `No element on the page matches ${selector}` : `${selector} takes no room on the page`);
      }
      const image = await wc.capturePage(measured?.rect);
      if (image.isEmpty()) throw new Error('The page drew nothing to capture');
      return image.toPNG();
    } finally {
      clearTimeout(timer);
      win.destroy();
    }
  };
}
