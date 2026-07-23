// Maru Today — Playwright e2e over the deterministic mocked-provider
// fixture (e2e/helpers/todayFixtures.ts). The dev server has no Tauri
// backend; every Today command resolves through the in-page fake registered
// by installTodayMocks, and all assertions run against a fixed logical day
// (2026-07-21) with the recorded invoke log — no wall-clock dependencies.

import { expect, test, type Page } from "@playwright/test";
import {
  buildTodaySeed,
  FIXTURE_DAY,
  FIXTURE_WORK_PATH,
  installTodayMocks,
  mutationCalls,
  readTodayCalls,
  TASK_A,
  TASK_A_TITLE,
  TASK_B_TITLE,
  TASK_C_TITLE,
  TASK_DONE_TITLE,
  TODAY_LAST_AUTO_OPEN_KEY,
  type TodayInvokeCall,
} from "./helpers/todayFixtures";

test.describe.configure({ retries: 0 });

const SETTINGS_KEY = `maru:settings:fallback:v1:${FIXTURE_WORK_PATH}`;

function callsOf(calls: TodayInvokeCall[], command: string) {
  return calls.filter((call) => call.command === command);
}

async function gotoTodayPrepare(page: Page) {
  await page.goto("/");
  await expect(page.locator(".today-pane")).toBeVisible();
  await expect(page.locator(".today-panel-braindump")).toBeVisible();
}

// First-launch seed: marker absent, persisted mode left at the "pkm"
// default. The auto-open decision must win over the settings-load effect
// re-applying the persisted mode (App keeps the boot auto-open via
// todayAutoOpenPathRef) — including under React StrictMode double-boot.
const AUTO_OPEN_SEED = { markerDay: null } as const;

test("first eligible daily launch auto-opens Today; later launches restore the persisted mode", async ({
  page,
}) => {
  // Marker absent + persisted mode "pkm" → the first launch of the logical
  // day still auto-opens Today on the Prepare route (dayState "preparing"),
  // i.e. the auto-open survives the persisted-mode restore.
  await installTodayMocks(page, buildTodaySeed(AUTO_OPEN_SEED));
  await gotoTodayPrepare(page);

  await expect(page.locator(".today-stepper")).toBeVisible();
  await expect(page.locator(".today-quick-skip")).toBeVisible();
  await expect(page.locator(".today-panel-capture")).toBeVisible();
  // The auto-open marks the logical day so later launches leave mode alone.
  await expect
    .poll(() => page.evaluate((key) => window.localStorage.getItem(key), TODAY_LAST_AUTO_OPEN_KEY))
    .toBe(FIXTURE_DAY);

  // Switch to another mode and let it persist into the settings fallback.
  await page
    .locator(".activity-rail")
    .getByRole("button", { name: "인박스", exact: true })
    .click();
  await expect(page.locator(".inbox-pane")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.localStorage.getItem(key)?.includes('"activeAppMode":"inbox"') ?? false,
        SETTINGS_KEY,
      ),
    )
    .toBe(true);

  // Second "launch": marker matches the logical day → no forced Today; the
  // persisted inbox mode is restored.
  await page.reload();
  await expect(page.locator(".inbox-pane")).toBeVisible();
  await expect(page.locator(".today-pane")).toHaveCount(0);
});

test("explicit settings-window navigation wins over the Today auto-open", async ({ page }) => {
  await installTodayMocks(page, buildTodaySeed({ markerDay: null }));
  await page.goto("/?window=settings&workPath=mock%3A%2F%2Fmaru-sample-workspace&tab=tasks");

  // The separate settings window returns before the main-app boot, so no
  // Today command fires at all — explicit navigation always wins.
  await expect(page.locator(".settings-window-shell")).toBeVisible();
  await expect(page.locator(".today-pane")).toHaveCount(0);
  const calls = await readTodayCalls(page);
  expect(calls.filter((call) => call.command.startsWith("today_"))).toHaveLength(0);
});

test("prepare: brain dump autosave, capture add-to-today, keyboard reorder, quick skip", async ({
  page,
}) => {
  await installTodayMocks(page, buildTodaySeed(AUTO_OPEN_SEED));
  await gotoTodayPrepare(page);

  // Brain dump typing autosaves through setBrainDump after the debounce.
  const brainDump = page.locator(".today-braindump-textarea");
  await brainDump.click();
  await brainDump.fill("오늘 집중할 일을 정리한다");
  await expect
    .poll(async () => mutationCalls(await readTodayCalls(page), "setBrainDump").length, {
      timeout: 8_000,
    })
    .toBeGreaterThan(0);
  const brainDumpCalls = mutationCalls(await readTodayCalls(page), "setBrainDump");
  const lastBrainDump = brainDumpCalls.at(-1)?.args.mutation as { brainDump?: string };
  expect(lastBrainDump?.brainDump).toBe("오늘 집중할 일을 정리한다");

  // Capture row "add to today" persists a setPlan mutation only — no task
  // creation commands. The fixture records EVERY invoked command (registered
  // or not), so these absence assertions can genuinely fail.
  const firstCapture = page.locator(".today-capture-row").first();
  await expect(firstCapture).toBeVisible();
  await firstCapture.getByRole("button", { name: "오늘에 추가" }).click();
  await expect(firstCapture.locator(".today-capture-state")).toHaveText("오늘 계획에 추가됨");
  await expect
    .poll(async () => mutationCalls(await readTodayCalls(page), "setPlan").length)
    .toBeGreaterThan(0);
  const setPlanCalls = mutationCalls(await readTodayCalls(page), "setPlan");
  const lastPlan = setPlanCalls.at(-1)?.args.mutation as { plan?: { flexible?: unknown[] } };
  expect(JSON.stringify(lastPlan?.plan?.flexible ?? [])).toContain('"kind":"capture"');
  const commands = (await readTodayCalls(page)).map((call) => call.command);
  for (const forbidden of [
    "create_task_note",
    "update_task_status",
    "update_task_details",
    "move_task_note",
  ]) {
    expect(commands).not.toContain(forbidden);
  }

  // Keyboard-only reorder: focus a Top 3 row, Alt+ArrowDown, and the polite
  // live region announces the new rank.
  const firstTop = page.locator(".today-top3-row").first();
  await expect(firstTop).toContainText(TASK_A_TITLE);
  await firstTop.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.locator(".today-top3-row").nth(1)).toContainText(TASK_A_TITLE);
  await expect(page.locator(".today-panel-top3 [aria-live='polite']")).toContainText(
    `${TASK_A_TITLE}, 2번째로 이동`,
  );

  // Quick skip issues the quickSkip mutation and lands on Execute.
  await page.locator(".today-quick-skip").click();
  await expect
    .poll(async () => mutationCalls(await readTodayCalls(page), "quickSkip").length)
    .toBe(1);
  await expect(page.locator(".today-panel-done")).toBeVisible();
  await expect(page.locator(".today-panel-done")).toContainText("오늘 완료한 항목");
});

test("finish setup materializes accepted captures as local task notes and confirms the day", async ({
  page,
}) => {
  await installTodayMocks(page, buildTodaySeed(AUTO_OPEN_SEED));
  await gotoTodayPrepare(page);

  // Accept one capture into the plan — a reversible plan ref only, still no
  // task creation at this point.
  const firstCapture = page.locator(".today-capture-row").first();
  await firstCapture.getByRole("button", { name: "오늘에 추가" }).click();
  await expect(firstCapture.locator(".today-capture-state")).toHaveText("오늘 계획에 추가됨");
  expect((await readTodayCalls(page)).map((call) => call.command)).not.toContain(
    "create_task_note",
  );

  // Finish setup: the accepted capture materializes as ONE local task note,
  // its plan ref is rewritten to the new task, and the day is confirmed.
  await page.locator(".today-finish-setup").click();
  await expect
    .poll(async () => callsOf(await readTodayCalls(page), "create_task_note").length)
    .toBe(1);
  const created = callsOf(await readTodayCalls(page), "create_task_note")[0];
  const draft = created.args.draft as {
    title?: string;
    bucket?: string;
    frontmatter?: Record<string, unknown>;
  };
  expect(draft.title).toBeTruthy();
  expect(draft.bucket).toBe("active");
  expect(draft.frontmatter?.status).toBe("active");

  await expect
    .poll(async () => mutationCalls(await readTodayCalls(page), "confirmSetup").length)
    .toBe(1);
  const setPlans = mutationCalls(await readTodayCalls(page), "setPlan");
  const finalPlan = setPlans.at(-1)?.args.mutation as { plan?: unknown };
  expect(JSON.stringify(finalPlan?.plan ?? {})).not.toContain('"kind":"capture"');

  // Confirmed day lands on Execute.
  await expect(page.locator(".today-panel-done")).toBeVisible();
});

test("execute: Top 3 completion flows through task_transition with a syncing badge", async ({
  page,
}) => {
  // dayState "executing" routes the auto-open straight to the Execute stage.
  await installTodayMocks(
    page,
    buildTodaySeed({ ...AUTO_OPEN_SEED, dayState: "executing", route: "execute" }),
  );
  await page.goto("/");
  await expect(page.locator(".today-pane")).toBeVisible();

  const top3Panel = page.locator(".today-panel-top3");
  await expect(top3Panel).toBeVisible();
  await expect(top3Panel.locator(".today-exec-row")).toHaveCount(3);

  // The fixture event log already completed B today; the Done Today section
  // shows it (plus the scan-based archived row carrying the sync-error
  // outbox badge).
  const donePanel = page.locator(".today-panel-done");
  await expect(donePanel.locator(".today-exec-row", { hasText: TASK_B_TITLE })).toBeVisible();
  await expect(donePanel.locator(".today-exec-row", { hasText: TASK_DONE_TITLE })).toContainText(
    "재시도 필요",
  );
  await expect(page.locator(".today-sync-status")).toBeVisible();

  // Complete A: task_transition fires with the expected-hash optimistic
  // concurrency payload, and the row appears in Done Today as syncing.
  const rowA = top3Panel.locator(".today-exec-row", { hasText: TASK_A_TITLE });
  await rowA.getByRole("button", { name: "완료" }).click();
  await expect
    .poll(async () => callsOf(await readTodayCalls(page), "task_transition").length)
    .toBe(1);
  const transition = callsOf(await readTodayCalls(page), "task_transition")[0];
  const request = transition.args.request as {
    kind?: string;
    taskPath?: string;
    expectedTaskHash?: string;
    date?: string;
  };
  expect(request.kind).toBe("complete");
  expect(request.taskPath).toBe(TASK_A);
  expect(request.expectedTaskHash).toMatch(/^[0-9a-f]{64}$/);
  expect(request.date).toBe(FIXTURE_DAY);

  const doneRowA = donePanel.locator(".today-exec-row", { hasText: TASK_A_TITLE });
  await expect(doneRowA).toBeVisible();
  await expect(doneRowA.locator(".today-sync-badge")).toContainText("동기화 중");

  // Keyboard-only activation: focus the C row, Tab onto its complete button,
  // Enter — a second task_transition fires.
  const rowC = top3Panel.locator(".today-exec-row", { hasText: TASK_C_TITLE });
  await rowC.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => callsOf(await readTodayCalls(page), "task_transition").length)
    .toBe(2);
  await expect(
    donePanel.locator(".today-exec-row", { hasText: TASK_C_TITLE }),
  ).toBeVisible();
});

test("review: planned-vs-completed groups render and the reflection saves", async ({ page }) => {
  await installTodayMocks(
    page,
    buildTodaySeed({ ...AUTO_OPEN_SEED, dayState: "executing", route: "execute" }),
  );
  await page.goto("/");
  await expect(page.locator(".today-pane")).toBeVisible();

  await page.locator(".today-sidebar").getByRole("button", { name: "오늘 정리" }).click();

  const summary = page.locator(".today-panel-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("계획 대비 완료");
  await expect(summary).toContainText("계획 3개 중 1개 완료");
  const completedPlanned = summary.locator(".today-review-group", { hasText: "계획대로 완료" });
  await expect(completedPlanned).toContainText(TASK_B_TITLE);
  const notCompleted = summary.locator(".today-review-group", { hasText: "완료하지 못한 계획" });
  await expect(notCompleted).toContainText(TASK_A_TITLE);
  await expect(notCompleted).toContainText(TASK_C_TITLE);

  const deferred = page.locator(".today-panel-deferred");
  await expect(deferred).toContainText("미루거나 취소한 항목");
  await expect(deferred).toContainText("외부 위원 초청 일정 확정");

  // Reflection journal is fixture-backed: the textarea is enabled and saving
  // persists through save_document on the daily journal path.
  const reflection = page.locator(".today-review-reflection-input");
  await expect(reflection).toBeVisible();
  await expect(reflection).toBeEnabled();
  await reflection.fill("오늘은 계획대로 잘 흘러갔다.");
  await page.getByRole("button", { name: "회고 저장" }).click();
  await expect
    .poll(async () => callsOf(await readTodayCalls(page), "save_document").length)
    .toBe(1);
  const saveCall = callsOf(await readTodayCalls(page), "save_document")[0];
  expect(saveCall.args.documentPath).toBe(`tasks/daily/${FIXTURE_DAY}.md`);
  expect(String(saveCall.args.content)).toContain("오늘은 계획대로 잘 흘러갔다.");
  await expect(page.locator(".today-review-saved")).toHaveText("저장됨");
});

test("calendar sync is a functional route with explicit selection and publish", async ({ page }) => {
  const plan = {
    logicalDay: FIXTURE_DAY,
    inputRevision: "rev-1",
    top: [
      {
        itemRef: { kind: "task", taskId: TASK_A },
        lane: "top",
        order: 0,
        outcome: null,
        estimateMinutes: 45,
        estimateProvisional: false,
        pinned: false,
        proposedBlock: {
          startIso: `${FIXTURE_DAY}T09:00:00+09:00`,
          endIso: `${FIXTURE_DAY}T09:45:00+09:00`,
        },
        calendarSync: { status: "none" },
      },
    ],
    flexible: [],
    overflow: [],
    reasons: [],
    warnings: [],
  };
  await installTodayMocks(page, buildTodaySeed({ ...AUTO_OPEN_SEED, plan }));
  await gotoTodayPrepare(page);

  await page.locator(".today-sidebar").getByRole("button", { name: "캘린더 연동" }).click();
  const panel = page.locator(".today-calendar-sync");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "연결된 일정" })).toBeVisible();
  await expect(panel.locator(".today-calendar-commitment-list li")).toHaveCount(2);
  await expect(panel).toContainText(TASK_A_TITLE);

  const publish = panel.getByRole("button", { name: "선택 항목 게시 (0)" });
  await expect(publish).toBeDisabled();
  await panel.getByRole("button", { name: "캘린더에 추가" }).click();
  await expect
    .poll(
      async () =>
        mutationCalls(await readTodayCalls(page), "setCalendarSync").length,
    )
    .toBe(1);
  await expect(panel.getByRole("button", { name: "선택 항목 게시 (1)" })).toBeEnabled();

  await panel.getByRole("button", { name: "선택 항목 게시 (1)" }).click();
  await expect
    .poll(async () => callsOf(await readTodayCalls(page), "today_calendar_publish").length)
    .toBe(1);
});

test("all tasks shows readable metadata and persists keyboard-resized regions", async ({ page }) => {
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
  await installTodayMocks(
    page,
    buildTodaySeed({ ...AUTO_OPEN_SEED, persistedMode: "tasks", taskRows }),
  );
  await gotoTodayPrepare(page);
  await page.locator(".today-sidebar").getByRole("button", { name: "전체 태스크" }).click();

  await expect(page.locator(".tasks-pane")).toBeVisible();
  await expect(page.locator(".tasks-sidebar")).toContainText("Admin AI innovation");
  await expect(page.locator(".tasks-sidebar")).toContainText("솔트룩스 협력");
  await expect(page.locator(".tasks-pane")).toContainText("AI혁신처 운영 점검");
  await expect(page.locator(".tasks-pane")).not.toContainText("[[admin-ai-innovation]]");

  const todaySidebar = page.locator(".today-sidebar");
  const resizeToday = page.getByRole("separator", { name: "Today 탐색 영역 크기 조절" });
  await expect(resizeToday).toHaveAttribute("aria-valuenow", "240");
  await resizeToday.focus();
  await page.keyboard.press("ArrowRight");
  await expect(resizeToday).toHaveAttribute("aria-valuenow", "252");
  await expect
    .poll(async () => Math.round((await todaySidebar.boundingBox())?.width ?? 0))
    .toBe(252);

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
  await expect
    .poll(async () => Math.round((await page.locator(".today-sidebar").boundingBox())?.width ?? 0))
    .toBe(252);
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

test("rollover: a mocked day change surfaces exactly one new-day notification", async ({ page }) => {
  // Fake timers drive the 60s watcher deterministically — no real waiting.
  await page.clock.install();
  // Marker matches the fixture day so the boot path performs no rollover of
  // its own; only the watcher may fire one.
  await installTodayMocks(page, buildTodaySeed({ markerDay: FIXTURE_DAY }));
  await page.goto("/");

  // The watcher seeds its logical-day ref on mount (and the boot path may
  // add its own today_logical_day call) — wait for the seed calls to land.
  await expect
    .poll(async () => callsOf(await readTodayCalls(page), "today_logical_day").length)
    .toBeGreaterThan(0);
  expect(callsOf(await readTodayCalls(page), "today_rollover")).toHaveLength(0);
  expect(callsOf(await readTodayCalls(page), "today_notify_new_day")).toHaveLength(0);

  // Cross the 03:30 boundary behind the app's back, then let one watcher
  // interval elapse.
  await page.evaluate(() =>
    (
      window as unknown as { __MARU_TODAY_MOCK__: { setLogicalDay: (day: string) => void } }
    ).__MARU_TODAY_MOCK__.setLogicalDay("2026-07-22"),
  );
  await page.clock.runFor(60_000);

  await expect
    .poll(async () => callsOf(await readTodayCalls(page), "today_notify_new_day").length)
    .toBe(1);
  expect(callsOf(await readTodayCalls(page), "today_rollover")).toHaveLength(1);
  const notify = callsOf(await readTodayCalls(page), "today_notify_new_day")[0];
  expect(notify.args.logicalDay).toBe("2026-07-22");
});

test("rollover retries after a transient failure before notifying or refreshing", async ({ page }) => {
  await page.clock.install();
  await installTodayMocks(
    page,
    buildTodaySeed({ markerDay: FIXTURE_DAY, rolloverFailures: 1 }),
  );
  await page.goto("/");
  await expect
    .poll(async () => callsOf(await readTodayCalls(page), "today_logical_day").length)
    .toBeGreaterThan(0);

  await page.evaluate(() =>
    (
      window as unknown as { __MARU_TODAY_MOCK__: { setLogicalDay: (day: string) => void } }
    ).__MARU_TODAY_MOCK__.setLogicalDay("2026-07-22"),
  );
  await page.clock.runFor(60_000);
  await expect
    .poll(async () => callsOf(await readTodayCalls(page), "today_rollover").length)
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(async () => callsOf(await readTodayCalls(page), "today_notify_new_day").length)
    .toBe(1);
  const calls = await readTodayCalls(page);
  const rolloverIndexes = calls
    .map((call, index) => (call.command === "today_rollover" ? index : -1))
    .filter((index) => index >= 0);
  const notifyIndex = calls.findIndex((call) => call.command === "today_notify_new_day");
  expect(notifyIndex).toBeGreaterThan(rolloverIndexes[1] ?? -1);
});

test("layout smoke at 1440x920: rail, 240px sidebar, two-panel prepare grid", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 920 });
  await installTodayMocks(page, buildTodaySeed(AUTO_OPEN_SEED));
  await gotoTodayPrepare(page);

  const topbar = await page.locator(".topbar").boundingBox();
  const rail = await page.locator(".activity-rail").boundingBox();
  const sidebar = await page.locator(".today-sidebar").boundingBox();
  expect(topbar).not.toBeNull();
  expect(rail).not.toBeNull();
  expect(sidebar).not.toBeNull();
  if (!topbar || !rail || !sidebar) return;
  expect(Math.abs(topbar.height - 44)).toBeLessThanOrEqual(2);
  expect(Math.abs(rail.width - 48)).toBeLessThanOrEqual(2);
  expect(Math.abs(sidebar.width - 240)).toBeLessThanOrEqual(2);

  // Brain dump and capture panels sit side by side (39.5/60.5 split).
  const brainDump = await page.locator(".today-panel-braindump").boundingBox();
  const capture = await page.locator(".today-panel-capture").boundingBox();
  expect(brainDump).not.toBeNull();
  expect(capture).not.toBeNull();
  if (!brainDump || !capture) return;
  expect(Math.abs(brainDump.y - capture.y)).toBeLessThanOrEqual(2);
  expect(capture.x).toBeGreaterThanOrEqual(brainDump.x + brainDump.width - 1);
});

test("layout smoke at 1024x720: compact one-column layout, no horizontal scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await installTodayMocks(page, buildTodaySeed(AUTO_OPEN_SEED));
  await gotoTodayPrepare(page);

  // One-column grid: capture stacks below the brain dump panel.
  const brainDump = await page.locator(".today-panel-braindump").boundingBox();
  const capture = await page.locator(".today-panel-capture").boundingBox();
  expect(brainDump).not.toBeNull();
  expect(capture).not.toBeNull();
  if (!brainDump || !capture) return;
  expect(capture.y).toBeGreaterThanOrEqual(brainDump.y + brainDump.height - 1);

  // The persisted default remains 240px while labels still fit.
  const sidebar = await page.locator(".today-sidebar").boundingBox();
  expect(sidebar).not.toBeNull();
  if (!sidebar) return;
  expect(Math.abs(sidebar.width - 240)).toBeLessThanOrEqual(2);

  // No horizontal scrollbar, on the document or inside the today pane.
  const docMetrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(docMetrics.scrollWidth).toBeLessThanOrEqual(docMetrics.clientWidth);
  const paneMetrics = await page
    .locator(".today-pane")
    .evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
  expect(paneMetrics.scrollWidth).toBeLessThanOrEqual(paneMetrics.clientWidth);

  // Narrower still (today pane ≤959px): the sidebar collapses to icon-only.
  await page.setViewportSize({ width: 960, height: 720 });
  await expect
    .poll(async () => (await page.locator(".today-sidebar").boundingBox())?.width ?? 0)
    .toBeLessThanOrEqual(58);
  await expect(page.locator(".today-sidebar .today-nav-label").first()).toBeHidden();
  const narrowMetrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(narrowMetrics.scrollWidth).toBeLessThanOrEqual(narrowMetrics.clientWidth);
});
