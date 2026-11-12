// A stand-in for the Mac's LAN API, for testing the iPad app. Never used in the product.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

/** A PNG of one colour, so a test can tell a drawn picture from Excalidraw's grey placeholder. */
function solidPng(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** The project a page hand-off reviews: one page and the stylesheet beside it. */
const PAGE_FILES = {
  'site/plan.html': {
    type: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><script src="/__agent-brief__/overlay.js"></script><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plan</title><link rel="stylesheet" href="plan.css"></head><body><h1>Keep the cart when a card fails</h1><p>Today a declined card empties the payment form.</p></body></html>',
  },
  'site/plan.css': { type: 'text/css', body: 'body { font: 18px -apple-system, sans-serif; margin: 24px; } h1 { color: rgb(47, 91, 211); }' },
};

/**
 * A Stack board as the Mac saves it after Claude adds screenshots while it is hidden: two pictures
 * in one group, not yet laid out, so the layout runs when the iPad opens it.
 */
function unlaidStackScene() {
  const el = { angle: 0, strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
  const dataURL = solidPng(400, 300, [59, 130, 246]);
  const image = (id, x) => ({ ...el, id, type: 'image', x, y: 30, width: 400, height: 300, fileId: `f-${id}`, status: 'saved', scale: [1, 1], frameId: 'g1' });
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements: [{ ...el, id: 'g1', type: 'frame', x: 0, y: 0, width: 880, height: 360, name: '1', frameId: null, customData: { stack: { index: 1 } } }, image('a', 20), image('b', 460)],
    appState: { viewBackgroundColor: '#ffffff' },
    files: Object.fromEntries(['a', 'b'].map((id) => [`f-${id}`, { id: `f-${id}`, mimeType: 'image/png', dataURL, created: 1 }])),
    agentBrief: { layout: 'stack' },
  });
}

export function startStub({ dir, port = 0, host = '127.0.0.1', macName = 'Stub Mac', promptPrefix = '', extra = [], stack = false, link = false, page = false, peer = false }) {
  mkdirSync(dir, { recursive: true });
  const keyFile = join(dir, 'key.pem');
  const certFile = join(dir, 'cert.pem');
  if (!existsSync(certFile)) {
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-days', '30', '-subj', '/CN=Agent Brief Stub', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  }
  const cert = readFileSync(certFile);
  const fingerprint = createHash('sha256').update(new X509Certificate(cert).raw).digest('base64url');
  const code = 'stub-code';
  const credential = 'device1.secret1';
  const baseScene = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements: [{ id: 'base1', type: 'rectangle', x: 100, y: 100, width: 300, height: 160, angle: 0, strokeColor: '#1971c2', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  });
  const now = Date.now();
  const handoffs = new Map([
    ['h1', { id: 'h1', sessionId: 's1', sessionLabel: 'agent-brief: iPad build', prompt: `${promptPrefix}${promptPrefix ? 'mark' : 'Mark'} up the sign-up flow`, boardName: 'ipad-h1', fromBoard: 'signup', createdAt: now - 120_000, state: 'open' }],
    ['h2', { id: 'h2', sessionId: 's2', sessionLabel: 'other session', prompt: `${promptPrefix}Blank board, no base scene`, boardName: 'blank', createdAt: now - 60_000, state: 'open' }],
    ...(page ? [['hp', { id: 'hp', sessionId: 's1', sessionLabel: 'agent-brief: iPad build', page: 'site/plan.html', boardName: 'ipad-hp', createdAt: now - 10_000, state: 'open' }]] : []),
    ...(link ? [['hl', { id: 'hl', sessionId: 's1', sessionLabel: 'agent-brief: iPad build', prompt: 'https://claude.ai/artifact/abc123XYZ?sk=not-for-show review this\nand the strategy information. The audience is the board, and also the wider R&D org, so keep it short.', boardName: 'ipad-hl', createdAt: now - 20_000, state: 'open' }]] : []),
    ...(stack ? [['hs', { id: 'hs', sessionId: 's1', sessionLabel: 'agent-brief: iPad build', boardName: 'ipad-hs', fromBoard: 'checkout-shots', createdAt: now - 30_000, state: 'open' }]] : []),
    ...extra.map((h, i) => [h.id, { sessionId: `x${i}`, boardName: h.id, createdAt: now - 180_000 - i * 3_600_000, state: 'open', ...h }]),
  ]);
  const delivered = new Map();
  const received = [];

  const reply = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };

  const server = https.createServer({ key: readFileSync(keyFile), cert }, (req, res) => {
    if (existsSync(join(dir, 'offline'))) {
      req.socket.destroy();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const path = new URL(req.url, 'https://stub').pathname;
      if (req.method === 'POST' && path === '/v1/pair') {
        const { code: sent, deviceName, installId } = JSON.parse(body);
        if (sent !== code) return reply(res, 400, { error: 'This pairing code is used or expired.', code: 'bad_request' });
        received.push({ kind: 'pair', deviceName, installId });
        return reply(res, 200, { credential, macName });
      }
      if (req.headers.authorization !== `Bearer ${credential}` || existsSync(join(dir, 'revoked'))) return reply(res, 401, { error: 'unauthorized', code: 'bad_request' });
      if (req.method === 'POST' && path === '/v1/unpair') {
        received.push({ kind: 'unpair' });
        return reply(res, 200, { ok: true });
      }
      if (req.method === 'GET' && path === '/v1/handoffs') {
        if (existsSync(join(dir, 'empty'))) return reply(res, 200, { handoffs: [] });
        const open = [...handoffs.values()].filter((h) => h.state === 'open' && !existsSync(join(dir, `closed-${h.id}`)));
        return reply(res, 200, { handoffs: open.sort((a, b) => b.createdAt - a.createdAt) });
      }
      const detail = /^\/v1\/handoffs\/([^/]+)$/.exec(path);
      if (req.method === 'DELETE' && detail) {
        // An Agent Brief from before this route answers as for any route it lacks.
        if (existsSync(join(dir, 'old-mac'))) return reply(res, 404, { error: 'no such route', code: 'not_found' });
        received.push({ kind: 'remove', id: detail[1] });
        return reply(res, 200, { removed: handoffs.delete(detail[1]) });
      }
      if (req.method === 'GET' && detail) {
        const h = handoffs.get(detail[1]);
        if (!h) return reply(res, 404, { error: 'no such hand-off', code: 'not_found' });
        return reply(res, 200, { handoff: h, scene: h.id === 'h1' ? baseScene : h.id === 'hs' ? unlaidStackScene() : null, notes: '' });
      }
      // A page hand-off's files, as the Mac serves them: HTML with the overlay as its first script.
      const pageFile = /^\/v1\/handoffs\/hp\/page\/(.+)$/.exec(path);
      if (req.method === 'GET' && pageFile && page) {
        const file = PAGE_FILES[decodeURIComponent(pageFile[1])];
        if (!file) return reply(res, 404, { error: 'no such file', code: 'not_found' });
        res.writeHead(200, { 'Content-Type': file.type });
        return res.end(file.body);
      }
      const deliver = /^\/v1\/handoffs\/([^/]+)\/deliver$/.exec(path);
      if (req.method === 'POST' && deliver) {
        const h = handoffs.get(deliver[1]);
        if (!h) return reply(res, 404, { error: 'no such hand-off', code: 'not_found' });
        if (delivered.has(h.id)) return reply(res, 200, delivered.get(h.id));
        if (existsSync(join(dir, 'refuse'))) return reply(res, 400, { error: 'This session has ended on the Mac.', code: 'bad_request' });
        const payload = JSON.parse(body);
        writeFileSync(join(dir, `delivery-${h.id}.json`), body);
        received.push({ kind: 'deliver', id: h.id, payload });
        h.state = 'delivered';
        const result = { ok: true, state: 'delivered', message: `Sent to ${h.sessionLabel}` };
        delivered.set(h.id, result);
        if (existsSync(join(dir, 'slow'))) return void setTimeout(() => reply(res, 200, result), 6_000);
        return reply(res, 200, result);
      }
      reply(res, 404, { error: 'no route', code: 'not_found' });
    });
  });

  // With `peer`, the stub stands in for the Mac's peer-to-peer service. It listens on every address, since Bonjour
  // resolves to the Mac's own addresses, and registers under the name the app derives from the fingerprint.
  // An `unadvertised` file in `dir` withdraws the service until the file goes.
  // The pairing link's hosts never answer. One fails at once and one would hang, so the test also times the fallback.
  return new Promise((resolve) => {
    server.listen(port, peer ? '::' : host, () => {
      const actual = server.address().port;
      let hosts = host;
      if (peer) {
        const name = `ab-${fingerprint.slice(0, 16)}`;
        let advert = null;
        const sync = () => {
          const wanted = !existsSync(join(dir, 'unadvertised'));
          if (wanted && !advert) {
            // AB_PEER_HELPER names the Mac's real helper, which then advertises and forwards in place of dns-sd.
            const helper = process.env.AB_PEER_HELPER;
            advert = helper
              ? spawn(helper, ['--name', name, '--port', String(actual)], { stdio: ['pipe', 'ignore', 'ignore'] })
              : spawn('dns-sd', ['-R', name, '_agentbrief._tcp', 'local.', String(actual)], { stdio: 'ignore' });
          }
          if (!wanted && advert) {
            advert.kill();
            advert = null;
          }
        };
        sync();
        const watch = setInterval(sync, 250);
        const stop = () => {
          clearInterval(watch);
          advert?.kill();
        };
        server.on('close', stop);
        process.on('exit', stop);
        hosts = 'stub-gone.invalid,192.0.2.1';
      }
      const q = new URLSearchParams({ h: hosts, p: String(actual), c: code, f: fingerprint, m: 'Stub Mac' });
      resolve({ server, port: actual, fingerprint, received, pairUrl: `agentbrief://pair?${q}` });
    });
  });
}
