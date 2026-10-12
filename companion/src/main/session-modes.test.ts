import { describe, expect, it } from 'vitest';
import { SessionModes } from './session-modes';

describe('SessionModes', () => {
  it('stores a mode per session, and default clears it', () => {
    const modes = new SessionModes();
    modes.set('a', { mode: 'product' });
    modes.set('b', { mode: 'orchestrate' });
    expect(modes.get('a')).toEqual({ mode: 'product' });
    expect(modes.get('b')).toEqual({ mode: 'orchestrate' });
    modes.set('a', { mode: 'default' });
    expect(modes.get('a')).toBeUndefined();
    expect(modes.get('b')).toEqual({ mode: 'orchestrate' });
  });

  it('keeps a fidelity only with prototype', () => {
    const modes = new SessionModes();
    modes.set('a', { mode: 'prototype', fidelity: 'live-patch' });
    expect(modes.get('a')).toEqual({ mode: 'prototype', fidelity: 'live-patch' });
    modes.set('a', { mode: 'product', fidelity: 'live-patch' });
    expect(modes.get('a')).toEqual({ mode: 'product' });
    modes.set('a', { mode: 'prototype' });
    expect(modes.get('a')).toEqual({ mode: 'prototype' });
  });

  it('forgets sessions that left', () => {
    const modes = new SessionModes();
    modes.set('a', { mode: 'product' });
    modes.set('b', { mode: 'prototype', fidelity: 'wireframe' });
    modes.keepOnly(['b']);
    expect(modes.get('a')).toBeUndefined();
    expect(modes.get('b')).toEqual({ mode: 'prototype', fidelity: 'wireframe' });
  });
});
