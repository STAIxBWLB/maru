import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.MARU_E2E_PORT ?? 5307);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // GATE-04 (D-12): capture a trace on the first failure without buying it with a
    // retry. DOM snapshots and screenshots are off because they are the bulk of the
    // per-test cost: `retain-on-failure` records every test and discards the passes,
    // and turning them on measurably slowed the suite (5.5m -> 7.3m in CI) enough to
    // tip two wall-clock-sensitive specs into flaking. Network log and stacks are
    // retained, which is what makes a CI failure diagnosable.
    trace: { mode: "retain-on-failure", snapshots: false, screenshots: false },
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
