import { describe, expect, it } from 'vitest';
import { herdrNumbers } from './terminals';

describe('herdrNumbers', () => {
  it('maps each workspace to its sidebar number', () => {
    const out = JSON.stringify({
      result: {
        type: 'workspace_list',
        workspaces: [
          { workspace_id: 'w1G', number: 16, label: 'agent-brief' },
          { workspace_id: 'w1M', number: 19, label: 'agent-brief' },
        ],
      },
    });
    expect([...herdrNumbers(out)]).toEqual([
      ['w1G', 16],
      ['w1M', 19],
    ]);
  });

  it('is empty for output it cannot read', () => {
    expect(herdrNumbers('').size).toBe(0);
    expect(herdrNumbers('{"result":{}}').size).toBe(0);
  });
});
