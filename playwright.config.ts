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
    // retry. `retain-on-failure` records every test and discards the passes, so it
    // costs per-test time on all 200+ specs; with snapshots and screenshots on it
    // measurably slowed CI (5.5m -> 7.4m) and tipped two wall-clock-sensitive specs
    // into flaking. With them off the suite is back to 5.4m with zero failures.
    //
    // Know what this trace does and does not contain, measured from a real CI probe:
    // it keeps the action timeline (`0-trace.trace`), the failing stack
    // (`0-trace.stacks`), and source, at ~123 KB across 6 entries. It does NOT keep
    // DOM snapshots, screenshots, or the network log — `snapshots: false` disables
    // network capture too, so `0-trace.network` is 0 bytes. The full-fat trace was
    // ~1.75 MB across 14 entries with a 471 KB network log.
    //
    // Consequence worth knowing before Phases 4-5: for a selector that stops matching
    // or a re-render that drops visible content, a DOM snapshot is usually the single
    // most useful diagnostic, and it is not here. Re-enable `snapshots` if that class
    // of failure starts costing more than the ~2 minutes it buys back.
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
