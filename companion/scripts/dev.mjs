// Runs the Vite dev server, rebuilds main and preload on change, and restarts Electron.
import { spawn } from 'node:child_process';
import electron from 'electron';
import { createServer } from 'vite';
import { buildDictate, watchMain } from './build.mjs';

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0];

let child;
function restart() {
  if (child) {
    child.removeAllListeners('exit');
    child.kill();
  }
  child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, COMPANION_DEV_URL: url } });
  child.on('exit', () => process.exit(0));
}

buildDictate();
await watchMain(restart);
