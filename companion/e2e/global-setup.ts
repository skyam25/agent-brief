import { endRun, startRun } from '../test/temp-run';

/**
 * Points TMPDIR at a per-run folder before workers start. Workers and the
 * Electron apps they launch inherit it, and teardown deletes the folder.
 */
export default function globalSetup(): () => void {
  const dir = startRun('abe2e');
  process.env.TMPDIR = dir;
  return () => endRun(dir);
}
