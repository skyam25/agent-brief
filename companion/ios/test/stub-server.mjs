// A stand-in for the Mac's LAN API, for testing the iPad app. Never used in the product.
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';

export function startStub({ dir, port = 0, host = '127.0.0.1', macName = 'Stub Mac', promptPrefix = '', extra = [] }) {
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
    ['h1', { id: 'h1', sessionId: 's1', sessionLabel: 'agent-brief: iPad build', prompt: `${promptPrefix}${promptPrefix ? 'mark' : 'Mark'} up the sign-up flow`, boardName: 'signup', createdAt: now - 120_000, state: 'open' }],
    ['h2', { id: 'h2', sessionId: 's2', sessionLabel: 'other session', prompt: `${promptPrefix}Blank board, no base scene`, boardName: 'blank', createdAt: now - 60_000, state: 'open' }],
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
      if (req.method === 'GET' && detail) {
        const h = handoffs.get(detail[1]);
        if (!h) return reply(res, 404, { error: 'no such hand-off', code: 'not_found' });
        return reply(res, 200, { handoff: h, scene: h.id === 'h1' ? baseScene : null, notes: '' });
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

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      const q = new URLSearchParams({ h: host, p: String(actual), c: code, f: fingerprint, m: 'Stub Mac' });
      resolve({ server, port: actual, fingerprint, received, pairUrl: `agentbrief://pair?${q}` });
    });
  });
}
