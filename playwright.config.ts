import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.MARU_E2E_PORT ?? 5307);

export default defineConfig({
  testDir: "./e2e",
  // The graph specs drive a real WebGL renderer and retain a residual flake that
  // the camera-settle and GPU-overlay fixes reduced but did not remove:
  // measured locally over 102 runs, 5 failures before, 4 after at one worker,
  // so it is not worker contention either. Retrying on CI is mitigation, not a
  // cure - Playwright reports a retried pass as flaky, so the noise stays
  // visible rather than being swallowed.
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
