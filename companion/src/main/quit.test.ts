import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_MS, EXIT_MS, FLUSH_MS, Quitter } from './quit';

const never = () => new Promise<never>(() => {});

function setup(over: { flush?: () => Promise<unknown>; closeServer?: () => Promise<unknown> } = {}) {
  const order: string[] = [];
  const quitter = new Quitter({
    flush: over.flush ?? (async () => void order.push('flush')),
    closeServer: over.closeServer ?? (async () => void order.push('close')),
    quit: () => order.push('quit'),
    exit: () => order.push('exit'),
  });
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  return { quitter, order, event };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Quitter', () => {
  it('holds the first quit, saves, closes, then quits', async () => {
    const { quitter, order, event } = setup();
    const e = event();
    quitter.beforeQuit(e);
    expect(e.prevented).toBe(true);
    await vi.waitFor(() => expect(order).toEqual(['flush', 'close', 'quit']));

    const again = event();
    quitter.beforeQuit(again);
    expect(again.prevented).toBe(false);
  });

  it('quits when the renderer never answers the flush', async () => {
    const { quitter, order, event } = setup({ flush: never });
    quitter.beforeQuit(event());
    await vi.advanceTimersByTimeAsync(FLUSH_MS - 1);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['close', 'quit']);
  });

  it('quits when the server never closes', async () => {
    const { quitter, order, event } = setup({ closeServer: never });
    quitter.beforeQuit(event());
    await vi.advanceTimersByTimeAsync(CLOSE_MS);
    expect(order).toEqual(['flush', 'quit']);
  });

  it('quits when a step throws', async () => {
    const { quitter, order, event } = setup({
      flush: () => {
        throw new Error('gone');
      },
      closeServer: async () => {
        throw new Error('closed');
      },
    });
    quitter.beforeQuit(event());
    await vi.waitFor(() => expect(order).toEqual(['quit']));
  });

  it('shares one run between quits that arrive while it saves', async () => {
    let flushes = 0;
    const { quitter, order, event } = setup({ flush: async () => void (flushes += 1) });
    quitter.beforeQuit(event());
    quitter.beforeQuit(event());
    await quitter.prepare();
    await vi.waitFor(() => expect(order.filter((s) => s === 'quit')).toHaveLength(2));
    expect(flushes).toBe(1);
  });

  it('exits when the quit it let through does not finish', async () => {
    const { quitter, order, event } = setup();
    await quitter.prepare();
    quitter.beforeQuit(event());
    quitter.beforeQuit(event());
    await vi.advanceTimersByTimeAsync(EXIT_MS - 1);
    expect(order).not.toContain('exit');
    await vi.advanceTimersByTimeAsync(1);
    expect(order.filter((s) => s === 'exit')).toHaveLength(1);
  });
});
