import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1050 } },
    },
    {
      name: 'mobile-360',
      use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 800 } },
    },
  ],
  webServer: {
    env: {
      SQOCH_DATABASE_PATH: '.cache/e2e.sqlite3',
      DEEPSEEK_API_KEY: '',
      LLM_PROVIDER: 'deepseek',
      DEEPSEEK_MODEL: 'deepseek-flash',
    },
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:8000/api/event',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
