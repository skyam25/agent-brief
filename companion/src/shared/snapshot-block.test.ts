import { describe, expect, it } from 'vitest';
import { snapshotBlock } from './snapshot-block';

/** A stand-in element with a tag, a size and a parent. */
function el(tagName: string, width: number, height: number, parentElement: Element | null = null, cls = ''): Element {
  const tags = (sel: string) => sel.split(',').map((s) => s.trim()).some((s) => s === tagName.toLowerCase() || (s === '[class*="card"]' && cls.includes('card')));
  return { tagName, parentElement, matches: tags, getBoundingClientRect: () => ({ width, height }) } as unknown as Element;
}

describe('snapshotBlock', () => {
  it('climbs to the nearest section, card or large ancestor', () => {
    const body = el('BODY', 1280, 3000);
    const section = el('SECTION', 200, 100, body);
    const button = el('BUTTON', 80, 30, el('DIV', 200, 40, section));
    expect(snapshotBlock(button)).toBe(section);
    const card = el('DIV', 240, 120, body, 'cart-card');
    expect(snapshotBlock(el('SPAN', 40, 16, card))).toBe(card);
    const wide = el('DIV', 600, 300, body);
    expect(snapshotBlock(el('P', 300, 20, el('DIV', 300, 60, wide)))).toBe(wide);
  });

  it('keeps a large element, and never takes the body', () => {
    const body = el('BODY', 1280, 3000);
    const big = el('DIV', 400, 200, body);
    expect(snapshotBlock(big)).toBe(big);
    const lone = el('BUTTON', 80, 30, body);
    expect(snapshotBlock(lone)).toBe(lone);
  });
});
