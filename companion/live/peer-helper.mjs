#!/usr/bin/env node
/**
 * Checks the built peer-to-peer helper against a local TCP server, with no app and no phone.
 *
 *   cd companion && pnpm build && node live/peer-helper.mjs [--mb <megabytes>]
 *
 * It runs `bin/agent-brief-peer`, waits for `ready`, finds the service with `dns-sd`, and sends 4 MB
 * (or `--mb`) each way at once through the helper's port on localhost. Each side half-closes after its
 * payload, and the other keeps sending. Further connections check a few request and reply turns on one
 * connection, and a large reply that the server sends and closes after the client has half-closed.
 * Last, it closes the helper's stdin and expects a clean exit. It exits 1 on any failure.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = join(ROOT, 'bin/agent-brief-peer');
const TYPE = '_agentbrief._tcp';
const NAME = `peer-check-${process.pid}`;
const mbAt = process.argv.indexOf('--mb');
const PAYLOAD_BYTES = Number(mbAt >= 0 ? process.argv[mbAt + 1] : 4) * 1024 * 1024;
const TURNS = 5;
const STEP_MS = 30_000;

const children = new Set();
let helper;

function step(message) {
  console.log(`- ${message}`);
}

function fail(message) {
  console.error(`FAIL ${message}`);
  for (const child of children) child.kill('SIGKILL');
  process.exit(1);
}

function within(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), STEP_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

/** Runs a long-lived command and resolves with the first stdout line `match` accepts. */
function firstLine(command, args, match) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    children.add(child);
    const done = (fn, value) => {
      child.kill();
      children.delete(child);
      fn(value);
    };
    createInterface({ input: child.stdout }).on('line', (line) => {
      const found = match(line);
      if (found !== undefined) done(resolve, found);
    });
    child.on('error', (err) => done(reject, err));
    child.on('exit', (code) => reject(new Error(`${command} exited ${code}`)));
  });
}

/** The far end of the helper. Each connection is either a bulk test or a turn test, by its first byte. */
function startServer() {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.once('readable', () => {
      const head = socket.read(1);
      if (!head) return;
      if (head[0] === 0x42) bulkServer(socket);
      else if (head[0] === 0x52) replyServer(socket);
      else turnServer(socket);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const serverPayload = randomBytes(PAYLOAD_BYTES);
let serverReceived;

/** Sends its own payload at once, reads the client's to the end, then ends its side. */
function bulkServer(socket) {
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  let wrote = false;
  let readAll = false;
  const maybeEnd = () => wrote && readAll && socket.end();
  socket.write(serverPayload, () => {
    wrote = true;
    maybeEnd();
  });
  socket.on('end', () => {
    serverReceived = Buffer.concat(chunks);
    readAll = true;
    maybeEnd();
  });
}

/** Waits for the client's end, then sends its payload and closes, as a `Connection: close` reply does. */
function replyServer(socket) {
  socket.resume();
  socket.on('end', () => socket.end(serverPayload));
}

/** Answers each newline-ended request with its length and hash. */
function turnServer(socket) {
  createInterface({ input: socket }).on('line', (line) => socket.write(`${line.length} ${digest(Buffer.from(line))}\n`));
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true }, () => resolve(socket));
    socket.once('error', reject);
  });
}

async function bulk(port) {
  const socket = await connect(port);
  const clientPayload = randomBytes(PAYLOAD_BYTES);
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  const ended = new Promise((resolve, reject) => {
    socket.on('end', resolve);
    socket.on('error', reject);
  });
  socket.write(Buffer.from([0x42]));
  socket.end(clientPayload);
  await within(ended, 'the bulk reply to end');
  const clientReceived = Buffer.concat(chunks);
  socket.destroy();
  if (!serverReceived?.equals(clientPayload)) {
    fail(`server got ${serverReceived?.length ?? 0} bytes (${digest(serverReceived ?? Buffer.alloc(0))}), expected ${PAYLOAD_BYTES} (${digest(clientPayload)})`);
  }
  if (!clientReceived.equals(serverPayload)) {
    fail(`client got ${clientReceived.length} bytes (${digest(clientReceived)}), expected ${PAYLOAD_BYTES} (${digest(serverPayload)})`);
  }
  step(`bulk: ${PAYLOAD_BYTES} bytes each way intact (${digest(clientPayload)} up, ${digest(serverPayload)} down)`);
}

async function reply(port) {
  const socket = await connect(port);
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  const ended = new Promise((resolve, reject) => {
    socket.on('end', resolve);
    socket.on('error', reject);
  });
  socket.end(Buffer.concat([Buffer.from([0x52]), Buffer.from('GET / HTTP/1.0\r\n\r\n')]));
  await within(ended, 'the reply to end');
  socket.destroy();
  const received = Buffer.concat(chunks);
  if (!received.equals(serverPayload)) {
    fail(`reply: got ${received.length} bytes (${digest(received)}), expected ${PAYLOAD_BYTES} (${digest(serverPayload)})`);
  }
  step(`reply: ${PAYLOAD_BYTES} bytes intact after the client half-closed`);
}

async function turns(port) {
  const socket = await connect(port);
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  socket.write(Buffer.from([0x54]));
  for (let i = 1; i <= TURNS; i++) {
    const request = randomBytes(1000 * i).toString('hex');
    socket.write(`${request}\n`);
    const { value } = await within(lines.next(), `reply ${i}`);
    const expected = `${request.length} ${digest(Buffer.from(request))}`;
    if (value !== expected) fail(`turn ${i}: got "${value}", expected "${expected}"`);
  }
  socket.destroy();
  step(`turns: ${TURNS} request and reply turns on one connection`);
}

if (!existsSync(HELPER)) fail(`${HELPER} is missing. Run pnpm build first.`);

const server = await startServer();
const targetPort = server.address().port;
step(`server on 127.0.0.1:${targetPort}`);

helper = spawn(HELPER, ['--name', NAME, '--port', String(targetPort)], { stdio: ['pipe', 'pipe', 'inherit'] });
children.add(helper);
const helperExit = new Promise((resolve) => helper.on('exit', (code, signal) => resolve({ code, signal })));
const helperLines = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();

try {
  const { value: first } = await within(helperLines.next(), 'the helper to start');
  if (first !== 'ready') fail(`helper said "${first}"`);
  step('helper: ready');

  // dns-sd -B prints rows ending in the instance name. dns-sd -L prints "can be reached at <host>:<port>".

  await within(
    firstLine('dns-sd', ['-B', TYPE, 'local.'], (line) => (line.includes(' Add ') && line.trimEnd().endsWith(NAME) ? true : undefined)),
    `dns-sd to browse ${NAME}`,
  );
  step(`browse: found ${NAME}.${TYPE}`);

  const reached = await within(
    firstLine('dns-sd', ['-L', NAME, TYPE, 'local.'], (line) => line.match(/can be reached at (\S+):(\d+)/)?.slice(1)),
    `dns-sd to resolve ${NAME}`,
  );
  const helperPort = Number(reached[1]);
  step(`resolve: ${reached[0]} port ${helperPort}`);

  await bulk(helperPort);
  await turns(helperPort);
  await reply(helperPort);

  helper.stdin.end();
  const { code, signal } = await within(helperExit, 'the helper to exit after stdin closed');
  if (code !== 0) fail(`helper exited with code ${code} signal ${signal} after stdin closed`);
  step('stdin closed: helper exited 0');
} catch (err) {
  fail(err.message);
}

server.close();
console.log('PASS');
