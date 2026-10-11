// Builds main and preload with esbuild, the renderer with Vite, and the companion CLI.
import { rmSync } from 'node:fs';
import { build as esbuild, context } from 'esbuild';
import { build as viteBuild } from 'vite';

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

export async function buildMain() {
  await esbuild(mainOptions);
}

export async function watchMain(onRebuild) {
  const ctx = await context({
    ...mainOptions,
    plugins: [{ name: 'notify', setup: (b) => b.onEnd((r) => r.errors.length === 0 && onRebuild()) }],
  });
  await ctx.watch();
  return ctx;
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
