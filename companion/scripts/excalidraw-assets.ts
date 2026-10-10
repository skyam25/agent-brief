import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type { Plugin } from 'vite';

const fontsDir = resolve(import.meta.dirname, '../node_modules/@excalidraw/excalidraw/dist/prod/fonts');

/** Serves Excalidraw's fonts at /fonts in dev and copies them next to the build, so nothing loads from a CDN. */
export function excalidrawFonts(outDir: string): Plugin {
  return {
    name: 'excalidraw-fonts',
    configureServer(server) {
      server.middlewares.use('/fonts', (req, res, next) => {
        const file = normalize(join(fontsDir, decodeURIComponent((req.url ?? '').split('?')[0])));
        if (!file.startsWith(fontsDir) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', 'font/woff2');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      cpSync(fontsDir, join(outDir, 'fonts'), { recursive: true });
    },
  };
}
