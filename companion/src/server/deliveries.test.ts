import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeServers, start } from './server-testkit';
import { tempDir } from './testkit';

afterEach(closeServers);

describe('deliveries', () => {
  const png = Buffer.from([1, 2, 3]);

  /** Registers a session and, unless `pick` is false, makes it the target. */
  async function withSession(h: Awaited<ReturnType<typeof start>>, id = 'a', pick = true) {
    const cwd = tempDir('proj');
    await h.call('POST', '/sessions', { sessionId: id, cwd });
    if (pick) h.server.setTarget(id);
    return cwd;
  }

  it('answers at once when queued', async () => {
    const h = await start();
    await withSession(h);
    const d = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    const t0 = Date.now();
    const r = await h.call('GET', '/deliveries?session=a&wait=10');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.body.deliveries).toEqual([d]);
  });

  it('wakes a held poll when a delivery arrives', async () => {
    const h = await start();
    await withSession(h);
    const t0 = Date.now();
    const held = h.call('GET', '/deliveries?session=a&wait=20');
    await new Promise((r) => setTimeout(r, 100));
    const d = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    const r = await held;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.body.deliveries.map((x: { id: string }) => x.id)).toEqual([d.id]);
  });

  it('times out empty', async () => {
    const h = await start();
    await withSession(h);
    const t0 = Date.now();
    const r = await h.call('GET', '/deliveries?session=a&wait=1');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(r.body).toEqual({ deliveries: [] });
  });

  it('clamps wait to 0..30', async () => {
    const h = await start();
    await withSession(h);
    const t0 = Date.now();
    await h.call('GET', '/deliveries?session=a&wait=-5');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('releases held polls on close', async () => {
    const h = await start();
    await withSession(h);
    const held = h.call('GET', '/deliveries?session=a&wait=30');
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await h.server.close();
    const r = await held.catch(() => ({ body: { deliveries: [] } }));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.body.deliveries).toEqual([]);
  });

  it('closes promptly with a held poll, an idle socket and a half-sent request open', async () => {
    const h = await start();
    await withSession(h);
    const held = h.call('GET', '/deliveries?session=a&wait=30').catch(() => undefined);
    const idle = net.connect(h.socketPath).on('error', () => {});
    const partial = net.connect(h.socketPath).on('error', () => {});
    partial.write('GET /sessions HTTP/1.1\r\nHost: x\r\n');
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await h.server.close();
    await held;
    expect(Date.now() - t0).toBeLessThan(500);
    idle.destroy();
    partial.destroy();
  });

  it('keeps deliveries until acked, then removes them', async () => {
    const h = await start();
    await withSession(h);
    const a = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    const b = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    expect(b.id).not.toBe(a.id);
    const first = await h.call('GET', '/deliveries?session=a&wait=0');
    const again = await h.call('GET', '/deliveries?session=a&wait=0');
    expect(first.body.deliveries).toHaveLength(2);
    expect(again.body.deliveries).toHaveLength(2);

    const ack = await h.call('POST', `/deliveries/${a.id}/ack`);
    expect(ack.body).toEqual({ acked: true });
    const left = await h.call('GET', '/deliveries?session=a&wait=0');
    expect(left.body.deliveries.map((x: { id: string }) => x.id)).toEqual([b.id]);
    expect((await h.call('POST', `/deliveries/${a.id}/ack`)).body).toEqual({ acked: false });
  });

  it('queues per session', async () => {
    const h = await start();
    await withSession(h, 'a');
    await withSession(h, 'b');
    await h.server.deliver({ sessionId: 'b', png, scene: {}, boardName: 'main' });
    expect((await h.call('GET', '/deliveries?session=a&wait=0')).body.deliveries).toEqual([]);
    expect((await h.call('GET', '/deliveries?session=b&wait=0')).body.deliveries).toHaveLength(1);
  });

  it('rejects with no session', async () => {
    const h = await start();
    await expect(h.server.deliver({ png, scene: {}, boardName: 'main' })).rejects.toThrow(
      /no Claude Code session/,
    );
    await expect(
      h.server.deliver({ sessionId: 'ghost', png, scene: {}, boardName: 'main' }),
    ).rejects.toThrow(/unknown session/);
  });

  it('writes every file and builds the draft', async () => {
    const h = await start();
    const cwd = await withSession(h);
    const scene = { type: 'excalidraw', elements: [{ id: 'e' }] };
    const transcript = [{ t: 0, tEnd: 1, text: 'hi' }];
    const d = await h.server.deliver({
      png,
      scene,
      boardName: 'idea board',
      notes: 'line one\nline two  ' + 'z'.repeat(400),
      timelineMd: '[00:01] stroke 1',
      transcript,
      audio: [
        { name: 'a.webm', data: Buffer.from('AUDIO') },
        { name: '../evil.webm', data: Buffer.from('X') },
      ],
      speech: 'this is the header',
      mode: 'submit',
    });

    expect(d.id).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}$/);
    expect(d.dir).toBe(join(cwd, '.feedback', 'sketches', d.id));
    expect(d.mode).toBe('submit');
    expect(d.sessionId).toBe('a');
    expect(d.createdAt).toBe(h.clock.t);

    const read = (f: string) => readFileSync(join(d.dir, f));
    expect([...read('sketch.png')]).toEqual([1, 2, 3]);
    expect(read('board.excalidraw').toString()).toBe(JSON.stringify(scene, null, 2));
    expect(read('notes.md').toString()).toContain('line two');
    expect(read('timeline.md').toString()).toBe('[00:01] stroke 1');
    expect(JSON.parse(read('transcript.json').toString())).toEqual(transcript);
    expect(read('audio/a.webm').toString()).toBe('AUDIO');
    expect(read('audio/evil.webm').toString()).toBe('X');
    expect(existsSync(join(cwd, '.gitignore'))).toBe(false);

    const notes = 'line one line two ' + 'z'.repeat(400);
    expect(d.draft).toBe(
      [
        `@.feedback/sketches/${d.id}/sketch.png`,
        'Sketch from the Agent Brief board "idea board".',
        'Said while drawing: "this is the header"',
        `Notes: ${notes.slice(0, 300)}`,
        `Timeline: .feedback/sketches/${d.id}/timeline.md`,
      ].join('\n'),
    );
  });

  it('writes only what it was given and defaults to fill', async () => {
    const h = await start();
    const cwd = await withSession(h);
    const d = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    expect(d.mode).toBe('fill');
    expect(d.draft).toBe(
      `@.feedback/sketches/${d.id}/sketch.png\nSketch from the Agent Brief board "main".`,
    );
    for (const f of ['notes.md', 'timeline.md', 'transcript.json', 'audio']) {
      expect(existsSync(join(cwd, '.feedback/sketches', d.id, f))).toBe(false);
    }
  });

  it('adds a suffix when the id collides', async () => {
    const h = await start();
    await withSession(h);
    const a = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    const b = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    expect(b.id.startsWith(a.id)).toBe(true);
    expect(b.id).toMatch(/-[0-9a-f]{4}$/);
  });

  it('delivers to the target by default', async () => {
    const h = await start();
    await withSession(h, 'a', false);
    const cwdB = await withSession(h, 'b', false);
    h.server.setTarget('b');
    const d = await h.server.deliver({ png, scene: {}, boardName: 'main' });
    expect(d.sessionId).toBe('b');
    expect(d.dir.startsWith(cwdB)).toBe(true);
  });
});
