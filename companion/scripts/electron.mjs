// Makes sure Electron's binary runs. A fresh worktree can skip the download or
// leave a truncated framework, which electron's own install check misses.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const binary = () => execFileSync('node', ['-p', "require('electron')"], { encoding: 'utf8' }).trim();

function runs() {
  try {
    execFileSync(binary(), ['--version'], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    return true;
  } catch {
    return false;
  }
}

export function ensureElectron() {
  if (runs()) return;
  console.log('Electron binary is missing or broken. Reinstalling it.');
  rmSync('node_modules/electron/dist', { recursive: true, force: true });
  execFileSync('node', ['node_modules/electron/install.js'], { stdio: 'inherit' });
  if (!runs()) throw new Error('Electron still fails to run after a reinstall.');
}
