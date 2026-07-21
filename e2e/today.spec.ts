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

// Dev-mode note: React StrictMode double-runs the boot effect, and the
// second boot re-applies the persisted mode AFTER the first boot's
// auto-open decision called setAppMode("tasks"). Seeding the persisted mode
// as "tasks" keeps the outcome deterministic; the auto-open path is still
// pinned by the prepare-route and marker assertions (a plain tasks-mode
// restore would land on route "all", never on the Prepare stage).
const AUTO_OPEN_SEED = { markerDay: null, persistedMode: "tasks" } as const;

test("first eligible daily launch auto-opens Today; later launches restore the persisted mode", async ({
  page,
}) => {
  // Marker absent → the first launch of the logical day auto-opens Today on
  // the Prepare route (dayState "preparing" in the fixture).
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
  // creation commands (create_task_note & friends must never fire here;
  // they are not even registered in the fixture map, so any call would
  // reject instead of being recorded).
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

test("layout smoke at 1440x920: rail, 350px sidebar, two-panel prepare grid", async ({ page }) => {
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
  expect(Math.abs(sidebar.width - 350)).toBeLessThanOrEqual(2);

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

  // Compact breakpoint: the sidebar column narrows to 280px (labels kept).
  const sidebar = await page.locator(".today-sidebar").boundingBox();
  expect(sidebar).not.toBeNull();
  if (!sidebar) return;
  expect(Math.abs(sidebar.width - 280)).toBeLessThanOrEqual(2);

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
