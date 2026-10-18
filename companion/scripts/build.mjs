// Builds main and preload with esbuild, the renderer with Vite, and the companion CLI.
import { rmSync } from 'node:fs';
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
  console.log('built out/ and bin/agent-brief.mjs');
}
