import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handoff } from '../protocol';
import { IPAD_MAX_BODY_BYTES, parsePairUrl, type IpadDelivery, type PairLink } from '../shared/ipad';
import type { SendPayload } from '../shared/ipc';
import { boardMark } from './handoffs';
import { Ipad, NOT_PAIRED, NO_LAN, type IpadDeps } from './index';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

const delivery = (over: Partial<IpadDelivery> = {}): IpadDelivery => ({
  pngBase64: PNG,
  scene: { elements: [{ id: 'a' }] },
  notes: 'a note',
  strokes: [{ t: 0, tEnd: 100, elementId: 'a', type: 'freedraw', bbox: { x: 0, y: 0, width: 10, height: 10 }, by: 'user', kind: 'add' }],
  utterances: [{ t: 50, tEnd: 900, text: 'this part is wrong' }],
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  ...over,
});

const opened: Ipad[] = [];

afterEach(async () => {
  while (opened.length) await opened.pop()!.stop();
});

function make(over: Partial<IpadDeps> = {}) {
  const live = new Set(['s1']);
  const boards = new Map<string, { scene: string; notes?: string }>();
  const filed: [string, string][] = [];
  const sends: [SendPayload, string][] = [];
  const send = vi.fn(async (p: SendPayload, id: string) => {
    sends.push([p, id]);
    return { ok: true, message: `Sent to ${id}` };
  });
  const ipad = new Ipad({
    dataDir: mkdtempSync(join(tmpdir(), 'ipad-')),
    isLive: (id) => live.has(id),
    sessionLabel: (id) => `label ${id}`,
    resolveBoard: (name) => name,
    loadBoard: (name) => ({ scene: `{"from":"${name}"}`, notes: 'base notes' }),
    saveBoard: (name, scene, notes) => void boards.set(name, { scene, notes }),
    fileBoard: (name, id) => void filed.push([name, id]),
    send,
    host: '127.0.0.1',
    port: 0,
    names: () => ({ computer: 'The Mac', local: 'the-mac.local' }),
    ...over,
  });
  opened.push(ipad);
  return { ipad, live, boards, filed, sends, send };
}

/** A client that pins the fingerprint, as the iPad does. */
function call(link: PairLink, method: string, path: string, opts: { body?: unknown; raw?: Buffer; credential?: string; pin?: string } = {}) {
  return new Promise<{ status: number; body: any; text: string; type?: string }>((resolve, reject) => {
    const payload = opts.raw ?? (opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body)));
    const req = https.request(
      {
        host: link.hosts[0],
        port: link.port,
        method,
        path,
        agent: false,
        rejectUnauthorized: false,
        headers: {
          ...(opts.credential ? { Authorization: `Bearer ${opts.credential}` } : {}),
          ...(payload ? { 'Content-Length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const type = res.headers['content-type'];
          resolve({ status: res.statusCode ?? 0, body: type?.startsWith('application/json') ? JSON.parse(text || 'null') : undefined, text, type });
        });
      },
    );
    req.on('error', reject);
    req.on('socket', (s) =>
      s.once('secureConnect', () => {
        const der = (s as TLSSocket).getPeerCertificate().raw;
        const seen = createHash('sha256').update(der).digest('base64url');
        if (seen !== (opts.pin ?? link.fingerprint)) req.destroy(new Error('pin mismatch'));
      }),
    );
    req.end(payload);
  });
}

async function paired(over: Partial<IpadDeps> = {}) {
  const made = make(over);
  const status = await made.ipad.openSheet();
  const link = parsePairUrl(status.url!)!;
  const reply = await call(link, 'POST', '/v1/pair', { body: { code: link.code, deviceName: 'iPad Pro' } });
  expect(reply.status).toBe(200);
  return { ...made, link, credential: reply.body.credential as string };
}

describe('pairing over TLS', () => {
  it('pairs through the QR link, pinning the certificate', async () => {
    const { ipad, link, credential } = await paired();
    expect(link.hosts).toEqual(['127.0.0.1']);
    expect(credential).toContain('.');
    expect(ipad.status()).toMatchObject({ paired: true, devices: [{ name: 'iPad Pro' }] });
  });

  it('notices a certificate that is not the pinned one', async () => {
    const { link, credential } = await paired();
    await expect(call(link, 'GET', '/v1/handoffs', { credential, pin: 'other' })).rejects.toThrow(/pin mismatch/);
  });

  it('refuses a used code, and the sheet drops its QR after a pairing', async () => {
    const { ipad, link } = await paired();
    const again = await call(link, 'POST', '/v1/pair', { body: { code: link.code, deviceName: 'x' } });
    expect(again.status).toBe(401);
    expect(ipad.sheetStatus().url).toBeUndefined();
  });

  it('refuses requests with no credential, a wrong one or a forgotten one', async () => {
    const { ipad, link, credential } = await paired();
    expect((await call(link, 'GET', '/v1/handoffs')).status).toBe(401);
    expect((await call(link, 'GET', '/v1/handoffs', { credential: 'a.b' })).status).toBe(401);
    expect((await call(link, 'GET', '/v1/handoffs', { credential })).status).toBe(200);
    const id = ipad.status().devices[0].id;
    ipad.forget(id);
    expect((await call(link, 'GET', '/v1/handoffs', { credential })).status).toBe(401);
  });

  it('serves no socket routes', async () => {
    const { link, credential } = await paired();
    for (const path of ['/health', '/sessions', '/boards', '/v1/sessions', '/v1/boards']) {
      expect((await call(link, 'GET', path, { credential })).status).toBe(404);
    }
  });

  it('puts the .local name first and refuses to make a code with no network', async () => {
    const en0 = [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false }] as never;
    const { ipad } = make({ host: undefined, port: 0, interfaces: () => ({ en0 }) });
    const status = await ipad.openSheet();
    expect(parsePairUrl(status.url!)!.hosts).toEqual(['the-mac.local', '192.168.1.20']);
    expect(status.network).toBe('192.168.1.x');

    const { ipad: offline } = make({ host: undefined, port: 0, interfaces: () => ({}) });
    const none = await offline.openSheet();
    expect(none.url).toBeUndefined();
    expect(none.error).toBe(NO_LAN);
  });
});

describe('listener lifetime', () => {
  const listening = async (url: string | undefined) => {
    const link = parsePairUrl(url!)!;
    return call(link, 'GET', '/v1/handoffs').then(
      () => true,
      () => false,
    );
  };

  it('stops when the sheet closes with nothing paired', async () => {
    const { ipad } = make();
    const { url } = await ipad.openSheet();
    expect(await listening(url)).toBe(true);
    await ipad.closeSheet();
    expect(await listening(url)).toBe(false);
  });

  it('keeps running while an iPad is paired and stops once none remain', async () => {
    const { ipad, link, credential } = await paired();
    await ipad.closeSheet();
    expect((await call(link, 'GET', '/v1/handoffs', { credential })).status).toBe(200);
    ipad.forget(ipad.status().devices[0].id);
    await ipad.sync();
    await expect(call(link, 'GET', '/v1/handoffs', { credential })).rejects.toThrow();
  });

  it('fires the paired change on the first pairing and the last forget', async () => {
    const onPairedChange = vi.fn();
    const { ipad } = await paired({ onPairedChange });
    expect(onPairedChange.mock.calls).toEqual([[true]]);
    ipad.forget(ipad.status().devices[0].id);
    expect(onPairedChange.mock.calls).toEqual([[true], [false]]);
  });
});

describe('hand-offs', () => {
  it('needs a paired iPad', () => {
    const { ipad } = make();
    expect(() => ipad.createHandoff({ sessionId: 's1' })).toThrow(NOT_PAIRED);
  });

  it('lists open hand-offs and shows the base board read at that time', async () => {
    const { ipad, link, credential } = await paired();
    const a = ipad.createHandoff({ sessionId: 's1', prompt: 'mark this up', board: 'flow' });
    const blank = ipad.createHandoff({ sessionId: 's1' });
    expect(a).toMatchObject({ sessionLabel: 'label s1', prompt: 'mark this up', state: 'open', boardName: `ipad-${a.id}`, fromBoard: 'flow' });
    expect(a).not.toHaveProperty('baseBoard');
    expect(blank).not.toHaveProperty('fromBoard');
    const list = await call(link, 'GET', '/v1/handoffs', { credential });
    expect(list.body.handoffs.map((h: Handoff) => h.id).sort()).toEqual([a.id, blank.id].sort());
    const detail = await call(link, 'GET', `/v1/handoffs/${a.id}`, { credential });
    expect(detail.body).toEqual({ handoff: a, scene: '{"from":"flow"}', notes: 'base notes' });
    const blankDetail = await call(link, 'GET', `/v1/handoffs/${blank.id}`, { credential });
    expect(blankDetail.body.scene).toBeNull();
    expect((await call(link, 'GET', '/v1/handoffs/none', { credential })).status).toBe(404);
  });

  it('keeps hand-offs across restarts', async () => {
    const { ipad } = await paired();
    const a = ipad.createHandoff({ sessionId: 's1', board: 'flow' });
    const dataDir = (ipad as unknown as { deps: IpadDeps }).deps.dataDir;
    const { ipad: again } = make({ dataDir });
    expect(again.listHandoffs('s1')).toEqual([a]);
    expect(again.listHandoffs('s2')).toEqual([]);
    expect(again.removeHandoff(a.id)).toBe(true);
    expect(again.listHandoffs()).toEqual([]);
    expect(existsSync(join(dataDir, 'ipad', 'handoffs.json'))).toBe(true);
  });
});

describe('delivery', () => {
  it('sends to the session that asked, saves the board and files it', async () => {
    const { ipad, link, credential, sends, boards, filed } = await paired();
    const h = ipad.createHandoff({ sessionId: 's1' });
    const reply = await call(link, 'POST', `/v1/handoffs/${h.id}/deliver`, { body: delivery(), credential });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, state: 'delivered', message: 'Sent to s1' });
    const [payload, sessionId] = sends[0];
    expect(sessionId).toBe('s1');
    expect(payload).toMatchObject({ boardName: h.boardName, notes: 'a note', segments: [], utterances: delivery().utterances });
    expect(Buffer.from(payload.png).toString('base64')).toBe(PNG);
    expect(boards.get(h.boardName)?.scene).toBe(JSON.stringify(delivery().scene));
    expect(filed).toEqual([[h.boardName, 's1']]);
    expect((await call(link, 'GET', '/v1/handoffs', { credential })).body.handoffs).toEqual([]);
    expect(ipad.listHandoffs()[0].state).toBe('delivered');
  });

  it('answers a second delivery with the first result and sends nothing', async () => {
    const { ipad, link, credential, send } = await paired();
    const h = ipad.createHandoff({ sessionId: 's1' });
    const [a, b] = await Promise.all([
      call(link, 'POST', `/v1/handoffs/${h.id}/deliver`, { body: delivery(), credential }),
      call(link, 'POST', `/v1/handoffs/${h.id}/deliver`, { body: delivery(), credential }),
    ]);
    const c = await call(link, 'POST', `/v1/handoffs/${h.id}/deliver`, { body: delivery({ notes: 'changed' }), credential });
    expect([a.body, b.body, c.body]).toEqual([a.body, a.body, a.body]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends a second iPad as its own delivery, on its own board, so no work is dropped', async () => {
    const { ipad, link, credential, send, sends, boards } = await paired();
    const status = await ipad.newCode();
    const other = parsePairUrl(status.url!)!;
    const second = await call(other, 'POST', '/v1/pair', { body: { code: other.code, deviceName: 'iPad', installId: 'b' } });
    const h = ipad.createHandoff({ sessionId: 's1' });
    await call(link, 'POST', `/v1/handoffs/${h.id}/deliver`, { body: delivery({ notes: 'first' }), credential });
    const reply = await call(other, 'POST', `/v1/handoffs/${h.id}/deliver`, { body: delivery({ notes: 'second' }), credential: second.body.credential });
    expect(reply.body.state).toBe('delivered');
    expect(send).toHaveBeenCalledTimes(2);
    expect(sends.map(([p]) => p.notes)).toEqual(['first', 'second']);
    expect(sends.map(([, id]) => id)).toEqual(['s1', 's1']);
    expect(new Set(sends.map(([p]) => p.boardName)).size).toBe(2);
    expect(boards.get(h.boardName)?.notes).toBe('first');

    // Each iPad's retry still writes nothing.
    await call(other, 'POST', `/v1/handoffs/${h.id}/deliver`, { body: delivery({ notes: 'second' }), credential: second.body.credential });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('lets an iPad remove itself, leaving the others', async () => {
    const { ipad, link, credential } = await paired();
    const status = await ipad.newCode();
    const other = parsePairUrl(status.url!)!;
    const second = await call(other, 'POST', '/v1/pair', { body: { code: other.code, deviceName: 'Other' } });
    expect((await call(link, 'POST', '/v1/unpair', { credential })).body).toEqual({ ok: true });
    expect((await call(link, 'GET', '/v1/handoffs', { credential })).status).toBe(401);
    expect((await call(other, 'GET', '/v1/handoffs', { credential: second.body.credential })).status).toBe(200);
    expect(ipad.status().devices.map((d) => d.name)).toEqual(['Other']);
  });

  it('files the board under an ended session and sends to no other', async () => {
    const { ipad, live, link, credential, send, boards, filed } = await paired();
    const h = ipad.createHandoff({ sessionId: 's1' });
    live.delete('s1');
    live.add('s2');
    const reply = await call(link, 'POST', `/v1/handoffs/${h.id}/deliver`, { body: delivery(), credential });
    expect(reply.body.state).toBe('filed');
    expect(reply.body.message).toContain('label s1');
    expect(send).not.toHaveBeenCalled();
    expect(boards.has(h.boardName)).toBe(true);
    expect(filed).toEqual([[h.boardName, 's1']]);
    expect(ipad.listHandoffs()[0].state).toBe('filed');
  });

  it('answers 503 when the Send fails, keeps the board, and takes the retry', async () => {
    const send = vi.fn().mockResolvedValueOnce({ ok: false, message: 'Send failed: disk full' }).mockResolvedValueOnce({ ok: true, message: 'Sent' });
    const { ipad, link, credential, boards } = await paired({ send });
    const h = ipad.createHandoff({ sessionId: 's1' });
    const first = await call(link, 'POST', `/v1/handoffs/${h.id}/deliver`, { body: delivery(), credential });
    expect(first.status).toBe(503);
    expect(first.body).toEqual({ error: 'Send failed: disk full', code: 'unavailable' });
    expect(boards.has(h.boardName)).toBe(true);
    expect(ipad.listHandoffs()[0].state).toBe('open');
    const second = await call(link, 'POST', `/v1/handoffs/${h.id}/deliver`, { body: delivery(), credential });
    expect(second.body.state).toBe('delivered');
  });

  it.each([
    ['a bad PNG', { pngBase64: 'aGVsbG8=' }],
    ['a scene with no elements', { scene: {} }],
    ['bad strokes', { strokes: [{ t: 'x' }] }],
    ['bad utterances', { utterances: [{ t: 1 }] }],
    ['bad bounds', { bounds: { x: 1 } }],
    ['bad notes', { notes: 3 }],
  ])('refuses %s', async (_name, patch) => {
    const { ipad, link, credential, send } = await paired();
    const h = ipad.createHandoff({ sessionId: 's1' });
    const reply = await call(link, 'POST', `/v1/handoffs/${h.id}/deliver`, { body: { ...delivery(), ...patch }, credential });
    expect(reply.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a body over the limit and an unknown hand-off', async () => {
    const { ipad, link, credential } = await paired();
    const h = ipad.createHandoff({ sessionId: 's1' });
    const big = await call(link, 'POST', `/v1/handoffs/${h.id}/deliver`, { raw: Buffer.alloc(IPAD_MAX_BODY_BYTES + 1, 32), credential });
    expect(big.status).toBe(413);
    const missing = await call(link, 'POST', '/v1/handoffs/none/deliver', { body: delivery(), credential });
    expect(missing.status).toBe(404);
  });
});

describe('the board a hand-off started from', () => {
  const scene = (version: number) => JSON.stringify({ elements: [{ id: 'a', version }] });

  async function handedOff(over: Partial<IpadDeps> = {}) {
    let disk = { scene: scene(1), notes: 'base notes' };
    const updateBoard = vi.fn<NonNullable<IpadDeps['updateBoard']>>(async (_name, next, notes, unchanged) => {
      if (!unchanged()) return false;
      disk = { scene: next, notes };
      return true;
    });
    const made = await paired({ loadBoard: () => disk, updateBoard, ...over });
    const { credential, link } = made;
    const handoff = made.ipad.createHandoff({ sessionId: 's1', board: 'flow' });
    const deliver = (cred = credential) => call(link, 'POST', `/v1/handoffs/${handoff.id}/deliver`, { body: delivery(), credential: cred });
    return { ...made, handoff, deliver, updateBoard, edit: () => { disk = { ...disk, scene: scene(2) }; }, disk: () => disk };
  }

  it('updates that board and sends under its name when nothing changed on the Mac', async () => {
    const { deliver, sends, boards, filed, disk } = await handedOff();
    const reply = await deliver();
    expect(reply.body.state).toBe('delivered');
    expect(JSON.parse(disk().scene).elements).toEqual([{ id: 'a' }]);
    expect(disk().notes).toBe('a note');
    expect(sends[0][0].boardName).toBe('flow');
    expect(boards.size).toBe(0);
    expect(filed).toEqual([]);
  });

  it('keeps an edited board and makes a new one, and says so', async () => {
    const { deliver, handoff, edit, sends, boards, filed, disk } = await handedOff();
    edit();
    const reply = await deliver();
    expect(JSON.parse(disk().scene).elements).toEqual([{ id: 'a', version: 2 }]);
    expect(boards.has(handoff.boardName)).toBe(true);
    expect(sends[0][0].boardName).toBe(handoff.boardName);
    expect(filed).toEqual([[handoff.boardName, 's1']]);
    expect(reply.body.message).toContain('"flow" changed on the Mac');
  });

  it('makes a new board when the panel cannot answer', async () => {
    const { deliver, handoff, boards } = await handedOff({ updateBoard: async () => { throw new Error('panel is not ready'); } });
    expect((await deliver()).status).toBe(200);
    expect(boards.has(handoff.boardName)).toBe(true);
  });

  it('ignores how the view or file changed', () => {
    const elements = [{ id: 'a', version: 1 }, { id: 'b', version: 3, isDeleted: true }];
    const mark = boardMark({ scene: JSON.stringify({ elements, appState: { zoom: 1 } }), notes: '' });
    expect(boardMark({ scene: JSON.stringify({ elements: [elements[0]], appState: { zoom: 2 }, files: {} }), notes: '' })).toBe(mark);
    expect(boardMark({ scene: JSON.stringify({ elements: [{ id: 'a', version: 2 }] }), notes: '' })).not.toBe(mark);
    expect(boardMark({ scene: JSON.stringify({ elements }), notes: 'more' })).not.toBe(mark);
    expect(boardMark({ scene: null, notes: '' })).toBeUndefined();
  });

  it('tells the panel about a blank hand-off, and never about an updated board', async () => {
    const onNewBoard = vi.fn();
    const { deliver, ipad, credential, link } = await handedOff({ onNewBoard });
    await deliver();
    expect(onNewBoard).not.toHaveBeenCalled();
    const blank = ipad.createHandoff({ sessionId: 's1' });
    await call(link, 'POST', `/v1/handoffs/${blank.id}/deliver`, { body: delivery(), credential });
    expect(onNewBoard).toHaveBeenCalledWith(blank.boardName, 's1');
  });
});

describe('page hand-offs', () => {
  /** A project with a page, a stylesheet beside it, and a dot folder that must stay private. */
  function project() {
    const root = mkdtempSync(join(tmpdir(), 'page-project-'));
    mkdirSync(join(root, 'site'));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'site/plan.html'), '<!doctype html><html><head><title>Plan</title></head><body><h1>Plan</h1></body></html>');
    writeFileSync(join(root, 'site/plan.css'), 'h1 { color: red }');
    writeFileSync(join(root, '.git/config'), 'secret');
    writeFileSync(join(root, 'notes.txt'), 'not a page');
    return root;
  }

  const review = (over: Record<string, unknown> = {}) => ({
    review: {
      comments: [{ id: 'c1', text: 'Shorter title', createdAt: 1, anchor: { selector: 'h1', tag: 'h1', text: 'Plan', fx: 0.5, fy: 0.5, rect: { x: 0, y: 0, width: 100, height: 40 }, scrollY: 0, viewport: { width: 400, height: 800 } } }],
      body: 'Overall fine',
    },
    notes: 'from the note tab',
    utterances: [],
    ...over,
  });

  it('opens an HTML file of the session project, named relative to it', async () => {
    const root = project();
    const { ipad } = await paired({ sessionRoot: () => root });
    const h = ipad.createHandoff({ sessionId: 's1', page: join(root, 'site/plan.html'), prompt: 'Review the plan' });
    expect(h).toMatchObject({ page: 'site/plan.html', prompt: 'Review the plan' });
    expect(h).not.toHaveProperty('pageRoot');
    expect(ipad.createHandoff({ sessionId: 's1', page: './site/plan.html' }).page).toBe('site/plan.html');
  });

  it('takes an absolute path through a symlink to the project, as macOS /tmp is', async () => {
    const root = project();
    const link = join(mkdtempSync(join(tmpdir(), 'page-link-')), 'proj');
    symlinkSync(root, link);
    const { ipad } = await paired({ sessionRoot: () => link });
    expect(ipad.createHandoff({ sessionId: 's1', page: join(root, 'site/plan.html') }).page).toBe('site/plan.html');
  });

  it('refuses a page that is not HTML, is missing, leaves the project, or comes with a board', async () => {
    const root = project();
    const { ipad } = await paired({ sessionRoot: () => root });
    expect(() => ipad.createHandoff({ sessionId: 's1', page: 'notes.txt' })).toThrow(/html/);
    expect(() => ipad.createHandoff({ sessionId: 's1', page: 'site/gone.html' })).toThrow(/no page/);
    expect(() => ipad.createHandoff({ sessionId: 's1', page: '../other/x.html' })).toThrow(/no page/);
    expect(() => ipad.createHandoff({ sessionId: 's1', page: 'site/plan.html', board: 'b' })).toThrow(/not both/);
    const { ipad: rootless } = await paired();
    expect(() => rootless.createHandoff({ sessionId: 's1', page: 'site/plan.html' })).toThrow(/project folder/);
  });

  it('serves the page with the review overlay, its files as they are, and nothing outside', async () => {
    const root = project();
    const { ipad, link, credential } = await paired({ sessionRoot: () => root });
    const h = ipad.createHandoff({ sessionId: 's1', page: 'site/plan.html' });
    const page = await call(link, 'GET', `/v1/handoffs/${h.id}/page/site/plan.html`, { credential });
    expect(page.status).toBe(200);
    expect(page.type).toContain('text/html');
    expect(page.text).toContain('<head><script src="/__agent-brief__/overlay.js"></script><title>Plan</title>');
    const css = await call(link, 'GET', `/v1/handoffs/${h.id}/page/site/plan.css`, { credential });
    expect([css.status, css.text]).toEqual([200, 'h1 { color: red }']);
    for (const path of ['.git/config', 'site/../.git/config', 'site/%2e%2e/.git/config', 'site/gone.css']) {
      expect((await call(link, 'GET', `/v1/handoffs/${h.id}/page/${path}`, { credential })).status).toBe(404);
    }
    expect((await call(link, 'GET', `/v1/handoffs/${h.id}/page/site/plan.html`)).status).toBe(401);
    const board = ipad.createHandoff({ sessionId: 's1' });
    expect((await call(link, 'GET', `/v1/handoffs/${board.id}/page/site/plan.html`, { credential })).status).toBe(404);
  });

  it('sends the review to the session as a review of the page', async () => {
    const root = project();
    const { ipad, link, credential, sends } = await paired({ sessionRoot: () => root });
    const h = ipad.createHandoff({ sessionId: 's1', page: 'site/plan.html' });
    const reply = await call(link, 'POST', `/v1/handoffs/${h.id}/deliver`, { credential, body: review() });
    expect(reply.body).toMatchObject({ ok: true, state: 'delivered' });
    const [payload, to] = sends[0]! as unknown as [{ text: string; review: { path: string; comments: { text: string; anchor: { selector: string } }[]; body: string }; fileSessionId: string }, string];
    expect(to).toBe('s1');
    expect(payload).not.toHaveProperty('png');
    expect(payload.text).toBe('Overall fine\n\nfrom the note tab');
    expect(payload.review).toMatchObject({ path: 'site/plan.html', body: payload.text, comments: [{ text: 'Shorter title', anchor: { selector: 'h1' } }] });
    expect(payload.fileSessionId).toBe('s1');
  });

  it('refuses an empty review, and keeps a review as a note once the session has ended', async () => {
    const root = project();
    const filed: [string, unknown][] = [];
    const { ipad, link, credential, live, sends } = await paired({ sessionRoot: () => root, fileReview: (id, p) => void filed.push([id, p]) });
    const h = ipad.createHandoff({ sessionId: 's1', page: 'site/plan.html' });
    const empty = await call(link, 'POST', `/v1/handoffs/${h.id}/deliver`, { credential, body: review({ review: { comments: [] }, notes: '' }) });
    expect(empty.status).toBe(400);
    live.delete('s1');
    const reply = await call(link, 'POST', `/v1/handoffs/${h.id}/deliver`, { credential, body: review() });
    expect(reply.body).toMatchObject({ state: 'filed' });
    expect(reply.body.message).toContain('waits on the Mac as a note');
    expect(sends).toHaveLength(0);
    expect(filed[0]).toMatchObject(['s1', { review: { path: 'site/plan.html' } }]);
  });
});
