import { copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { excalidrawFonts } from './scripts/excalidraw-assets.ts';

const outDir = resolve(import.meta.dirname, 'out/web');

/** The app icon doubles as the iPad home-screen icon. */
function homeScreenIcon(): Plugin {
  return {
    name: 'home-screen-icon',
    closeBundle() {
      copyFileSync(resolve(import.meta.dirname, 'build/icons/icon-1024.png'), join(outDir, 'icon-1024.png'));
    },
  };
}

/** The iPad client, served by the Mac's LAN web server. */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/web-client'),
  base: '/',
  plugins: [react(), excalidrawFonts(outDir), homeScreenIcon()],
  build: {
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
});
