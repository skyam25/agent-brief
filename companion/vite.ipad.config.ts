import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { build as esbuild } from 'esbuild';
import { defineConfig, type Plugin } from 'vite';
import { excalidrawFonts } from './scripts/excalidraw-assets.ts';

const outDir = resolve(import.meta.dirname, 'ios/AgentBrief/Web');

/** Builds the review overlay beside the board, for pages the device reviews. The app serves it to each page. */
const reviewOverlay = (): Plugin => ({
  name: 'review-overlay',
  apply: 'build',
  async closeBundle() {
    await esbuild({ entryPoints: [resolve(import.meta.dirname, 'src/review/overlay.ts')], bundle: true, format: 'iife', target: 'safari17', outfile: resolve(outDir, 'overlay.js'), logLevel: 'warning' });
  },
});

/** The board inside the iPad app's web view. The app bundles this folder. */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/ipad-client'),
  base: './',
  plugins: [react(), excalidrawFonts(outDir), reviewOverlay()],
  build: {
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
});
