import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("maru:e2e:storage-cleared", "true");
  });
});

/** Maru follows the browser platform for `mod`; Desktop Chrome advertises a
 *  Windows UA even on macOS (see smoke.spec.ts). */
async function appCombo(page: Page, key: string): Promise<string> {
  const mod = await page.evaluate(() =>
    navigator.platform.toLowerCase().includes("mac") ? "Meta" : "Control",
  );
  return `${mod}+${key}`;
}

async function openGlossary(page: Page) {
  await page.goto("/");
  const documentList = page.locator(".document-list");
  await documentList.getByRole("button", { name: "모두 펴기" }).click();
  await documentList.getByRole("button", { name: /Maru 용어집/ }).click();
  await expect(
    page.locator(".document-tab-title", { hasText: "Maru 용어집" }),
  ).toBeVisible();
}

test("Cmd+F finds text in the document body (source and preview)", async ({ page }) => {
  await openGlossary(page);
  const findCombo = await appCombo(page, "f");

  // Source mode: the bar opens, matches drive the textarea selection.
  await page.locator(".tab-trigger", { hasText: "원문" }).click();
  const textarea = page.locator("textarea.source-editor");
  await expect(textarea).toBeVisible();
  await page.keyboard.press(findCombo);
  const findBar = page.locator(".editor-find-bar");
  await expect(findBar).toBeVisible();
  await expect(findBar.locator(".editor-find-input")).toBeFocused();

  await findBar.locator(".editor-find-input").fill("본부");
  await expect(findBar.locator(".editor-find-count")).toHaveText(/1 \/ [2-9]/);
  const firstSelection = await textarea.evaluate((el: HTMLTextAreaElement) => ({
    start: el.selectionStart,
    end: el.selectionEnd,
    selected: el.value.slice(el.selectionStart, el.selectionEnd),
  }));
  expect(firstSelection.selected).toBe("본부");

  // Enter cycles to the next match.
  await findBar.locator(".editor-find-input").press("Enter");
  await expect(findBar.locator(".editor-find-count")).toHaveText(/2 \/ [2-9]/);
  const secondSelection = await textarea.evaluate((el: HTMLTextAreaElement) => ({
    start: el.selectionStart,
    selected: el.value.slice(el.selectionStart, el.selectionEnd),
  }));
  expect(secondSelection.selected).toBe("본부");
  expect(secondSelection.start).not.toBe(firstSelection.start);

  // Esc closes the bar.
  await findBar.locator(".editor-find-input").press("Escape");
  await expect(page.locator(".editor-find-bar")).toHaveCount(0);

  // Preview mode: matches are highlighted, the current one is distinct.
  await page.locator(".tab-trigger", { hasText: "미리보기" }).click();
  const preview = page.locator(".preview-surface");
  await expect(preview).toContainText("Maru 용어집");
  await page.keyboard.press(findCombo);
  await expect(findBar).toBeVisible();
  await findBar.locator(".editor-find-input").fill("본부");
  await expect(preview.locator("mark.find-mark").first()).toBeVisible();
  await expect(preview.locator("mark.find-mark-current")).toHaveCount(1);
  await expect(findBar.locator(".editor-find-count")).toHaveText(/1 \/ [2-9]/);
  await findBar.locator(".editor-find-input").press("Enter");
  await expect(findBar.locator(".editor-find-count")).toHaveText(/2 \/ [2-9]/);
  await expect(preview.locator("mark.find-mark-current")).toHaveCount(1);

  // Closing the bar removes every mark.
  await findBar.locator(".editor-find-input").press("Escape");
  await expect(preview.locator("mark.find-mark")).toHaveCount(0);
});

test("Cmd+A selects only the document body, never the chrome", async ({ page }) => {
  await openGlossary(page);
  const selectAllCombo = await appCombo(page, "a");

  await page.locator(".tab-trigger", { hasText: "미리보기" }).click();
  const preview = page.locator(".preview-surface");
  await expect(preview).toContainText("Maru 용어집");
  await preview.click({ position: { x: 80, y: 80 } });
  await page.keyboard.press(selectAllCombo);

  const scoped = await page.evaluate(() => {
    const selection = window.getSelection();
    const node = selection?.anchorNode ?? null;
    const el = node instanceof HTMLElement ? node : node?.parentElement ?? null;
    return {
      text: selection?.toString() ?? "",
      inPreview: el?.closest(".preview-surface") !== null,
      inList: el?.closest(".document-list") !== null,
    };
  });
  expect(scoped.inPreview).toBe(true);
  expect(scoped.inList).toBe(false);
  expect(scoped.text).toContain("Maru 용어집");

  // Cmd+A on chrome (the document tab strip) selects nothing.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.locator(".document-tabs-row").first().click();
  await page.keyboard.press(selectAllCombo);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""))
    .toBe("");
});

test("Cmd+Shift+F focuses the document list search", async ({ page }) => {
  await openGlossary(page);
  const listSearchCombo = await appCombo(page, "Shift+F");
  await page.keyboard.press(listSearchCombo);
  await expect(page.getByPlaceholder("제목, 경로, 메타데이터, 요약 검색")).toBeFocused();
});
