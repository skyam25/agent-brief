import { defineConfig } from 'vitest/config';
import { runDir } from './test/temp-run';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'cli/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['node_modules', 'out', 'e2e'],

    // Temp files go to one folder per run, which global setup deletes at the end.
    globalSetup: ['test/vitest-setup.ts'],
    env: { TMPDIR: runDir('abunit') },
  },
});
