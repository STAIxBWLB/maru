import { expect, test } from "@playwright/test";

test("opens a binary file as a viewer tab", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "Files" }).click();
  await explorer.getByRole("button", { name: "모두 펴기" }).click();

  const pdfRow = explorer.getByRole("button", { name: /rise-budget-review\.pdf/ });
  await expect(pdfRow).toBeVisible();
  await pdfRow.dblclick();

  const pdfTab = page.locator(
    ".document-tab-title",
    { hasText: "rise-budget-review.pdf" },
  );
  await expect(pdfTab).toBeVisible();
  await expect(page.locator(".binary-viewer-shell")).toBeVisible();
  await expect(page.locator(".binary-viewer-header strong")).toHaveText(
    "rise-budget-review.pdf",
  );
  await expect(page.locator(".binary-viewer-native-pdf")).toBeVisible();
  await expect(page.locator(".binary-viewer--pdf")).toContainText("WebView");

  // Closing the binary tab from the strip removes the viewer.
  await page
    .locator(".document-tab", { has: pdfTab })
    .locator(".document-tab-close")
    .click();
  await expect(pdfTab).toHaveCount(0);
  await expect(page.locator(".binary-viewer-shell")).toHaveCount(0);
});

test("right-clicking a binary file exposes Open file menu item", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "Files" }).click();
  await explorer.getByRole("button", { name: "모두 펴기" }).click();

  await explorer
    .getByRole("button", { name: /rise-budget-review\.pdf/ })
    .click({ button: "right" });

  await expect(
    page.locator(".context-menu").getByRole("menuitem", { name: "파일 열기" }),
  ).toBeVisible();
});

test("opens unsupported binaries in a safe fallback viewer", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "Files" }).click();
  await explorer.getByRole("button", { name: "모두 펴기" }).click();

  await explorer.getByRole("button", { name: /raw-dump\.bin/ }).dblclick();

  await expect(page.locator(".document-tab[title='attachments/raw-dump.bin']")).toBeVisible();
  await expect(page.locator(".binary-viewer--unsupported")).toBeVisible();
  await expect(page.locator(".binary-viewer--unsupported")).toContainText(
    "미리보기를 지원하지 않는 파일",
  );
  await expect(page.locator(".binary-viewer--unsupported")).toContainText("시스템 미리보기");
});

test("opens Office binaries as system preview shells", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "Files" }).click();
  await explorer.getByRole("button", { name: "모두 펴기" }).click();

  await explorer.getByRole("button", { name: /sample-report\.docx/ }).dblclick();
  await expect(page.locator(".document-tab[title='attachments/sample-report.docx']")).toBeVisible();
  await expect(page.locator(".binary-viewer--docx.binary-viewer--system-preview")).toBeVisible();
  await expect(page.locator(".binary-viewer--docx")).toContainText("시스템 미리보기");
  await expect(page.locator(".binary-viewer-canvas--docx")).toHaveCount(0);

  await explorer.getByRole("button", { name: /weekly-kpi\.xlsx/ }).dblclick();
  await expect(page.locator(".document-tab[title='attachments/weekly-kpi.xlsx']")).toBeVisible();
  await expect(page.locator(".binary-viewer--xlsx.binary-viewer--system-preview")).toBeVisible();
  await expect(page.locator(".binary-viewer--xlsx")).toContainText("시스템 미리보기");
  await expect(page.locator(".binary-viewer-canvas--xlsx")).toHaveCount(0);
});

test("keeps mixed document and binary tabs in visible order", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "Files" }).click();
  await explorer.getByRole("button", { name: "모두 펴기" }).click();
  await explorer.getByRole("button", { name: /rise-budget-review\.pdf/ }).dblclick();
  await expect(page.locator(".document-tab[title='attachments/rise-budget-review.pdf']")).toBeVisible();
  await explorer.getByRole("button", { name: /anchor-glossary\.md/ }).dblclick();

  const tabPaths = await page.locator(".document-tab").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("title")),
  );
  expect(tabPaths).toEqual([
    "anchor-weekly-meeting.md",
    "attachments/rise-budget-review.pdf",
    "references/anchor-glossary.md",
  ]);

  await page.locator(".document-tab[title='attachments/rise-budget-review.pdf']").click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "오른쪽 탭 닫기" }).click();
  await expect(page.locator(".document-tab[title='references/anchor-glossary.md']")).toHaveCount(0);
  await expect(page.locator(".document-tab[title='attachments/rise-budget-review.pdf']")).toBeVisible();
});

test("can split a binary viewer to the right pane", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "Files" }).click();
  await explorer.getByRole("button", { name: "모두 펴기" }).click();
  await explorer.getByRole("button", { name: /rise-budget-review\.pdf/ }).dblclick();

  await page.getByRole("button", { name: "오른쪽으로 분할" }).click();
  await expect(page.locator(".binary-viewer-shell")).toHaveCount(2);
});
