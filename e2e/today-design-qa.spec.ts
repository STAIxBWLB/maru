// Maru Today — visual design QA against the reference render
// (docs/design-qa.md has the analysis). Captures deterministic screenshots
// of the three Today stages at the reference viewport (1487x1058, Korean,
// light theme, logical clock fixed at 2026-07-21T03:30+09:00), measures the
// pixel anchors with boundingBox(), and builds one side-by-side comparison
// image (reference left / implementation right). Interactive QA is covered
// by e2e/today.spec.ts (Playwright Chromium, not the packaged Tauri shell).

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildTodaySeed, installTodayMocks } from "./helpers/todayFixtures";

test.describe.configure({ retries: 0 });

// Deterministic greeting/date: fixed logical clock + fixed browser timezone.
test.use({ timezoneId: "Asia/Seoul" });

// The Concept 3 reference render is a local design-authoring artifact (not
// committed — it lives outside the repo). Overridable via env; when absent
// (e.g. CI) the side-by-side comparison below is skipped while the portable
// screenshots, measurements, and hard anchor gates still run.
const REFERENCE_PATH =
  process.env.MARU_DESIGN_QA_REFERENCE ??
  "/Users/yj.lee/.codex/generated_images/019f81cb-5d43-79a3-89d9-c4efeb664a24/exec-a7ea0eb8-a8a6-4a6d-93d5-ce47460cd304.png";
const OUT_DIR = path.join("docs", "design-qa");
const REFERENCE_VIEWPORT = { width: 1487, height: 1058 };
const COMPACT_VIEWPORT = { width: 1024, height: 720 };
const WIDE_VIEWPORT = { width: 1440, height: 920 };

interface AnchorMeasurement {
  selector: string;
  property: "width" | "height" | "x" | "y";
  expected: number;
  tolerance: number;
  measured: number | null;
  within: boolean | null;
}

test("design QA screenshots, pixel anchors, and side-by-side", async ({ page }) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await page.clock.install();
  await page.clock.setFixedTime(new Date("2026-07-21T03:30:00+09:00"));
  await installTodayMocks(page, buildTodaySeed({ markerDay: null, persistedMode: "tasks" }));
  await page.setViewportSize(REFERENCE_VIEWPORT);
  await page.goto("/");

  // --- Prepare (the reference screen) --------------------------------------
  await expect(page.locator(".today-pane")).toBeVisible();
  await expect(page.locator(".today-panel-braindump")).toBeVisible();
  await expect(page.locator(".today-panel-capture")).toBeVisible();
  // Sanity: the fixed clock drives the greeting date.
  await expect(page.locator(".today-greeting")).toContainText("2026년 7월 21일");
  await expect(page.locator(".today-greeting")).toContainText("좋은 아침입니다");
  // Let capture rows settle before shooting.
  await expect(page.locator(".today-capture-row")).toHaveCount(5);
  await page.screenshot({ path: path.join(OUT_DIR, "today-prepare-1487.png") });

  // --- Pixel anchors on the Prepare shell ----------------------------------
  const measure = async (
    selector: string,
    property: AnchorMeasurement["property"],
    expected: number,
    tolerance: number,
  ): Promise<AnchorMeasurement> => {
    const box = await page.locator(selector).first().boundingBox();
    const measured = box ? Math.round(box[property] * 100) / 100 : null;
    return {
      selector,
      property,
      expected,
      tolerance,
      measured,
      within: measured === null ? null : Math.abs(measured - expected) <= tolerance,
    };
  };

  const brainBox = await page.locator(".today-panel-braindump").boundingBox();
  const captureBox = await page.locator(".today-panel-capture").boundingBox();
  if (!brainBox || !captureBox) throw new Error("prepare grid panels missing");
  const gridInnerWidth = brainBox.width + captureBox.width; // gap excluded
  const splitMeasurements: AnchorMeasurement[] = [
    {
      selector: ".today-panel-braindump",
      property: "width",
      expected: Math.round(gridInnerWidth * 0.395 * 100) / 100,
      tolerance: 4,
      measured: Math.round(brainBox.width * 100) / 100,
      within: Math.abs(brainBox.width - gridInnerWidth * 0.395) <= 4,
    },
    {
      selector: ".today-panel-capture",
      property: "width",
      expected: Math.round(gridInnerWidth * 0.605 * 100) / 100,
      tolerance: 4,
      measured: Math.round(captureBox.width * 100) / 100,
      within: Math.abs(captureBox.width - gridInnerWidth * 0.605) <= 4,
    },
  ];

  const anchors: AnchorMeasurement[] = [
    await measure(".topbar", "height", 44, 2),
    await measure(".activity-rail", "width", 48, 2),
    await measure(".today-sidebar", "width", 240, 2),
    await measure(".today-stage-header", "height", 116, 4),
    ...splitMeasurements,
  ];

  const compactMetrics = {
    viewport: REFERENCE_VIEWPORT,
    brainDumpWidth: Math.round(brainBox.width * 100) / 100,
    captureWidth: Math.round(captureBox.width * 100) / 100,
    measuredSplit: `${((brainBox.width / gridInnerWidth) * 100).toFixed(1)}/${((captureBox.width / gridInnerWidth) * 100).toFixed(1)}`,
    docScrollWidth: await page.evaluate(() => document.documentElement.scrollWidth),
    docClientWidth: await page.evaluate(() => document.documentElement.clientWidth),
  };

  // --- Execute + Review at the reference viewport ---------------------------
  await page.locator(".today-sidebar").getByRole("button", { name: "오늘 실행" }).click();
  await expect(page.locator(".today-panel-top3")).toBeVisible();
  await expect(page.locator(".today-panel-done")).toBeVisible();
  await page.screenshot({ path: path.join(OUT_DIR, "today-execute-1487.png") });

  await page.locator(".today-sidebar").getByRole("button", { name: "오늘 정리" }).click();
  await expect(page.locator(".today-panel-summary")).toBeVisible();
  await expect(page.locator(".today-review-reflection-input")).toBeVisible();
  await page.screenshot({ path: path.join(OUT_DIR, "today-review-1487.png") });

  // --- All Tasks at the reference viewport ---------------------------------
  await page.locator(".today-sidebar").getByRole("button", { name: "전체 태스크" }).click();
  await expect(page.locator(".tasks-pane")).toBeVisible();
  await expect(page.getByRole("separator", { name: "태스크 필터 영역 크기 조절" })).toBeVisible();
  await expect(page.getByRole("separator", { name: "일정 목록 영역 크기 조절" })).toBeVisible();
  await page.screenshot({ path: path.join(OUT_DIR, "today-tasks-1487.png") });

  // --- Prepare at 1440x920 (responsive note) --------------------------------
  await page.setViewportSize(WIDE_VIEWPORT);
  await page.locator(".today-sidebar").getByRole("button", { name: "오늘 준비" }).click();
  await expect(page.locator(".today-panel-braindump")).toBeVisible();
  const wideBrain = await page.locator(".today-panel-braindump").boundingBox();
  const wideCapture = await page.locator(".today-panel-capture").boundingBox();
  await page.screenshot({ path: path.join(OUT_DIR, "today-prepare-1440.png") });

  // --- Prepare at 1024x720 (compact) ----------------------------------------
  await page.setViewportSize(COMPACT_VIEWPORT);
  await expect(page.locator(".today-panel-braindump")).toBeVisible();
  const compactBrain = await page.locator(".today-panel-braindump").boundingBox();
  const compactCapture = await page.locator(".today-panel-capture").boundingBox();
  const compactSidebar = await page.locator(".today-sidebar").boundingBox();
  if (!compactBrain || !compactCapture || !compactSidebar) {
    throw new Error("compact layout boxes missing");
  }
  const compact = {
    viewport: COMPACT_VIEWPORT,
    sidebarWidth: Math.round(compactSidebar.width * 100) / 100,
    brainDumpWidth: Math.round(compactBrain.width * 100) / 100,
    captureWidth: Math.round(compactCapture.width * 100) / 100,
    stacked: compactCapture.y >= compactBrain.y + compactBrain.height - 1,
    docScrollWidth: await page.evaluate(() => document.documentElement.scrollWidth),
    docClientWidth: await page.evaluate(() => document.documentElement.clientWidth),
  };
  await page.screenshot({ path: path.join(OUT_DIR, "today-prepare-1024.png") });

  const wide = {
    viewport: WIDE_VIEWPORT,
    brainDumpWidth: wideBrain ? Math.round(wideBrain.width * 100) / 100 : null,
    captureWidth: wideCapture ? Math.round(wideCapture.width * 100) / 100 : null,
    sideBySide:
      wideBrain && wideCapture ? Math.abs(wideBrain.y - wideCapture.y) <= 2 : null,
  };

  fs.writeFileSync(
    path.join(OUT_DIR, "measurements.json"),
    JSON.stringify({ anchors, reference: compactMetrics, wide, compact }, null, 2),
  );

  // --- Side-by-side comparison (reference left / implementation right) ------
  // Local-only: needs the uncommitted reference render. Skipped in CI.
  if (fs.existsSync(REFERENCE_PATH)) {
    const referencePng = fs.readFileSync(REFERENCE_PATH).toString("base64");
    const implPng = fs
      .readFileSync(path.join(OUT_DIR, "today-prepare-1487.png"))
      .toString("base64");
    const comparePage = await page.context().newPage();
    await comparePage.setViewportSize({
      width: REFERENCE_VIEWPORT.width * 2 + 40,
      height: REFERENCE_VIEWPORT.height + 80,
    });
    await comparePage.setContent(`<!doctype html>
<html><body style="margin:0;padding:12px;background:#3f3f46;display:flex;gap:12px;font:600 14px/1.4 system-ui;color:#fafafa">
  <figure style="margin:0">
    <figcaption>reference (1487x1058)</figcaption>
    <img alt="reference" width="${REFERENCE_VIEWPORT.width}" height="${REFERENCE_VIEWPORT.height}" src="data:image/png;base64,${referencePng}" />
  </figure>
  <figure style="margin:0">
    <figcaption>implementation (1487x1058)</figcaption>
    <img alt="implementation" width="${REFERENCE_VIEWPORT.width}" height="${REFERENCE_VIEWPORT.height}" src="data:image/png;base64,${implPng}" />
  </figure>
</body></html>`);
    await comparePage.screenshot({
      path: path.join(OUT_DIR, "side-by-side.png"),
      fullPage: true,
    });
    await comparePage.close();
  }

  // Hard gates: shell anchors must sit inside tolerance.
  for (const anchor of anchors) {
    expect(anchor.within, `${anchor.selector} ${anchor.property}`).toBe(true);
  }
  expect(compact.stacked).toBe(true);
  expect(compact.docScrollWidth).toBeLessThanOrEqual(compact.docClientWidth);
  // The persisted 240px default remains labeled here (icon-only kicks in
  // at a ≤959px Today container).
  expect(Math.abs(compact.sidebarWidth - 240)).toBeLessThanOrEqual(2);
});
