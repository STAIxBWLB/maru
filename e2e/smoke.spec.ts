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

  await documentList.getByRole("button", { name: "모두 펴기" }).click();
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
  const documentList = page.locator(".document-list");
  await expect(documentList.getByRole("button", { name: /references/ })).toBeVisible();
  await expect(documentList.getByRole("button", { name: /Anchor 용어집/ })).toHaveCount(0);
  await documentList.getByRole("button", { name: "모두 펴기" }).click();
  await expect(documentList.getByRole("button", { name: /Anchor 용어집/ })).toBeVisible();
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
  await documentList.getByRole("button", { name: "모두 펴기" }).click();
  await documentList.getByRole("button", { name: /Anchor 용어집/ }).click();
  await page.locator(".tab-trigger", { hasText: "원문" }).click();

  await expect(page.locator("textarea.source-editor")).toHaveAttribute("readonly", "");
  await expect(page.getByRole("button", { name: "스냅샷" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "저장" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "새 문서" })).toBeDisabled();

  await page.locator(".document-tab.active").click({ button: "right" });
  const menu = page.locator(".document-tab-context-menu");
  await expect(menu.getByRole("button", { name: "이름 변경..." })).toBeDisabled();
  await expect(menu.getByRole("button", { name: "이동..." })).toBeDisabled();
  await expect(menu.getByRole("button", { name: "복제..." })).toBeDisabled();
  await expect(menu.getByRole("button", { name: "삭제" })).toBeDisabled();
});

test("restores direct write policy when leaving Obsidian provider", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Public 추가" }).click();
  const dialog = page.locator(".dialog-content");
  const directPolicy = dialog.locator("button.chip").filter({ hasText: /^Direct$/ });
  const delegatedPolicy = dialog.locator("button.chip").filter({ hasText: /^Delegated$/ });
  const readOnlyPolicy = dialog.locator("button.chip").filter({ hasText: /^Read-only$/ });

  await dialog.getByRole("button", { name: "Obsidian", exact: true }).click();
  await expect(delegatedPolicy).toHaveClass(/active/);
  await expect(readOnlyPolicy).toBeDisabled();

  await dialog.getByRole("button", { name: "Google Drive", exact: true }).click();
  await expect(directPolicy).toHaveClass(/active/);
  await expect(readOnlyPolicy).toBeEnabled();
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
  await expect(documentList.getByRole("button", { name: /Anchor 용어집/ })).toHaveCount(0);

  await documentList.getByRole("button", { name: "모두 펴기" }).click();
  await expect(documentList.getByRole("button", { name: /Anchor 용어집/ })).toBeVisible();

  await documentList.getByRole("button", { name: "모두 접기" }).click();
  await expect(documentList.getByRole("button", { name: /Anchor 용어집/ })).toHaveCount(0);

  await documentList.getByRole("button", { name: "모두 펴기" }).click();
  await expect(documentList.getByRole("button", { name: /Anchor 용어집/ })).toBeVisible();

  await documentList.getByRole("button", { name: /Anchor 용어집/ }).click({
    button: "right",
  });
  await expect(page.getByRole("button", { name: "파일 열기" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finder에서 보기" })).toBeVisible();
  await expect(page.getByRole("button", { name: "경로 복사", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "상대 경로 복사" })).toBeVisible();
});

test("shows supported document tab menu items and performs file operations", async ({
  page,
}) => {
  await page.goto("/");

  const documentList = page.locator(".document-list");
  await documentList.getByRole("button", { name: "모두 펴기" }).click();
  await documentList.getByRole("button", { name: /Anchor 용어집/ }).click();
  await documentList.getByRole("button", { name: "목록" }).click();

  const glossaryTab = page.locator(".document-tab[title='references/anchor-glossary.md']");
  await expect(glossaryTab).toBeVisible();
  await glossaryTab.click({ button: "right" });

  const menu = page.locator(".document-tab-context-menu");
  await expect(menu.getByRole("button", { name: "닫기", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "다른 탭 닫기" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "오른쪽 탭 닫기" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "저장된 탭 닫기" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "이름 복사" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "상대 경로 복사" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "이름 변경..." })).toBeEnabled();
  await expect(menu.getByRole("button", { name: "이동..." })).toBeEnabled();
  await expect(menu.getByRole("button", { name: "복제..." })).toBeEnabled();
  await expect(menu.getByRole("button", { name: "삭제" })).toBeEnabled();
  await expect(menu.getByRole("button", { name: "미리보기 열기" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Finder에서 보기" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Explorer View에서 보기" })).toBeVisible();
  await expect(menu).not.toContainText("Remote URL");
  await expect(menu).not.toContainText("Share");
  await expect(menu).not.toContainText("Open Changes");
  await expect(menu).not.toContainText("File History");
  await expect(menu).not.toContainText("Reopen Editor With");

  await menu.getByRole("button", { name: "Explorer View에서 보기" }).click();
  const revealedGlossary = documentList.getByRole("button", { name: /Anchor 용어집/ });
  await expect(documentList.getByRole("button", { name: "트리" })).toHaveClass(/active/);
  await expect(revealedGlossary).toBeVisible();
  await expect(revealedGlossary).toBeFocused();

  await glossaryTab.click({ button: "right" });
  await page
    .locator(".document-tab-context-menu")
    .getByRole("button", { name: "복제..." })
    .click();
  const copyTab = page.locator(".document-tab[title='references/anchor-glossary-copy.md']");
  await expect(copyTab).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("prompt");
    await dialog.accept("anchor-glossary-renamed");
  });
  await copyTab.click({ button: "right" });
  await page
    .locator(".document-tab-context-menu")
    .getByRole("button", { name: "이름 변경..." })
    .click();
  const renamedTab = page.locator(".document-tab[title='references/anchor-glossary-renamed.md']");
  await expect(renamedTab).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("prompt");
    await dialog.accept("moved/anchor-glossary-renamed.md");
  });
  await renamedTab.click({ button: "right" });
  await page
    .locator(".document-tab-context-menu")
    .getByRole("button", { name: "이동..." })
    .click();
  const movedTab = page.locator(".document-tab[title='moved/anchor-glossary-renamed.md']");
  await expect(movedTab).toBeVisible();
  await expect(page.locator("textarea.source-editor")).toHaveValue(/# Anchor 용어집/);

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.accept();
  });
  await movedTab.click({ button: "right" });
  await page
    .locator(".document-tab-context-menu")
    .getByRole("button", { name: "삭제" })
    .click();
  await expect(movedTab).toHaveCount(0);
  await expect(page.locator(".toast", { hasText: ".anchor/trash/documents/moved/" })).toBeVisible();
});

test("suppresses native context menus outside document surfaces", async ({ page }) => {
  await page.goto("/");

  const topbarPrevented = await page.locator(".topbar").evaluate((node) => {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    return !node.dispatchEvent(event);
  });
  expect(topbarPrevented).toBe(true);

  const editorPrevented = await page.locator("textarea.source-editor").evaluate((node) => {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    return !node.dispatchEvent(event);
  });
  expect(editorPrevented).toBe(false);
});

test("switches between Documents and Files explorer modes", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await expect(explorer.getByRole("button", { name: "Documents" })).toHaveClass(/active/);
  await expect(explorer.getByRole("button", { name: "목록" })).toBeVisible();

  await explorer.getByRole("button", { name: "Files" }).click();

  await expect(explorer.getByRole("heading", { name: "파일" })).toBeVisible();
  await expect(explorer.getByRole("button", { name: "목록" })).toHaveCount(0);
  await expect(explorer.getByRole("button", { name: "Git tracked" })).toBeVisible();
  await expect(explorer.getByRole("button", { name: /attachments/ })).toBeVisible();
  await expect(explorer.getByRole("button", { name: /rise-budget-review\.pdf/ })).toHaveCount(0);

  await explorer.getByRole("button", { name: "Binary" }).click();
  await expect(explorer.getByRole("button", { name: /attachments/ })).toBeVisible();
  await expect(explorer.getByRole("button", { name: /rise-budget-review\.pdf/ })).toHaveCount(0);
  await explorer.getByRole("button", { name: "모두 펴기" }).click();
  await expect(explorer.getByRole("button", { name: /rise-budget-review\.pdf/ })).toBeVisible();
  await explorer.getByRole("button", { name: "모두 접기" }).click();
  await expect(explorer.getByRole("button", { name: /rise-budget-review\.pdf/ })).toHaveCount(0);
  await expect(explorer.getByRole("button", { name: /anchor-weekly-meeting\.md/ })).toHaveCount(0);

  await explorer.getByRole("button", { name: "전체" }).click();
  await explorer.getByRole("button", { name: "모두 펴기" }).click();
  await explorer.getByRole("button", { name: /anchor-glossary\.md/ }).dblclick();
  await expect(page.locator(".document-tab-title", { hasText: "Anchor 용어집" })).toBeVisible();
  await explorer.getByRole("button", { name: "모두 접기" }).click();
  await expect(explorer.getByRole("button", { name: /anchor-glossary\.md/ })).toHaveCount(0);

  await page.locator(".document-tab[title='references/anchor-glossary.md']").click({
    button: "right",
  });
  await page
    .locator(".document-tab-context-menu")
    .getByRole("button", { name: "Explorer View에서 보기" })
    .click();
  const revealedFile = explorer.getByRole("button", { name: /anchor-glossary\.md/ });
  await expect(explorer.getByRole("button", { name: "Files" })).toHaveClass(/active/);
  await expect(revealedFile).toBeVisible();
  await expect(revealedFile).toBeFocused();
});

test("queues selected files in the right Files pane and applies explicitly", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "Files" }).click();
  await explorer.getByRole("button", { name: /anchor-weekly-meeting\.md/ }).click();
  await explorer.getByRole("button", { name: "선택 파일 추가" }).click();

  const rightPane = page.locator(".outline-pane");
  await rightPane.getByRole("tab", { name: "파일" }).click();
  await expect(rightPane.getByRole("button", { name: "아이콘 보기" })).toHaveClass(/active/);
  await expect(rightPane.locator(".right-list.file-shelf-icons")).toBeVisible();
  await expect(rightPane.locator(".right-list-item.queue", { hasText: "anchor-weekly-meeting.md" })).toBeVisible();
  await expect(rightPane.locator('.queue-file-icon[data-kind="markdown"]')).toBeVisible();
  await rightPane.getByRole("button", { name: "리스트 보기" }).click();
  await expect(rightPane.locator(".right-list.file-shelf-icons")).toHaveCount(0);
  await rightPane.getByRole("button", { name: "Apply" }).click();
  await expect(rightPane.locator(".right-list-item.queue.done", { hasText: "완료" })).toBeVisible();
});

test("clears selected and all file shelf items explicitly", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "Files" }).click();
  await explorer.getByRole("button", { name: "모두 펴기" }).click();
  await explorer.getByRole("button", { name: /anchor-weekly-meeting\.md/ }).click();
  await explorer.getByRole("button", { name: "선택 파일 추가" }).click();
  await explorer.getByRole("button", { name: /minutes-template\.md/ }).click();
  await explorer.getByRole("button", { name: "선택 파일 추가" }).click();

  const rightPane = page.locator(".outline-pane");
  await rightPane.getByRole("tab", { name: "파일" }).click();
  await expect(rightPane.locator(".right-list-item.queue")).toHaveCount(2);

  await rightPane.locator(".right-list-item.queue", { hasText: "minutes-template.md" }).click();
  await rightPane.getByRole("button", { name: "선택 항목 1개 비우기" }).click();
  await expect(rightPane.locator(".right-list-item.queue", { hasText: "minutes-template.md" })).toHaveCount(0);
  await expect(rightPane.locator(".right-list-item.queue", { hasText: "anchor-weekly-meeting.md" })).toBeVisible();

  await rightPane.getByRole("button", { name: "전체 비우기" }).click();
  await expect(rightPane.locator(".right-list-item.queue")).toHaveCount(0);
  await expect(rightPane.locator(".outline-empty", { hasText: "대기 중인 파일 작업이 없습니다." })).toBeVisible();
});

test("copies selected Files shelf items into a tree context target", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "Files" }).click();
  await explorer.getByRole("button", { name: "모두 펴기" }).click();
  await explorer.getByRole("button", { name: /anchor-weekly-meeting\.md/ }).click();
  await explorer.getByRole("button", { name: "선택 파일 추가" }).click();
  await explorer.getByRole("button", { name: /minutes-template\.md/ }).click();
  await explorer.getByRole("button", { name: "선택 파일 추가" }).click();

  const rightPane = page.locator(".outline-pane");
  await rightPane.getByRole("tab", { name: "파일" }).click();
  const weeklyItem = rightPane.locator(".right-list-item.queue", {
    hasText: "anchor-weekly-meeting.md",
  });
  const templateItem = rightPane.locator(".right-list-item.queue", {
    hasText: "minutes-template.md",
  });
  await expect(weeklyItem).toBeVisible();
  await expect(templateItem).toBeVisible();
  await weeklyItem.click({ modifiers: ["Shift"] });

  await explorer.getByRole("button", { name: /templates/ }).click({ button: "right" });
  await page.getByRole("button", { name: "선택 항목 2개 여기에 복사" }).click();
  await expect(rightPane.locator(".right-list-item.queue.done")).toHaveCount(2);
});

test("resizes document and right panes with drag handles", async ({ page }) => {
  await page.goto("/");

  const documentList = page.locator(".document-list");
  const outlinePane = page.locator(".outline-pane");
  await expect(documentList).toBeVisible();
  await expect(outlinePane).toBeVisible();

  const initialDocumentBox = await documentList.boundingBox();
  const documentHandleBox = await page.locator(".documents-pane-resize").boundingBox();
  expect(initialDocumentBox).not.toBeNull();
  expect(documentHandleBox).not.toBeNull();
  if (!initialDocumentBox || !documentHandleBox) return;

  await page.mouse.move(
    documentHandleBox.x + documentHandleBox.width / 2,
    documentHandleBox.y + documentHandleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    documentHandleBox.x + documentHandleBox.width / 2 + 70,
    documentHandleBox.y + documentHandleBox.height / 2,
  );
  await page.mouse.up();

  const resizedDocumentBox = await documentList.boundingBox();
  expect(resizedDocumentBox).not.toBeNull();
  if (!resizedDocumentBox) return;
  expect(resizedDocumentBox.width).toBeGreaterThan(initialDocumentBox.width + 40);

  const initialOutlineBox = await outlinePane.boundingBox();
  const outlineHandleBox = await page.locator(".outline-pane-resize").boundingBox();
  expect(initialOutlineBox).not.toBeNull();
  expect(outlineHandleBox).not.toBeNull();
  if (!initialOutlineBox || !outlineHandleBox) return;

  await page.mouse.move(
    outlineHandleBox.x + outlineHandleBox.width / 2,
    outlineHandleBox.y + outlineHandleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    outlineHandleBox.x + outlineHandleBox.width / 2 - 60,
    outlineHandleBox.y + outlineHandleBox.height / 2,
  );
  await page.mouse.up();

  const resizedOutlineBox = await outlinePane.boundingBox();
  expect(resizedOutlineBox).not.toBeNull();
  if (!resizedOutlineBox) return;
  expect(resizedOutlineBox.width).toBeGreaterThan(initialOutlineBox.width + 35);
});

test("keeps split source editors constrained to their pane widths", async ({ page }) => {
  await page.goto("/");

  await page.locator(".tab-trigger", { hasText: "원문" }).click();
  await page.getByLabel("오른쪽으로 분할").first().click();

  const panes = page.locator(".editor-split-shell.split .editor-pane");
  await expect(panes).toHaveCount(2);
  await expect(page.locator(".editor-split-shell.split textarea.source-editor")).toHaveCount(2);

  for (let i = 0; i < 2; i += 1) {
    const paneBox = await panes.nth(i).boundingBox();
    const editorBox = await panes.nth(i).locator("textarea.source-editor").boundingBox();
    expect(paneBox).not.toBeNull();
    expect(editorBox).not.toBeNull();
    if (!paneBox || !editorBox) return;
    expect(editorBox.x).toBeGreaterThanOrEqual(paneBox.x - 1);
    expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
  }
});

test("keeps document list rows from overlapping in list mode", async ({ page }) => {
  await page.goto("/");

  const documentList = page.locator(".document-list");
  await documentList.getByRole("button", { name: "목록" }).click();
  const rows = documentList.locator(".virtual-list-row.entry");
  await expect(rows.first()).toBeVisible();
  await expect(rows.nth(1)).toBeVisible();

  const first = await rows.nth(0).boundingBox();
  const second = await rows.nth(1).boundingBox();
  const firstCard = await rows.nth(0).locator(".doc-row").boundingBox();
  const secondCard = await rows.nth(1).locator(".doc-row").boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(firstCard).not.toBeNull();
  expect(secondCard).not.toBeNull();
  if (!first || !second || !firstCard || !secondCard) return;

  expect(first.y + first.height).toBeLessThanOrEqual(second.y + 1);
  expect(firstCard.y + firstCard.height).toBeLessThanOrEqual(secondCard.y + 1);
});

test("places the right pane active marker on the rail edge", async ({ page }) => {
  await page.goto("/");

  const activeTab = page.locator(".right-pane-tabs button.active").first();
  await expect(activeTab).toBeVisible();
  const marker = await activeTab.evaluate((node) => {
    const style = window.getComputedStyle(node, "::before");
    return {
      left: style.left,
      right: style.right,
      width: style.width,
    };
  });

  expect(marker.right).not.toBe("auto");
  expect(marker.width).toBe("2px");
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
