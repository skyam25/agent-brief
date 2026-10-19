import { describe, expect, it } from 'vitest';
import { claimTalk, talkOwner } from './talk-owner';

describe('talk owner', () => {
  it('gives ⌥T to the newest claim and falls back as claims release', () => {
    const layer = () => undefined;
    const panel = () => undefined;
    expect(talkOwner()).toBeUndefined();
    const releasePanel = claimTalk(panel);
    const releaseLayer = claimTalk(layer);
    expect(talkOwner()).toBe(layer);
    releaseLayer();
    expect(talkOwner()).toBe(panel);
    releasePanel();
    expect(talkOwner()).toBeUndefined();
  });
});
