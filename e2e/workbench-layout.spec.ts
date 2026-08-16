import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_MARU_SETTINGS } from "../src/lib/settings";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:e2e:layout-storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("maru:e2e:layout-storage-cleared", "true");
  });
});

async function dockTerminalRight(page: Page) {
  await page.locator(".topbar-command-action").click();
  const input = page.locator(".cmdk-input input");
  await input.fill("패널을 오른쪽에 배치");
  await page.locator(".cmdk-item", { hasText: "패널을 오른쪽에 배치" }).click();
}

const PRIMARY_MODES = [
  ["파일", ".files-workbench"],
  ["인박스", ".inbox-pane"],
  ["메시지", ".comms-pane"],
  ["회의록", ".meetings-pane"],
  ["오늘", ".today-pane"],
  ["태스크", ".tasks-pane"],
  ["대시보드", ".dashboard-pane"],
  ["아이디어", ".drafts-pane"],
  ["갭 분석", ".gap-pane"],
  ["에이전트", ".agents-pane"],
  ["카탈로그", ".catalog-pane"],
  ["스튜디오", ".studio-pane"],
  ["사이트", ".sites-pane"],
  ["그래프", ".graph-view"],
  ["다이어그램", ".maru-diagram"],
] as const;

async function readPersistedLayout(page: Page) {
  return page.evaluate(() => {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith("maru:settings:fallback:v1:")) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      return (JSON.parse(raw) as { ui?: { layout?: Record<string, unknown> } }).ui?.layout ?? null;
    }
    return null;
  });
}

for (const width of [1024, 1280, 1440]) {
  test(`keeps Docs usable with terminal right and an editor split at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await dockTerminalRight(page);

    const workbench = page.locator(".app-workbench");
    const documents = workbench.locator(".document-list");
    const outline = workbench.locator(".outline-pane");
    const singleEditor = workbench.locator(".editor-split-shell > .editor-pane");
    await expect(documents).toBeVisible();
    await expect(outline).toBeVisible();
    await expect(singleEditor).toBeVisible();

    const [workbenchBox, documentsBox, editorBox, outlineBox, terminalBox] =
      await Promise.all([
        workbench.boundingBox(),
        documents.boundingBox(),
        singleEditor.boundingBox(),
        outline.boundingBox(),
        page.locator(".terminal-panel").boundingBox(),
      ]);
    expect(workbenchBox).not.toBeNull();
    expect(documentsBox).not.toBeNull();
    expect(editorBox).not.toBeNull();
    expect(outlineBox).not.toBeNull();
    expect(terminalBox).not.toBeNull();
    if (!workbenchBox || !documentsBox || !editorBox || !outlineBox || !terminalBox) return;
    expect(workbenchBox.width).toBeGreaterThanOrEqual(735);
    expect(documentsBox.width).toBeGreaterThan(180);
    expect(editorBox.width).toBeGreaterThanOrEqual(300);
    expect(outlineBox.width).toBeGreaterThan(160);
    expect(terminalBox.x).toBeGreaterThanOrEqual(workbenchBox.x + workbenchBox.width - 1);
    expect(await documents.locator(".list-scroll").evaluate((element) =>
      getComputedStyle(element).overflowY,
    )).toBe("auto");
    expect(await outline.locator(".right-pane-tabs").evaluate((element) =>
      getComputedStyle(element).overflowY,
    )).toBe("auto");
    expect(
      await documents.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    expect(
      await documents.locator(".list-header").evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);

    await page.getByRole("button", {
      name: "마크다운 소스와 미리보기를 나란히 열기",
    }).click();
    const splitPanes = workbench.locator(".editor-split-shell.split > .editor-pane");
    await expect(splitPanes).toHaveCount(2);
    await expect(outline).toBeVisible();
    const terminalPanel = page.locator(".terminal-panel");
    const [
      splitWorkbenchBox,
      splitDocumentsBox,
      splitOutlineBox,
      leftBox,
      rightBox,
      splitTerminalBox,
    ] = await Promise.all([
      workbench.boundingBox(),
      documents.boundingBox(),
      outline.boundingBox(),
      splitPanes.nth(0).boundingBox(),
      splitPanes.nth(1).boundingBox(),
      terminalPanel.boundingBox(),
    ]);
    expect(splitWorkbenchBox).not.toBeNull();
    expect(splitDocumentsBox).not.toBeNull();
    expect(splitOutlineBox).not.toBeNull();
    expect(leftBox).not.toBeNull();
    expect(rightBox).not.toBeNull();
    expect(splitTerminalBox).not.toBeNull();
    if (
      !splitWorkbenchBox ||
      !splitDocumentsBox ||
      !splitOutlineBox ||
      !leftBox ||
      !rightBox ||
      !splitTerminalBox
    ) return;
    expect(splitWorkbenchBox.width).toBeGreaterThanOrEqual(735);
    expect(splitDocumentsBox.width).toBeGreaterThanOrEqual(180);
    expect(splitOutlineBox.width).toBeGreaterThanOrEqual(140);
    expect(leftBox.width).toBeGreaterThanOrEqual(190);
    expect(rightBox.width).toBeGreaterThanOrEqual(190);
    expect(splitTerminalBox.width).toBeGreaterThanOrEqual(220);
    expect(splitTerminalBox.x).toBeGreaterThanOrEqual(
      splitWorkbenchBox.x + splitWorkbenchBox.width - 1,
    );
    for (const pane of await splitPanes.all()) {
      expect(
        await pane.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
    }
    for (const surface of [
      terminalPanel,
      terminalPanel.locator(".terminal-header"),
      terminalPanel.locator(".terminal-workspace"),
      terminalPanel.locator(".terminal-main"),
      terminalPanel.locator(".terminal-body"),
      documents,
      documents.locator(".list-header"),
    ]) {
      expect(
        await surface.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
    }
    const terminalWorkspaceSize = await terminalPanel.locator(".terminal-workspace").evaluate(
      (element) => ({ width: element.clientWidth, height: element.clientHeight }),
    );
    expect(terminalWorkspaceSize.width).toBeGreaterThan(0);
    expect(terminalWorkspaceSize.height).toBeGreaterThan(0);
    const terminalBodySize = await terminalPanel.locator(".terminal-body").evaluate(
      (element) => ({ width: element.clientWidth, height: element.clientHeight }),
    );
    expect(terminalBodySize.width).toBeGreaterThanOrEqual(190);
    expect(terminalBodySize.height).toBeGreaterThan(0);
    if (width === 1024) {
      const compactSidebar = terminalPanel.locator(".terminal-session-sidebar");
      const compactSidebarBox = await compactSidebar.boundingBox();
      expect(compactSidebarBox).not.toBeNull();
      if (compactSidebarBox) expect(compactSidebarBox.width).toBeLessThanOrEqual(43);
      // Responsive compaction must not mutate the session-local user state.
      await expect(
        compactSidebar.getByRole("button", {
          name: "사이드바 접기",
          includeHidden: true,
        }),
      ).toBeAttached();
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);

    await expect
      .poll(() => readPersistedLayout(page))
      .toMatchObject({
        documentsPaneOpen: true,
        documentsPaneWidth: 340,
        outlineOpen: true,
        outlinePaneWidth: 280,
        terminalDock: "right",
        terminalWidth: 640,
      });

    if (width === 1280) {
      await page.reload();
      await expect(page.locator(".editor-split-shell.split > .editor-pane")).toHaveCount(2);
      await expect(page.locator(".outline-pane")).toBeVisible();
      await expect(page.locator(".app-shell")).toHaveClass(/terminal-dock-right/);
    }
  });
}

for (const width of [1024, 1280, 1440]) {
  test(`keeps every primary workbench contained with terminal right at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await dockTerminalRight(page);

    for (const [label, selector] of PRIMARY_MODES) {
      await page.getByRole("button", { name: label, exact: true }).click();
      const root = page.locator(selector);
      await expect(root).toHaveCount(1);
      await expect(root).toBeVisible();

      const [workbenchBox, terminalBox, statusBox] = await Promise.all([
        page.locator(".app-workbench").boundingBox(),
        page.locator(".terminal-panel").boundingBox(),
        page.locator(".agent-usage-bar").boundingBox(),
      ]);
      expect(workbenchBox).not.toBeNull();
      expect(terminalBox).not.toBeNull();
      expect(statusBox).not.toBeNull();
      if (!workbenchBox || !terminalBox || !statusBox) continue;
      expect(workbenchBox.width).toBeGreaterThan(300);
      expect(workbenchBox.height).toBeGreaterThan(200);
      expect(terminalBox.x).toBeGreaterThanOrEqual(workbenchBox.x + workbenchBox.width - 1);
      expect(statusBox.y).toBeGreaterThanOrEqual(workbenchBox.y + workbenchBox.height - 1);
      // Per mode: the bar must span the shell. Several legacy mode templates
      // define no `status` area, and a bar that falls back to auto-placement
      // lands in the 48px activity column with every chip clipped.
      expect(statusBox.x).toBeLessThanOrEqual(1);
      expect(statusBox.width).toBeGreaterThanOrEqual(width - 1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
    }
  });
}

for (const width of [1024, 1280]) {
  test(`contains every right workbench beside a right-docked terminal at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await dockTerminalRight(page);

    for (const [label, selector] of PRIMARY_MODES) {
      await page.getByRole("button", {
        name: `${label} 오른쪽에 열기 (Option-click)`,
      }).click();

      const workbench = page.locator(".app-workbench.workbench-secondary-open");
      const secondary = workbench.locator(".workbench-secondary-surface");
      const terminal = page.locator(".terminal-panel");
      const root = secondary.locator(`:scope > ${selector}`);
      await expect(workbench.locator(":scope > .editor-pane")).toBeVisible();
      await expect(root).toHaveCount(1);
      await expect(root).toBeVisible();
      await expect(page.locator(selector)).toHaveCount(1);

      const [workbenchBox, secondaryBox, terminalBox] = await Promise.all([
        workbench.boundingBox(),
        secondary.boundingBox(),
        terminal.boundingBox(),
      ]);
      expect(workbenchBox).not.toBeNull();
      expect(secondaryBox).not.toBeNull();
      expect(terminalBox).not.toBeNull();
      if (workbenchBox && secondaryBox && terminalBox) {
        expect(secondaryBox.width).toBeGreaterThan(250);
        expect(secondaryBox.height).toBeGreaterThan(200);
        expect(terminalBox.x).toBeGreaterThanOrEqual(
          workbenchBox.x + workbenchBox.width - 1,
        );
      }
      expect(
        await secondary.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
    }
  });
}

test("keeps every status bar control inside the status row", async ({ page }) => {
  // A screenshot of the bar element itself renders content the parent grid
  // clips, so this asserts geometry instead: the row must contain its own
  // content, and no control may cross the window edge.
  for (const height of [720, 900]) {
    await page.setViewportSize({ width: 1280, height });
    await page.goto("/");
    const bar = page.locator(".agent-usage-bar");
    await expect(bar).toBeVisible();
    await expect(bar.locator(".agent-usage-chip").first()).toBeVisible();

    const measured = await bar.evaluate((node) => ({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      bottom: node.getBoundingClientRect().bottom,
      width: node.getBoundingClientRect().width,
      shellWidth:
        document.querySelector(".app-shell")?.getBoundingClientRect().width ?? 0,
      overflowing: Array.from(node.querySelectorAll("button")).filter((child) => {
        const rect = child.getBoundingClientRect();
        const box = node.getBoundingClientRect();
        return rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5;
      }).length,
    }));
    // The bar must span the shell, not land in the activity column: a bad
    // grid placement left it 48px wide with every chip overflowing unseen.
    expect(measured.width).toBeGreaterThanOrEqual(measured.shellWidth - 1);
    expect(measured.scrollHeight).toBeLessThanOrEqual(measured.clientHeight + 1);
    expect(measured.overflowing).toBe(0);
    expect(measured.bottom).toBeLessThanOrEqual(height + 0.5);
  }
});

test("keeps terminal and status inside a 720x800 viewport", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 800 });
  await page.goto("/");
  await dockTerminalRight(page);

  const [shellBox, workbenchBox, terminalBox, statusBox] = await Promise.all([
    page.locator(".app-shell").boundingBox(),
    page.locator(".app-workbench").boundingBox(),
    page.locator(".terminal-panel").boundingBox(),
    page.locator(".agent-usage-bar").boundingBox(),
  ]);
  expect(shellBox).not.toBeNull();
  expect(workbenchBox).not.toBeNull();
  expect(terminalBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  if (!shellBox || !workbenchBox || !terminalBox || !statusBox) return;

  expect(shellBox.height).toBeLessThanOrEqual(801);
  expect(workbenchBox.height).toBeGreaterThan(100);
  expect(terminalBox.y).toBeGreaterThanOrEqual(workbenchBox.y + workbenchBox.height - 1);
  expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(801);
  await expect(page.locator(".agent-usage-bar")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollHeight <= window.innerHeight + 1 &&
        document.body.scrollHeight <= window.innerHeight + 1,
    ),
  ).toBe(true);
});

test("contains the opt-in E2E workbench in main and right placements", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto("/?maru-e2e=1");
  await dockTerminalRight(page);

  await page.getByRole("button", { name: "E2E 플로우", exact: true }).click();
  await expect(page.locator(".e2e-pane")).toHaveCount(1);
  await expect(page.locator(".e2e-pane")).toBeVisible();

  await page
    .getByRole("button", { name: "E2E 플로우 오른쪽에 열기 (Option-click)" })
    .click();
  const secondary = page.locator(
    ".workbench-secondary-surface > .e2e-pane",
  );
  await expect(secondary).toHaveCount(1);
  await expect(secondary).toBeVisible();
  expect(
    await secondary.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
});

test("falls back from a persisted Diagram split when Diagram is disabled", async ({ page }) => {
  await page.goto("/?maru-diagram=0");
  await expect(page.locator(".document-tab.active")).toBeVisible();

  const settings = structuredClone(DEFAULT_MARU_SETTINGS);
  settings.ui.activeAppMode = "pkm";
  settings.ui.rightWorkbenchSurface = "diagram";
  settings.ui.layout.editorSplitOpen = true;
  await page.evaluate((nextSettings) => {
    window.dispatchEvent(
      new CustomEvent("maru://settings-updated", {
        detail: {
          workPath: "mock://maru-sample-workspace",
          settings: nextSettings,
          globalChanged: true,
          workspaceChanged: true,
        },
      }),
    );
  }, settings);

  await expect(page.getByRole("button", { name: "다이어그램", exact: true })).toHaveCount(0);
  await expect(page.locator(".workbench-secondary-surface")).toHaveCount(0);
  await expect(page.locator(".editor-pane")).toBeVisible();
});
