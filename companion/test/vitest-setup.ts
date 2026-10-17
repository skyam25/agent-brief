import { endRun, startRun } from './temp-run';

/** Creates the folder vitest.config.ts points TMPDIR at, and deletes it after the run. */
export default function setup(): () => void {
  const dir = startRun('abunit');
  return () => endRun(dir);
}
