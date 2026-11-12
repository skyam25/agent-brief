// Builds main and preload with esbuild, the renderer with Vite, the companion CLI and the Swift helpers.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { build as esbuild, context } from 'esbuild';
import { build as viteBuild } from 'vite';
import { syncPlugin } from './sync-plugin.mjs';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'warning',
};

export const mainOptions = {
  ...shared,
  entryPoints: { 'main/index': 'src/main/index.ts', 'preload/index': 'src/preload/index.ts' },
  outdir: 'out',
  outExtension: { '.js': '.cjs' },
};

/** The script the review pane adds to each HTML page it shows. */
export const overlayOptions = {
  entryPoints: { 'review/overlay': 'src/review/overlay.ts' },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  outdir: 'out',
  logLevel: 'warning',
};

export async function buildMain() {
  syncPlugin();
  await Promise.all([esbuild(mainOptions), esbuild(overlayOptions)]);
}

export async function watchMain(onRebuild) {
  syncPlugin();
  const notify = [{ name: 'notify', setup: (b) => b.onEnd((r) => r.errors.length === 0 && onRebuild()) }];
  const contexts = await Promise.all([context({ ...mainOptions, plugins: notify }), context({ ...overlayOptions, plugins: notify })]);
  await Promise.all(contexts.map((c) => c.watch()));
  return contexts[0];
}

const DICTATE_SRC = 'native/dictate.swift';
const DICTATE_BIN = 'bin/agent-brief-dictate';
const PEER_SRC = 'native/peer.swift';
const PEER_BIN = 'bin/agent-brief-peer';

/** Compiles a Swift helper when its source is newer. Without swiftc it warns and skips. */
function buildSwift(src, bin) {
  if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) return;
  try {
    execFileSync('swiftc', ['-O', '-target', 'arm64-apple-macos26.0', src, '-o', bin], { stdio: 'inherit' });
  } catch (err) {
    console.warn(`skipped ${bin}: ${err.message}`);
  }
}

/** Compiles the Swift dictation helper. Without it, voice falls back to clips. */
export function buildDictate() {
  buildSwift(DICTATE_SRC, DICTATE_BIN);
}

/** Compiles the peer-to-peer Wi-Fi helper. Without it, the phone reaches the Mac only on a shared subnet. */
export function buildPeer() {
  buildSwift(PEER_SRC, PEER_BIN);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Packaging ships all of out/, so start empty.
  rmSync('out', { recursive: true, force: true });
  await buildMain();
  await viteBuild({ configFile: 'vite.config.ts', logLevel: 'warn' });
  await esbuild({
    entryPoints: ['cli/run.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    outfile: 'bin/agent-brief.mjs',
    logLevel: 'warning',
  });
  buildDictate();
  buildPeer();
  const helpers = [DICTATE_BIN, PEER_BIN].filter((bin) => existsSync(bin));
  console.log(`built out/, bin/agent-brief.mjs${helpers.length ? `, ${helpers.join(', ')}` : ''}`);
}
