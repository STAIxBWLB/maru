import { expect, test } from "@playwright/test";

// Drives the Agents mode through the browser e2e seam
// (`window.__MARU_E2E_INVOKE__`, see src/lib/e2eInvoke.ts). State lives in the
// init-script closure so the command handlers behave like a tiny in-memory
// registry.
function seedBackend(page: import("@playwright/test").Page) {
  return page.addInitScript(() => {
    const agents = [
      {
        id: "inbox-triage",
        labelKey: "agents.builtin.inboxTriage",
        label: null,
        description: null,
        skillName: "inbox-process",
        runtime: "inherit",
        permissionMode: "inherit",
        prompt: "",
        kind: "background",
        enabled: true,
        builtin: true,
        customized: false,
      },
      {
        id: "commit-message",
        labelKey: "agents.builtin.commitMessage",
        label: null,
        description: null,
        skillName: "",
        runtime: "inherit",
        permissionMode: "inherit",
        prompt: "",
        kind: "inline",
        enabled: true,
        builtin: true,
        customized: false,
      },
      {
        id: "vault-hygiene",
        labelKey: "agents.builtin.vaultHygiene",
        label: null,
        description: null,
        skillName: "vault-lint",
        runtime: "inherit",
        permissionMode: "inherit",
        prompt: "정합성 리포트를 생성",
        kind: "background",
        enabled: true,
        builtin: true,
        customized: false,
        recommendedSchedule: { hour: 22, minute: 0, daysOfWeek: [0] },
      },
    ];
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const record = (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args: args ?? {} });
    };

    const handlers = {
      agents_list: (args: Record<string, unknown>) => {
        record("agents_list", args);
        return agents.map((agent) => ({ ...agent }));
      },
      agents_upsert: (args: Record<string, unknown>) => {
        record("agents_upsert", args);
        const next = args.agent as (typeof agents)[number];
        const index = agents.findIndex((agent) => agent.id === next.id);
        if (index >= 0) agents[index] = { ...agents[index], ...next };
        else agents.push({ ...next });
        return { ...next };
      },
      scheduler_list: (args: Record<string, unknown>) => {
        record("scheduler_list", args);
        return [];
      },
      list_ai_missions: (args: Record<string, unknown>) => {
        record("list_ai_missions", args);
        return [];
      },
    };
    (
      window as unknown as {
        __MARU_E2E_INVOKE__: typeof handlers;
        __MARU_AGENT_CALLS__: typeof calls;
      }
    ).__MARU_E2E_INVOKE__ = handlers;
    (window as unknown as { __MARU_AGENT_CALLS__: typeof calls }).__MARU_AGENT_CALLS__ =
      calls;
  });
}

async function openAgentsMode(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .locator(".activity-rail")
    .getByRole("button", { name: "에이전트", exact: true })
    .click();
  const pane = page.locator(".agents-pane");
  await expect(pane).toBeVisible();
  return pane;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await seedBackend(page);
});

test("lists the registered agents with their backend and schedule", async ({ page }) => {
  const pane = await openAgentsMode(page);

  const rows = pane.locator(".agents-list-item");
  await expect(rows).toHaveCount(3);
  await expect(pane).toContainText("받은편지함 정리");
  await expect(pane).toContainText("지식 그래프 정합성 점검");
  // "inherit" renders as the resolved default rather than as jargon.
  await expect(rows.first().locator(".agents-runtime-badge")).toHaveText("기본");
});

test("changing an agent's backend persists it through agents_upsert", async ({ page }) => {
  const pane = await openAgentsMode(page);

  await pane.locator(".agents-list-item", { hasText: "받은편지함 정리" }).click();
  await pane.getByRole("button", { name: "설정" }).click();

  const backend = pane.locator("select").first();
  await backend.selectOption("codex");
  await pane.getByRole("button", { name: "저장" }).click();

  const saved = await page.evaluate(() =>
    (
      window as unknown as {
        __MARU_AGENT_CALLS__: Array<{ command: string; args: Record<string, unknown> }>;
      }
    ).__MARU_AGENT_CALLS__.filter((call) => call.command === "agents_upsert"),
  );
  expect(saved).toHaveLength(1);
  expect((saved[0].args.agent as { runtime: string }).runtime).toBe("codex");
  expect((saved[0].args.agent as { id: string }).id).toBe("inbox-triage");
});

test("a feature-bound agent cannot be run standalone, a prompted one can", async ({
  page,
}) => {
  const pane = await openAgentsMode(page);

  // inbox-triage has no prompt of its own: the Inbox pane builds one per run.
  await pane.locator(".agents-list-item", { hasText: "받은편지함 정리" }).click();
  await expect(pane.getByRole("button", { name: "지금 실행" })).toBeDisabled();

  await pane.locator(".agents-list-item", { hasText: "정합성 점검" }).click();
  await expect(pane.getByRole("button", { name: "지금 실행" })).toBeEnabled();
});

test("an inline agent can change and save its backend", async ({ page }) => {
  const pane = await openAgentsMode(page);

  // Inline agents carry no skill by design; requiring one used to leave Save
  // permanently disabled on the very agents whose only editable field is the
  // backend.
  await pane.locator(".agents-list-item", { hasText: "커밋 메시지 작성" }).click();
  await pane.getByRole("button", { name: "설정" }).click();

  const save = pane.getByRole("button", { name: "저장" });
  await expect(save).toBeEnabled();
  await pane.locator("select").first().selectOption("kimi");
  await save.click();

  const saved = await page.evaluate(() =>
    (
      window as unknown as {
        __MARU_AGENT_CALLS__: Array<{ command: string; args: Record<string, unknown> }>;
      }
    ).__MARU_AGENT_CALLS__.filter((call) => call.command === "agents_upsert"),
  );
  expect(saved).toHaveLength(1);
  expect((saved[0].args.agent as { runtime: string }).runtime).toBe("kimi");
});
