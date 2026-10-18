import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveQueue } from './save-queue';

function deferred() {
  let resolve!: (saved: boolean) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('SaveQueue', () => {
  it('debounces each record independently', async () => {
    const write = vi.fn(async (_id: string) => true);
    const queue = new SaveQueue(write, vi.fn());
    queue.schedule('a');
    queue.schedule('b');
    await vi.advanceTimersByTimeAsync(200);
    queue.schedule('a');
    await vi.advanceTimersByTimeAsync(200);
    expect(write.mock.calls).toEqual([['b']]);
    expect(queue.has('a')).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(write.mock.calls).toEqual([['b'], ['a']]);
    expect(queue.has('a')).toBe(false);
  });

  it('waits for an already-running save even when nothing is queued', async () => {
    const save = deferred();
    const write = vi.fn(() => save.promise);
    const queue = new SaveQueue(write, vi.fn());
    queue.schedule('a');
    await vi.advanceTimersByTimeAsync(400);
    let finished = false;
    const flushing = queue.flush().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(queue.has('a')).toBe(true);
    save.resolve(true);
    await flushing;
    expect(finished).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(queue.has('a')).toBe(false);
  });

  it('serializes edits of one record when its timer and flush meet an active write', async () => {
    const first = deferred();
    const second = deferred();
    let text = 'first';
    const snapshots: string[] = [];
    const write = vi.fn(() => {
      snapshots.push(text);
      return snapshots.length === 1 ? first.promise : second.promise;
    });
    const queue = new SaveQueue(write, vi.fn());
    queue.schedule('a');
    await vi.advanceTimersByTimeAsync(400);
    text = 'latest';
    queue.schedule('a');
    await vi.advanceTimersByTimeAsync(400);
    let finished = false;
    const flushing = queue.flush().then(() => { finished = true; });
    expect(write).toHaveBeenCalledTimes(1);
    first.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toEqual(['first', 'latest']);
    expect(finished).toBe(false);
    second.resolve(true);
    await flushing;
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(queue.has('a')).toBe(false);
  });

  it('lets independent records save concurrently', async () => {
    const a = deferred();
    const b = deferred();
    const write = vi.fn((id: string) => id === 'a' ? a.promise : b.promise);
    const queue = new SaveQueue(write, vi.fn());
    queue.schedule('a');
    queue.schedule('b');
    const flushing = queue.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(write.mock.calls).toEqual([['a'], ['b']]);
    b.resolve(true);
    a.resolve(true);
    await flushing;
  });

  it('bounds immediate retries, keeps failures queued and clears the error after recovery', async () => {
    const write = vi.fn(async () => true).mockRejectedValue(new Error('disk full'));
    const changed = vi.fn();
    const queue = new SaveQueue(write, changed);
    queue.schedule('a');
    await queue.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(queue.error).toBe('disk full');
    expect(queue.has('a')).toBe(true);
    write.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(3);
    expect(queue.error).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('keeps a newer edit on its debounce when an older save fails', async () => {
    const first = deferred();
    const write = vi.fn(async () => true).mockImplementationOnce(() => first.promise);
    const queue = new SaveQueue(write, vi.fn());
    queue.schedule('a');
    await vi.advanceTimersByTimeAsync(400);
    queue.schedule('a');
    await vi.advanceTimersByTimeAsync(200);
    first.reject(new Error('busy'));
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.error).toBe('busy');
    await vi.advanceTimersByTimeAsync(199);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(queue.error).toBeUndefined();
  });

  it('cancels a removed record before its timer fires', async () => {
    const write = vi.fn(async () => true);
    const queue = new SaveQueue(write, vi.fn());
    queue.schedule('a');
    queue.cancel('a');
    await queue.flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).not.toHaveBeenCalled();
  });

  it('does not retry or report an in-flight failure after cancellation', async () => {
    const first = deferred();
    const write = vi.fn(() => first.promise);
    const changed = vi.fn();
    const queue = new SaveQueue(write, changed);
    queue.schedule('a');
    await vi.advanceTimersByTimeAsync(400);
    queue.cancel('a');
    first.reject(new Error('removed'));
    await queue.flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(queue.error).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
  });

  it('does not retry an intentionally skipped write or treat it as error recovery', async () => {
    const write = vi.fn(async () => false).mockRejectedValueOnce(new Error('busy'));
    const queue = new SaveQueue(write, vi.fn());
    queue.schedule('a');
    await queue.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(queue.has('a')).toBe(false);
    expect(queue.error).toBe('busy');
    await vi.advanceTimersByTimeAsync(2000);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
