import { expect, test } from "@playwright/test";

// Ideation -> implementation-draft e2e. Seeds the backend through the browser
// e2e seam (`window.__MARU_E2E_INVOKE__`, see src/lib/e2eInvoke.ts) and fakes
// the mission lifecycle: a completed `ideation-drafts ideate-to-draft` run is
// listed by list_ai_missions and exposes its maru_implementation_draft_v1
// artifact through agent_read_run_events. DraftsPane's mount scan ingests it
// (same pattern as the scheduler ingestion in e2e/drafts.spec.ts).

const IDEA_PATH = "ideas/maru-vault-graph.md";
const RUN_ID = "ai-e2e-ideation-draft";

function seedBackend(page: import("@playwright/test").Page) {
  return page.addInitScript((ideaPath) => {
    const ideation = [
      {
        collection: "ideation",
        relativePath: ideaPath,
        name: "maru-vault-graph.md",
        source: "manual",
        ideationStage: "developing",
        format: "markdown",
        updatedAt: "2026-07-27T00:00:00Z",
        sizeBytes: 42,
        preview: "Graph view for the vault",
        revision: "r1",
        stale: false,
        editable: true,
      },
    ];
    const created: Array<Record<string, unknown>> = [];
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const record = (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
    };
    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      drafts_list: (args) => {
        record("drafts_list", args);
        return created.map((entry) => ({ ...entry }));
      },
      drafts_read: (args) => {
        record("drafts_read", args);
        const entry = created.find((candidate) => candidate.id === args.id);
        if (!entry) throw new Error("drafts_not_found");
        return { ...entry, content: "# 볼트 그래프 뷰\n\n## 개요\n\n내용" };
      },
      drafts_set_status: (args) => {
        record("drafts_set_status", args);
        const entry = created.find((candidate) => candidate.id === args.id);
        if (!entry) throw new Error("drafts_not_found");
        entry.status = args.status as string;
        entry.updatedAt = "2026-07-30T00:05:00Z";
        return { ...entry };
      },
      drafts_create: (args) => {
        record("drafts_create", args);
        const entry = {
          id: `d-ideation-${created.length + 1}`,
          kind: args.kind,
          title: args.title,
          status: "new",
          importance: args.importance ?? null,
          confidence: args.confidence ?? null,
          source: args.source ?? "maru",
          originRefs: (args.originRefs as string[] | null) ?? [],
          bodyPath: `.maru/drafts/d-ideation-${created.length + 1}/body.md`,
          promotedTo: null,
          createdAt: "2026-07-30T00:00:00Z",
          updatedAt: "2026-07-30T00:00:00Z",
        };
        created.push(entry);
        return { ...entry };
      },
      scratchpad_list: (args) => {
        record("scratchpad_list", args);
        return ideation.map((entry) => ({ ...entry }));
      },
      scheduler_list: () => [],
      list_ai_missions: () => [],
    };
    (
      window as unknown as {
        __MARU_E2E_INVOKE__: typeof handlers;
        __MARU_DRAFTS_CALLS__: typeof calls;
      }
    ).__MARU_E2E_INVOKE__ = handlers;
    (window as unknown as { __MARU_DRAFTS_CALLS__: typeof calls }).__MARU_DRAFTS_CALLS__ =
      calls;
  }, IDEA_PATH);
}

// A done implementation-draft mission whose run events carry the artifact.
function seedCompletedMission(page: import("@playwright/test").Page) {
  return page.addInitScript(
    ({ ideaPath, runId }) => {
      const handlers = (
        window as unknown as {
          __MARU_E2E_INVOKE__: Record<string, (args: Record<string, unknown>) => unknown>;
        }
      ).__MARU_E2E_INVOKE__;
      const artifact = JSON.stringify({
        schemaVersion: "maru_implementation_draft_v1",
        title: "볼트 그래프 뷰 구현 초안",
        confidence: 0.8,
        draftBody: "# 볼트 그래프 뷰\n\n## 개요\n\n내용",
      });
      handlers.list_ai_missions = () => [
        {
          id: runId,
          kind: "skill",
          startedAt: "2026-07-30T00:00:00Z",
          lastOutputAt: "2026-07-30T00:01:00Z",
          status: "done",
          exitCode: 0,
          outputLogPath: null,
          metadata: {
            origin: "ideationDraft",
            kind: "implementation-draft",
            ideaPath,
            ideaName: "maru-vault-graph.md",
            skillName: "ideation-drafts",
            runtime: "claude",
          },
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
    },
    { ideaPath: IDEA_PATH, runId: RUN_ID },
  );
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

async function createCallCount(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (
        (window as unknown as {
          __MARU_DRAFTS_CALLS__?: Array<{ command: string }>;
        }).__MARU_DRAFTS_CALLS__ ?? []
      ).filter((call) => call.command === "drafts_create").length,
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

test("ingests a completed ideation-draft run into an implementation draft with lineage", async ({
  page,
}) => {
  await seedCompletedMission(page);
  const pane = await openDraftsMode(page);

  // The artifact becomes an implementation draft linked to the idea; the idea
  // row shows the "초안 N개" indicator.
  const list = pane.locator(".drafts-list");
  await expect(list.getByText("볼트 그래프 뷰 구현 초안")).toBeVisible();
  await expect(
    pane.locator(".drafts-list-item", { hasText: "maru-vault-graph.md" }).locator(
      ".drafts-idea-count",
    ),
  ).toHaveText("초안 1개");

  // The draft detail renders the lineage breadcrumb idea -> draft.
  await pane.locator(".drafts-list-item", { hasText: "볼트 그래프 뷰 구현 초안" }).click();
  const detail = pane.locator(".drafts-detail");
  const lineage = detail.locator(".drafts-lineage");
  await expect(lineage).toBeVisible();
  await expect(lineage.locator(".drafts-lineage-link")).toHaveText("maru-vault-graph.md");
  await expect(lineage).toContainText("볼트 그래프 뷰 구현 초안");

  // drafts_create ran exactly once, with the idea as originRef.
  await expect.poll(() => createCallCount(page)).toBe(1);
  const createArgs = await page.evaluate(
    () =>
      (
        (window as unknown as {
          __MARU_DRAFTS_CALLS__?: Array<{ command: string; args: Record<string, unknown> }>;
        }).__MARU_DRAFTS_CALLS__ ?? []
      ).find((call) => call.command === "drafts_create")?.args,
  );
  expect(createArgs).toMatchObject({
    kind: "implementation",
    title: "볼트 그래프 뷰 구현 초안",
    originRefs: [IDEA_PATH],
    confidence: 0.8,
  });
});

test("offers the existing draft instead of generating a duplicate", async ({ page }) => {
  await seedCompletedMission(page);
  const pane = await openDraftsMode(page);
  await expect(pane.locator(".drafts-list").getByText("볼트 그래프 뷰 구현 초안")).toBeVisible();

  // On the idea detail the generate button is replaced by "기존 초안 열기".
  await pane.locator(".drafts-list-item", { hasText: "maru-vault-graph.md" }).click();
  const detail = pane.locator(".drafts-detail");
  const openExisting = detail.getByRole("button", { name: "기존 초안 열기" });
  await expect(openExisting).toBeVisible();
  await expect(detail.getByRole("button", { name: "구현 초안 생성" })).toHaveCount(0);

  // Clicking it selects the existing draft in the list; no new draft.
  await openExisting.click();
  await expect(
    detail.getByRole("heading", { name: "볼트 그래프 뷰 구현 초안" }),
  ).toBeVisible();
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

test("dispatches an ideate-to-draft mission and shows the in-progress state", async ({
  page,
}) => {
  const pane = await openDraftsMode(page);

  await pane.locator(".drafts-list-item", { hasText: "maru-vault-graph.md" }).click();
  const detail = pane.locator(".drafts-detail");
  const generate = detail.getByRole("button", { name: "구현 초안 생성" });
  await expect(generate).toBeVisible();
  await generate.click();

  // While the mission runs, the detail button is disabled and the list row
  // carries the generating indicator.
  await expect(detail.getByRole("button", { name: "초안 생성 중..." })).toBeDisabled();
  await expect(
    pane.locator(".drafts-list-item", { hasText: "maru-vault-graph.md" }).locator(
      ".drafts-idea-generating",
    ),
  ).toBeVisible();

  // No draft was created locally; ingestion waits for the mission artifact.
  expect(await createCallCount(page)).toBe(0);
});
