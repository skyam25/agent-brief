import { expect, test } from '@playwright/test';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeliveriesResponse } from '../src/protocol';
import { joinSpeech } from '../src/voice/timeline';
import type { Utterance } from '../src/voice/types';
import { interactiveCanvas, launch, penStroke, pickPen, RESULTS, ROOT, sendToSession, showPanel, sock, tempDataDir } from './helpers';

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

  await page.getByTestId('mic').click();
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
  await expect(mic).toContainText('Talk');

  await page.keyboard.press('Alt+KeyT');
  await expect(mic).toHaveText('Stop');
  await expect(page.getByTestId('voice-strip')).toContainText('Listening');
  await expect(page.getByTestId('level-meter').locator('span')).toHaveCount(28);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(RESULTS, 'voice-recording.png') });

  await mic.click();
  await expect(page.getByTestId('voice-take')).toHaveText(/^00:0[1-2] recorded$/);
  await expect(mic).toContainText('Talk more');
  await page.screenshot({ path: join(RESULTS, 'voice-take.png') });

  // Talking more adds to the same take, and Discard while recording drops all of it.
  await mic.click();
  await expect(page.getByTestId('mic-clock')).toHaveText(/^00:0[1-2]$/);
  await page.getByTestId('voice-discard').click();
  await expect(page.getByTestId('voice-take')).toHaveCount(0);
  await expect(mic).toContainText('Talk');
  expect(await page.evaluate(() => window.__board.recorder.segments.length)).toBe(0);

  await page.keyboard.press('Alt+KeyT');
  await page.waitForTimeout(1200);
  await page.keyboard.press('Alt+KeyT');
  await page.getByTestId('voice-take-discard').click();
  await expect(page.getByTestId('voice-take')).toHaveCount(0);
  await page.screenshot({ path: join(RESULTS, 'voice-idle.png') });
  await app.close();
});
