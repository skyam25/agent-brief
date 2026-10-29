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

  it('names an output by its absolute path, and opens it only from its own project', () => {
    expect(referenceText({ kind: 'output', sessionId: 's1', ref: '/work/mock/a.html', title: 'Checkout' }, drafts)).toBe(
      `Read my Agent Brief page "Checkout" in '/work/mock/a.html'. If it is inside this project, show it with agent-brief open --output '/work/mock/a.html'.`,
    );
    expect(referenceText({ kind: 'output', sessionId: 's1', ref: '/work/docs/memo.md', title: 'Memo' }, drafts)).toBe(
      `Read my Agent Brief document "Memo" in '/work/docs/memo.md'. If it is inside this project, show it with agent-brief open --output '/work/docs/memo.md'.`,
    );
  });

  it('sends an outline through agent-brief outline', () => {
    expect(referenceText({ kind: 'output', sessionId: 's1', ref: '/work/memo.outline.md', title: 'Memo' }, drafts)).toBe(
      `Read my Agent Brief outline "Memo" in '/work/memo.outline.md', and change it only through agent-brief outline. If it is inside this project, show it with agent-brief open --output '/work/memo.outline.md'.`,
    );
  });

  it('gives a linked output its link', () => {
    expect(referenceText({ kind: 'output', sessionId: 's1', ref: 'https://claude.ai/artifact/x', title: 'Deck' }, drafts)).toBe(
      'Open my Agent Brief output "Deck" at https://claude.ai/artifact/x.',
    );
  });
});
