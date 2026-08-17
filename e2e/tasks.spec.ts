// Maru Tasks — Playwright e2e for the standalone tasks mode (.tasks-pane),
// split out of the Today planner. Same deterministic mocked-provider fixture
// as e2e/today.spec.ts (e2e/helpers/todayFixtures.ts): the dev server has no
// Tauri backend, every task/calendar command resolves through the in-page
// fake registered by installTodayMocks, and all assertions run against the
// fixed logical day (2026-07-21) — no wall-clock dependencies.

import { expect, test, type Page } from "@playwright/test";
import {
  buildTodaySeed,
  FIXTURE_DAY,
  FIXTURE_WORK_PATH,
  installTodayMocks,
  TASK_A_TITLE,
} from "./helpers/todayFixtures";

test.describe.configure({ retries: 0 });

const SETTINGS_KEY = `maru:settings:fallback:v1:${FIXTURE_WORK_PATH}`;

// Boot seed for the standalone mode: the auto-open marker already matches the
// fixture day, so the persisted "tasks" mode is restored as-is.
const TASKS_BOOT_SEED = { markerDay: FIXTURE_DAY, persistedMode: "tasks" } as const;

async function gotoTasksPane(page: Page) {
  await page.goto("/");
  await expect(page.locator(".tasks-pane")).toBeVisible();
  await expect(page.locator(".today-pane")).toHaveCount(0);
}

async function runCommandPaletteAction(page: Page, label: string) {
  await page.locator(".topbar-command-action").click();
  const input = page.locator(".cmdk-input input");
  await expect(input).toBeVisible();
  await input.fill(label);
  await page.locator(".cmdk-item", { hasText: label }).click();
}

test("boots into the standalone tasks pane when tasks is the persisted mode", async ({
  page,
}) => {
  await installTodayMocks(page, buildTodaySeed(TASKS_BOOT_SEED));
  await gotoTasksPane(page);

  await expect(page.locator(".tasks-sidebar")).toBeVisible();
  await expect(page.locator(".tasks-toolbar")).toBeVisible();
  await expect(page.locator(".tasks-view-switcher")).toBeVisible();
  await expect(page.locator(".unified-calendar")).toBeVisible();
  await expect(page.locator(".tasks-pane")).toContainText(TASK_A_TITLE);
});

test("opens the standalone tasks mode from the 태스크 rail button", async ({ page }) => {
  await installTodayMocks(page, buildTodaySeed({ markerDay: FIXTURE_DAY }));
  await page.goto("/");
  await expect(page.locator(".tasks-pane")).toHaveCount(0);

  await page
    .locator(".activity-rail")
    .getByRole("button", { name: "태스크", exact: true })
    .click();
  await expect(page.locator(".tasks-pane")).toBeVisible();
  await expect(page.locator(".today-pane")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.localStorage.getItem(key)?.includes('"activeAppMode":"tasks"') ?? false,
        SETTINGS_KEY,
      ),
    )
    .toBe(true);
});

test("task list shows readable metadata and persists keyboard-resized regions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1700, height: 920 });
  const taskRows = [
    {
      path: `${FIXTURE_WORK_PATH}/tasks/active/260723-admin-ai.md`,
      relPath: "tasks/active/260723-admin-ai.md",
      fileName: "260723-admin-ai.md",
      displayTitle: "AI혁신처 운영 점검",
      bucket: "active",
      sizeBytes: 320,
      updatedAt: "2026-07-21T09:00:00+09:00",
      frontmatter: {
        status: "active",
        priority: "high",
        project: "[[admin-ai-innovation]]",
        due: FIXTURE_DAY,
      },
    },
    {
      path: `${FIXTURE_WORK_PATH}/tasks/active/260723-saltlux.md`,
      relPath: "tasks/active/260723-saltlux.md",
      fileName: "260723-saltlux.md",
      displayTitle: "에이전틱 AI 협력안 정리",
      bucket: "active",
      sizeBytes: 320,
      updatedAt: "2026-07-21T09:10:00+09:00",
      frontmatter: {
        status: "active",
        priority: "medium",
        project: "[[agentic-ai-education-platform-with-saltlux-luxia|솔트룩스 협력]]",
      },
    },
  ];
  await installTodayMocks(page, buildTodaySeed({ ...TASKS_BOOT_SEED, taskRows }));
  await gotoTasksPane(page);

  await expect(page.locator(".tasks-sidebar")).toContainText("Admin AI innovation");
  await expect(page.locator(".tasks-sidebar")).toContainText("솔트룩스 협력");
  await expect(page.locator(".tasks-pane")).toContainText("AI혁신처 운영 점검");
  await expect(page.locator(".tasks-pane")).not.toContainText("[[admin-ai-innovation]]");

  const resizeFilters = page.getByRole("separator", { name: "태스크 필터 영역 크기 조절" });
  await resizeFilters.focus();
  await page.keyboard.press("ArrowRight");
  await expect(resizeFilters).toHaveAttribute("aria-valuenow", "252");

  const resizeAgenda = page.getByRole("separator", { name: "일정 목록 영역 크기 조절" });
  await resizeAgenda.focus();
  await page.keyboard.press("ArrowRight");
  await expect(resizeAgenda).toHaveAttribute("aria-valuenow", "292");

  await page
    .locator(".cal-agenda-pane")
    .getByRole("button", { name: "AI혁신처 운영 점검", exact: true })
    .click();
  await expect(page.locator(".task-detail-drawer")).toBeVisible();
  const resizeDetails = page.getByRole("separator", { name: "태스크 상세 영역 크기 조절" });
  await resizeDetails.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(resizeDetails).toHaveAttribute("aria-valuenow", "412");

  await page.reload();
  await expect(page.locator(".tasks-pane")).toBeVisible();
  await expect(
    page.getByRole("separator", { name: "태스크 필터 영역 크기 조절" }),
  ).toHaveAttribute("aria-valuenow", "252");
  await expect(
    page.getByRole("separator", { name: "일정 목록 영역 크기 조절" }),
  ).toHaveAttribute("aria-valuenow", "292");
  await page
    .locator(".cal-agenda-pane")
    .getByRole("button", { name: "AI혁신처 운영 점검", exact: true })
    .click();
  await expect(
    page.getByRole("separator", { name: "태스크 상세 영역 크기 조절" }),
  ).toHaveAttribute("aria-valuenow", "412");

  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
});

test("tasks calendar fills the compact pane with a right-docked graph and keeps the agenda as an overlay", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 920 });
  await installTodayMocks(page, buildTodaySeed(TASKS_BOOT_SEED));
  await gotoTasksPane(page);

  // The Graph surface intentionally returns the primary app mode to Docs
  // when it is activated. Open it there first, then return to Tasks; this is
  // the supported way to keep a primary workbench beside the shared panel.
  await page
    .locator(".activity-rail")
    .getByRole("button", { name: "문서", exact: true })
    .click();
  await expect(page.locator(".document-list")).toBeVisible();

  const calendar = page.locator(".unified-calendar");
  const tasksMain = page.locator(".tasks-main");
  const main = calendar.locator(".cal-main");

  // Keep Tasks mounted while opening the shared panel, as in the graph
  // workbench regression: dock first, expand the panel, then switch its
  // surface to Graph. The command "패널에서 그래프 열기" intentionally
  // navigates away from Tasks, so it is not the right path for this layout.
  await runCommandPaletteAction(page, "패널을 오른쪽에 배치");
  const terminalPanel = page.locator(".terminal-panel");
  await expect(page.locator(".app-shell")).toHaveClass(/terminal-dock-right/);
  await terminalPanel.locator(".terminal-title").click();
  await expect(terminalPanel).not.toHaveClass(/collapsed/);
  const graphTab = terminalPanel.getByTestId("panel-graph-tab");
  await graphTab.click();
  await expect(graphTab).toHaveAttribute("aria-selected", "true");
  await expect(terminalPanel.locator(".graph-view")).toBeVisible();

  await page
    .locator(".activity-rail")
    .getByRole("button", { name: "태스크", exact: true })
    .click();
  await expect(page.locator(".tasks-pane")).toBeVisible();
  await expect(calendar).toBeVisible();
  await expect(tasksMain).toBeVisible();
  await expect(main).toBeVisible();

  const calendarBox = await calendar.boundingBox();
  const tasksMainBox = await tasksMain.boundingBox();
  const mainBox = await main.boundingBox();
  expect(calendarBox).not.toBeNull();
  expect(tasksMainBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  if (!calendarBox || !tasksMainBox || !mainBox) return;
  expect(calendarBox.width).toBeGreaterThan(0);
  expect(tasksMainBox.width).toBeGreaterThan(0);
  const tasksMainContentWidth = await tasksMain.evaluate((element) => element.clientWidth);
  const calendarContentWidth = await calendar.evaluate((element) => element.clientWidth);
  expect(Math.abs(tasksMainContentWidth - calendarContentWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(mainBox.width - calendarBox.width)).toBeLessThanOrEqual(1);

  await expect(calendar.locator(".cal-agenda-pane")).toBeHidden();
  await expect(calendar.locator(".cal-agenda-resizer")).toBeHidden();

  const agendaToggle = calendar.locator(".cal-agenda-toggle");
  await expect(agendaToggle).toBeVisible();
  const agendaPaneId = await agendaToggle.getAttribute("aria-controls");
  expect(agendaPaneId).toBeTruthy();
  if (!agendaPaneId) return;
  const agendaPane = calendar.locator(`[id="${agendaPaneId}"]`);
  await expect(agendaPane).toHaveClass(/cal-agenda-pane/);
  await expect(agendaPane).toBeHidden();
  await expect(agendaToggle).toHaveAccessibleName("일정 목록 열기");
  await expect(agendaToggle).toHaveAttribute("aria-expanded", "false");
  await agendaToggle.click();
  await expect(agendaToggle).toHaveAttribute("aria-expanded", "true");
  await expect(agendaToggle).toHaveAccessibleName("일정 목록 닫기");
  await expect(agendaToggle).toHaveAttribute("aria-controls", agendaPaneId);
  await expect(agendaPane).toBeVisible();
  await agendaToggle.click();
  await expect(agendaToggle).toHaveAttribute("aria-expanded", "false");
  await expect(agendaToggle).toHaveAccessibleName("일정 목록 열기");
  await expect(agendaPane).toBeHidden();

  // Keep the selected-task detail overlay in the same compact layout covered.
  await expect(calendar.locator(".cal-bar").first()).toBeVisible();
  await calendar.locator(".cal-bar").first().click();
  await expect(page.locator(".task-detail-drawer")).toBeVisible();

  const metrics = await page.evaluate(() => {
    const selectors = [
      ".unified-calendar",
      ".cal-toolbar",
      ".cal-week-body",
      ".cal-week-columns",
      ".cal-body",
    ];
    const widths = Object.fromEntries(
      selectors.map((selector) => {
        const element = document.querySelector<HTMLElement>(selector);
        return [
          selector,
          element
            ? { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }
            : null,
        ];
      }),
    ) as Record<string, { scrollWidth: number; clientWidth: number } | null>;
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      calendarPresent: Boolean(document.querySelector<HTMLElement>(".unified-calendar")),
      widths,
    };
  });
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.documentClientWidth + 1);
  expect(metrics.calendarPresent).toBe(true);
  for (const selector of [
    ".unified-calendar",
    ".cal-toolbar",
    ".cal-week-body",
    ".cal-week-columns",
    ".cal-body",
  ]) {
    const widths = metrics.widths[selector];
    expect(widths, `${selector} should be present`).not.toBeNull();
    if (widths) {
      expect(
        widths.scrollWidth,
        `${selector} should not overflow horizontally`,
      ).toBeLessThanOrEqual(widths.clientWidth + 1);
    }
  }
});
