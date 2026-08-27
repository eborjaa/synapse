import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end suite for the DSH × Synapse HTTP plugin.
 *
 * It drives the REAL running stack (deploy/compose.yml): a DeepSeek Harness UI on
 * 127.0.0.1:8080 whose Synapse tools are served over HTTP by synapse-core. Nothing here
 * is mocked — the point of the suite is that the tools follow the OPEN FOLDER, and a mock
 * cannot be wrong about that.
 *
 * Bring the stack up first:  BIND_ADDR=127.0.0.1 ./deploy/up.sh up -d --no-build
 * Then:                      npm --prefix dsh/e2e test
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,

  // ONE worker, on purpose. A DSH session is SERVER-side state: every browser context sees
  // the same sidebar, so two workers each clicking "New session" race for the same draft and
  // one of them silently ends up watching a session it did not send to. The parallelism this
  // suite actually needs is four folders answering AT THE SAME TIME, and that lives inside a
  // test (Promise.all over sessions), where it is asserted rather than left to the runner.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,

  // A turn is a live model call, not a pure function. Retrying re-runs the model against a
  // vault this suite has already written to, so a "flaky" retry would be testing a different
  // world than the first attempt. Fail loudly instead.
  retries: 0,

  // Budgets are generous because each assertion waits on a real agent turn. The plugin's own
  // tool timeout is 180s, so a single turn can legitimately take three minutes.
  timeout: 10 * 60 * 1000,
  expect: { timeout: 4 * 60 * 1000 },

  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  outputDir: 'results',

  use: {
    baseURL: process.env.DSH_URL ?? 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 30 * 1000,
    navigationTimeout: 60 * 1000,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
