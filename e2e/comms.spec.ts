import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("anchor:e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("anchor:e2e:storage-cleared", "true");
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
