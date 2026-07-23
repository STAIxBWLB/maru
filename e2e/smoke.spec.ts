import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("maru:e2e:storage-cleared", "true");
  });
});

async function dispatchDrag(
  page: Page,
  sourceSelector: string,
  sourceLabel: string,
  targetSelector: string,
  targetLabel: string,
  altKey = false,
) {
  await page.evaluate(
    ({ sourceSelector, sourceLabel, targetSelector, targetLabel, altKey }) => {
      const findByLabel = (selector: string, label: string) =>
        Array.from(document.querySelectorAll<HTMLElement>(selector)).find((element) => {
          const text = element.textContent ?? "";
          const aria = element.getAttribute("aria-label") ?? "";
          const title = element.getAttribute("title") ?? "";
          return text.includes(label) || aria.includes(label) || title.includes(label);
        });
      const source = findByLabel(sourceSelector, sourceLabel);
      const target = findByLabel(targetSelector, targetLabel);
      if (!source || !target) {
        throw new Error(`Cannot dispatch drag from ${sourceLabel} to ${targetLabel}`);
      }
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          altKey,
        }),
      );
      target.dispatchEvent(
        new DragEvent("dragenter", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          altKey,
        }),
      );
      target.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          altKey,
        }),
      );
      target.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          altKey,
        }),
      );
      source.dispatchEvent(
        new DragEvent("dragend", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          altKey,
        }),
      );
    },
    { sourceSelector, sourceLabel, targetSelector, targetLabel, altKey },
  );
}

async function runCommandPaletteAction(page: Page, label: string) {
  await page.locator(".topbar-command-action").click();
  const input = page.locator(".cmdk-input input");
  await expect(input).toBeVisible();
  await input.fill(label);
  await page.locator(".cmdk-item", { hasText: label }).click();
}

async function ensureRightPaneVisible(page: Page) {
  const rightPane = page.locator(".outline-pane");
  if (!(await rightPane.isVisible())) {
    await page.locator(".activity-rail").getByLabel("오른쪽 패널 보이기").click();
  }
  await expect(rightPane).toBeVisible();
}

test("boots the sample workspace and opens multiple editor tabs", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Sample Workspace" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Private" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Public 추가" })).toBeVisible();
  const documentList = page.locator(".document-list");
  await expect(documentList.getByRole("button", { name: /Maru 사업 주간 점검 회의/ })).toBeVisible();

  await documentList.getByRole("button", { name: "모두 펴기" }).click();
  await documentList.getByRole("button", { name: /Maru 용어집/ }).click();

  await expect(page.locator(".document-tab-title", { hasText: "Maru 사업 주간 점검 회의" })).toBeVisible();
  await expect(page.locator(".document-tab-title", { hasText: "Maru 용어집" })).toBeVisible();

  await page.locator(".tab-trigger", { hasText: "원문" }).click();
  await expect(page.locator("textarea.source-editor")).toHaveValue(/# Maru 용어집/);

  await page.locator(".tab-trigger", { hasText: "미리보기" }).click();
  await expect(page.locator(".preview-surface")).toContainText("Maru 용어집");

  await page.getByRole("tab", { name: "증빙" }).click();
  await expect(page.locator(".evidence-binder")).toContainText("Evidence Binder");
  await expect(page.locator(".evidence-card")).toContainText("receipt.pdf");
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
  await expect(documentList.getByRole("button", { name: /Maru 용어집/ })).toHaveCount(0);
  await documentList.getByRole("button", { name: "모두 펴기" }).click();
  await expect(documentList.getByRole("button", { name: /Maru 용어집/ })).toBeVisible();
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
  await documentList.getByRole("button", { name: /Maru 용어집/ }).click();
  await page.locator(".tab-trigger", { hasText: "원문" }).click();

  await expect(page.locator("textarea.source-editor")).toHaveAttribute("readonly", "");
  await expect(page.getByRole("button", { name: "스냅샷" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "저장" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "새 문서" })).toBeDisabled();

  await page.locator(".document-tab.active").click({ button: "right" });
  const menu = page.locator(".document-tab-context-menu");
  await expect(menu.getByRole("menuitem", { name: "이름 변경..." })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "이동..." })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "복제..." })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "삭제" })).toBeDisabled();
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

  await expect(page.locator(".app-shell")).toHaveClass(/terminal-dock-bottom/);
  await expect(page.locator(".terminal-panel")).toHaveClass(/collapsed/);
  await expect(page.locator(".sidebar.embedded")).toBeVisible();
  await expect(page.locator(".document-list")).toBeVisible();

  const rail = page.locator(".activity-rail");
  await rail.getByLabel("오른쪽 패널 숨기기").click();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await rail.getByLabel("오른쪽 패널 보이기").click();
  await expect(page.locator(".sidebar.embedded")).toBeVisible();

  await rail.getByLabel("문서 패널 숨기기").click();
  await expect(page.locator(".document-list")).toHaveCount(0);
  await rail.getByLabel("문서 패널 보이기").click();
  await expect(page.locator(".document-list")).toBeVisible();
});

test("keeps close shortcut scoped to the focused terminal panel", async ({ page }) => {
  await page.goto("/");

  const documentTabs = page.locator(".document-tab");
  const tabCount = await documentTabs.count();
  expect(tabCount).toBeGreaterThan(0);

  const terminalTitle = page.locator(".terminal-title");
  await terminalTitle.click();
  await expect(page.locator(".terminal-panel")).not.toHaveClass(/collapsed/);
  await terminalTitle.focus();

  // Chromium reserves the physical Meta+W chord before the page receives it.
  // Dispatch the DOM event delivered by the Tauri menu/accelerator path and
  // verify the focused terminal consumes it even when it has no active tab.
  const shortcutHandled = await terminalTitle.evaluate((element) => {
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const event = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(shortcutHandled).toBe(true);

  await expect(documentTabs).toHaveCount(tabCount);
  await expect(page.locator(".document-tab.active")).toBeVisible();
});

test("docks the terminal to a resizable uncapped right column", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/");

  const shell = page.locator(".app-shell");
  const terminalPanel = page.locator(".terminal-panel");
  await expect(shell).toHaveClass(/terminal-dock-bottom/);
  await expect(terminalPanel).toHaveClass(/collapsed/);

  await runCommandPaletteAction(page, "터미널을 오른쪽에 배치");

  await expect(shell).toHaveClass(/terminal-dock-right/);
  await expect(terminalPanel).not.toHaveClass(/collapsed/);
  const rightPaneBox = await page.locator(".outline-pane").boundingBox();
  const terminalBox = await terminalPanel.boundingBox();
  expect(rightPaneBox).not.toBeNull();
  expect(terminalBox).not.toBeNull();
  if (!rightPaneBox || !terminalBox) return;
  expect(terminalBox.x).toBeGreaterThanOrEqual(rightPaneBox.x + rightPaneBox.width - 1);
  expect(terminalBox.width).toBeGreaterThan(520);

  const handleBox = await terminalPanel.locator(".terminal-resize-handle").boundingBox();
  expect(handleBox).not.toBeNull();
  if (!handleBox) return;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 - 140, handleBox.y + handleBox.height / 2);
  await page.mouse.up();

  const resizedBox = await terminalPanel.boundingBox();
  expect(resizedBox).not.toBeNull();
  if (!resizedBox) return;
  expect(resizedBox.width).toBeGreaterThan(terminalBox.width + 80);

  await page.setViewportSize({ width: 820, height: 720 });
  await expect
    .poll(() =>
      terminalPanel.evaluate((element) => Math.round(element.getBoundingClientRect().height)),
    )
    .toBeGreaterThan(150);

  await runCommandPaletteAction(page, "터미널을 하단에 배치");
  await expect(shell).toHaveClass(/terminal-dock-bottom/);
  await expect(terminalPanel).not.toHaveClass(/collapsed/);
});

test("restores the previous app state on startup", async ({ page }) => {
  await page.goto("/");

  const rail = page.locator(".activity-rail");
  await rail.getByRole("button", { name: "인박스", exact: true }).click();
  await expect(page.locator(".inbox-pane")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from({ length: window.localStorage.length }, (_, index) =>
          window.localStorage.getItem(window.localStorage.key(index) ?? ""),
        ).some((value) => value?.includes('"activeAppMode":"inbox"')),
      ),
    )
    .toBe(true);

  await page.reload();
  await expect(page.locator(".inbox-pane")).toBeVisible();
  await rail.getByRole("button", { name: "문서", exact: true }).click();

  await ensureRightPaneVisible(page);
  await page.locator(".tab-trigger", { hasText: "미리보기" }).click();
  await page.getByLabel("오른쪽으로 분할").first().click();
  await page.getByRole("button", { name: "Files" }).click();
  await page.getByRole("tab", { name: "파일" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from({ length: window.localStorage.length }, (_, index) =>
          window.localStorage.getItem(window.localStorage.key(index) ?? ""),
        ).some(
          (value) =>
            value != null &&
            value.includes('"activeAppMode":"pkm"') &&
            value.includes('"editorViewMode":"preview"') &&
            value.includes('"rightPaneTab":"files"'),
        ),
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from({ length: window.localStorage.length }, (_, index) =>
          window.localStorage.getItem(window.localStorage.key(index) ?? ""),
        ).some(
          (value) =>
            value != null &&
            value.includes('"rightRelPath":"maru-weekly-meeting.md"') &&
            value.includes('"focusedGroup":"right"'),
        ),
      ),
    )
    .toBe(true);

  await page.reload();

  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Files" })).toHaveClass(/active/);
  await expect(page.getByRole("tab", { name: "파일" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".tab-trigger", { hasText: "미리보기" }).first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".editor-split-shell.split .editor-pane")).toHaveCount(2);
});

test("opens meetings mode with list, detail, and calendar views", async ({ page }) => {
  // Pin "today" inside the sample meetings' month (2026-05) so the calendar
  // defaults to a month that has meetings, regardless of the real wall clock.
  await page.clock.setFixedTime(new Date("2026-05-04T09:00:00"));
  await page.goto("/");

  await page.locator(".activity-rail").getByRole("button", { name: "회의록" }).click();
  await expect(page.locator(".meetings-pane")).toBeVisible();
  const meetingsPane = page.locator(".meetings-pane");
  await expect(
    meetingsPane.getByRole("button", { name: /Maru 사업 주간 점검/ }),
  ).toBeVisible();

  await meetingsPane.getByRole("button", { name: /Skills 관리/ }).click();
  await expect(page.locator(".meetings-detail-pane")).toContainText("Skills 관리");

  await meetingsPane.getByRole("button", { name: "캘린더" }).click();
  await expect(page.locator(".unified-calendar")).toBeVisible();
  await expect(page.locator(".unified-calendar")).toContainText("Skills 관리");

  // The transcript intake entry moved from an actions-bar button to a sidebar
  // nav item ("녹취록", hint "녹취록·메모를 회의록으로"). Match the label.
  await meetingsPane.getByRole("button", { name: /녹취록/ }).click();
  await expect(page.locator(".meetings-workbench")).toBeVisible();
  const transcriptTextarea = page.locator(".meetings-source-card textarea");
  await expect(transcriptTextarea).toBeVisible();
  await expect(transcriptTextarea).toHaveAttribute("placeholder", /녹취록 전문/);
  await expect(meetingsPane.getByRole("button", { name: "회의록 생성" })).toBeDisabled();
  await transcriptTextarea.fill("참석자들이 워크숍 일정과 후속 작업을 논의했다.");
  await expect(meetingsPane.getByRole("button", { name: "회의록 생성" })).toBeEnabled();
  await expect(page.getByText("주제 힌트 (선택)")).toBeVisible();
  await expect(page.getByText("세부 힌트 (선택)")).toBeVisible();
  await meetingsPane.getByRole("button", { name: "회의록 생성" }).click();
  await expect(page.locator(".meetings-runtime-chooser")).toContainText("실행 엔진 선택");
  await expect(page.getByRole("button", { name: "Claude로 실행" })).toBeVisible();
  await page.getByRole("button", { name: "Codex로 실행" }).click();
  await expect(page.locator(".meetings-run-panel")).toContainText("Codex");
  await expect(page.locator(".meetings-run-steps")).toContainText("스킬 실행");
  await expect(page.locator(".meetings-run-panel")).toContainText("진행 중인 회의록 작업");
  await expect(page.locator(".meetings-review-card")).toContainText("결과 대기");

  await meetingsPane.getByRole("button", { name: "전체" }).click();
  const progressDock = page.locator(".meetings-progress-dock");
  await expect(progressDock).toContainText("진행 중인 회의록 작업");
  await expect(progressDock.locator(".meetings-progress-list")).toBeVisible();
  await expect(progressDock.getByRole("button", { name: "진행 패널 접기" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  await progressDock.getByRole("button", { name: "진행 패널 접기" }).click();
  await expect(progressDock).toHaveClass(/collapsed/);
  await expect(progressDock.locator(".meetings-progress-list")).toBeHidden();
  await expect(progressDock.getByRole("button", { name: "진행 패널 펼치기" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  await progressDock.getByRole("button", { name: "진행 패널 펼치기" }).click();
  await expect(progressDock.locator(".meetings-progress-list")).toBeVisible();
  const initialDockHeight = await progressDock.evaluate((element) =>
    Math.round(element.getBoundingClientRect().height),
  );
  const resizeHandle = progressDock.locator(".meetings-progress-resize-handle");
  await expect(resizeHandle).toBeVisible();
  const resizeHandleBox = await resizeHandle.boundingBox();
  expect(resizeHandleBox).not.toBeNull();
  if (!resizeHandleBox) throw new Error("Missing meetings progress resize handle box.");
  await page.mouse.move(
    resizeHandleBox.x + resizeHandleBox.width / 2,
    resizeHandleBox.y + resizeHandleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    resizeHandleBox.x + resizeHandleBox.width / 2,
    resizeHandleBox.y + resizeHandleBox.height / 2 - 56,
  );
  await page.mouse.up();
  await expect
    .poll(() =>
      progressDock.evaluate((element) => Math.round(element.getBoundingClientRect().height)),
    )
    .toBeGreaterThan(initialDockHeight + 32);

  const storedDockHeight = await page.evaluate(() => {
    let raw: string | null = null;
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith("maru:meetings:progress-dock:")) {
        raw = window.localStorage.getItem(key);
        break;
      }
    }
    if (!raw) return 0;
    return Math.round(JSON.parse(raw).height);
  });
  expect(storedDockHeight).toBeGreaterThan(initialDockHeight + 32);

  await page.reload();
  const reloadedMeetingsPane = page.locator(".meetings-pane");
  await page.locator(".activity-rail").getByRole("button", { name: "회의록" }).click();
  await reloadedMeetingsPane.getByRole("button", { name: /녹취록/ }).click();
  await page.locator(".meetings-source-card textarea").fill("새 회의록 작업으로 저장된 패널 높이를 확인한다.");
  await reloadedMeetingsPane.getByRole("button", { name: "회의록 생성" }).click();
  await page.getByRole("button", { name: "Codex로 실행" }).click();
  await reloadedMeetingsPane.getByRole("button", { name: "전체" }).click();
  const restoredDock = page.locator(".meetings-progress-dock");
  await expect(restoredDock).toBeVisible();
  await expect
    .poll(() =>
      restoredDock.evaluate((element) => Math.round(element.getBoundingClientRect().height)),
    )
    .toBe(storedDockHeight);

  // External/auto-summary intake also moved to a sidebar nav item
  // ("자동정리 회의록"); "외부 노트 정제" is now the workbench title.
  await meetingsPane.getByRole("button", { name: /자동정리 회의록/ }).click();
  await expect(page.locator(".meetings-source-card textarea")).toBeVisible();
  await page.locator(".meetings-source-card textarea").fill("외부 노트 초안을 회의록 형식으로 정리한다.");
  await reloadedMeetingsPane.getByRole("button", { name: "정제 실행" }).click();
  await expect(page.locator(".meetings-runtime-chooser")).toContainText("실행 엔진 선택");
  await expect(page.locator(".meetings-run-panel")).toContainText("진행 중인 회의록 작업");
});

test("opens document studio with the seven-step shell", async ({ page }) => {
  await page.goto("/");

  await page.locator(".activity-rail").getByRole("button", { name: "스튜디오" }).click();
  await expect(page.locator(".studio-pane")).toBeVisible();
  await expect(page.locator(".studio-header")).toContainText("Document Studio");
  await expect(page.locator(".studio-step-button")).toHaveCount(7);
  await expect(page.locator(".studio-step-rail")).toContainText("Source");
  await expect(page.locator(".studio-step-rail")).toContainText("Package");
  await expect(page.locator(".studio-active-document")).toContainText(
    "Maru 사업 주간 점검 회의",
  );
});

test("shows the meetings settings tab in the settings window shell", async ({ page }) => {
  await page.goto("/?window=settings&workPath=mock%3A%2F%2Fmaru-sample-workspace&tab=meetings");

  await expect(page.getByRole("tab", { name: "회의록" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("회의록 루트", { exact: true })).toBeVisible();
  await expect(page.getByText("작업 로그 append", { exact: true })).toBeVisible();
});

test("manages secrets settings with full-width scroll and explicit reveal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 720 });
  await page.goto("/?window=settings&workPath=mock%3A%2F%2Fmaru-sample-workspace&tab=secrets");

  await expect(page.getByRole("tab", { name: "Secrets" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const body = page.locator(".settings-window-shell .system-body");
  const form = body.locator(".secrets-settings-form");
  await expect(form).toBeVisible();
  await expect(form).toContainText("Workspace 시크릿");
  await expect(form).toContainText("관리 인벤토리");
  const inventoryTable = form.locator(".secrets-inventory-table");
  await expect(inventoryTable).toBeVisible();
  await expect(inventoryTable).not.toContainText(".DS_Store");

  const bodyBox = await body.boundingBox();
  const formBox = await form.boundingBox();
  expect(bodyBox).not.toBeNull();
  expect(formBox).not.toBeNull();
  if (!bodyBox || !formBox) return;
  expect(formBox.width).toBeGreaterThan(bodyBox.width * 0.85);

  const scrollMetrics = await body.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);

  await form.getByRole("button", { name: "드라이런" }).click();
  const migrationPanel = form.locator(".settings-section-panel", {
    hasText: "마이그레이션 드라이런",
  });
  await expect(migrationPanel).toBeVisible();
  await expect(migrationPanel).toContainText("작업 3개 · 2개 선택됨");
  const applySelected = migrationPanel.getByRole("button", { name: "선택 항목 적용" });
  await expect(applySelected).toBeEnabled();

  const automaticActionCheck = migrationPanel.getByRole("checkbox", {
    name: "create-legacy-symlink .secrets 선택",
  });
  await expect(automaticActionCheck).toBeDisabled();
  await expect(automaticActionCheck).not.toBeChecked();

  const selectedChecks = migrationPanel.locator('input[type="checkbox"]:not(:disabled)');
  await expect(selectedChecks).toHaveCount(2);
  const checkCount = await selectedChecks.count();
  for (let index = 0; index < checkCount; index += 1) {
    await selectedChecks.nth(index).uncheck();
  }
  await expect(migrationPanel).toContainText("작업 3개 · 0개 선택됨");
  await expect(applySelected).toBeDisabled();
  await selectedChecks.first().check();
  await expect(migrationPanel).toContainText("작업 3개 · 1개 선택됨");
  await applySelected.click();
  await expect(form.locator(".settings-section-panel", { hasText: "적용된 마이그레이션" })).toBeVisible();

  await form
    .getByRole("button", {
      name: /services\/telegram-monitor\.config\.yaml 공개 및 편집/,
    })
    .click();
  const dialog = page.locator(".secret-editor-dialog");
  await expect(dialog).toBeVisible();
  const textarea = dialog.locator("textarea");
  await expect(textarea).toBeDisabled();
  await expect(textarea).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();

  await dialog.getByRole("button", { name: "공개" }).click();
  await expect(textarea).toBeEnabled();
  await expect(textarea).toHaveValue(/api_hash/);
  await expect(dialog.getByRole("button", { name: "저장" })).toBeEnabled();

  const confirmDialogPromise = new Promise<string>((resolve) => {
    page.once("dialog", async (confirmDialog) => {
      const message = confirmDialog.message();
      await confirmDialog.dismiss();
      resolve(message);
    });
  });
  await dialog.getByRole("button", { name: "삭제" }).click();
  const confirmMessage = await confirmDialogPromise;
  expect(confirmMessage).toContain(
    "텍스트 시크릿 파일 .maru/secrets/services/telegram-monitor.config.yaml 를 삭제할까요?",
  );
  expect(confirmMessage).not.toContain("metadata entry");
  await expect(dialog).toBeVisible();
});

test("supports tree bulk controls and Finder context menu", async ({ page }) => {
  await page.goto("/");

  const documentList = page.locator(".document-list");
  await expect(documentList.getByRole("button", { name: /references/ })).toBeVisible();
  await expect(documentList.getByRole("button", { name: /Maru 용어집/ })).toHaveCount(0);

  await documentList.getByRole("button", { name: "모두 펴기" }).click();
  await expect(documentList.getByRole("button", { name: /Maru 용어집/ })).toBeVisible();

  await documentList.getByRole("button", { name: "모두 접기" }).click();
  await expect(documentList.getByRole("button", { name: /Maru 용어집/ })).toHaveCount(0);

  await documentList.getByRole("button", { name: "모두 펴기" }).click();
  await expect(documentList.getByRole("button", { name: /Maru 용어집/ })).toBeVisible();

  await documentList.getByRole("button", { name: /Maru 용어집/ }).click({
    button: "right",
  });
  await expect(page.getByRole("menuitem", { name: "파일 열기" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Finder에서 보기" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "경로 복사", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "상대 경로 복사" })).toBeVisible();
});

test("shows supported document tab menu items and performs file operations", async ({
  page,
}) => {
  await page.goto("/");

  const documentList = page.locator(".document-list");
  await documentList.getByRole("button", { name: "모두 펴기" }).click();
  await documentList.getByRole("button", { name: /Maru 용어집/ }).click();
  await documentList.getByRole("button", { name: "목록" }).click();

  const glossaryTab = page.locator(".document-tab[title='references/maru-glossary.md']");
  await expect(glossaryTab).toBeVisible();
  await glossaryTab.click({ button: "right" });

  const menu = page.locator(".document-tab-context-menu");
  await expect(menu.getByRole("menuitem", { name: "닫기", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "다른 탭 닫기" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "오른쪽 탭 닫기" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "저장된 탭 닫기" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "이름 복사" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "상대 경로 복사" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "이름 변경..." })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "이동..." })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "복제..." })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "삭제" })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "미리보기 열기" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Finder에서 보기" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Explorer View에서 보기" })).toBeVisible();
  await expect(menu).not.toContainText("Remote URL");
  await expect(menu).not.toContainText("Share");
  await expect(menu).not.toContainText("Open Changes");
  await expect(menu).not.toContainText("File History");
  await expect(menu).not.toContainText("Reopen Editor With");

  await menu.getByRole("menuitem", { name: "Explorer View에서 보기" }).click();
  const revealedGlossary = documentList.getByRole("button", { name: /Maru 용어집/ });
  await expect(documentList.getByRole("button", { name: "트리" })).toHaveClass(/active/);
  await expect(revealedGlossary).toBeVisible();
  await expect(revealedGlossary).toBeFocused();

  await glossaryTab.click({ button: "right" });
  await page
    .locator(".document-tab-context-menu")
    .getByRole("menuitem", { name: "복제..." })
    .click();
  const copyTab = page.locator(".document-tab[title='references/maru-glossary-copy.md']");
  await expect(copyTab).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("prompt");
    await dialog.accept("maru-glossary-renamed");
  });
  await copyTab.click({ button: "right" });
  await page
    .locator(".document-tab-context-menu")
    .getByRole("menuitem", { name: "이름 변경..." })
    .click();
  const renamedTab = page.locator(".document-tab[title='references/maru-glossary-renamed.md']");
  await expect(renamedTab).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("prompt");
    await dialog.accept("moved/maru-glossary-renamed.md");
  });
  await renamedTab.click({ button: "right" });
  await page
    .locator(".document-tab-context-menu")
    .getByRole("menuitem", { name: "이동..." })
    .click();
  const movedTab = page.locator(".document-tab[title='moved/maru-glossary-renamed.md']");
  await expect(movedTab).toBeVisible();
  await expect(page.locator("textarea.source-editor")).toHaveValue(/# Maru 용어집/);

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.accept();
  });
  await movedTab.click({ button: "right" });
  await page
    .locator(".document-tab-context-menu")
    .getByRole("menuitem", { name: "삭제" })
    .click();
  await expect(movedTab).toHaveCount(0);
  await expect(page.locator(".toast", { hasText: ".maru/trash/documents/moved/" })).toBeVisible();
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

test("keeps macOS window controls outside custom drag regions", async ({ page }) => {
  await page.goto("/");

  const dragRegion = await page.locator(".topbar").evaluate((node) => {
    const guard = node.querySelector(".topbar-window-controls-guard");
    if (!(guard instanceof HTMLElement)) {
      throw new Error("Missing topbar window-controls guard");
    }
    const guardBox = guard.getBoundingClientRect();
    return {
      hasTauriDragRegion: node.hasAttribute("data-tauri-drag-region"),
      topbarAppRegion: window.getComputedStyle(node).getPropertyValue("-webkit-app-region"),
      guardAppRegion: window.getComputedStyle(guard).getPropertyValue("-webkit-app-region"),
      guardWidth: guardBox.width,
    };
  });

  expect(dragRegion.hasTauriDragRegion).toBe(true);
  expect(dragRegion.topbarAppRegion).toBe("drag");
  expect(dragRegion.guardAppRegion).toBe("no-drag");
  expect(dragRegion.guardWidth).toBeGreaterThanOrEqual(70);
});

test("switches between Documents and Files explorer modes", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await expect(explorer.getByRole("button", { name: "Documents" })).toHaveClass(/active/);
  await expect(explorer.getByRole("button", { name: "목록" })).toBeVisible();

  await explorer.getByRole("button", { name: "Files" }).click();

  await expect(explorer.getByRole("heading", { name: "파일" })).toBeVisible();
  const filesViewControls = explorer.getByRole("group", { name: "파일 보기 방식" });
  await expect(filesViewControls.getByRole("button", { name: "목록" })).toBeVisible();
  await expect(filesViewControls.getByRole("button", { name: "트리" })).toHaveClass(/active/);
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
  await expect(explorer.getByRole("button", { name: /maru-weekly-meeting\.md/ })).toHaveCount(0);

  await explorer.getByRole("button", { name: "전체" }).click();
  await explorer.getByRole("button", { name: "모두 펴기" }).click();
  await explorer.getByRole("button", { name: /maru-glossary\.md/ }).dblclick();
  await expect(page.locator(".document-tab-title", { hasText: "Maru 용어집" })).toBeVisible();
  await explorer.getByRole("button", { name: "모두 접기" }).click();
  await expect(explorer.getByRole("button", { name: /maru-glossary\.md/ })).toHaveCount(0);

  await page.locator(".document-tab[title='references/maru-glossary.md']").click({
    button: "right",
  });
  await page
    .locator(".document-tab-context-menu")
    .getByRole("menuitem", { name: "Explorer View에서 보기" })
    .click();
  const revealedFile = explorer.getByRole("button", { name: /maru-glossary\.md/ });
  await expect(explorer.getByRole("button", { name: "Files" })).toHaveClass(/active/);
  await expect(revealedFile).toBeVisible();
  await expect(revealedFile).toBeFocused();
});

test("queues selected files in the right Files pane and applies explicitly", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "Files" }).click();
  await explorer.getByRole("button", { name: /maru-weekly-meeting\.md/ }).click();
  await explorer.getByRole("button", { name: "선택 파일 추가" }).click();

  const rightPane = page.locator(".outline-pane");
  await expect(rightPane.getByRole("tab", { name: "파일" })).toHaveAttribute("aria-selected", "true");
  await expect(rightPane.getByRole("button", { name: "아이콘 보기" })).toHaveClass(/active/);
  await expect(rightPane.locator(".right-list.file-shelf-icons")).toBeVisible();
  await expect(rightPane.locator(".right-list-item.queue", { hasText: "maru-weekly-meeting.md" })).toBeVisible();
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
  await explorer.getByRole("button", { name: /maru-weekly-meeting\.md/ }).click();
  await explorer.getByRole("button", { name: "선택 파일 추가" }).click();
  await explorer.getByRole("button", { name: /minutes-template\.md/ }).click();
  await explorer.getByRole("button", { name: "선택 파일 추가" }).click();

  const rightPane = page.locator(".outline-pane");
  await rightPane.getByRole("tab", { name: "파일" }).click();
  await expect(rightPane.locator(".right-list-item.queue")).toHaveCount(2);

  await rightPane.locator(".right-list-item.queue", { hasText: "minutes-template.md" }).click();
  await rightPane.getByRole("button", { name: "선택 항목 1개 비우기" }).click();
  await expect(rightPane.locator(".right-list-item.queue", { hasText: "minutes-template.md" })).toHaveCount(0);
  await expect(rightPane.locator(".right-list-item.queue", { hasText: "maru-weekly-meeting.md" })).toBeVisible();

  await rightPane.getByRole("button", { name: "전체 비우기" }).click();
  await expect(rightPane.locator(".right-list-item.queue")).toHaveCount(0);
  await expect(rightPane.locator(".outline-empty", { hasText: "대기 중인 파일 작업이 없습니다." })).toBeVisible();
});

test("copies selected Files shelf items into a tree context target", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "Files" }).click();
  await explorer.getByRole("button", { name: "모두 펴기" }).click();
  await explorer.getByRole("button", { name: /maru-weekly-meeting\.md/ }).click();
  await explorer.getByRole("button", { name: "선택 파일 추가" }).click();
  await explorer.getByRole("button", { name: /minutes-template\.md/ }).click();
  await explorer.getByRole("button", { name: "선택 파일 추가" }).click();

  const rightPane = page.locator(".outline-pane");
  await rightPane.getByRole("tab", { name: "파일" }).click();
  const weeklyItem = rightPane.locator(".right-list-item.queue", {
    hasText: "maru-weekly-meeting.md",
  });
  const templateItem = rightPane.locator(".right-list-item.queue", {
    hasText: "minutes-template.md",
  });
  await expect(weeklyItem).toBeVisible();
  await expect(templateItem).toBeVisible();
  await weeklyItem.click();
  await templateItem.click({ modifiers: ["Meta"] });
  await expect(rightPane.getByRole("button", { name: "선택 항목 2개 비우기" })).toBeEnabled();

  await explorer.getByRole("button", { name: /templates/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "선택 항목 2개 여기에 복사" }).click();
  await expect(rightPane.locator(".right-list-item.queue.done")).toHaveCount(2);
});

test("drags a Documents list item into the right Files shelf", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "목록" }).click();
  await page
    .locator(".document-list .doc-row", { hasText: "Maru 사업 주간 점검 회의" })
    .dragTo(page.getByRole("tab", { name: "파일" }));

  const rightPane = page.locator(".outline-pane");
  await expect(rightPane.getByRole("tab", { name: "파일" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    rightPane.locator(".right-list-item.queue", { hasText: "maru-weekly-meeting.md" }),
  ).toBeVisible();
});

test("drags explorer items directly onto left tree targets", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "모두 펴기" }).click();
  await page
    .locator(".document-list .tree-row.file", { hasText: "Maru 사업 주간 점검 회의" })
    .dragTo(page.locator(".document-list .tree-row.folder", { hasText: "references" }));

  const rightPane = page.locator(".outline-pane");
  await expect(rightPane.getByRole("tab", { name: "파일" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(rightPane.locator(".right-list-item.queue.done")).toHaveCount(1);
});

test("drags multi-selected Files rows and folder rows", async ({ page }) => {
  await page.goto("/");

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "Files" }).click();
  await explorer.getByRole("button", { name: "모두 펴기" }).click();
  await explorer.getByRole("button", { name: /maru-weekly-meeting\.md/ }).click();
  await explorer.getByRole("button", { name: /minutes-template\.md/ }).click({
    modifiers: ["Meta"],
  });

  // dispatchDrag instead of dragTo: dragTo scrolls the drop target into view
  // while the button is down, which shifts the virtualized rows under the
  // pointer and starts the drag from the wrong row.
  await dispatchDrag(
    page,
    ".document-list .tree-row.file",
    "maru-weekly-meeting.md",
    ".document-list .tree-row.folder",
    "attachments",
  );

  const rightPane = page.locator(".outline-pane");
  await expect(rightPane.locator(".right-list-item.queue.done")).toHaveCount(2);
  await rightPane.getByRole("button", { name: "전체 비우기" }).click();

  await page
    .locator(".document-list .tree-row.folder", { hasText: "attachments" })
    .dragTo(page.getByRole("tab", { name: "파일" }));
  await expect(
    rightPane.locator(".right-list-item.queue", { hasText: "attachments" }),
  ).toBeVisible();
  await expect(rightPane.locator('.queue-file-icon[data-kind="directory"]')).toBeVisible();
});

test("blocks moving dirty open documents by drag and drop", async ({ page }) => {
  await page.goto("/");

  const textarea = page.locator("textarea.source-editor");
  await textarea.fill(`${await textarea.inputValue()}\n\nUnsaved local edit`);

  const explorer = page.locator(".document-list");
  await explorer.getByRole("button", { name: "모두 펴기" }).click();
  await dispatchDrag(
    page,
    ".document-list .tree-row.file",
    "Maru 사업 주간 점검 회의",
    ".document-list .tree-row.folder",
    "references",
    true,
  );

  await expect(page.locator(".toast")).toContainText("저장되지 않은 문서는 이동할 수 없습니다");
  await expect(page.locator(".outline-pane .right-list-item.queue.done")).toHaveCount(0);
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

test("keeps split editor modes independent and constrained to their pane widths", async ({ page }) => {
  await page.goto("/");

  await page.locator(".tab-trigger", { hasText: "원문" }).click();
  await page.getByLabel("오른쪽으로 분할").first().click();

  const panes = page.locator(".editor-split-shell.split .editor-pane");
  await expect(panes).toHaveCount(2);
  await expect(page.locator(".editor-split-shell.split textarea.source-editor")).toHaveCount(2);

  await panes.nth(0).locator(".tab-trigger", { hasText: "미리보기" }).click();
  await expect(panes.nth(0).locator(".preview-surface")).toBeVisible();
  await expect(panes.nth(1).locator("textarea.source-editor")).toBeVisible();

  for (let i = 0; i < 2; i += 1) {
    const paneBox = await panes.nth(i).boundingBox();
    const editorBox = await panes
      .nth(i)
      .locator(i === 0 ? ".preview-surface" : "textarea.source-editor")
      .boundingBox();
    expect(paneBox).not.toBeNull();
    expect(editorBox).not.toBeNull();
    if (!paneBox || !editorBox) return;
    expect(editorBox.x).toBeGreaterThanOrEqual(paneBox.x - 1);
    expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
  }

  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from({ length: window.localStorage.length }, (_, index) =>
          window.localStorage.getItem(window.localStorage.key(index) ?? ""),
        ).some((value) =>
          value?.includes('"editorPaneViewModes":{"left":"preview","right":"source"}'),
        ),
      ),
    )
    .toBe(true);
});

test("opens a persistent Graph surface in the right editor split", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");

  await page.getByLabel("오른쪽에 그래프 열기").click();

  const splitShell = page.locator(".editor-split-shell.split");
  const graphPane = page.getByTestId("graph-split-pane");
  await expect(splitShell).toBeVisible();
  await expect(splitShell.locator(".editor-pane")).toHaveCount(2);
  await expect(graphPane).toBeVisible();
  await expect(graphPane.getByTestId("graph-mode")).toBeVisible();
  await expect(page.locator(".document-tab.active").first()).toBeVisible();

  await graphPane.getByTestId("graph-search-toggle").click();
  await expect(graphPane.getByTestId("graph-search")).toBeVisible();

  const documentList = page.locator(".document-list");
  await documentList.getByRole("button", { name: "모두 펴기" }).click();
  await documentList.getByRole("button", { name: /Maru 용어집/ }).click();
  await expect(graphPane).toBeVisible();
  await expect(
    splitShell.locator(".editor-pane").first().locator(".document-tab-title", {
      hasText: "Maru 용어집",
    }),
  ).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from({ length: window.localStorage.length }, (_, index) =>
          window.localStorage.getItem(window.localStorage.key(index) ?? ""),
        ).some(
          (value) =>
            value?.includes('"editorSplitOpen":true') &&
            value.includes('"editorSplitSurface":"graph"'),
        ),
      ),
    )
    .toBe(true);

  await page.reload();
  await expect(page.getByTestId("graph-split-pane")).toBeVisible();
  await expect(page.getByTestId("graph-split-pane").getByTestId("graph-mode")).toBeVisible();

  await page
    .getByTestId("graph-split-pane")
    .locator(".graph-split-tab .document-tab-main")
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from({ length: window.localStorage.length }, (_, index) =>
          window.localStorage.getItem(window.localStorage.key(index) ?? ""),
        ).some((value) => value?.includes('"focusedGroup":"right"')),
      ),
    )
    .toBe(true);

  const shortcutHandled = await page.getByTestId("graph-split-pane").evaluate((element) => {
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const event = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(shortcutHandled).toBe(true);

  await expect(page.getByTestId("graph-split-pane")).toHaveCount(0);
  await expect(page.locator(".editor-split-shell.split")).toHaveCount(0);
  await expect(page.locator(".document-tab.active")).toBeVisible();
});

test("closes the focused right editor pane with Cmd/Ctrl+W", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("오른쪽으로 분할").first().click();

  const panes = page.locator(".editor-split-shell.split .editor-pane");
  await expect(panes).toHaveCount(2);
  const rightSource = panes.nth(1).locator("textarea.source-editor");
  await rightSource.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from({ length: window.localStorage.length }, (_, index) =>
          window.localStorage.getItem(window.localStorage.key(index) ?? ""),
        ).some((value) => value?.includes('"focusedGroup":"right"')),
      ),
    )
    .toBe(true);
  await page.waitForTimeout(100);
  // Chromium reserves the physical Meta+W chord before a web page receives
  // it. Dispatch the same DOM event that the Tauri webview/native menu route
  // delivers so this regression covers Maru's active-pane behavior.
  const shortcutHandled = await rightSource.evaluate((element) => {
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const event = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(shortcutHandled).toBe(true);

  await expect(page.locator(".editor-split-shell.split")).toHaveCount(0);
  await expect(page.locator(".editor-pane")).toHaveCount(1);
  await expect(page.locator(".document-tab.active")).toBeVisible();
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
  await page.goto("/?window=settings&workPath=mock://maru-sample-workspace");

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
