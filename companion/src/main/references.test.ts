import { describe, expect, it } from 'vitest';
import { referenceText } from './references';

const drafts = '/Users/me/Library/Application Support/AgentBrief/drafts';

describe('referenceText', () => {
  it('names a board and the commands that open and read it', () => {
    expect(referenceText({ kind: 'board', name: "Bob's flow" }, drafts)).toBe(
      `Open my Agent Brief board "Bob's flow" with agent-brief open --board 'Bob'\\''s flow', then read it with agent-brief read --board 'Bob'\\''s flow'.`,
    );
  });

  it('names a note by its file, quoted for the space in Application Support', () => {
    expect(referenceText({ kind: 'note', id: 'd1', title: 'Launch "v2" email' }, drafts)).toBe(
      `Read my Agent Brief note "Launch \\"v2\\" email" in '${drafts}/d1.json'. Show it with agent-brief open --note 'd1', and save changes with agent-brief note --id 'd1'.`,
    );
  });

  it('attaches an initiative by id, so a shared title cannot pick the wrong one', () => {
    expect(referenceText({ kind: 'initiative', id: 'pricing-2', title: 'Pricing' }, drafts)).toBe(
      `Attach my Agent Brief initiative "Pricing" with agent-brief initiative attach 'pricing-2', then read it with agent-brief initiative show 'pricing-2'.`,
    );
  });
});
