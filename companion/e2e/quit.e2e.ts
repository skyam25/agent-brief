import { expect, test } from '@playwright/test';
import http from 'node:http';
import type { ElectronApplication } from '@playwright/test';
import { launch, launchShown, openNotes, tempDataDir } from './helpers';

/** Resolves with the time the app took to exit, or undefined if it outlived `ms`. */
function exitWithin(app: ElectronApplication, ms: number): Promise<number | undefined> {
  const proc = app.process();
  const t0 = Date.now();
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(0);
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve(undefined);
    }, ms);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve(Date.now() - t0);
    });
  });
}

test('SIGTERM quits with a held /deliveries poll, and keeps the last edit', async () => {
  const { ctx, socketPath, dataDir } = await launchShown();
  await openNotes(ctx.page);
  await ctx.page.getByTestId('notes').fill('typed before SIGTERM');
  http.get({ socketPath, path: '/deliveries?session=s1&wait=30' }).on('error', () => {});
  await ctx.page.waitForTimeout(200);

  const exited = exitWithin(ctx.app, 10_000);
  ctx.app.process().kill('SIGTERM');
  expect(await exited).toBeLessThan(2000);

  const { app, page } = await launch(dataDir);
  await openNotes(page);
  await expect(page.getByTestId('notes')).toHaveValue('typed before SIGTERM');
  await app.close();
});

test('a beforeunload handler in the panel does not cancel the quit', async () => {
  const { app, page } = await launch(tempDataDir());
  await page.evaluate(() =>
    window.addEventListener('beforeunload', (e) => {
      e.preventDefault();
      e.returnValue = '';
    }),
  );
  // Chromium honours beforeunload only after a user gesture.
  await page.mouse.click(5, 5);

  const exited = exitWithin(app, 10_000);
  app.process().kill('SIGTERM');
  expect(await exited).toBeLessThan(2000);
});

test('a quit that a window cancels still exits', async () => {
  const { app } = await launch(tempDataDir());
  await app.evaluate(() => globalThis.__companion.panel.win.on('close', (e) => e.preventDefault()));

  const exited = exitWithin(app, 15_000);
  void app.evaluate(({ app }) => app.quit()).catch(() => undefined);
  expect(await exited).toBeLessThan(8000);
});
