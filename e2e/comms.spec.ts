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

test("filters processed results on the backend and refreshes without clearing the list", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
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
      scan_inbox_processed_items: (args) => {
        calls.push({ command: "scan_inbox_processed_items", args });
        const channel = typeof args.channel === "string" ? args.channel : null;
        const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
        return items.filter(
          (item) =>
            (!channel || item.channel === channel) &&
            (!query ||
              item.title.toLowerCase().includes(query) ||
              item.summaryPreview.toLowerCase().includes(query)),
        );
      },
      read_inbox_source_runs: (args) => {
        calls.push({ command: "read_inbox_source_runs", args });
        return [];
      },
      count_inbox_processed_by_channel: (args) => {
        calls.push({ command: "count_inbox_processed_by_channel", args });
        return { gws: 1, mso: 1, telegram: 0, kakao: 0 };
      },
    };
    (
      window as unknown as {
        __MARU_E2E_INVOKE__: typeof handlers;
        __MARU_COMMS_CALLS__: typeof calls;
      }
    ).__MARU_E2E_INVOKE__ = handlers;
    (
      window as unknown as {
        __MARU_COMMS_CALLS__: typeof calls;
      }
    ).__MARU_COMMS_CALLS__ = calls;
  });
  await page.goto("/");
  await page
    .locator(".activity-rail")
    .getByRole("button", { name: "메시지", exact: true })
    .click();

  const pane = page.locator(".comms-pane");
  await pane.locator(".comms-source-selector").getByRole("button", { name: /Gmail/ }).click();
  await expect(pane.locator(".processed-row", { hasText: "Budget approval" })).toBeVisible();
  await expect(pane.locator(".processed-row", { hasText: "Contract review" })).toHaveCount(0);
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
              call.command === "scan_inbox_processed_items" &&
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
              call.command === "scan_inbox_processed_items" &&
              call.args.channel === "gws" &&
              call.args.query === "Budget",
          ) ?? false,
      ),
    )
    .toBe(true);

  await pane.getByRole("button", { name: "처리된 항목 새로고침" }).click();
  await expect(pane.locator(".processed-row", { hasText: "Budget approval" })).toBeVisible();
});
