// Builds the notarized zip and publishes it as a GitHub release.
// Installed copies read latest-mac.yml from the newest release to update.
//
//   pnpm release [--notes-file notes.md]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { ensureElectron } from './electron.mjs';

const argv = process.argv.slice(2);
if (argv.length && !(argv.length === 2 && argv[0] === '--notes-file')) {
  console.log('Usage: pnpm release [--notes-file notes.md]');
  process.exit(argv.includes('--help') ? 0 : 1);
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = `v${version}`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

const dirty = out('git', ['status', '--porcelain']);
if (dirty) throw new Error(`Commit or remove these first. The release builds what HEAD holds.\n${dirty}`);
const head = out('git', ['rev-parse', 'HEAD']);
run('git', ['fetch', 'origin', 'main']);
if (out('git', ['rev-parse', 'origin/main']) !== head) throw new Error('Push main first, so the tag matches the build.');
try {
  out('gh', ['release', 'view', tag]);
  throw new Error(`${tag} is already released. Bump the version in package.json.`);
} catch (err) {
  if (err.message.includes('already released')) throw err;
}

// A plugin change ships inside the app, so it needs its own version bump.
run('git', ['fetch', '--tags', '--quiet', 'origin']);
// The first release has no earlier tag to compare against.
const hasTag = out('git', ['tag', '--list', 'v*', '--merged', 'HEAD']) !== '';
const last = hasTag ? out('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*']) : undefined;
const pluginJson = '../mod/agent-brief/.claude-plugin/plugin.json';
const pluginChanged = last && out('git', ['diff', '--name-only', last, 'HEAD', '--', '../mod/agent-brief', ':(exclude)../mod/agent-brief/tests']);
const pluginVersion = rev => JSON.parse(out('git', ['show', `${rev}:mod/agent-brief/.claude-plugin/plugin.json`])).version;
if (pluginChanged && pluginVersion(last) === pluginVersion('HEAD')) {
  throw new Error(`mod/agent-brief changed since ${last}. Bump version in ${pluginJson}.`);
}

ensureElectron();

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

const notes = argv.length ? argv : ['--generate-notes'];
run('gh', ['release', 'create', tag, ...assets, '--target', head, '--title', `Agent Brief ${version}`, ...notes]);

const uploaded = out('gh', ['release', 'view', tag, '--json', 'assets', '--jq', '.assets[].name']).split('\n');
const missing = assets.map(a => a.split('/').pop()).filter(name => !uploaded.includes(name));
if (missing.length) throw new Error(`${tag} is missing ${missing.join(', ')}. Installed copies won't see it.`);
console.log(`Released ${tag} with ${uploaded.join(', ')}.`);
