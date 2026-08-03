import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("maru:e2e:storage-cleared", "true");
  });
});

test("keeps the E2E console hidden in normal app mode", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: "E2E 플로우" })).toHaveCount(0);
  await expect(page.getByTestId("e2e-flow-pane")).toHaveCount(0);
});

test("runs the single-screen Maru E2E sample flow and re-queries saved metadata", async ({
  page,
}) => {
  await page.goto("/?maru-e2e=1");

  await page.getByRole("button", { name: "E2E 플로우", exact: true }).click();
  const pane = page.getByTestId("e2e-flow-pane");
  await expect(pane).toBeVisible();
  await expect(pane).toContainText("샘플 입력 선택");
  await expect(pane).toContainText("스킬 등록");

  await page.getByTestId("e2e-run").click();
  await expect(page.getByTestId("e2e-report-preview")).toContainText(
    "Maru E2E Development Report",
  );
  await expect(page.getByTestId("e2e-save-id")).toContainText(/^maru-e2e-/);
  await expect(pane).toContainText("등록 · 편집 · 실행 완료");
  await expect(pane).toContainText("baseline 4019.88ms");
  console.log(`[e2e-flow-timing] ${await page.getByTestId("e2e-performance-summary").textContent()}`);

  await page.getByTestId("e2e-lookup").click();
  await expect(page.getByTestId("e2e-lookup-status")).toContainText("메타데이터 재조회 완료");
});
