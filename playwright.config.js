import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  use: {
    ...devices['Desktop Chrome'],
    userDataDir: process.env.USER_DATA_DIR ?? './playwright-profile',
    headless: true,
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    bypassCSP: true,
    ignoreHTTPSErrors: true,
  },
  timeout: 60_000,
  retries: 2,
});
