import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseItems, withDecisions } from '../src/shared/items';
import { parseOutputsFile } from '../src/shared/output-file';
import { parseItems as pluginItems, withDecisions as pluginDecisions } from '../../mod/agent-brief/hooks/items-file';
import { parseOutputsFile as pluginOutputs } from '../../mod/agent-brief/hooks/outputs';
import type { OpenRequest } from '../../mod/agent-brief/hooks/companion-protocol';

describe('standalone plugin contracts', () => {
  it('ships generated sources matching the canonical app contracts', () => {
    execFileSync(process.execPath, [resolve(import.meta.dirname, '../scripts/sync-plugin.mjs'), '--check']);
    // Compile-time coverage of the field whose absence was hidden by a conditional spread.
    const request: OpenRequest = { mode: 'write', text: 'A note', sessionId: 's1' };
    expect(request.text).toBe('A note');
  });

  it('gives both output readers the same first-record, trimming and invalid-record policy', () => {
    const text = JSON.stringify({ version: 1, sessionId: 's1', outputs: [
      { ref: 'docs/report.md', title: ' Report ', kind: 'markdown', tier: 'declared', status: 'ready' },
      { ref: 'docs/report.md', title: 'Newest', kind: 'markdown', tier: 'declared' },
      { ref: '   ', kind: 'markdown', tier: 'detected' },
      { ref: 'bad.md', kind: 'unknown', tier: 'detected' },
    ] });
    const expected = { version: 1, sessionId: 's1', outputs: [
      { ref: 'docs/report.md', title: 'Report', kind: 'markdown', tier: 'declared', status: 'ready' },
    ] };
    expect(parseOutputsFile(text)).toEqual(expected);
    expect(pluginOutputs(text)).toEqual(expected);
    for (const invalid of ['null', '{', '{"version":2,"outputs":[]}', '{"version":1}']) {
      expect(pluginOutputs(invalid)).toBeUndefined();
      expect(parseOutputsFile(invalid)).toBeUndefined();
    }
  });

  it.each(['\n', '\r\n'])('preserves item bytes and decisions across both readers (%j)', (eol) => {
    const text = ['# Items', '', '- [ ] #2 Layout', '    Claude: Wide or narrow?', '    You:', '', '- [x] #1 Done', '    Out: docs/done.md', ''].join(eol);
    const decisions = [{ n: 2, text: ' wide\nplease ' }, { n: 9, text: 'unknown' }];
    const expected = text.replace(`    You:${eol}`, `    You: wide please${eol}`);
    expect(withDecisions(text, decisions)).toBe(expected);
    expect(pluginDecisions(text, decisions)).toBe(expected);
    expect(pluginItems(expected)).toEqual(parseItems(expected));
    expect(pluginItems(expected).items[0]?.lines.at(-1)).toEqual({ by: 'you', text: 'wide please' });
  });
});
