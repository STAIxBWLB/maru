import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test("boots the sample vault and opens multiple editor tabs", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Sample Vault" })).toBeVisible();
  const documentList = page.locator(".document-list");
  await expect(documentList.getByRole("button", { name: /Anchor 사업 주간 점검 회의/ })).toBeVisible();

  await documentList.getByRole("button", { name: /Anchor 용어집/ }).click();

  await expect(page.locator(".document-tab-title", { hasText: "Anchor 사업 주간 점검 회의" })).toBeVisible();
  await expect(page.locator(".document-tab-title", { hasText: "Anchor 용어집" })).toBeVisible();

  await page.locator(".tab-trigger", { hasText: "원문" }).click();
  await expect(page.locator("textarea.source-editor")).toHaveValue(/# Anchor 용어집/);

  await page.locator(".tab-trigger", { hasText: "미리보기" }).click();
  await expect(page.locator(".preview-surface")).toContainText("Anchor 용어집");
});
