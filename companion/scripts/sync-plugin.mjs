/** Keep standalone plugin contracts reproducible from the app's canonical sources. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const pluginContracts = [
  ['companion/src/protocol.ts', 'mod/agent-brief/hooks/companion-protocol.ts'],
  ['companion/src/shared/items.ts', 'mod/agent-brief/hooks/generated/items.ts'],
  ['companion/src/shared/output-file.ts', 'mod/agent-brief/hooks/generated/output-file.ts'],
];

export function generatedContract(source) {
  const text = readFileSync(resolve(root, source), 'utf8').replace("from '../protocol'", "from '../companion-protocol'");
  return `// Generated from ${source}. Run pnpm sync:plugin in companion; do not edit.\n${text}`;
}

export function syncPlugin({ check = false } = {}) {
  const stale = [];
  for (const [source, target] of pluginContracts) {
    const expected = generatedContract(source);
    const file = resolve(root, target);
    let current;
    try { current = readFileSync(file, 'utf8'); } catch { /* A missing generated file is stale. */ }
    if (current === expected) continue;
    if (check) stale.push(target);
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, expected);
    }
  }
  if (stale.length) throw new Error(`Plugin contracts are stale: ${stale.join(', ')}. Run pnpm sync:plugin in companion.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncPlugin({ check: process.argv.includes('--check') });
}
