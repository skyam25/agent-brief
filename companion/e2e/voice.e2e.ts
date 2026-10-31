import { expect, test } from '@playwright/test';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeliveriesResponse } from '../src/protocol';
import { joinSpeech } from '../src/voice/timeline';
import type { Utterance } from '../src/voice/types';
import { backend, interactiveCanvas, launch, penStroke, pickPen, RESULTS, ROOT, sendToSession, showPanel, sock, tempDataDir } from './helpers';

const SPEECH = join(ROOT, 'e2e/fixtures/speech.wav');

test('C3.1 recorded speech is transcribed into the bundle next to the strokes drawn during it', async () => {
  test.skip(!existsSync(SPEECH), 'speech fixture missing');
  test.setTimeout(120_000);
  const dataDir = tempDataDir();
  const socketPath = join(dataDir, 'companion.sock');
  const { app, page } = await launch(dataDir, { COMPANION_TEST_AUDIO: SPEECH });
  await showPanel(app, page);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'v1', cwd, title: 'Pricing' });

  // Talk turns the comment tool on. Turning it off hands the mic to plain sketch voice, so the pen draws.
  await page.getByTestId('mic').click();
  await expect(page.getByTestId('comment-tool')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('c');
  await expect(page.getByTestId('comment-tool')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('mic-clock')).toHaveText('00:00');

  const cdp = await page.context().newCDPSession(page);
  await pickPen(page);
  const box = (await interactiveCanvas(page).boundingBox())!;
  await penStroke(cdp, { x: box.x + 320, y: box.y + 250 }, { x: box.x + 600, y: box.y + 250 }, 0.6);
  await page.waitForTimeout(1500);
  await penStroke(cdp, { x: box.x + 320, y: box.y + 450 }, { x: box.x + 600, y: box.y + 520 }, 0.9);
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('mic-clock')).toHaveText(/^00:0[3-6]$/);

  await sendToSession(page, 'Pricing');
  await expect(page.getByTestId('send-status')).toHaveText(/^Sent to Pricing$/, { timeout: 60_000 });
  await expect(page.getByTestId('mic')).toHaveAttribute('aria-pressed', 'false');

  const [id] = readdirSync(join(cwd, '.feedback', 'sketches'));
  const dir = join(cwd, '.feedback', 'sketches', id);
  expect(readdirSync(dir).sort()).toEqual(['audio', 'board.excalidraw', 'sketch.png', 'timeline.md', 'transcript.json']);
  expect(readdirSync(join(dir, 'audio'))).toEqual(['seg-0.webm']);
  copyFileSync(join(dir, 'sketch.png'), join(RESULTS, 'voice-sketch.png'));

  const transcript: Utterance[] = JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8'));
  expect(transcript.length).toBeGreaterThan(0);
  expect(transcript.map((u) => u.text).join(' ')).toMatch(/pricing table/i);
  expect(transcript[0]).toMatchObject({ audio: 'audio/seg-0.webm' });

  const timeline = readFileSync(join(dir, 'timeline.md'), 'utf8');
  expect(timeline).toMatch(/stroke 1/);
  expect(timeline).toMatch(/stroke 2/);
  expect(timeline).toMatch(/🎙️ "This pricing table/i);
  // Every utterance is in the timeline, with speech split by short pauses sharing one line.
  for (const u of transcript) expect(timeline).toContain(u.text.replace(/"/g, "'"));
  expect(timeline.match(/🎙️/g)).toHaveLength(joinSpeech(transcript).length);

  const polled = await sock<DeliveriesResponse>(socketPath, 'GET', '/deliveries?session=v1&wait=0');
  const draft = polled.body.deliveries[0].draft;
  expect(draft).toMatch(/Said while drawing: ".*pricing table/i);
  expect(draft).toContain(`Timeline: .feedback/sketches/${id}/timeline.md`);
  await app.close();
});

test('Talk records into a take that Send carries and Discard drops', async () => {
  test.skip(!existsSync(SPEECH), 'speech fixture missing');
  const { app, page } = await launch(tempDataDir(), { COMPANION_TEST_AUDIO: SPEECH });
  await showPanel(app, page);
  const mic = page.getByTestId('mic');
  await expect(mic).toContainText('Talk and annotate');
  const plainTalk = async () => {
    await page.keyboard.press('Alt+KeyT');
    await expect(page.getByTestId('comment-tool')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('c');
  };

  await plainTalk();
  await expect(mic).toHaveText('Stop');
  await expect(page.getByTestId('voice-strip')).toContainText('Listening');
  await expect(page.getByTestId('level-meter').locator('span')).toHaveCount(28);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(RESULTS, 'voice-recording.png') });

  await mic.click();
  await expect(page.getByTestId('voice-take')).toHaveText(/^00:0[1-2] recorded$/);
  await expect(mic).toContainText('Talk and annotate');
  await page.screenshot({ path: join(RESULTS, 'voice-take.png') });

  // Talking more adds to the same take, and Discard while recording drops all of it.
  await plainTalk();
  await expect(page.getByTestId('mic-clock')).toHaveText(/^00:0[1-2]$/);
  await page.getByTestId('voice-discard').click();
  await expect(page.getByTestId('voice-take')).toHaveCount(0);
  await expect(mic).toContainText('Talk and annotate');
  expect(await page.evaluate(() => window.__board.recorder.segments.length)).toBe(0);

  await plainTalk();
  await page.waitForTimeout(1200);
  await page.keyboard.press('Alt+KeyT');
  await page.getByTestId('voice-take-discard').click();
  await expect(page.getByTestId('voice-take')).toHaveCount(0);
  await page.screenshot({ path: join(RESULTS, 'voice-idle.png') });
  await app.close();
});

test('a click on the board while talking points the words at that element', async () => {
  test.skip(!existsSync(SPEECH), 'speech fixture missing');
  test.setTimeout(120_000);
  const ctx = await launch(tempDataDir(), { COMPANION_TEST_AUDIO: SPEECH });
  const { app, page } = ctx;
  await showPanel(app, page);
  await backend(app, 'draw', 'current', {
    elements: [
      { type: 'rectangle', id: 'a', x: 100, y: 100, label: 'Header' },
      { type: 'rectangle', id: 'b', x: 400, y: 100, label: 'Footer' },
    ],
  });
  const centre = (id: string) =>
    page.evaluate((id) => {
      const s = window.__excalidraw.getAppState();
      const e = window.__excalidraw.getSceneElements().find((x) => x.id === id)!;
      return { x: (e.x + e.width / 2 + s.scrollX) * s.zoom.value + s.offsetLeft, y: (e.y + e.height / 2 + s.scrollY) * s.zoom.value + s.offsetTop };
    }, id);

  // Talk turns the comment tool on, so clicks pin while the mic listens.
  await expect(page.getByTestId('mic')).toHaveText(/Talk and annotate/);
  await page.getByTestId('mic').click();
  await expect(page.getByTestId('comment-tool')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('board-comments')).toBeVisible();
  await expect(page.getByTestId('mic')).toHaveText(/Stop/);

  const a = await centre('a');
  await page.mouse.click(a.x, a.y);
  await page.waitForTimeout(5500);
  const b = await centre('b');
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(5500);
  await page.getByTestId('mic').click();

  const cards = page.getByTestId('board-comment-text');
  await expect(cards).toHaveCount(2);
  await expect(page.getByTestId('board-comment-card').nth(0)).toContainText('“Header”');
  await expect(cards.nth(0)).toHaveValue(/pricing table/i, { timeout: 60_000 });
  await expect(cards.nth(1)).toHaveValue(/pricing table/i, { timeout: 60_000 });
  await page.screenshot({ path: join(RESULTS, 'board-comments-voice.png') });
  await app.close();
});

test('live dictation splits speech that runs on across a new pin', async () => {
  test.skip(!existsSync(SPEECH), 'speech fixture missing');

  // One phrase with no pause in it, heard after both pins exist. Its words straddle the second pin.
  const words = [[2.5, 'Make'], [2.7, 'it'], [2.9, 'bolder,'], [8, 'and'], [8.2, 'add'], [8.4, 'links.']];
  const { app, page } = await launch(tempDataDir(), {
    COMPANION_TEST_AUDIO: SPEECH,
    COMPANION_TEST_DICTATE: join(ROOT, 'e2e/fixtures/fake-dictate.mjs'),
    FAKE_DICTATE: JSON.stringify({ phrases: [{ at: 11_000, start: 2.5, text: 'Make it bolder, and add links.', words }] }),
  });
  await showPanel(app, page);
  await backend(app, 'draw', 'current', {
    elements: [
      { type: 'rectangle', id: 'a', x: 100, y: 100, label: 'Header' },
      { type: 'rectangle', id: 'b', x: 400, y: 100, label: 'Footer' },
    ],
  });
  const centre = (id: string) =>
    page.evaluate((id) => {
      const s = window.__excalidraw.getAppState();
      const e = window.__excalidraw.getSceneElements().find((x) => x.id === id)!;
      return { x: (e.x + e.width / 2 + s.scrollX) * s.zoom.value + s.offsetLeft, y: (e.y + e.height / 2 + s.scrollY) * s.zoom.value + s.offsetTop };
    }, id);
  const a = await centre('a');
  const b = await centre('b');

  await page.getByTestId('mic').click();
  await expect(page.getByTestId('comment-tool')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(a.x, a.y);
  await page.waitForTimeout(5000);
  await page.mouse.click(b.x, b.y);

  const cards = page.getByTestId('board-comment-text');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveValue('Make it bolder,', { timeout: 15_000 });
  await expect(cards.nth(1)).toHaveValue('and add links.');
  await page.getByTestId('mic').click();
  await app.close();
});

test('live dictation times words from when the mic runs, so a slow start still splits words at the click', async () => {
  test.skip(!existsSync(SPEECH), 'speech fixture missing');

  // The mic runs 2 s after the press, as on a slow Mac. Word times count from then.
  const words = [[0.8, 'Make'], [1, 'it'], [1.2, 'bolder,'], [4.5, 'and'], [4.7, 'add'], [4.9, 'links.']];
  const { app, page } = await launch(tempDataDir(), {
    COMPANION_TEST_AUDIO: SPEECH,
    COMPANION_TEST_DICTATE: join(ROOT, 'e2e/fixtures/fake-dictate.mjs'),
    FAKE_DICTATE: JSON.stringify({ ready: 2000, phrases: [{ at: 9000, start: 0.8, text: 'Make it bolder, and add links.', words }] }),
  });
  await showPanel(app, page);
  await backend(app, 'draw', 'current', {
    elements: [
      { type: 'rectangle', id: 'a', x: 100, y: 100, label: 'Header' },
      { type: 'rectangle', id: 'b', x: 400, y: 100, label: 'Footer' },
    ],
  });
  const centre = (id: string) =>
    page.evaluate((id) => {
      const s = window.__excalidraw.getAppState();
      const e = window.__excalidraw.getSceneElements().find((x) => x.id === id)!;
      return { x: (e.x + e.width / 2 + s.scrollX) * s.zoom.value + s.offsetLeft, y: (e.y + e.height / 2 + s.scrollY) * s.zoom.value + s.offsetTop };
    }, id);
  const a = await centre('a');
  const b = await centre('b');

  await page.getByTestId('mic').click();
  await expect(page.getByTestId('voice-strip')).toContainText('Starting dictation…');
  await page.screenshot({ path: join(RESULTS, 'dictation-starting.png') });
  await expect(page.getByTestId('voice-strip')).toContainText('Listening', { timeout: 5000 });
  await page.mouse.click(a.x, a.y);
  await page.waitForTimeout(3000);
  await page.mouse.click(b.x, b.y);

  const cards = page.getByTestId('board-comment-text');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveValue('Make it bolder,', { timeout: 15_000 });
  await expect(cards.nth(1)).toHaveValue('and add links.');
  await page.getByTestId('mic').click();
  await app.close();
});

test('Send while talking carries the words for every pin and the overall note', async () => {
  test.skip(!existsSync(SPEECH), 'speech fixture missing');
  test.setTimeout(150_000);
  const dataDir = tempDataDir();
  const socketPath = join(dataDir, 'companion.sock');
  const { app, page } = await launch(dataDir, { COMPANION_TEST_AUDIO: SPEECH });
  await showPanel(app, page);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'v2', cwd, title: 'Pricing' });
  await backend(app, 'draw', 'current', {
    elements: [
      { type: 'rectangle', id: 'a', x: 100, y: 100, label: 'Header' },
      { type: 'rectangle', id: 'b', x: 400, y: 100, label: 'Footer' },
    ],
  });
  const centre = (id: string) =>
    page.evaluate((id) => {
      const s = window.__excalidraw.getAppState();
      const e = window.__excalidraw.getSceneElements().find((x) => x.id === id)!;
      return { x: (e.x + e.width / 2 + s.scrollX) * s.zoom.value + s.offsetLeft, y: (e.y + e.height / 2 + s.scrollY) * s.zoom.value + s.offsetTop };
    }, id);

  // Words before the first pin go to the overall note. Send goes out with the mic still on.
  await page.getByTestId('mic').click();
  await expect(page.getByTestId('mic')).toHaveText(/Stop/);
  await page.waitForTimeout(4000);
  const a = await centre('a');
  await page.mouse.click(a.x, a.y);
  await page.waitForTimeout(8000);
  const b = await centre('b');
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(4000);
  await sendToSession(page, 'Pricing');
  await expect(page.getByTestId('send-status')).toHaveText(/^Sent to Pricing$/, { timeout: 60_000 });
  await expect(page.getByTestId('mic')).toHaveAttribute('aria-pressed', 'false');

  const [id] = readdirSync(join(cwd, '.feedback', 'sketches'));
  const md = readFileSync(join(cwd, '.feedback', 'sketches', id, 'comments.md'), 'utf8');
  copyFileSync(join(cwd, '.feedback', 'sketches', id, 'comments.md'), join(RESULTS, 'send-while-talking-comments.md'));
  const section = (heading: RegExp) => md.split(/\n## /).find((s) => heading.test(s)) ?? '';
  expect(section(/^Overall/)).toMatch(/pricing table/i);
  expect(section(/^1\. /)).toMatch(/pricing table/i);
  expect(section(/^2\. /)).toMatch(/pricing table/i);
  expect(md).not.toContain('(No words.');

  // Nothing lands on the board after the Send.
  await page.waitForTimeout(3000);
  await expect(page.getByTestId('board-comments')).toHaveCount(0);
  await app.close();
});

test('Send while talking with no pin yet sends the words as the overall note', async () => {
  test.skip(!existsSync(SPEECH), 'speech fixture missing');
  test.setTimeout(120_000);
  const dataDir = tempDataDir();
  const socketPath = join(dataDir, 'companion.sock');
  const { app, page } = await launch(dataDir, { COMPANION_TEST_AUDIO: SPEECH });
  await showPanel(app, page);
  await expect.poll(() => existsSync(socketPath)).toBe(true);
  const cwd = mkdtempSync(join(tmpdir(), 'project-'));
  await sock(socketPath, 'POST', '/sessions', { sessionId: 'v3', cwd, title: 'Pricing' });

  await page.getByTestId('mic').click();
  await expect(page.getByTestId('mic')).toHaveText(/Stop/);
  await page.waitForTimeout(4000);
  await sendToSession(page, 'Pricing');
  await expect(page.getByTestId('send-status')).toHaveText(/^Sent to Pricing$/, { timeout: 60_000 });
  await expect(page.getByTestId('mic')).toHaveAttribute('aria-pressed', 'false');

  const [id] = readdirSync(join(cwd, '.feedback', 'sketches'));
  const md = readFileSync(join(cwd, '.feedback', 'sketches', id, 'comments.md'), 'utf8');
  expect(md).toMatch(/## Overall\n\n.*pricing table/i);
  await page.waitForTimeout(3000);
  await expect(page.getByTestId('board-comments')).toHaveCount(0);
  await app.close();
});
