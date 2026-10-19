/**
 * Before and after pictures for feedback items. A hidden offscreen window loads the
 * HTML output the way the review pane does and captures the block around the item's
 * `Where:` element, with the element outlined, or the whole page up to a height. Each picture is a new file in the output's
 * sibling folder, and the item gains a `Before:` or `After:` line for it.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { BrowserWindow as ElectronWindow, Rectangle, Session } from 'electron';
import type { FeedbackSnapRequest, FeedbackSnapResult } from '../protocol';
import type { FeedbackActor } from '../shared/feedback';
import { picturePath, snapLine, snapName } from '../shared/feedback-pictures';
import { SNAPSHOT_MARK, snapshotBlock } from '../shared/snapshot-block';
import type { FeedbackStore } from './feedback';
import { feedbackAssetsDir, plainRelative, resolveFeedback, within, writeFeedbackAsset } from './feedback-paths';
import { REVIEW_SCHEME } from './review-protocol';
import { OFFSCREEN } from './window-options';

class SnapError extends Error {
  constructor(readonly code: 'bad_request', message: string) { super(message); }
}
const bad = (s: string): never => { throw new SnapError('bad_request', s); };

/**
 * Captures `selector`'s element on the page at `url`, or the whole page. `clipped` is
 * the height in CSS pixels the picture stops at when the element or page is taller.
 * Throws SnapError when the element is not there.
 */
export type PageCapture = (url: string, selector: string | undefined) => Promise<{ png: Buffer; clipped?: number }>;

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const MAX_PICTURE = 15 * 1024 * 1024;
/** Retakes of one side in one round. */
const MAX_REVISIONS = 100;

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

    const { png, clipped } = await this.deps.capture(this.deps.urlFor(root, doc.output), item.where);
    // The capture awaited, so check the output, its folders and the item again before writing.
    const current = this.deps.store.read(root, doc.output);
    if (current.output !== doc.output) return bad(`${doc.output} moved while it was being captured. Nothing was written.`);
    const named = new Set(current.items.find((i) => i.n === item.n)?.lines.map((l) => picturePath(l.text)) ?? bad(`${doc.path} has no item #${item.n}`));
    const assets = feedbackAssetsDir(root, doc.output);
    let rev = 1;
    for (; rev <= MAX_REVISIONS; rev++) {
      if (!named.has(snapLine(doc.output, item.n, round, req.side, rev)) && writeFeedbackAsset(assets, snapName(item.n, round, req.side, rev), png)) break;
    }
    if (rev > MAX_REVISIONS) return bad(`#${item.n} has ${MAX_REVISIONS} ${req.side} pictures for round ${round} already`);

    const picture = `${assets.rel}/${snapName(item.n, round, req.side, rev)}`;
    const key = req.side === 'before' ? 'Before' : 'After';
    const text = `${snapLine(doc.output, item.n, round, req.side, rev)}${clipped ? ` · clipped to the top ${clipped}px` : ''}`;
    const next = this.deps.store.update(root, doc.output, { version: current.version, ops: [{ op: 'append', item: item.n, key, text }] }, by);
    return { path: next.path, output: next.output, version: next.version, title: next.title, rounds: next.rounds, items: next.items, picture, ...(clipped ? { clipped } : {}) };
  }

  /** A picture a `Before:` or `After:` line names, as a data URL, or undefined when it is not there. */
  picture(root: string, output: unknown, rel: unknown): string | undefined {
    if (typeof output !== 'string' || typeof rel !== 'string') return bad('Expected an output and a picture path');
    if (!plainRelative(rel)) return bad('Pictures sit beside the output, without dot folders');
    const type = IMAGE_TYPES[rel.split('.').at(-1)!.toLowerCase()] ?? bad('Pictures are PNG, JPEG, WebP or GIF');
    const { realRoot, outputFile } = resolveFeedback(root, output, { orphan: true });
    const target = resolve(dirname(outputFile), rel);
    if (!existsSync(target)) return undefined;
    const real = realpathSync(target);
    if (!within(realRoot, real) || !plainRelative(relative(realRoot, real)) || !statSync(real).isFile()) return bad('Pictures must be files inside the project, outside dot folders');
    if (statSync(real).size > MAX_PICTURE) return bad(`${rel} is over 15 MB`);
    return `data:${type};base64,${readFileSync(real).toString('base64')}`;
  }
}

const VIEW = { width: 1280, height: 800 };
/** The tallest picture, in CSS pixels. Taller elements and pages are clipped to their top. */
export const MAX_HEIGHT = 10_000;
const LOAD_TIMEOUT = 15_000;
/** Room around the element, in CSS pixels. */
const PAD = 8;

/** `rect` is the block's padded box in the viewport, absent for the whole page. `full` is the height it needs. */
type Measured = { rect?: Rectangle; full: number } | { error: 'missing' | 'invalid' | 'empty' };

/**
 * Runs in the page. Scrolls the element's block, or the page, to the top, outlines
 * the element, waits two frames, and measures the block.
 */
function measure(selector: string | null, pad: number, block: (el: Element) => Element, mark: { color: string; width: number }): Promise<Measured> {
  return (async () => {
    await document.fonts?.ready;
    let el: Element | null = null;
    let target: Element | null = null;
    if (selector) {
      try { target = document.querySelector(selector); } catch { return { error: 'invalid' as const }; }
      if (!target) return { error: 'missing' as const };
      el = block(target);
      el.scrollIntoView({ block: 'start', inline: 'nearest' });
      scrollBy(0, -pad);
      const t = target.getBoundingClientRect();
      if (!t.width || !t.height) return { error: 'empty' as const };
      document.querySelector('[data-agent-brief-mark]')?.remove();
      const outline = document.createElement('div');
      outline.setAttribute('data-agent-brief-mark', '');
      const w = mark.width;
      outline.style.cssText = `all: initial; display: block; position: fixed; left: ${t.left - w}px; top: ${t.top - w}px; width: ${t.width + w * 2}px; height: ${t.height + w * 2}px; border: ${w}px solid ${mark.color}; box-sizing: border-box; pointer-events: none; z-index: 2147483647;`;
      document.documentElement.append(outline);
    } else scrollTo(0, 0);
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    if (!el) return { full: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)) };
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
 * A session for captures alone. It serves the review scheme, grants no permission
 * to any frame, and downloads nothing.
 */
export function captureSession(ses: Session, serve: (request: Request) => Response | Promise<Response>): Session {
  ses.protocol.handle(REVIEW_SCHEME, serve);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
  return ses;
}

/**
 * Captures pages in a window that is never shown. It renders offscreen, sits off
 * every display, takes no focus, and shows no dialogs. Its main frame cannot
 * navigate or open windows, and other frames stay on the review scheme.
 */
export function offscreenCapture(Window: typeof ElectronWindow, session: Session): PageCapture {
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
      webPreferences: { session, offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false, disableDialogs: true, spellcheck: false },
    });
    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('will-frame-navigate', (e) => {
      if (!e.isMainFrame && !e.url.startsWith(`${REVIEW_SCHEME}://`) && e.url !== 'about:blank') e.preventDefault();
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The page took too long to load')), LOAD_TIMEOUT); });
      await Promise.race([wc.loadURL(url), timeout]);
      const run = async () => {
        const script = `(${measure.toString()})(${JSON.stringify(selector ?? null)}, ${PAD}, ${snapshotBlock.toString()}, ${JSON.stringify(SNAPSHOT_MARK)})`;
        const measured = await Promise.race([wc.executeJavaScript(script) as Promise<Measured>, timeout]);
        if ('full' in measured) return measured;
        if (measured.error === 'invalid') return bad(`Where: ${selector} is not a CSS selector`);
        return bad(measured.error === 'missing' ? `No element on the page matches ${selector}` : `${selector} takes no room on the page`);
      };
      let measured = await run();
      // A tall element or page gets a taller window, up to a limit.
      if (measured.full > VIEW.height) {
        win.setContentSize(VIEW.width, Math.min(measured.full, MAX_HEIGHT));
        measured = await run();
      }
      const image = await wc.capturePage(measured.rect);
      if (image.isEmpty()) throw new Error('The page drew nothing to capture');
      return { png: image.toPNG(), ...(measured.full > MAX_HEIGHT ? { clipped: MAX_HEIGHT } : {}) };
    } finally {
      clearTimeout(timer);
      win.destroy();
    }
  };
}
