import { expect, test } from "@playwright/test";

// Seeds the drafts/scheduler backend through the browser e2e seam
// (`window.__MARU_E2E_INVOKE__`, see src/lib/e2eInvoke.ts). State lives in the
// init-script closure so command handlers behave like a tiny in-memory backend.
function seedBackend(page: import("@playwright/test").Page) {
  return page.addInitScript(() => {
    const drafts = [
      {
        id: "d-weekly",
        kind: "task",
        title: "Review weekly report",
        status: "new",
        importance: "high",
        confidence: 0.85,
        source: "claude",
        originRefs: ["meetings/2026-07-28-weekly.md"],
        bodyPath: ".maru/drafts/d-weekly/body.md",
        promotedTo: null,
        createdAt: "2026-07-28T00:00:00Z",
        updatedAt: "2026-07-28T00:00:00Z",
      },
      {
        id: "d-parser",
        kind: "implementation",
        title: "Refactor parser",
        status: "discarded",
        importance: "low",
        confidence: 0.4,
        source: "codex",
        originRefs: [],
        bodyPath: ".maru/drafts/d-parser/body.md",
        promotedTo: null,
        createdAt: "2026-07-20T00:00:00Z",
        updatedAt: "2026-07-20T00:00:00Z",
      },
    ];
    const ideation = [
      {
        collection: "ideation",
        relativePath: "ideas/maru-vault-graph.md",
        name: "maru-vault-graph.md",
        source: "manual",
        ideationStage: "seed",
        format: "markdown",
        updatedAt: "2026-07-27T00:00:00Z",
        sizeBytes: 42,
        preview: "Graph view for the vault",
        revision: "r1",
        stale: false,
        editable: true,
      },
    ];
    const schedules = [
      {
        id: "s-inbox",
        name: "Inbox digest",
        skillId: "inbox-process",
        runtime: "claude",
        prompt: "Process the inbox",
        hour: 7,
        minute: 30,
        daysOfWeek: [],
        enabled: true,
        lastRunAt: null,
        nextRunAt: "2026-07-30T07:30:00Z",
      },
    ];
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const record = (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
    };
    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      drafts_list: (args) => {
        record("drafts_list", args);
        return drafts.map((entry) => ({ ...entry }));
      },
      drafts_read: (args) => {
        record("drafts_read", args);
        const entry = drafts.find((candidate) => candidate.id === args.id);
        if (!entry) throw new Error("drafts_not_found");
        return { ...entry, content: "# Draft body\n\nSeeded content." };
      },
      drafts_set_status: (args) => {
        record("drafts_set_status", args);
        const entry = drafts.find((candidate) => candidate.id === args.id);
        if (!entry) throw new Error("drafts_not_found");
        entry.status = args.status as string;
        entry.updatedAt = "2026-07-29T00:00:00Z";
        return { ...entry };
      },
      drafts_discard: (args) => {
        record("drafts_discard", args);
        const entry = drafts.find((candidate) => candidate.id === args.id);
        if (!entry) throw new Error("drafts_not_found");
        entry.status = "discarded";
        entry.updatedAt = "2026-07-29T00:00:00Z";
        return { ...entry };
      },
      scratchpad_list: (args) => {
        record("scratchpad_list", args);
        return ideation.map((entry) => ({ ...entry }));
      },
      scheduler_list: (args) => {
        record("scheduler_list", args);
        return schedules.map((entry) => ({ ...entry }));
      },
    };
    (
      window as unknown as {
        __MARU_E2E_INVOKE__: typeof handlers;
        __MARU_DRAFTS_CALLS__: typeof calls;
      }
    ).__MARU_E2E_INVOKE__ = handlers;
    (window as unknown as { __MARU_DRAFTS_CALLS__: typeof calls }).__MARU_DRAFTS_CALLS__ =
      calls;
  });
}

async function openDraftsMode(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .locator(".activity-rail")
    .getByRole("button", { name: "초안", exact: true })
    .click();
  const pane = page.locator(".drafts-pane");
  await expect(pane).toBeVisible();
  return pane;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("maru:e2e:storage-cleared", "true");
  });
  await seedBackend(page);
});

test("lists drafts and ideas, hiding discarded drafts by default", async ({ page }) => {
  const pane = await openDraftsMode(page);

  const list = pane.locator(".drafts-list");
  await expect(list.getByText("Review weekly report")).toBeVisible();
  await expect(list.getByText("maru-vault-graph.md")).toBeVisible();
  // Discarded drafts are hidden under the default "open" status filter.
  await expect(list.getByText("Refactor parser")).toHaveCount(0);

  // The "all" status filter reveals the discarded draft.
  await pane
    .getByRole("group", { name: "상태 필터" })
    .getByRole("button", { name: "전체" })
    .click();
  await expect(list.getByText("Refactor parser")).toBeVisible();

  // Kind chips filter the merged list.
  await pane
    .getByRole("group", { name: "종류 필터" })
    .getByRole("button", { name: "아이디어" })
    .click();
  await expect(list.getByText("maru-vault-graph.md")).toBeVisible();
  await expect(list.getByText("Review weekly report")).toHaveCount(0);
});

test("shows schedules in the automation section", async ({ page }) => {
  const pane = await openDraftsMode(page);

  await pane.getByRole("button", { name: /자동화/ }).first().click();
  const row = pane.locator(".drafts-schedule-row", { hasText: "Inbox digest" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("07:30");
  await expect(row).toContainText("매일");
});

test("opens a draft detail and moves it to in-review", async ({ page }) => {
  const pane = await openDraftsMode(page);

  await pane.locator(".drafts-list-item", { hasText: "Review weekly report" }).click();

  const detail = pane.locator(".drafts-detail");
  await expect(detail.getByRole("heading", { name: "Review weekly report" })).toBeVisible();
  // Opening a "new" draft transitions it to "in-review" via drafts_set_status.
  await expect(detail.locator(".drafts-status")).toHaveText("검토 중");
  await expect(detail.locator(".drafts-preview")).toContainText("Draft body");
  await expect(detail.locator(".drafts-origin-refs")).toContainText(
    "meetings/2026-07-28-weekly.md",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            (window as unknown as {
              __MARU_DRAFTS_CALLS__?: Array<{ command: string }>;
            }).__MARU_DRAFTS_CALLS__ ?? []
          ).some((call) => call.command === "drafts_set_status"),
      ),
    )
    .toBe(true);
});

test("discards a draft after confirmation", async ({ page }) => {
  const pane = await openDraftsMode(page);

  await pane.locator(".drafts-list-item", { hasText: "Review weekly report" }).click();
  await expect(pane.locator(".drafts-detail")).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await pane.getByRole("button", { name: "폐기", exact: true }).click();

  // The discarded draft disappears from the default (open) list.
  await expect(
    pane.locator(".drafts-list").getByText("Review weekly report"),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            (window as unknown as {
              __MARU_DRAFTS_CALLS__?: Array<{ command: string }>;
            }).__MARU_DRAFTS_CALLS__ ?? []
          ).some((call) => call.command === "drafts_discard"),
      ),
    )
    .toBe(true);
});

// Ingestion e2e: a completed scheduler skill mission exposes its run events
// through the same __MARU_E2E_INVOKE__ seam. The SchedulerSection mount scan
// picks the mission up, parses the maru_task_candidates_v1 artifact, and
// imports candidates as task drafts (threshold + dedupe applied).
function seedIngestionRun(page: import("@playwright/test").Page) {
  return page.addInitScript(() => {
    const handlers = (
      window as unknown as {
        __MARU_E2E_INVOKE__: Record<string, (args: Record<string, unknown>) => unknown>;
      }
    ).__MARU_E2E_INVOKE__;
    const calls = (
      window as unknown as {
        __MARU_DRAFTS_CALLS__: Array<{ command: string; args: Record<string, unknown> }>;
      }
    ).__MARU_DRAFTS_CALLS__;
    const artifact = JSON.stringify({
      schemaVersion: "maru_task_candidates_v1",
      summary: "inbox + meetings scan",
      candidates: [
        {
          title: "예산 검토 보고서 초안 작성",
          importance: "high",
          confidence: 0.9,
          originRefs: ["meetings/2026-07-28-weekly.md"],
          summary: "주간 회의 후속: 예산 검토 보고서 작성",
          draftBody: "# 예산 검토 보고서\n\n- 항목 정리\n- 검토 요청",
        },
        {
          // Duplicate of the seeded non-discarded draft -> skipped.
          title: "review weekly report",
          importance: "high",
          confidence: 0.8,
          originRefs: ["meetings/2026-07-28-weekly.md"],
          summary: "dup",
          draftBody: "dup",
        },
        {
          // Below the default "medium" threshold -> skipped.
          title: "Optional tidy-up",
          importance: "low",
          confidence: 0.3,
          originRefs: [],
          summary: "minor",
          draftBody: "minor",
        },
      ],
    });
    const runId = "ai-e2e-ingest";
    const created: Array<Record<string, unknown>> = [];
    const originalList = handlers.drafts_list;
    handlers.drafts_list = (args) => [
      ...(originalList(args) as Array<Record<string, unknown>>),
      ...created.map((entry) => ({ ...entry })),
    ];
    handlers.list_ai_missions = () => [
      {
        id: runId,
        kind: "skill",
        startedAt: "2026-07-30T00:00:00Z",
        lastOutputAt: "2026-07-30T00:01:00Z",
        status: "done",
        exitCode: 0,
        outputLogPath: null,
        metadata: { scheduler: true, scheduleId: "s-inbox", scheduleName: "Inbox digest" },
      },
    ];
    handlers.agent_read_run_events = () => [
      {
        id: "e1",
        runId,
        ts: "2026-07-30T00:00:00Z",
        type: "run.started",
        actor: "maru.skill_host",
        payload: { dispatch: { runtime: "claude" } },
        schemaVersion: "agent_run_event_v1",
      },
      {
        id: "e2",
        runId,
        ts: "2026-07-30T00:00:30Z",
        type: "provider.output",
        actor: "provider",
        payload: { stream: "stdout", line: artifact },
        schemaVersion: "agent_run_event_v1",
      },
      {
        id: "e3",
        runId,
        ts: "2026-07-30T00:01:00Z",
        type: "run.completed",
        actor: "maru.skill_host",
        payload: { exitCode: 0, success: true },
        schemaVersion: "agent_run_event_v1",
      },
    ];
    handlers.drafts_create = (args) => {
      calls.push({ command: "drafts_create", args });
      const entry = {
        id: `d-ingested-${created.length + 1}`,
        kind: args.kind,
        title: args.title,
        status: "new",
        importance: args.importance ?? null,
        confidence: args.confidence ?? null,
        source: args.source ?? "maru",
        originRefs: (args.originRefs as string[] | null) ?? [],
        bodyPath: `.maru/drafts/d-ingested-${created.length + 1}/body.md`,
        promotedTo: null,
        createdAt: "2026-07-30T00:00:00Z",
        updatedAt: "2026-07-30T00:00:00Z",
      };
      created.push(entry);
      return { ...entry };
    };
  });
}

test("ingests task candidates from a completed scheduler run into drafts", async ({ page }) => {
  await seedIngestionRun(page);
  const pane = await openDraftsMode(page);

  // The high-importance candidate becomes a task draft; the duplicate and the
  // below-threshold candidate do not.
  await expect(pane.locator(".drafts-list").getByText("예산 검토 보고서 초안 작성")).toBeVisible();
  await expect(pane.locator(".drafts-list").getByText("Optional tidy-up")).toHaveCount(0);

  // The automation section surfaces the ingestion result line.
  await pane.getByRole("button", { name: /자동화/ }).first().click();
  await expect(pane.locator(".drafts-automation-ingest")).toContainText(
    "마지막 수집: 초안 1개 생성 (중요도 미달 1개 · 중복 1개 제외)",
  );

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            (window as unknown as {
              __MARU_DRAFTS_CALLS__?: Array<{ command: string }>;
            }).__MARU_DRAFTS_CALLS__ ?? []
          ).filter((call) => call.command === "drafts_create").length,
      ),
    )
    .toBe(1);
});
