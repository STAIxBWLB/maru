import { expect, test, type Page } from "@playwright/test";

/**
 * E2E coverage for the Safe WYSIWYG HTML editor (.html/.htm document tabs).
 *
 * Harness notes:
 * - The app runs in browser-mock mode (no Tauri runtime); `pnpm dev` serves
 *   the frontend and `src/lib/api.ts` falls back to `src/lib/fixtures.ts`.
 * - HTML fixture documents live behind the `?mockHtml=1` query param (same
 *   opt-in pattern as `?mockPublic=1`) so other specs are unaffected.
 * - `prepareHtmlEditorAssets` returns `{ documentDirectory: "" }` in mock
 *   mode, so relative local asset URLs stay UNTOUCHED in the iframe srcdoc.
 *   The rewrite to `asset:` URLs only happens in the native app and cannot
 *   be observed here; what IS observable is that remote http(s) assets are
 *   blocked (attribute removed + warning banner) and relative URLs survive.
 * - iframe srcdoc works in Chromium and the visual iframe uses
 *   sandbox="allow-same-origin", so frameLocator can read/type into the body.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("maru:e2e:storage-cleared", "true");
  });
});

const VISUAL_FRAME = '[data-testid="html-editor-frame"]';

/** Open an HTML fixture file from the Files explorer as a document tab. */
async function openHtmlDocument(page: Page, name: RegExp, relPath: string) {
  await page.goto("/?mockHtml=1");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "Files" }).click();
  await explorer.getByRole("button", { name: "전체" }).click();
  await explorer.getByRole("button", { name: "모두 펴기" }).click();
  await explorer.getByRole("button", { name }).dblclick();

  await expect(page.locator(`.document-tab[title='${relPath}']`)).toBeVisible();
}

test("opens an .html document in Visual mode by default", async ({ page }) => {
  await openHtmlDocument(page, /clean-report\.html/, "clean-report.html");

  // Visual is the default tab; Source/Preview sit next to it.
  await expect(page.locator(".tab-trigger", { hasText: "비주얼" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".tab-trigger", { hasText: "원문" })).toBeVisible();
  await expect(page.locator(".tab-trigger", { hasText: "미리보기" })).toBeVisible();

  // Toolbar + sandboxed iframe render; body content is visible inside.
  await expect(page.locator(".html-editor-toolbar")).toBeVisible();
  const frameElement = page.locator(VISUAL_FRAME);
  await expect(frameElement).toBeVisible();
  await expect(frameElement).toHaveAttribute("sandbox", "allow-same-origin");
  const body = page.frameLocator(VISUAL_FRAME).locator("body");
  await expect(body).toContainText("클린 문서");
  await expect(body).toHaveAttribute("contenteditable", "true");

  // Clean document: no risk overlay, no asset warning, status bar shows HTML.
  await expect(page.locator('[data-testid="html-editor-risk"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="html-editor-asset-warning"]')).toHaveCount(0);
  await expect(page.locator(".editor-status")).toContainText("HTML");
});

test("strips scripts from the runtime document but keeps them in source", async ({ page }) => {
  await openHtmlDocument(page, /sample-page\.html/, "sample-page.html");

  // The risk overlay gates visual editing for scripted documents; confirm it.
  const riskOverlay = page.locator('[data-testid="html-editor-risk"]');
  await expect(riskOverlay).toBeVisible();
  await expect(riskOverlay).toContainText("스크립트");
  await riskOverlay.getByRole("button", { name: "계속 편집" }).click();
  await expect(riskOverlay).toHaveCount(0);

  // The iframe renders the document body…
  const frameElement = page.locator(VISUAL_FRAME);
  await expect(frameElement).toBeVisible();
  await expect(page.frameLocator(VISUAL_FRAME).locator("body")).toContainText("분기 보고서");

  // …but the script never runs: not in the top page, not inside the iframe.
  expect(await page.evaluate(() => (window as never as Record<string, unknown>).__maruScriptRan))
    .toBeUndefined();
  const frameHandle = await frameElement.elementHandle();
  const frame = await frameHandle?.contentFrame();
  expect(frame).not.toBeNull();
  expect(await frame!.evaluate(() => (window as never as Record<string, unknown>).__maruScriptRan))
    .toBeUndefined();

  // The runtime srcdoc has no <script> and carries the injected CSP meta.
  const srcdoc = await frameElement.getAttribute("srcdoc");
  expect(srcdoc).not.toBeNull();
  expect(srcdoc).not.toContain("<script");
  expect(srcdoc).toContain("Content-Security-Policy");

  // Source mode still shows the raw, unsanitized document.
  await page.locator(".tab-trigger", { hasText: "원문" }).click();
  await expect(page.locator("textarea.source-editor")).toHaveValue(
    /<script>window\.__maruScriptRan = true<\/script>/,
  );
});

test("preserves the document shell through visual editing and saving", async ({ page }) => {
  await openHtmlDocument(page, /sample-page\.html/, "sample-page.html");

  const riskOverlay = page.locator('[data-testid="html-editor-risk"]');
  await expect(riskOverlay).toBeVisible();
  await riskOverlay.getByRole("button", { name: "계속 편집" }).click();

  // Type into the visual iframe body; the debounced serialize marks the draft
  // dirty (save button enables).
  const body = page.frameLocator(VISUAL_FRAME).locator("body");
  await body.click();
  await page.keyboard.type("E2E 추가 문장");
  const saveButton = page.getByRole("button", { name: "저장" });
  await expect(saveButton).toBeEnabled();

  // Switching to Source flushes the iframe edit: doctype/head/body attrs are
  // preserved byte-for-byte and only the body contents changed.
  await page.locator(".tab-trigger", { hasText: "원문" }).click();
  const textarea = page.locator("textarea.source-editor");
  await expect(textarea).toHaveValue(/E2E 추가 문장/);
  const source = await textarea.inputValue();
  // Byte-identity of the shell: the head (incl. the untouched <script>) and
  // the </body></html> tail survive the edit exactly; only body contents change.
  const SHELL_PREFIX =
    '<!DOCTYPE html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n' +
    "<title>Maru HTML 샘플</title>\n<style>body { color: #333; }</style>\n" +
    "<script>window.__maruScriptRan = true</script>\n</head>\n" +
    '<body class="report">';
  expect(source.startsWith(SHELL_PREFIX)).toBe(true);
  expect(source.endsWith("</body>\n</html>\n")).toBe(true);

  // Save through the mock backend, then close + reopen the tab to prove the
  // edit round-tripped through read/write (mock saveDocument mutates the
  // fixture document in place, so a fresh read must show the typed text).
  await saveButton.click();
  await expect(page.locator(".save-state.saved")).toBeVisible();
  await page
    .locator(".document-tab[title='sample-page.html']")
    .locator(".document-tab-close")
    .click();
  await expect(page.locator(".document-tab[title='sample-page.html']")).toHaveCount(0);

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "모두 펴기" }).click();
  await explorer.getByRole("button", { name: /sample-page\.html/ }).dblclick();
  await expect(page.locator(".document-tab[title='sample-page.html']")).toBeVisible();
  await page.locator(".tab-trigger", { hasText: "원문" }).click();
  await expect(page.locator("textarea.source-editor")).toHaveValue(/E2E 추가 문장/);
});

test("renders Preview in a locked-down frame without scripts", async ({ page }) => {
  await openHtmlDocument(page, /sample-page\.html/, "sample-page.html");

  // The risk overlay only gates Visual mode; Preview can open directly.
  await expect(page.locator('[data-testid="html-editor-risk"]')).toBeVisible();
  await page.locator(".tab-trigger", { hasText: "미리보기" }).click();

  const preview = page.locator('[data-testid="html-preview-frame"]');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("sandbox", "");
  const srcdoc = await preview.getAttribute("srcdoc");
  expect(srcdoc).not.toBeNull();
  expect(srcdoc).not.toContain("<script");
  expect(srcdoc).toContain("분기 보고서");
});

test("cancelling the risk overlay switches to Source mode", async ({ page }) => {
  await openHtmlDocument(page, /sample-page\.html/, "sample-page.html");

  const riskOverlay = page.locator('[data-testid="html-editor-risk"]');
  await expect(riskOverlay).toBeVisible();
  await riskOverlay.getByRole("button", { name: "취소" }).click();

  await expect(page.locator(".tab-trigger", { hasText: "원문" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("textarea.source-editor")).toHaveValue(
    /<script>window\.__maruScriptRan = true<\/script>/,
  );
});

test("falls back to an Open-in-Source action for malformed documents", async ({ page }) => {
  await openHtmlDocument(page, /malformed\.html/, "malformed.html");

  const fallback = page.locator('[data-testid="html-editor-malformed"]');
  await expect(fallback).toBeVisible();
  await fallback.getByRole("button", { name: "원문으로 열기" }).click();

  await expect(page.locator(".tab-trigger", { hasText: "원문" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("textarea.source-editor")).toHaveValue(/<html><head>/);
});

test("blocks remote assets and keeps relative URLs in browser-mock mode", async ({ page }) => {
  await openHtmlDocument(page, /remote-assets\.html/, "remote-assets.html");

  // One remote https:// asset was stripped from the runtime document.
  const warning = page.locator('[data-testid="html-editor-asset-warning"]');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("1개");

  const frameElement = page.locator(VISUAL_FRAME);
  await expect(frameElement).toBeVisible();
  const srcdoc = await frameElement.getAttribute("srcdoc");
  expect(srcdoc).not.toBeNull();
  expect(srcdoc).not.toContain("https://example.com");
  // Browser-mock mode has no asset protocol (documentDirectory ""), so the
  // relative URL is left untouched here. In the native app it is rewritten to
  // an asset: URL instead — that path needs the real Tauri backend to verify.
  expect(srcdoc).toContain("./local-image.png");
});
