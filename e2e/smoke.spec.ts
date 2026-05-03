import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test("boots the sample workspace and opens multiple editor tabs", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Sample Workspace" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Private" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Public 추가" })).toBeVisible();
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

test("switches explorer between private and optional public workspace tabs", async ({
  page,
}) => {
  await page.goto("/?mockPublic=1");

  const privateTab = page.getByRole("tab", { name: "Private" });
  const publicTab = page.getByRole("tab", { name: "Public" });
  await expect(privateTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".workspace-caption")).toHaveText(
    "Sample Workspace · Local · 쓰기 가능",
  );
  await expect(page.getByRole("button", { name: "Public 추가" })).toHaveCount(0);

  await publicTab.click();

  await expect(publicTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".workspace-caption")).toHaveText(
    "Public Workspace · Google Drive · 쓰기 가능",
  );
  await expect(page.locator(".document-list").getByRole("button", { name: /Anchor 용어집/ })).toBeVisible();
});

test("switches between public provider roots and gates read-only actions", async ({
  page,
}) => {
  await page.goto("/?mockPublic=1");

  await page.getByRole("tab", { name: "Public" }).click();
  await expect(page.locator(".workspace-caption")).toHaveText(
    "Public Workspace · Google Drive · 쓰기 가능",
  );
  await page.locator(".workspace-switcher").click();
  await page.locator(".workspace-menu-item", { hasText: "Shared Reference" }).click();

  await expect(page.locator(".workspace-caption")).toHaveText(
    "Shared Reference · SharePoint · 읽기 전용",
  );

  const documentList = page.locator(".document-list");
  await documentList.getByRole("button", { name: /Anchor 용어집/ }).click();
  await page.locator(".tab-trigger", { hasText: "원문" }).click();

  await expect(page.locator("textarea.source-editor")).toHaveAttribute("readonly", "");
  await expect(page.getByRole("button", { name: "스냅샷" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "저장" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "새 문서" })).toBeDisabled();
});

test("restores a dense shell with tabbed explorer and collapsed terminal", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.locator(".terminal-panel")).toHaveClass(/collapsed/);
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".document-list")).toBeVisible();

  const rail = page.locator(".activity-rail");
  await rail.getByLabel("문서 타입 패널 숨기기").click();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await rail.getByLabel("문서 타입 패널 보이기").click();
  await expect(page.locator(".sidebar")).toBeVisible();

  await rail.getByLabel("문서 패널 숨기기").click();
  await expect(page.locator(".document-list")).toHaveCount(0);
  await rail.getByLabel("문서 패널 보이기").click();
  await expect(page.locator(".document-list")).toBeVisible();
});

test("supports tree bulk controls and Finder context menu", async ({ page }) => {
  await page.goto("/");

  const documentList = page.locator(".document-list");
  await expect(documentList.getByRole("button", { name: /references/ })).toBeVisible();
  await expect(documentList.getByRole("button", { name: /Anchor 용어집/ })).toBeVisible();

  await documentList.getByRole("button", { name: "모두 접기" }).click();
  await expect(documentList.getByRole("button", { name: /Anchor 용어집/ })).toHaveCount(0);

  await documentList.getByRole("button", { name: "모두 펴기" }).click();
  await expect(documentList.getByRole("button", { name: /Anchor 용어집/ })).toBeVisible();

  await documentList.getByRole("button", { name: /Anchor 용어집/ }).click({
    button: "right",
  });
  await expect(page.getByRole("button", { name: "Finder에서 보기" })).toBeVisible();
});

test("centers the empty editor placeholder", async ({ page }) => {
  await page.goto("/");

  await page.locator(".document-tab-close").first().click();
  const editor = page.locator(".editor-empty");
  const plate = editor.locator(".empty-document-plate");
  await expect(plate).toBeVisible();

  const editorBox = await editor.boundingBox();
  const plateBox = await plate.boundingBox();
  expect(editorBox).not.toBeNull();
  expect(plateBox).not.toBeNull();
  if (!editorBox || !plateBox) return;

  const editorCenter = {
    x: editorBox.x + editorBox.width / 2,
    y: editorBox.y + editorBox.height / 2,
  };
  const plateCenter = {
    x: plateBox.x + plateBox.width / 2,
    y: plateBox.y + plateBox.height / 2,
  };

  expect(Math.abs(editorCenter.x - plateCenter.x)).toBeLessThan(2);
  expect(Math.abs(editorCenter.y - plateCenter.y)).toBeLessThan(2);
});

test("keeps the settings window content anchored at the top", async ({ page }) => {
  await page.goto("/?window=settings&workPath=mock://anchor-sample-workspace");

  const pane = page.locator(".settings-window-shell .system-pane");
  const header = pane.locator(".system-header");
  const activeTab = pane.locator(".system-tab.active");

  await expect(header.getByRole("heading", { name: "시스템" })).toBeVisible();
  await expect(activeTab).toHaveText("Preferences");

  const paneBox = await pane.boundingBox();
  const headerBox = await header.boundingBox();
  const tabBox = await activeTab.boundingBox();
  expect(paneBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(tabBox).not.toBeNull();
  if (!paneBox || !headerBox || !tabBox) return;

  expect(paneBox.y).toBeLessThan(2);
  expect(headerBox.y).toBeLessThan(24);
  expect(tabBox.y).toBeLessThan(96);
});
