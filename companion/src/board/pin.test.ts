import { describe, expect, it } from 'vitest';
import { pinSpot, pinTarget, type Pinnable } from './pin';

const frame: Pinnable = { id: 'f', type: 'frame', x: 0, y: 0, width: 1000, height: 600, name: 'Login flow' };
const box: Pinnable = { id: 'r', type: 'rectangle', x: 100, y: 100, width: 200, height: 100, frameId: 'f' };
const label: Pinnable = { id: 't', type: 'text', x: 150, y: 140, width: 100, height: 20, containerId: 'r', text: 'Open the app', frameId: 'f' };
const arrow: Pinnable = { id: 'a', type: 'arrow', x: 300, y: 150, width: 200, height: 0, points: [[0, 0], [200, 0]], frameId: 'f' };

describe('pinTarget', () => {
  const scene = [frame, box, label, arrow];

  it('pins the shape when the click lands on its text, with the frame name', () => {
    expect(pinTarget(scene, [160, 150])).toEqual({ elementId: 'r', type: 'rectangle', label: 'Open the app', frame: 'Login flow', fx: 0.3, fy: 0.5 });
  });

  it('takes a line within a few units of the click', () => {
    expect(pinTarget(scene, [400, 154])?.elementId).toBe('a');
  });

  it('falls back to the frame, named by its title', () => {
    expect(pinTarget(scene, [800, 500])).toMatchObject({ elementId: 'f', type: 'frame', label: 'Login flow' });
  });

  it('finds nothing on empty board and skips deleted elements', () => {
    expect(pinTarget(scene, [2000, 2000])).toBeUndefined();
    expect(pinTarget([{ ...box, isDeleted: true }], [160, 150])).toBeUndefined();
  });
});

describe('pinSpot', () => {
  it('follows its element and stays put once the element is gone', () => {
    const pin = { elementId: 'r', x: 160, y: 150, fx: 0.3, fy: 0.5 };
    expect(pinSpot(pin, new Map([['r', { ...box, x: 500 }]]))).toEqual({ at: [560, 150], gone: false });
    expect(pinSpot(pin, new Map())).toEqual({ at: [160, 150], gone: true });
    expect(pinSpot({ x: 5, y: 6 }, new Map())).toEqual({ at: [5, 6], gone: false });
  });
});
