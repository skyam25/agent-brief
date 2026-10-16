/**
 * Serves project files to the review pane over `agent-brief-review://<token>/<path>`.
 * Each project folder gets its own random token, so each is its own origin and
 * none shares one with the panel. HTML pages get the overlay script added.
 */

import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { annotate, versionOf } from './html-edit';

export const REVIEW_SCHEME = 'agent-brief-review';
/** The overlay script's path on every review origin. Project files cannot use it. */
export const OVERLAY_PATH = '/__agent-brief__/overlay.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

export const contentType = (path: string) => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

/** Project folders by token, and back. */
export class ReviewRoots {
  private readonly byToken = new Map<string, string>();
  private readonly byRoot = new Map<string, string>();

  /** The address of `path` under the project at `root`. */
  urlFor(root: string, path: string): string {
    let token = this.byRoot.get(root);
    if (!token) {
      token = randomBytes(12).toString('hex');
      this.byRoot.set(root, token);
      this.byToken.set(token, root);
    }
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return `${REVIEW_SCHEME}://${token}/${encoded}`;
  }

  root(token: string): string | undefined {
    return this.byToken.get(token);
  }
}

/**
 * The file a URL path names under `root`, or undefined when it may not be served:
 * outside the project, through a link that leaves it, or in a dot folder such as `.git`.
 */
export function resolveReviewPath(root: string, urlPath: string): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  const segments = path.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === '..' || s.startsWith('.'))) return undefined;
  const target = resolve(root, ...segments);
  if (relative(root, target).startsWith('..')) return undefined;
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(target);
    return real === realRoot || real.startsWith(realRoot + sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adds the overlay script as the page's first script, so it runs before the page's own.
 * `version` is the file's, so the overlay's edits name the copy they were made on.
 */
export function injectOverlay(html: string, src = OVERLAY_PATH, version?: string): string {
  const tag = version ? `<script src="${src}" data-ab-version="${version}"></script>` : `<script src="${src}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const doc = /<html(\s[^>]*)?>/i.exec(html);
  if (doc) return html.slice(0, doc.index + doc[0].length) + tag + html.slice(doc.index + doc[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + tag + html.slice(doctype[0].length);
  return tag + html;
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });

/** Answers one request on the review scheme. */
export async function serveReview(roots: ReviewRoots, overlayFile: string, request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  const url = new URL(request.url);
  const root = roots.root(url.hostname);
  if (!root) return notFound();
  const headers = { 'cache-control': 'no-store' };
  if (url.pathname === OVERLAY_PATH) {
    return new Response(new Uint8Array(await readFile(overlayFile)), { headers: { ...headers, 'content-type': TYPES['.js']! } });
  }
  const file = resolveReviewPath(root, url.pathname);
  if (!file) return notFound();
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    return notFound();
  }
  const type = contentType(file);
  const text = type.startsWith('text/html') ? data.toString('utf8') : undefined;
  const body = text === undefined ? new Uint8Array(data) : injectOverlay(annotate(text), OVERLAY_PATH, versionOf(text));
  return new Response(body, { headers: { ...headers, 'content-type': type } });
}

/** Where the built overlay script sits, next to the built main. */
export const overlayFileFrom = (mainDir: string) => join(mainDir, '../review/overlay.js');
