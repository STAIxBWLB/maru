// Maru Dashboard — Playwright e2e over the deterministic mocked-provider
// fixture (e2e/helpers/todayFixtures.ts, extended with catalog_scan /
// catalog_query stubs). The dev server has no Tauri backend; every dashboard
// command resolves through the in-page fake or the api.ts browser fallbacks
// (git_status → not-a-repo, dot_sync_overview → empty overview, scan_inbox_drop
// → fixed mock drop items), so widget states are fully deterministic.

import { expect, test, type Page } from "@playwright/test";
import {
  buildTodaySeed,
  FIXTURE_DAY,
  FIXTURE_WORK_PATH,
  installTodayMocks,
} from "./helpers/todayFixtures";

test.describe.configure({ retries: 0 });

// Commitments/today widgets format with the logical clock; pin the timezone
// like the other Today-fixture specs.
test.use({ timezoneId: "Asia/Seoul" });

// Boot seed for the dashboard mode: the auto-open marker already matches the
// fixture day, so the persisted "dashboard" mode is restored as-is.
const DASHBOARD_BOOT_SEED = { markerDay: FIXTURE_DAY, persistedMode: "dashboard" } as const;

const WIDGET_KINDS = [
  "today",
  "tasks",
  "schedule",
  "catalog",
  "inbox",
  "agents",
  "drafts",
  "git",
  "recents",
  "sync",
] as const;

async function gotoDashboard(page: Page) {
  await page.goto("/");
  await expect(page.locator(".dashboard-pane")).toBeVisible();
  await expect(page.locator(".today-pane")).toHaveCount(0);
  await expect(page.locator(".tasks-pane")).toHaveCount(0);
}

function widget(page: Page, kind: (typeof WIDGET_KINDS)[number]) {
  return page.locator(`.dashboard-widget-${kind}`);
}

function dashTaskRow(
  relPath: string,
  title: string,
  status: string,
  frontmatterExtra: Record<string, unknown> = {},
  bucket = "active",
) {
  return {
    path: `${FIXTURE_WORK_PATH}/${relPath}`,
    relPath,
    fileName: relPath.split("/").pop(),
    bucket,
    sizeBytes: 320,
    updatedAt: "2026-07-20T18:00:00+09:00",
    frontmatter: { title, status, priority: "medium", ...frontmatterExtra },
  };
}

test("boots into the dashboard overview grid with all ten widgets", async ({ page }) => {
  await installTodayMocks(page, buildTodaySeed(DASHBOARD_BOOT_SEED));
  await gotoDashboard(page);

  await expect(
    page.locator(".dashboard-header").getByRole("button", { name: "새로고침" }),
  ).toBeVisible();
  await expect(page.locator(".dashboard-grid")).toBeVisible();
  for (const kind of WIDGET_KINDS) {
    await expect(page.locator(`[data-dashboard-widget="${kind}"]`)).toHaveCount(1);
  }

  // Geometry guard: the pane must fill the workbench, not fall into the
  // documents grid column (regression: .dashboard-pane missing from the
  // pane-placement :is() lists in styles.css left it auto-placed at ~27%).
  const viewportWidth = page.viewportSize()?.width ?? 1280;
  const paneBox = await page.locator(".dashboard-pane").boundingBox();
  expect(paneBox).not.toBeNull();
  expect(paneBox!.width).toBeGreaterThan(viewportWidth * 0.6);

  // Fixture-backed widgets render their data; the browser fallbacks render
  // their deterministic empty/setup states. Nothing errors.
  await expect(widget(page, "today").locator(".dashboard-widget-count")).toHaveText("3");
  await expect(widget(page, "today")).toContainText("준비 중");
  await expect(widget(page, "schedule")).toContainText("주간 사업 점검 회의");
  // 2 mock drop items + 5 pending fixture entries; the latest list is sorted
  // by recency, so the newer pending entries lead.
  await expect(widget(page, "inbox").locator(".dashboard-widget-count")).toHaveText("7");
  await expect(widget(page, "inbox")).toContainText("공유대학 예산안 검토 요청");
  await expect(widget(page, "git").locator(".dashboard-widget-empty")).toHaveText(
    "Git 저장소가 아닙니다",
  );
  await expect(widget(page, "sync").locator(".dashboard-pill")).toHaveClass(
    /dashboard-sync-setup/,
  );
  await expect(page.locator(".dashboard-widget-error")).toHaveCount(0);
});

test("tasks widget chips reflect seeded counts and drill down into filtered rows", async ({
  page,
}) => {
  // The chip counts key off the wall-clock "today" — pin it to the fixture day.
  await page.clock.install();
  await page.clock.setFixedTime(new Date("2026-07-21T09:00:00+09:00"));
  const taskRows = [
    dashTaskRow("tasks/active/260721-today.md", "오늘 마감 보고서", "active", {
      due: FIXTURE_DAY,
    }),
    dashTaskRow("tasks/active/260719-overdue.md", "기한 지난 회신", "active", {
      due: "2026-07-19",
    }),
    dashTaskRow("tasks/active/260725-future.md", "다음주 발표 준비", "active", {
      due: "2026-07-25",
    }),
    dashTaskRow("tasks/backlog/260720-idea.md", "백로그 아이디어", "backlog", {}, "backlog"),
    dashTaskRow(
      "tasks/archive/260718-done.md",
      "완료된 정리",
      "done",
      { done: "2026-07-18" },
      "archive",
    ),
  ];
  await installTodayMocks(page, buildTodaySeed({ ...DASHBOARD_BOOT_SEED, taskRows }));
  await gotoDashboard(page);

  const tasks = widget(page, "tasks");
  const chip = (name: string) => tasks.locator(".dashboard-chip", { hasText: name });
  await expect(chip("오늘").locator(".dashboard-chip-count")).toHaveText("1");
  await expect(chip("기한 초과").locator(".dashboard-chip-count")).toHaveText("1");
  await expect(chip("예정").locator(".dashboard-chip-count")).toHaveText("3");
  await expect(chip("백로그").locator(".dashboard-chip-count")).toHaveText("1");
  await expect(chip("완료").locator(".dashboard-chip-count")).toHaveText("1");

  await chip("기한 초과").click();
  const drilldown = page.locator(".dashboard-drilldown-tasks");
  await expect(drilldown).toBeVisible();
  await expect(drilldown.locator(".dashboard-chip.active")).toContainText("기한 초과");
  await expect(drilldown.locator(".dashboard-row")).toHaveCount(1);
  await expect(drilldown).toContainText("기한 지난 회신");
  await expect(drilldown).not.toContainText("오늘 마감 보고서");

  await page.locator(".dashboard-back").click();
  await expect(page.locator(".dashboard-grid")).toBeVisible();
  await expect(page.locator(".dashboard-drilldown")).toHaveCount(0);
});

test("catalog widget renders seeded kind counts and drills into kind entries", async ({
  page,
}) => {
  await installTodayMocks(page, buildTodaySeed(DASHBOARD_BOOT_SEED));
  await gotoDashboard(page);

  const catalog = widget(page, "catalog");
  await expect(catalog.locator(".dashboard-widget-count")).toHaveText("4");
  const chip = (name: string) => catalog.locator(".dashboard-chip", { hasText: name });
  await expect(chip("마감 임박").locator(".dashboard-chip-count")).toHaveText("2");
  await expect(chip("결재 진행").locator(".dashboard-chip-count")).toHaveText("1");
  await expect(chip("미연결 증빙").locator(".dashboard-chip-count")).toHaveText("1");
  await expect(chip("인박스 대기").locator(".dashboard-chip-count")).toHaveText("0");
  await expect(chip("태스크 마감").locator(".dashboard-chip-count")).toHaveText("0");

  await chip("마감 임박").click();
  const drilldown = page.locator(".dashboard-drilldown-catalog");
  await expect(drilldown).toBeVisible();
  await expect(drilldown.locator(".dashboard-chip.active")).toContainText("마감 임박");
  await expect(drilldown.locator(".dashboard-row-static")).toHaveCount(2);
  await expect(drilldown).toContainText("RISE 사업 중간보고서");
  await expect(drilldown).toContainText("KOICA 사업계획서");
  await expect(drilldown).not.toContainText("여름학기 예산 결재");
});

test("a failing widget renders its own error and retry recovers it", async ({ page }) => {
  // React StrictMode double-runs the mount effect in dev, and the cancelled
  // first fetch still consumes one injected failure — so failing twice is
  // what leaves the live second fetch rejected. Every other command resolves
  // normally.
  await installTodayMocks(
    page,
    buildTodaySeed({ ...DASHBOARD_BOOT_SEED, catalogScanFailures: 2 }),
  );
  await gotoDashboard(page);

  const catalog = widget(page, "catalog");
  await expect(catalog.locator(".dashboard-widget-error")).toBeVisible();
  await expect(catalog.locator(".dashboard-widget-retry")).toBeVisible();

  // The failure stays inside the catalog widget — neighbors render fine.
  await expect(page.locator(".dashboard-widget-error")).toHaveCount(1);
  await expect(widget(page, "tasks").locator(".dashboard-chip").first()).toBeVisible();
  await expect(widget(page, "inbox")).toContainText("공유대학 예산안 검토 요청");

  await catalog.locator(".dashboard-widget-retry").click();
  await expect(catalog.locator(".dashboard-widget-error")).toHaveCount(0);
  await expect(
    catalog.locator(".dashboard-chip", { hasText: "마감 임박" }),
  ).toBeVisible();
});

test("widget actions deep-link into the owning modes", async ({ page }) => {
  await installTodayMocks(page, buildTodaySeed(DASHBOARD_BOOT_SEED));
  await gotoDashboard(page);

  await widget(page, "tasks").locator(".dashboard-widget-action").click();
  await expect(page.locator(".tasks-pane")).toBeVisible();
  await expect(page.locator(".dashboard-pane")).toHaveCount(0);

  await page
    .locator(".activity-rail")
    .getByRole("button", { name: "대시보드", exact: true })
    .click();
  await expect(page.locator(".dashboard-pane")).toBeVisible();

  await widget(page, "inbox").locator(".dashboard-widget-action").click();
  await expect(page.locator(".inbox-pane")).toBeVisible();
  await expect(page.locator(".dashboard-pane")).toHaveCount(0);
});

test("recents widget lists seeded recent documents and opens one in Docs mode", async ({
  page,
}) => {
  // The recents feed is localStorage-backed ("maru:recent:v1") and resolves
  // against the browser document index (src/lib/fixtures.ts mockDocuments).
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:e2e:recents-seeded") === "true") return;
    window.localStorage.setItem(
      "maru:recent:v1",
      JSON.stringify([
        "mock://maru-sample-workspace/maru-weekly-meeting.md",
        "mock://maru-sample-workspace/references/maru-glossary.md",
      ]),
    );
    window.sessionStorage.setItem("maru:e2e:recents-seeded", "true");
  });
  await installTodayMocks(page, buildTodaySeed(DASHBOARD_BOOT_SEED));
  await gotoDashboard(page);

  const recents = widget(page, "recents");
  await expect(recents.locator(".dashboard-widget-count")).toHaveText("2");
  await expect(recents).toContainText("Maru 사업 주간 점검 회의");
  await expect(recents).toContainText("Maru 용어집");

  await recents.getByRole("button", { name: "Maru 용어집" }).click();
  await expect(page.locator(".dashboard-pane")).toHaveCount(0);
  await expect(
    page.locator(".document-tab-title", { hasText: "Maru 용어집" }),
  ).toBeVisible();
});
