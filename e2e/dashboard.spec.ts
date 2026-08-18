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

// Eight, not ten: the schedule card folded into "today" (both answer "what is
// today") and the task chips merged with the catalog signals into "attention",
// whose chip vocabulary no longer restates the inbox badge beside it.
const WIDGET_KINDS = [
  "today",
  "attention",
  "inbox",
  "recents",
  "agents",
  "drafts",
  "git",
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

test("boots into the dashboard overview grid with every widget", async ({ page }) => {
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
  // The agenda merged into the today card.
  await expect(widget(page, "today")).toContainText("주간 사업 점검 회의");
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

test("attention widget task chips reflect seeded counts and drill into filtered rows", async ({
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

  const tasks = widget(page, "attention");
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

test("attention widget renders seeded catalog counts and drills into kind entries", async ({
  page,
}) => {
  await installTodayMocks(page, buildTodaySeed(DASHBOARD_BOOT_SEED));
  await gotoDashboard(page);

  const catalog = widget(page, "attention");
  const chip = (name: string) => catalog.locator(".dashboard-chip", { hasText: name });
  await expect(chip("마감 임박").locator(".dashboard-chip-count")).toHaveText("2");
  await expect(chip("결재 진행").locator(".dashboard-chip-count")).toHaveText("1");
  await expect(chip("미연결 증빙").locator(".dashboard-chip-count")).toHaveText("1");
  // The inbox-pending and task-due kinds are gone: the inbox badge and the task
  // chips in this same card already carry them, from the sources that own them.
  await expect(catalog.locator(".dashboard-chip", { hasText: "인박스 대기" })).toHaveCount(0);
  await expect(catalog.locator(".dashboard-chip", { hasText: "태스크 마감" })).toHaveCount(0);

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

  const catalog = widget(page, "attention");
  await expect(catalog.locator(".dashboard-widget-error")).toBeVisible();
  await expect(catalog.locator(".dashboard-widget-retry")).toBeVisible();

  // The failure stays inside the catalog chip group: neighbours render fine and,
  // crucially, so do the task chips sharing the card with it.
  await expect(page.locator(".dashboard-widget-error")).toHaveCount(1);
  await expect(catalog.locator(".dashboard-chip", { hasText: "오늘" })).toBeVisible();
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

  await widget(page, "attention").locator(".dashboard-widget-action").click();
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

// Regression guard: `.dashboard-list` was `display: grid` with an implicit
// `auto` column track. A grid item's automatic minimum size keeps that track at
// the item's min-content width, so the card only survives as long as the label
// has *somewhere* to break. Inbox labels are slugs, and the global
// `word-break: keep-all` (foundations.css) is stricter about break
// opportunities in WebKit than in Chromium — in the shipped WKWebView app the
// whole slug became one unbreakable token, the track grew to it, and the text
// painted straight through the card border.
//
// Seeding hyphenated slugs would only reproduce that in WebKit, and this suite
// runs Chromium. So seed labels with no break opportunity at all in any engine:
// then the min-content width *is* the whole string everywhere, and the guard
// fails on the pre-fix CSS as it should. What it pins is the behaviour we
// actually want — a label too long for its card gets clipped, never escapes.
const OVERFLOW_SEED_TITLES = [
  `260818gwsYouHaveANewGoogleAccountForJejuAi${"AndAVeryLongUnbrokenTail".repeat(3)}`,
  `260818msoActionRequired7DaysLeftToBackUpYourData${"BeforeTheDeadline".repeat(3)}`,
  `제주한라대학교인공지능학과공유대학예산안검토요청최종본대외비${"2026년도사업계획".repeat(3)}`,
];

for (const width of [1024, 1280, 1487]) {
  test(`dashboard lists stay inside their cards at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1058 });
    await installTodayMocks(
      page,
      buildTodaySeed({
        ...DASHBOARD_BOOT_SEED,
        inboxEntries: OVERFLOW_SEED_TITLES.map((title, index) => ({
          id: `260818-gws-overflow-${index}`,
          kind: "pendingItem",
          path: `${FIXTURE_WORK_PATH}/inbox/items/pending/260818-gws-overflow-${index}`,
          relPath: `inbox/items/pending/260818-gws-overflow-${index}`,
          title,
          channel: "gws",
          sourceKind: "mail",
          dropPath: null,
          configuredRoot: "inbox",
          itemId: `260818-gws-overflow-${index}`,
          status: "pending",
          manifestPath: null,
          summaryPath: null,
          routePath: null,
          sizeBytes: 640,
          receivedAt: `2026-08-18T0${index + 1}:00:00+09:00`,
        })),
      }),
    );
    await gotoDashboard(page);
    await expect(widget(page, "inbox")).toBeVisible();

    // No widget scrolls its own content horizontally...
    const overflowingWidgets = await page
      .locator(".dashboard-widget")
      .evaluateAll((els) =>
        els
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => el.getAttribute("data-dashboard-widget")),
      );
    expect(overflowingWidgets).toEqual([]);

    // ...and no list row paints outside the card that owns it.
    const escapedRows = await page
      .locator(".dashboard-widget")
      .evaluateAll((els) =>
        els.flatMap((el) => {
          const cardRight = el.getBoundingClientRect().right;
          return [...el.querySelectorAll(".dashboard-list > li, .dashboard-link")]
            .filter((row) => row.getBoundingClientRect().right > cardRight + 1)
            .map(() => el.getAttribute("data-dashboard-widget"));
        }),
      );
    expect(escapedRows).toEqual([]);

    // The pane itself never gains a horizontal scrollbar.
    expect(
      await page
        .locator(".dashboard-pane")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
  });
}

// Both guards below come from review findings on the six-into-four merge: each
// one folded a second data source into a card whose empty/error gate still only
// consulted the first.

test("today card keeps the agenda when Today itself is disabled", async ({ page }) => {
  // useDashboardToday is gated on settings.today.enabled; useDashboardSchedule
  // is not, so commitments still load. Before the fix the merged card fell
  // straight to "Today is disabled" and the agenda that used to have its own
  // card vanished with it.
  await installTodayMocks(
    page,
    buildTodaySeed({ ...DASHBOARD_BOOT_SEED, todayEnabled: false }),
  );
  await gotoDashboard(page);

  const today = widget(page, "today");
  await expect(today).toContainText("주간 사업 점검 회의");
  await expect(today.locator(".dashboard-widget-empty")).toHaveCount(0);
});

test("attention card surfaces a catalog failure even with no tasks", async ({ page }) => {
  // A failed scan zero-fills every catalog chip, so a data-only empty test read
  // "nothing needs attention" and painted the empty state over the nested error
  // and its retry button, leaving no way back.
  await installTodayMocks(
    page,
    buildTodaySeed({ ...DASHBOARD_BOOT_SEED, taskRows: [], catalogScanFailures: 2 }),
  );
  await gotoDashboard(page);

  const attention = widget(page, "attention");
  await expect(attention.locator(".dashboard-widget-error")).toBeVisible();
  await expect(attention.locator(".dashboard-widget-retry")).toBeVisible();
  await expect(attention.locator(".dashboard-widget-empty")).toHaveCount(0);
});
