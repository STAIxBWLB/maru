import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("maru:e2e:storage-cleared", "true");
  });
});

test("opens the Messages per-source processing dashboard", async ({ page }) => {
  await page.goto("/");

  const rail = page.locator(".activity-rail");
  await rail.getByRole("button", { name: "메시지", exact: true }).click();

  const pane = page.locator(".comms-pane");
  await expect(pane).toBeVisible();

  // Source selector + one overview card per configured source (gws/mso/telegram/kakao).
  await expect(pane.locator(".comms-source-selector")).toBeVisible();
  await expect(pane.locator(".comms-source-grid .source-card")).toHaveCount(4);

  // Non-Tauri mock => no run state, so each source reports "never processed".
  await expect(pane.getByText("아직 처리한 적 없음").first()).toBeVisible();

  // Drill into a single source → detail view with the processing-results browser.
  await pane.locator(".source-card-open").first().click();
  await expect(pane.locator(".comms-source-detail")).toBeVisible();
  await expect(pane.locator(".comms-results")).toBeVisible();
});

test("shows the kakao relay panel and auth badge against browser mocks", async ({ page }) => {
  await page.goto("/");

  const rail = page.locator(".activity-rail");
  await rail.getByRole("button", { name: "메시지", exact: true }).click();

  const pane = page.locator(".comms-pane");
  await expect(pane).toBeVisible();

  // Drill into the kakao source via the selector.
  await pane
    .locator(".comms-source-selector")
    .getByRole("button", { name: /카카오톡/ })
    .click();
  await expect(pane.locator(".comms-source-detail")).toBeVisible();

  // The auth badge now renders for kakao too (mock relay reports running).
  await expect(pane.locator(".source-controls .auth-status-badge")).toBeVisible();

  // The relay panel renders the mock room + captured messages, read-only viewer.
  const panel = pane.locator(".kakao-relay-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator("select").first()).toBeVisible();
  await expect(panel.locator(".kakao-relay-message")).toHaveCount(2);
  await expect(panel.getByText("이번 주 일정 공유드립니다.")).toBeVisible();

  // The composer is available because the mock room is send-allowed.
  await expect(
    panel.getByRole("button", { name: "보내기", exact: true }),
  ).toBeVisible();
});

test("filters processed results on the backend and refreshes without clearing the list", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    let releaseInitialSnapshot: (() => void) | null = null;
    let initialSnapshotResolved = false;
    const initialSnapshotGate = new Promise<void>((resolve) => {
      releaseInitialSnapshot = resolve;
    });
    const items = [
      {
        id: "gws-budget",
        status: "done",
        channel: "gws",
        provider: "gws",
        kind: "message",
        receivedAt: "2026-07-24T09:00:00+09:00",
        itemDir: "/mock/inbox/items/done/gws-budget",
        manifestPath: "/mock/inbox/items/done/gws-budget/manifest.yaml",
        summaryPath: "/mock/inbox/items/done/gws-budget/summary.md",
        routePath: null,
        extractedPath: null,
        title: "Budget approval",
        description: null,
        project: "Shared University",
        classification: "action",
        routeStatus: "routed",
        summaryPreview: "Review the shared budget.",
        rawFileCount: 1,
        updatedAt: "2026-07-24T09:01:00+09:00",
        error: null,
      },
      {
        id: "mso-contract",
        status: "done",
        channel: "mso",
        provider: "mso",
        kind: "message",
        receivedAt: "2026-07-24T08:00:00+09:00",
        itemDir: "/mock/inbox/items/done/mso-contract",
        manifestPath: "/mock/inbox/items/done/mso-contract/manifest.yaml",
        summaryPath: "/mock/inbox/items/done/mso-contract/summary.md",
        routePath: null,
        extractedPath: null,
        title: "Contract review",
        description: null,
        project: "Research",
        classification: "action",
        routeStatus: "routed",
        summaryPreview: "Review the contract.",
        rawFileCount: 1,
        updatedAt: "2026-07-24T08:01:00+09:00",
        error: null,
      },
    ];
    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      scan_inbox_processed_snapshot: async (args) => {
        calls.push({ command: "scan_inbox_processed_snapshot", args });
        const channel = typeof args.channel === "string" ? args.channel : null;
        const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
        if (!channel) {
          await initialSnapshotGate;
          initialSnapshotResolved = true;
        }
        return {
          items: items.filter(
            (item) =>
              (!channel || item.channel === channel) &&
              (!query ||
                item.title.toLowerCase().includes(query) ||
                item.summaryPreview.toLowerCase().includes(query)),
          ),
          counts: channel
            ? { gws: 1, mso: 1, telegram: 0, kakao: 0 }
            : { gws: 99, mso: 99, telegram: 0, kakao: 0 },
        };
      },
      read_inbox_source_runs: (args) => {
        calls.push({ command: "read_inbox_source_runs", args });
        return [];
      },
    };
    (
      window as unknown as {
        __MARU_E2E_INVOKE__: typeof handlers;
        __MARU_COMMS_CALLS__: typeof calls;
        __MARU_RELEASE_INITIAL_SNAPSHOT__: () => void;
        __MARU_INITIAL_SNAPSHOT_RESOLVED__: () => boolean;
      }
    ).__MARU_E2E_INVOKE__ = handlers;
    (
      window as unknown as {
        __MARU_COMMS_CALLS__: typeof calls;
      }
    ).__MARU_COMMS_CALLS__ = calls;
    (
      window as unknown as {
        __MARU_RELEASE_INITIAL_SNAPSHOT__: () => void;
      }
    ).__MARU_RELEASE_INITIAL_SNAPSHOT__ = () => releaseInitialSnapshot?.();
    (
      window as unknown as {
        __MARU_INITIAL_SNAPSHOT_RESOLVED__: () => boolean;
      }
    ).__MARU_INITIAL_SNAPSHOT_RESOLVED__ = () => initialSnapshotResolved;
  });
  await page.goto("/");
  await page
    .locator(".activity-rail")
    .getByRole("button", { name: "메시지", exact: true })
    .click();

  const pane = page.locator(".comms-pane");
  const gmailFilter = pane
    .locator(".comms-source-selector")
    .getByRole("button", { name: /Gmail/ });
  await gmailFilter.click();
  await expect(pane.locator(".processed-row", { hasText: "Budget approval" })).toBeVisible();
  await expect(pane.locator(".processed-row", { hasText: "Contract review" })).toHaveCount(0);
  await expect(gmailFilter.locator(".count")).toHaveText("1");
  await page.evaluate(() => {
    (
      window as unknown as {
        __MARU_RELEASE_INITIAL_SNAPSHOT__?: () => void;
      }
    ).__MARU_RELEASE_INITIAL_SNAPSHOT__?.();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __MARU_INITIAL_SNAPSHOT_RESOLVED__?: () => boolean;
            }
          ).__MARU_INITIAL_SNAPSHOT_RESOLVED__?.() ?? false,
      ),
    )
    .toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(pane.locator(".processed-row", { hasText: "Contract review" })).toHaveCount(0);
  await expect(gmailFilter.locator(".count")).toHaveText("1");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __MARU_COMMS_CALLS__?: Array<{
                command: string;
                args: Record<string, unknown>;
              }>;
            }
          ).__MARU_COMMS_CALLS__?.some(
            (call) =>
              call.command === "scan_inbox_processed_snapshot" &&
              call.args.channel === "gws",
          ) ?? false,
      ),
    )
    .toBe(true);

  await pane.getByPlaceholder("처리된 항목 검색").fill("Budget");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __MARU_COMMS_CALLS__?: Array<{
                command: string;
                args: Record<string, unknown>;
              }>;
            }
          ).__MARU_COMMS_CALLS__?.some(
            (call) =>
              call.command === "scan_inbox_processed_snapshot" &&
              call.args.channel === "gws" &&
              call.args.query === "Budget",
          ) ?? false,
      ),
    )
    .toBe(true);

  await pane.getByRole("button", { name: "처리된 항목 새로고침" }).click();
  await expect(pane.locator(".processed-row", { hasText: "Budget approval" })).toBeVisible();
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __MARU_COMMS_CALLS__?: Array<{
            command: string;
            args: Record<string, unknown>;
          }>;
        }
      ).__MARU_COMMS_CALLS__ ?? [],
  );
  expect(calls.map((call) => call.command)).not.toContain(
    "count_inbox_processed_by_channel",
  );
  expect(
    calls.filter(
      (call) =>
        call.command === "scan_inbox_processed_snapshot" &&
        call.args.channel === null,
    ),
  ).toHaveLength(1);
});
