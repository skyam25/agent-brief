import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  // Each test launches its own app on its own data dir and socket. Past ~6 workers runs stop getting faster.
  workers: '40%',
  reporter: [['list']],
  outputDir: 'test-results/playwright',
});
