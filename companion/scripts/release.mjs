// Builds the notarized zip and publishes it as a GitHub release.
// Installed copies read latest-mac.yml from the newest release to update.
//
//   pnpm release [--notes-file notes.md]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = `v${version}`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

if (out('git', ['status', '--porcelain'])) throw new Error('Commit or stash changes first.');
const head = out('git', ['rev-parse', 'HEAD']);
run('git', ['fetch', 'origin', 'main']);
if (out('git', ['rev-parse', 'origin/main']) !== head) throw new Error('Push main first, so the tag matches the build.');
try {
  out('gh', ['release', 'view', tag]);
  throw new Error(`${tag} is already released. Bump the version in package.json.`);
} catch (err) {
  if (err.message.includes('already released')) throw err;
}

run('pnpm', ['build']);
run('pnpm', ['exec', 'electron-builder', '--mac', '--publish', 'never'], {
  env: { ...process.env, APPLE_KEYCHAIN_PROFILE: 'companion-notary' },
});

const zip = `dist/Agent-Brief-${version}-arm64.zip`;
const assets = [zip, `${zip}.blockmap`, 'dist/latest-mac.yml'];
const plugin = 'dist/mac-arm64/Agent Brief.app/Contents/Resources/plugin';
for (const file of [...assets, `${plugin}/.claude-plugin/marketplace.json`, `${plugin}/mod/agent-brief/hooks/hooks.json`]) {
  if (!existsSync(file)) throw new Error(`missing ${file}`);
}
run('codesign', ['--verify', '--deep', '--strict', 'dist/mac-arm64/Agent Brief.app']);
run('xcrun', ['stapler', 'validate', 'dist/mac-arm64/Agent Brief.app']);

const notesIndex = process.argv.indexOf('--notes-file');
const notes = notesIndex > 0 ? ['--notes-file', process.argv[notesIndex + 1]] : ['--generate-notes'];
run('gh', ['release', 'create', tag, ...assets, '--target', head, '--title', `Agent Brief ${version}`, ...notes]);
