import { expect, test, type Page } from "@playwright/test";

async function openAttachments(page: Page) {
  await page.goto("/");
  await page.locator(".activity-rail").getByRole("button", { name: "파일", exact: true }).click();
  const files = page.locator(".files-workbench");
  await expect(files).toBeVisible();
  await files.locator(".files-list-row", { hasText: "attachments" }).dblclick();
  await expect(files.locator(".files-breadcrumbs")).toContainText("attachments");
  return files;
}

test("previews a binary file without leaving Files", async ({ page }) => {
  const files = await openAttachments(page);

  await files.locator(".files-list-row", { hasText: "rise-budget-review.pdf" }).click();

  await expect(files.locator(".binary-viewer-shell")).toBeVisible();
  await expect(files.locator(".binary-viewer-header strong")).toHaveText(
    "rise-budget-review.pdf",
  );
  await expect(files.locator(".binary-viewer-native-pdf")).toBeVisible();
  await expect(files.locator(".binary-viewer--pdf")).toContainText("WebView");
  await expect(page.locator(".files-workbench")).toBeVisible();
});

test("right-clicking a binary file exposes file operations", async ({ page }) => {
  const files = await openAttachments(page);

  await files
    .locator(".files-list-row", { hasText: "rise-budget-review.pdf" })
    .click({ button: "right" });

  const menu = page.locator(".files-context-menu");
  await expect(menu.getByRole("menuitem", { name: "열기", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "이름 변경" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "휴지통으로 이동" })).toBeVisible();
});

test("previews unsupported binaries in a safe fallback", async ({ page }) => {
  const files = await openAttachments(page);

  await files.locator(".files-list-row", { hasText: "raw-dump.bin" }).click();

  await expect(files.locator(".binary-viewer--unsupported")).toBeVisible();
  await expect(files.locator(".binary-viewer--unsupported")).toContainText(
    "미리보기를 지원하지 않는 파일",
  );
  await expect(files.locator(".binary-viewer--unsupported")).toContainText("시스템 미리보기");
});

test("previews Office binaries as system preview shells", async ({ page }) => {
  const files = await openAttachments(page);

  await files.locator(".files-list-row", { hasText: "sample-report.docx" }).click();
  await expect(
    files.locator(".binary-viewer--docx.binary-viewer--system-preview"),
  ).toBeVisible();
  await expect(files.locator(".binary-viewer--docx")).toContainText("시스템 미리보기");

  await files.locator(".files-list-row", { hasText: "weekly-kpi.xlsx" }).click();
  await expect(
    files.locator(".binary-viewer--xlsx.binary-viewer--system-preview"),
  ).toBeVisible();
  await expect(files.locator(".binary-viewer--xlsx")).toContainText("시스템 미리보기");
});

test("summarizes multi-selection in the preview pane", async ({ page }) => {
  const files = await openAttachments(page);
  const pdf = files.locator(".files-list-row", { hasText: "rise-budget-review.pdf" });
  const sheet = files.locator(".files-list-row", { hasText: "weekly-kpi.xlsx" });

  await pdf.click();
  await sheet.click({ modifiers: ["Meta"] });

  await expect(files.locator(".files-preview-summary")).toContainText("2개 항목 선택");
  await expect(files.locator(".files-preview-summary")).toContainText("파일");
});
