import { expect, test } from "@playwright/test";

// Seeds the gap-analysis backend through the browser e2e seam
// (`window.__MARU_E2E_INVOKE__`, see src/lib/e2eInvoke.ts). State lives in the
// init-script closure so command handlers behave like a tiny in-memory backend.
function seedBackend(page: import("@playwright/test").Page) {
  return page.addInitScript(() => {
    const reports = [
      {
        draftId: "d-weekly",
        title: "주간 보고서 검토",
        promotedTo: "docs/weekly.md",
        promotedAt: "2026-07-28T09:00:00Z",
        hasBaseline: true,
      },
      {
        draftId: "d-parser",
        title: "파서 리팩터링",
        promotedTo: "docs/parser.md",
        promotedAt: "2026-07-20T09:00:00Z",
        hasBaseline: false,
      },
    ];
    const report = {
      draftId: "d-weekly",
      draftTitle: "주간 보고서 검토",
      promotedTo: "docs/weekly.md",
      baselineHash: "abc123",
      analyzedAt: "2026-07-30T01:00:00Z",
      hunks: [
        {
          op: "equal",
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: " ", text: "# 주간 보고서" },
            { kind: " ", text: "" },
            { kind: " ", text: "## 요약" },
          ],
          hunkType: "formatting",
          evidence: [],
        },
        {
          op: "replace",
          oldStart: 4,
          oldLines: 1,
          newStart: 4,
          newLines: 2,
          lines: [
            { kind: "-", text: "이번 주 진행 상황을 정리했다." },
            { kind: "+", text: "이번 주 KOICA 사업 진행 상황을 정리했다." },
            { kind: "+", text: "예산 집행률은 42%였다." },
          ],
          hunkType: "external-info",
          evidence: ["KOICA", "예산"],
        },
        {
          op: "insert",
          oldStart: 5,
          oldLines: 0,
          newStart: 6,
          newLines: 2,
          lines: [
            { kind: "+", text: "## 다음 주 계획" },
            { kind: "+", text: "- 보고서 최종 검토" },
          ],
          hunkType: "direct-edit",
          evidence: [],
        },
      ],
      summary: {
        totalHunks: 3,
        addedLines: 4,
        removedLines: 1,
        byType: { externalInfo: 1, directEdit: 1, crossDocReference: 0, formatting: 1 },
      },
    };
    const logEntries = [
      {
        at: "2026-07-29T14:00:00",
        draftId: "d-weekly",
        promotedTo: "docs/weekly.md",
        addedLines: 2,
        removedLines: 2,
        byType: { externalInfo: 0, directEdit: 1, crossDocReference: 0, formatting: 1 },
        hunkCount: 2,
      },
      {
        at: "2026-07-28T10:00:00",
        draftId: "d-weekly",
        promotedTo: "docs/weekly.md",
        addedLines: 6,
        removedLines: 4,
        byType: { externalInfo: 2, directEdit: 1, crossDocReference: 0, formatting: 0 },
        hunkCount: 3,
      },
    ];
    const drafts = [
      {
        id: "d-weekly",
        kind: "task",
        title: "주간 보고서 검토",
        status: "accepted",
        importance: "high",
        confidence: 0.85,
        source: "claude",
        originRefs: [],
        bodyPath: ".maru/drafts/d-weekly/body.md",
        promotedTo: "docs/weekly.md",
        createdAt: "2026-07-28T00:00:00Z",
        updatedAt: "2026-07-28T00:00:00Z",
      },
    ];
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const record = (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
    };
    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      gap_reports_list: (args) => {
        record("gap_reports_list", args);
        return reports.map((entry) => ({ ...entry }));
      },
      gap_analyze: (args) => {
        record("gap_analyze", args);
        if (args.draftId !== report.draftId) throw new Error("gap_not_promoted");
        return JSON.parse(JSON.stringify(report));
      },
      gap_append_log: (args) => {
        record("gap_append_log", args);
        const entry = {
          at: "2026-07-30T02:00:00",
          draftId: String(args.draftId),
          promotedTo: "docs/weekly.md",
          addedLines: report.summary.addedLines,
          removedLines: report.summary.removedLines,
          byType: { ...report.summary.byType },
          hunkCount: report.summary.totalHunks,
        };
        logEntries.unshift(entry);
        return { ...entry };
      },
      gap_log_list: (args) => {
        record("gap_log_list", args);
        return logEntries.map((entry) => ({ ...entry }));
      },
      drafts_list: (args) => {
        record("drafts_list", args);
        return drafts.map((entry) => ({ ...entry }));
      },
      drafts_read: (args) => {
        record("drafts_read", args);
        const entry = drafts.find((candidate) => candidate.id === args.id);
        if (!entry) throw new Error("drafts_not_found");
        return { ...entry, content: "# Draft body" };
      },
      scratchpad_list: () => [],
      scheduler_list: () => [],
    };
    (
      window as unknown as {
        __MARU_E2E_INVOKE__: typeof handlers;
        __MARU_GAP_CALLS__: typeof calls;
      }
    ).__MARU_E2E_INVOKE__ = handlers;
    (window as unknown as { __MARU_GAP_CALLS__: typeof calls }).__MARU_GAP_CALLS__ = calls;
  });
}

async function openGapMode(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .locator(".activity-rail")
    .getByRole("button", { name: "갭 분석", exact: true })
    .click();
  const pane = page.locator(".gap-pane");
  await expect(pane).toBeVisible();
  return pane;
}

async function gapCalls(page: import("@playwright/test").Page, command: string) {
  return page.evaluate(
    (name) =>
      (
        (window as unknown as {
          __MARU_GAP_CALLS__?: Array<{ command: string; args: Record<string, unknown> }>;
        }).__MARU_GAP_CALLS__ ?? []
      ).filter((call) => call.command === name),
    command,
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("maru:e2e:storage-cleared", "true");
  });
  await seedBackend(page);
});

test("lists analyzable documents and renders the diff with type badges", async ({ page }) => {
  const pane = await openGapMode(page);

  const list = pane.locator(".gap-list");
  await expect(list.getByText("주간 보고서 검토")).toBeVisible();
  await expect(list.getByText("파서 리팩터링")).toBeVisible();
  await expect(list.locator(".gap-baseline-chip.ok")).toHaveCount(1);
  await expect(list.locator(".gap-baseline-chip.missing")).toHaveCount(1);

  await pane.locator(".gap-list-item", { hasText: "주간 보고서 검토" }).click();

  const diff = pane.locator(".gap-diff-table");
  await expect(diff).toBeVisible();
  // Column headers: baseline (AI draft) left, final document right.
  await expect(diff.getByText("AI 초안 (베이스라인)")).toBeVisible();
  await expect(diff.getByText("최종 문서")).toBeVisible();

  // Hunk headers carry the unified-diff range + type badge + evidence chips.
  await expect(diff.getByText("@@ -4,1 +4,2 @@")).toBeVisible();
  const externalHeader = diff.locator(".gap-diff-hunk-header", { hasText: "@@ -4,1 +4,2 @@" });
  await expect(externalHeader.locator(".gap-type-external-info")).toHaveText("외부 정보");
  await expect(externalHeader.locator(".gap-evidence-chip")).toHaveText(["KOICA", "예산"]);
  await expect(diff.locator(".gap-type-direct-edit")).toHaveText("직접 수정");

  // Aligned rows: removed line only on the left, added lines only on the right.
  await expect(diff.locator(".gap-diff-row.kind-del")).toContainText(
    "이번 주 진행 상황을 정리했다.",
  );
  await expect(diff.locator(".gap-diff-row.kind-add")).toHaveCount(4);

  // Equal hunks are collapsed by default and expand on click. Context lines
  // render on both columns, hence two cells once expanded.
  const collapsed = diff.getByRole("button", { name: "변경 없는 줄 3개" });
  await expect(collapsed).toBeVisible();
  await expect(diff.getByText("# 주간 보고서")).toHaveCount(0);
  await collapsed.click();
  await expect(diff.getByText("# 주간 보고서")).toHaveCount(2);

  // Summary line reflects the report.
  await expect(pane.locator(".gap-summary")).toHaveText("헝크 3개 · +4 / -1");
});

test("filters hunks by type with the toggle chips", async ({ page }) => {
  const pane = await openGapMode(page);
  await pane.locator(".gap-list-item", { hasText: "주간 보고서 검토" }).click();
  const diff = pane.locator(".gap-diff-table");
  await expect(diff.locator(".gap-type-direct-edit")).toHaveCount(1);

  await pane
    .getByRole("group", { name: "유형 필터" })
    .getByRole("button", { name: /직접 수정/ })
    .click();

  // The direct-edit hunk header is hidden; other change hunks remain, and the
  // collapsed equal hunk keeps the context scaffolding.
  await expect(diff.locator(".gap-type-direct-edit")).toHaveCount(0);
  await expect(diff.locator(".gap-type-external-info")).toHaveCount(1);
  await expect(diff.getByRole("button", { name: "변경 없는 줄 3개" })).toBeVisible();

  // Re-enabling the type brings the hunk back.
  await pane
    .getByRole("group", { name: "유형 필터" })
    .getByRole("button", { name: /직접 수정/ })
    .click();
  await expect(diff.locator(".gap-type-direct-edit")).toHaveCount(1);
});

test("shows distribution, trend, and day-grouped log entries", async ({ page }) => {
  const pane = await openGapMode(page);
  await pane.locator(".gap-list-item", { hasText: "주간 보고서 검토" }).click();

  const log = pane.locator(".gap-log-col");
  // Aggregate distribution across both seeded entries.
  const distribution = log.getByLabel("수정 유형 분포");
  await expect(distribution.locator(".gap-dist-row")).toHaveCount(4);
  await expect(
    distribution.locator(".gap-dist-row", { hasText: "외부 정보" }).locator(".gap-dist-count"),
  ).toHaveText("2");

  // Trend for the selected document: 10 -> 4, shrinking.
  const trend = log.getByLabel("갭 추이 (오래된 순)");
  await expect(trend.locator(".gap-trend-size").first()).toHaveText("10");
  await expect(trend.locator(".gap-trend-arrow.gap-trend-down")).toHaveCount(1);

  // Entries are grouped by local day, newest day first.
  const days = log.locator(".gap-log-day");
  await expect(days).toHaveCount(2);
  await expect(days.first().locator(".gap-log-entry")).toHaveCount(1);
  await expect(log.locator(".gap-log-entry-lines").first()).toHaveText("+2 / -2");
});

test("saves the viewed analysis to the log and refreshes the log zone", async ({ page }) => {
  const pane = await openGapMode(page);
  await pane.locator(".gap-list-item", { hasText: "주간 보고서 검토" }).click();
  await expect(pane.locator(".gap-diff-table")).toBeVisible();

  const log = pane.locator(".gap-log-col");
  await expect(log.locator(".gap-log-entry")).toHaveCount(2);

  await pane.getByRole("button", { name: "로그에 기록" }).click();

  await expect(pane.locator(".status-banner-success")).toContainText(
    "분석 결과를 로그에 기록했습니다.",
  );
  await expect.poll(async () => (await gapCalls(page, "gap_append_log")).length).toBe(1);
  // The log zone refreshes with the appended entry on top.
  await expect(log.locator(".gap-log-entry")).toHaveCount(3);
  await expect(log.locator(".gap-log-entry-lines").first()).toHaveText("+4 / -1");
});

test("navigates from the drafts pane to gap mode with the draft preselected", async ({ page }) => {
  await page.goto("/");
  await page
    .locator(".activity-rail")
    .getByRole("button", { name: "초안", exact: true })
    .click();
  const draftsPane = page.locator(".drafts-pane");
  await expect(draftsPane).toBeVisible();

  await draftsPane.locator(".drafts-list-item", { hasText: "주간 보고서 검토" }).click();
  await expect(draftsPane.locator(".drafts-detail")).toBeVisible();
  await draftsPane.getByRole("button", { name: "갭 분석 보기" }).click();

  const gapPane = page.locator(".gap-pane");
  await expect(gapPane).toBeVisible();
  // The handed-over draft is selected and analyzed without another click.
  await expect(gapPane.locator(".gap-list-item.active")).toContainText("주간 보고서 검토");
  await expect(gapPane.locator(".gap-diff-table")).toBeVisible();
  await expect
    .poll(async () =>
      (await gapCalls(page, "gap_analyze")).some((call) => call.args.draftId === "d-weekly"),
    )
    .toBe(true);
});
