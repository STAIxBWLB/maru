import { expect, test } from "@playwright/test";

const IDEA_PATH = "ideas/maru-vault-graph.md";

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
      drafts_promote_default_dir: (args) => {
        record("drafts_promote_default_dir", args);
        return "configured/incoming";
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
      drafts_promote: (args) => {
        record("drafts_promote", args);
        const entry = drafts.find((candidate) => candidate.id === args.id);
        if (!entry) throw new Error("drafts_not_found");
        entry.status = "accepted";
        entry.promotedTo = (args.targetPath as string | null) ?? null;
        entry.updatedAt = "2026-07-29T00:00:00Z";
        return { ...entry };
      },
      scratchpad_list: (args) => {
        record("scratchpad_list", args);
        return ideation.map((entry) => ({ ...entry }));
      },
      scratchpad_read: (args) => {
        record("scratchpad_read", args);
        const entry = ideation.find((candidate) => candidate.relativePath === args.relativePath);
        if (!entry) throw new Error("scratchpad_not_found");
        return { ...entry, content: "# Graph idea\n\nOriginal body" };
      },
      scratchpad_save: (args) => {
        record("scratchpad_save", args);
        const entry = ideation.find((candidate) => candidate.relativePath === args.relativePath);
        if (!entry) throw new Error("scratchpad_not_found");
        entry.revision = "r2";
        entry.preview = String(args.content).slice(0, 160);
        return { ...entry, content: args.content as string };
      },
      scratchpad_transition_idea: (args) => {
        record("scratchpad_transition_idea", args);
        const entry = ideation.find((candidate) => candidate.relativePath === args.relativePath);
        if (!entry) throw new Error("scratchpad_not_found");
        const remainder = entry.relativePath.split("/").slice(1).join("/");
        const stageDirs: Record<string, string> = {
          seed: "seeds",
          developing: "developing",
          proposal: "proposals",
          archive: "_archive",
        };
        entry.relativePath = `${stageDirs[String(args.stage)]}/${remainder}`;
        entry.ideationStage = args.stage as string;
        entry.revision = "r3";
        return { ...entry, content: "# Graph idea\n\nUpdated body" };
      },
      scratchpad_create_idea: (args) => {
        record("scratchpad_create_idea", args);
        const entry = {
          collection: "ideation",
          relativePath: "seeds/new-hub-idea.md",
          name: "new-hub-idea.md",
          source: "manual",
          ideationStage: "seed",
          format: "markdown",
          updatedAt: "2026-07-30T00:00:00Z",
          sizeBytes: 42,
          preview: String(args.title),
          revision: "new-r1",
          stale: false,
          editable: true,
        };
        ideation.push(entry);
        return { ...entry, content: `# ${String(args.title)}\n` };
      },
      drafts_create: (args) => {
        record("drafts_create", args);
        const entry = {
          id: "d-manual",
          kind: args.kind as string,
          title: args.title as string,
          status: "new",
          importance: (args.importance as string | null) ?? null,
          confidence: (args.confidence as number | null) ?? null,
          source: args.source as string,
          originRefs: (args.originRefs as string[]) ?? [],
          bodyPath: ".maru/drafts/d-manual/body.md",
          promotedTo: null,
          createdAt: "2026-07-30T00:00:00Z",
          updatedAt: "2026-07-30T00:00:00Z",
        };
        drafts.push(entry);
        return { ...entry };
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
    .getByRole("button", { name: "아이디어", exact: true })
    .click();
  const pane = page.locator(".drafts-pane");
  await expect(pane).toBeVisible();
  return pane;
}

async function readPersistedDraftsListWidth(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem(
      "maru:settings:fallback:v1:mock://maru-sample-workspace",
    );
    if (!raw) return null;
    return (JSON.parse(raw) as { ui?: { layout?: { draftsListWidth?: number } } }).ui?.layout
      ?.draftsListWidth ?? null;
  });
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

test("persists the Ideation list width and restores it after reload", async ({ page }) => {
  const pane = await openDraftsMode(page);
  const resizeHandle = pane.getByRole("separator", { name: "아이디어 목록 영역 크기 조절" });

  await expect(resizeHandle).toHaveAttribute("aria-valuenow", "340");
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  if (!handleBox) return;
  const centerY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(handleBox.x + handleBox.width / 2, centerY);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 48, centerY, { steps: 2 });
  await page.mouse.up();
  await expect(resizeHandle).toHaveAttribute("aria-valuenow", "388");
  await expect.poll(() => readPersistedDraftsListWidth(page)).toBe(388);

  await page.reload();
  const reloadedPane = await openDraftsMode(page);
  await expect(
    reloadedPane.getByRole("separator", { name: "아이디어 목록 영역 크기 조절" }),
  ).toHaveAttribute("aria-valuenow", "388");
});

test("hides the resize handle at 720px and restores it at 721px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const pane = await openDraftsMode(page);
  const workbench = page.locator(".app-workbench");
  const resizeHandle = pane.locator(".drafts-body > .pane-resize-handle");

  await workbench.evaluate((element) => {
    (element as HTMLElement).style.width = "720px";
  });
  await expect.poll(() => resizeHandle.evaluate((element) => getComputedStyle(element).display)).toBe(
    "none",
  );

  await workbench.evaluate((element) => {
    (element as HTMLElement).style.width = "721px";
  });
  await expect
    .poll(() => resizeHandle.evaluate((element) => getComputedStyle(element).display))
    .not.toBe("none");
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

test("uses the configured promote directory for the document suggestion", async ({ page }) => {
  const pane = await openDraftsMode(page);

  await pane.locator(".drafts-list-item", { hasText: "Review weekly report" }).click();
  await pane.getByRole("button", { name: "수락 (승격)", exact: true }).click();

  const dialog = page.locator(".drafts-promote-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: "문서" }).check();
  await expect(dialog.getByRole("textbox")).toHaveValue(
    "configured/incoming/review-weekly-report.md",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            (window as unknown as {
              __MARU_DRAFTS_CALLS__?: Array<{ command: string }>;
            }).__MARU_DRAFTS_CALLS__ ?? []
          ).some((call) => call.command === "drafts_promote_default_dir"),
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

test("edits and transitions an idea in the Ideation hub with optimistic revisions", async ({
  page,
}) => {
  const pane = await openDraftsMode(page);
  await pane.locator(".drafts-list-item", { hasText: "maru-vault-graph.md" }).click();

  const detail = pane.locator(".drafts-detail");
  await expect(detail.getByRole("heading", { name: "maru-vault-graph.md" })).toBeVisible();
  await detail.getByRole("button", { name: "편집", exact: true }).click();
  await detail.locator("textarea.drafts-editor").fill("Updated idea body");
  await detail.getByRole("button", { name: "저장", exact: true }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            (window as unknown as {
              __MARU_DRAFTS_CALLS__?: Array<{ command: string }>;
            }).__MARU_DRAFTS_CALLS__ ?? []
          ).some((call) => call.command === "scratchpad_save"),
      ),
    )
    .toBe(true);
  const saveArgs = await page.evaluate(
    () =>
      (
        (window as unknown as {
          __MARU_DRAFTS_CALLS__?: Array<{
            command: string;
            args: Record<string, unknown>;
          }>;
        }).__MARU_DRAFTS_CALLS__ ?? []
      ).find((call) => call.command === "scratchpad_save")?.args,
  );
  expect(saveArgs).toMatchObject({
    collection: "ideation",
    relativePath: IDEA_PATH,
    content: "Updated idea body",
    expectedRevision: "r1",
  });

  await detail.getByRole("button", { name: "발전 중", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            (window as unknown as {
              __MARU_DRAFTS_CALLS__?: Array<{ command: string }>;
            }).__MARU_DRAFTS_CALLS__ ?? []
          ).some((call) => call.command === "scratchpad_transition_idea"),
      ),
    )
    .toBe(true);
  const transitionArgs = await page.evaluate(
    () =>
      (
        (window as unknown as {
          __MARU_DRAFTS_CALLS__?: Array<{
            command: string;
            args: Record<string, unknown>;
          }>;
        }).__MARU_DRAFTS_CALLS__ ?? []
      ).find((call) => call.command === "scratchpad_transition_idea")?.args,
  );
  expect(transitionArgs).toMatchObject({
    relativePath: IDEA_PATH,
    stage: "developing",
    expectedRevision: "r2",
  });
});

test("creates a new idea from the Ideation hub", async ({ page }) => {
  const pane = await openDraftsMode(page);
  page.once("dialog", (dialog) => void dialog.accept("New hub idea"));
  await pane.getByRole("button", { name: "새 아이디어", exact: true }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            (window as unknown as {
              __MARU_DRAFTS_CALLS__?: Array<{
                command: string;
                args: Record<string, unknown>;
              }>;
            }).__MARU_DRAFTS_CALLS__ ?? []
          ).find((call) => call.command === "scratchpad_create_idea")?.args ?? null,
      ),
    )
    .toMatchObject({ title: "New hub idea" });
  await expect(pane.locator(".drafts-list").getByText("new-hub-idea.md")).toBeVisible();
});

// Ingestion e2e: a completed scheduler skill mission exposes its run events
// through the same __MARU_E2E_INVOKE__ seam. The useTaskCandidateIngestion mount scan
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

  // The ingest bar surfaces the result line.
  await expect(pane.locator(".drafts-ingest-status")).toContainText(
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

test("manual create dialog writes a draft and opens it", async ({ page }) => {
  const pane = await openDraftsMode(page);

  await pane.getByRole("button", { name: "새 초안", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("초안 제목").fill("손으로 쓴 초안");
  await dialog.getByPlaceholder("마크다운으로 작성").fill("직접 작성한 본문");
  await dialog.getByRole("button", { name: "만들기", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  const createArgs = await page.evaluate(
    () =>
      (
        (window as unknown as {
          __MARU_DRAFTS_CALLS__?: Array<{ command: string; args: Record<string, unknown> }>;
        }).__MARU_DRAFTS_CALLS__ ?? []
      ).find((call) => call.command === "drafts_create")?.args ?? null,
  );
  expect(createArgs).toMatchObject({
    kind: "task",
    title: "손으로 쓴 초안",
    source: "manual",
    body: "직접 작성한 본문",
  });

  // The created draft opens in the detail view.
  await expect(pane.locator(".drafts-detail")).toContainText("손으로 쓴 초안", {
    timeout: 10000,
  });
});
