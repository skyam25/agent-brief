import { describe, expect, it } from 'vitest';
import type { ItemsDocInfo } from '../shared/ipc';
import { parseItems } from '../shared/items';
import { ItemsStore } from './items';

const TEXT = ['- [ ] #1 Open one', '- [x] #2 Done one', '- [ ] #3 Open two', ''].join('\n');
const info = (text = TEXT): ItemsDocInfo => ({ sessionId: 's1', path: '/p/i.md', exists: true, doc: parseItems(text) });

function store() {
  let push: (i: ItemsDocInfo) => void = () => undefined;
  const items = new ItemsStore({ readItems: async () => info(), onItems: (fn) => void (push = fn) });
  return { items, push: (i: ItemsDocInfo) => push(i) };
}

describe('ItemsStore', () => {
  it('sends trimmed decisions on open items only, in file order', async () => {
    const { items } = store();
    await items.load('s1');
    items.setDecision('s1', 3, ' later ');
    items.setDecision('s1', 2, 'too late');
    items.setDecision('s1', 1, '   ');
    items.setDecision('s1', 9, 'no such item');
    expect(items.decisions('s1')).toEqual([{ n: 3, text: 'later' }]);
    items.setDecision('s1', 1, 'first');
    expect(items.decisions('s1').map((d) => d.n)).toEqual([1, 3]);
    expect(items.decisions('s2')).toEqual([]);
  });

  it('clears what a Send delivered, but keeps a field edited since', () => {
    const { items, push } = store();
    push(info());
    items.setDecision('s1', 1, 'a');
    items.setDecision('s1', 3, 'b');
    const sent = items.decisions('s1');
    items.setDecision('s1', 3, 'b, and more');
    items.clear('s1', sent);
    expect(items.decision('s1', 1)).toBe('');
    expect(items.decision('s1', 3)).toBe('b, and more');
  });
});
