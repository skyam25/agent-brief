import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { excalidrawFonts } from './scripts/excalidraw-assets.ts';

const outDir = resolve(import.meta.dirname, 'ios/AgentBrief/Web');

/** The board inside the iPad app's web view. The app bundles this folder. */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/ipad-client'),
  base: './',
  plugins: [react(), excalidrawFonts(outDir)],
  build: {
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
});
