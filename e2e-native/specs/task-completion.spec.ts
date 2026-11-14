// Real WKWebView policy/write/restart check using only a disposable task.
// The launcher supplies fixture-owned Codex/Claude programs through PATH.
// Their fixed outputs prove process/UI/evidence wiring, not model quality or IME.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {} from "webdriverio";
import { fixtureRootDir } from "../helpers/fixtureWorkspace";

const title = "Native completion evidence fixture";
const relative = "work-items/active/native-completion.md";

interface NativeReceipt {
  schemaVersion: string;
  token: { runId: string; taskId: string; generation: number };
  creatorPrincipals: string[];
  processFinished: boolean;
  processSuccess: boolean;
  apply: { complete: boolean; paths: string[] } | null;
  review: { principal: string; passed: boolean | null; binding: { artifacts: Array<{ path: string; sha256: string | null }> } } | null;
  acceptance: { completed: boolean; approvalId: string; reviewRevision: string; beforeRevision: string; afterRevision: string; targetPath: string } | null;
  acceptanceHistory: unknown[];
}

async function recordedReceipts(): Promise<Array<{ file: string; raw: string; receipt: NativeReceipt }>> {
  const root = path.join(fixtureRootDir(), "workspace/.maru/task-completion/receipts");
  const found: Array<{ file: string; raw: string; receipt: NativeReceipt }> = [];
  const walk = async (dir: string) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ENOENT") return; throw failure; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith(".json")) {
        const raw = await fs.readFile(file, "utf8");
        found.push({ file, raw, receipt: JSON.parse(raw) as NativeReceipt });
      }
    }
  };
  await walk(root);
  return found;
}

async function providerCalls(): Promise<Array<{ provider: string; operation: string }>> {
  try {
    return (await fs.readFile(path.join(fixtureRootDir(), "task-completion-provider-calls.jsonl"), "utf8"))
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { provider: string; operation: string });
  } catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ENOENT") return []; throw failure; }
}

async function assertFixtureProviderResolution(): Promise<void> {
  const raw = await browser.executeAsync((done: (value: string) => void) => {
    const scope = window as unknown as { __TAURI_INTERNALS__: { invoke(command: string, args: unknown): Promise<unknown> } };
    void Promise.all(["codex", "claude"].map((runtime) => scope.__TAURI_INTERNALS__.invoke("skills_runtime_status", { runtime, commandOverride: null })))
      .then((statuses) => done(JSON.stringify({ statuses })), (failure: unknown) => done(JSON.stringify({ failure: String(failure) })));
  });
  const result = JSON.parse(raw) as { statuses?: Array<{ runtime: string; available: boolean; binaryPath: string | null }>; failure?: string };
  assert.equal(result.failure, undefined, "fixture provider resolution failed before execution");
  assert.equal(result.statuses?.length, 2);
  for (const status of result.statuses ?? []) {
    assert.equal(status.available, true, `${status.runtime} fixture is unavailable`);
    assert.ok(status.binaryPath);
    assert.equal(await fs.realpath(status.binaryPath), await fs.realpath(path.join(fixtureRootDir(), "task-completion-bin", status.runtime)), "refusing to launch an ambient provider");
  }
}

async function expectNativeRefusal(command: string, args: Record<string, unknown>): Promise<unknown> {
  const raw = await browser.executeAsync((name: string, params: Record<string, unknown>, done: (value: string) => void) => {
    const scope = window as unknown as { __TAURI_INTERNALS__: { invoke(command: string, args: unknown): Promise<unknown> } };
    void scope.__TAURI_INTERNALS__.invoke(name, params).then(
      (body) => done(JSON.stringify({ refused: false, body })),
      (body: unknown) => done(JSON.stringify({ refused: true, body })),
    );
  }, command, args);
  const result = JSON.parse(raw) as { refused: boolean; body: unknown };
  assert.equal(result.refused, true, `${command} bypassed completion evidence`);
  return result.body;
}

async function clickNamed(scope: string, pattern: string, name: string): Promise<void> {
  await stage(name, () => browser.execute((selector: string, source: string) => {
    const expression = new RegExp(source);
    const button = [...document.querySelectorAll<HTMLButtonElement>(`${selector} button`)]
      .find((item) => expression.test(item.textContent?.trim() ?? ""));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, scope, pattern));
}

async function stage(name: string, ready: () => Promise<boolean>): Promise<void> {
  try {
    await browser.waitUntil(ready, { timeout: 30_000, interval: 200, timeoutMsg: `task completion stalled at ${name}` });
  } catch (failure) {
    const diagnostics = await browser.execute(() => JSON.stringify({
      mode: window.__MARU_NATIVE_E2E__?.readAppState()?.appMode,
      tasks: document.querySelector(".tasks-pane")?.textContent?.slice(-5000),
      message: document.querySelector('.error-banner, .error-toast, [role="alert"]')?.textContent,
    }));
    throw new Error(`native_task_completion_stage_failed: ${name}; ${String(failure)}; ${diagnostics}`);
  }
}

async function openTask(filterName = "Unscheduled"): Promise<void> {
  await stage("Tasks mode", () => browser.execute(() => {
    const rail = [...document.querySelectorAll<HTMLButtonElement>(".activity-rail button")]
      .find((button) => /^(태스크|Tasks)$/.test(button.getAttribute("aria-label") ?? ""));
    if (!rail) return false;
    rail.click();
    return true;
  }));
  await stage("Tasks surface", () => browser.execute(() => Boolean(document.querySelector(".tasks-pane:not(.tasks-empty)"))));
  await stage("Tasks refresh", () => browser.execute(() => {
    const refresh = [...document.querySelectorAll<HTMLButtonElement>(".tasks-header button")]
      .find((button) => /^(새로고침|Refresh)$/.test(button.textContent?.trim() ?? ""));
    if (!refresh || refresh.disabled) return false;
    refresh.click();
    return true;
  }));
  await stage("Task filter", () => browser.execute((wanted: string) => {
    const filter = [...document.querySelectorAll<HTMLButtonElement>(".tasks-sidebar button")]
      .find((button) => new RegExp(wanted).test(button.querySelector(".tasks-filter-copy")?.textContent?.trim() ?? ""));
    if (!filter) return false;
    filter.click();
    return true;
  }, filterName));
  await stage("List view", () => browser.execute(() => {
    const list = [...document.querySelectorAll<HTMLButtonElement>(".tasks-view-switcher button")]
      .find((button) => /^(목록|List)$/.test(button.textContent?.trim() ?? ""));
    if (!list) return false;
    list.click();
    return true;
  }));
  await stage("Fixture task", () => browser.execute((wanted: string) => {
    const task = [...document.querySelectorAll<HTMLButtonElement>(".tasks-list .task-row")]
      .find((button) => button.querySelector("strong")?.textContent === wanted);
    if (!task) return false;
    task.click();
    return true;
  }, title));
  await stage("Completion controls", () => browser.execute(() => Boolean(
    [...document.querySelectorAll(".task-detail-drawer section")]
      .find((section) => /^(완료 근거|Completion evidence)$/.test(section.querySelector("h3")?.textContent ?? ""))
      ?.querySelector('input[type="checkbox"]:not(:disabled)'),
  )));
}

async function completionState(): Promise<{ required: boolean; acceptDisabled: boolean; text: string }> {
  // A string result avoids WebDriver's reserved value.error transport handling.
  const json = await browser.execute(() => {
    const section = [...document.querySelectorAll(".task-detail-drawer section")]
      .find((element) => /^(완료 근거|Completion evidence)$/.test(element.querySelector("h3")?.textContent ?? ""));
    const accept = [...(section?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((button) => /^(수락하고 완료 처리|Accept and mark Done)$/.test(button.textContent?.trim() ?? ""));
    return JSON.stringify({
      required: section?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked === true,
      acceptDisabled: !accept || accept.disabled,
      text: section?.textContent ?? "",
    });
  });
  return JSON.parse(json) as { required: boolean; acceptDisabled: boolean; text: string };
}

describe("native task completion evidence", () => {
  it("requires reviewed committed artifacts and fresh acceptance, then retains terminal evidence after restart", async () => {
    assert.ok(process.env.MARU_NATIVE_E2E_HOME, "native fixture isolation must be active");
    assert.equal(process.env.MARU_NATIVE_E2E_TASK_COMPLETION_FIXTURE, "1", "the launcher must activate isolated fake providers before app spawn");
    const workspace = path.join(fixtureRootDir(), "workspace");
    const file = path.join(workspace, relative);
    const archive = path.join(workspace, "work-items/archive/native-completion.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\ntitle: ${title}\nstatus: active\ncustom: retained\n---\n# Native completion fixture\n`);
    await openTask();
    assert.equal((await completionState()).required, false);

    const enabled = await browser.execute(() => {
      const section = [...document.querySelectorAll(".task-detail-drawer section")]
        .find((element) => /^(완료 근거|Completion evidence)$/.test(element.querySelector("h3")?.textContent ?? ""));
      const control = section?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!control || control.disabled || control.checked) return false;
      control.click();
      return true;
    });
    assert.equal(enabled, true, "the completion opt-in was not available in Task details");
    await stage("Durable completion policy", async () => /^maruCompletionRequired: true$/m.test(await fs.readFile(file, "utf8")));
    const requiredSource = await fs.readFile(file, "utf8");
    assert.match(requiredSource, /^maruCompletionPolicyRevision: .+$/m, "the app must mint a policy revision");
    await stage("Unresolved acceptance", async () => {
      const state = await completionState();
      return state.required && state.acceptDisabled && /execution|실행/.test(state.text);
    });

    assert.equal(await browser.execute((wanted: string) => {
      const task = [...document.querySelectorAll(".tasks-list .task-row")]
        .find((button) => button.querySelector("strong")?.textContent === wanted);
      const done = task?.querySelector<HTMLElement>('[role="checkbox"]');
      if (!done) return false;
      done.click();
      return true;
    }, title), true);
    await stage("Direct Done refusal", () => browser.execute(() => /requires reviewed, committed artifact evidence before Done/.test(document.body.textContent ?? "")));
    assert.equal(await fs.readFile(file, "utf8"), requiredSource, "refused Done changed the task bytes");
    await assert.rejects(fs.stat(archive), { code: "ENOENT" }, "refused Done published an archived task");

    const suffix = await expectNativeRefusal("move_document", {
      vaultPath: workspace, documentPath: relative, targetRelPath: relative.replace(/\.md$/, ".html"),
    });
    assert.match(JSON.stringify(suffix), /task_completion_refused/);
    assert.equal(await fs.readFile(file, "utf8"), requiredSource);
    await assert.rejects(fs.stat(path.join(workspace, relative.replace(/\.md$/, ".html"))), { code: "ENOENT" });

    const outbox = path.join(workspace, ".maru/today/outbox");
    const outboxNames = async () => {
      try { return (await fs.readdir(outbox)).sort(); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ENOENT") return []; throw failure; }
    };
    const beforeOutbox = await outboxNames();
    const today = await expectNativeRefusal("task_transition", { workPath: workspace, request: {
        taskId: "native-completion-fixture", taskPath: relative, kind: "complete", expectedTaskHash: createHash("sha256").update(requiredSource).digest("hex"),
        deferDate: null, date: "2026-11-14", nowIso: "2026-11-14T10:00:00+09:00", webActionId: null, payload: {},
    } });
    assert.match(JSON.stringify(today), /task_completion_refused/);
    assert.equal(await fs.readFile(file, "utf8"), requiredSource);
    assert.deepEqual(await outboxNames(), beforeOutbox, "refused Today completion created a provider outbox record");
    await assert.rejects(fs.stat(archive), { code: "ENOENT" });

    const whitespace = await expectNativeRefusal("save_document", {
      vaultPath: workspace, documentPath: relative,
      content: requiredSource.replace("status: active", "status: ' done '"),
      expectedRevision: createHash("sha256").update(requiredSource).digest("hex"),
    });
    assert.match(JSON.stringify(whitespace), /task_completion_refused/);
    assert.equal(await fs.readFile(file, "utf8"), requiredSource);
    const creation = await expectNativeRefusal("create_task_note", { workPath: workspace, root: "work-items", draft: {
      slug: "forged-completion", title: "Forbidden completion fixture", bucket: "archive",
      frontmatter: { maruCompletionRequired: true, status: "done" }, body: "# No approved evidence\n",
    } });
    // create_task_note retains its existing string-error wire contract.
    assert.match(JSON.stringify(creation), /Completion policy/);
    assert.match(JSON.stringify(creation), /Task details/);
    await assert.rejects(fs.stat(path.join(workspace, "work-items/archive/forged-completion.md")), { code: "ENOENT" });

    await browser.reloadSession();
    await openTask();
    const restored = await completionState();
    assert.equal(restored.required, true, "restart lost the durable completion requirement");
    assert.equal(restored.acceptDisabled, true, "restart treated the task as accepted without reviewed evidence");
    assert.equal(await fs.readFile(file, "utf8"), requiredSource);
    await assert.rejects(fs.stat(archive), { code: "ENOENT" });
    assert.deepEqual(await providerCalls(), [], "opening or restarting the task launched a provider without an explicit Run");

    await assertFixtureProviderResolution();

    await clickNamed(".task-detail-drawer", "^(이 태스크로 스킬 실행|Run skill on this)$", "Creator compose");
    await stage("Compose ready", () => browser.execute(() => Boolean(document.querySelector(".compose-dialog"))));
    await clickNamed(".compose-dialog .compose-run-groups", "^Codex$", "Explicit Codex creator");
    await clickNamed(".compose-dialog", "^(백그라운드|Background)$", "Background creator mode");
    await clickNamed(".compose-dialog .compose-actions", "^(실행|Run)$", "Creator launch");
    await stage("Creator terminal receipt", async () => (await recordedReceipts()).some(({ receipt }) => receipt.processFinished && receipt.processSuccess));
    const creatorReceipt = (await recordedReceipts())[0].receipt;
    const claim = JSON.parse(await fs.readFile(path.join(workspace, ".maru/task-execution", `${creatorReceipt.token.taskId}.json`), "utf8")) as { tasksRoot: string };
    assert.equal(await fs.realpath(claim.tasksRoot), await fs.realpath(path.join(workspace, "work-items")), "tracked execution ignored the configured Tasks root");
    assert.deepEqual(await providerCalls(), [{ provider: "codex", operation: "creator" }]);
    const artifact = path.join(workspace, "scratchpad/memos/native-task-output.md");
    await assert.rejects(fs.stat(artifact), { code: "ENOENT" }, "a process exit committed an unapproved proposal");
    assert.match(await fs.readFile(file, "utf8"), /^status: active$/m);

    await clickNamed(".tasks-sidebar", "^(전체 실행|All runs)$", "Task runs");
    await clickNamed(".tasks-run-card-actions", "^(검토|Review)$", "Load creator proposal");
    await clickNamed(".tasks-review-actions", "^(적용|Apply)$", "Apply reviewed proposal");
    await clickNamed(".approval-dialog", "^(승인|Approve)$", "Approve artifact commit");
    await stage("Committed artifact", async () => {
      try { return (await fs.readFile(artifact, "utf8")).includes("Synthetic provider lifecycle evidence."); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ENOENT") return false; throw failure; }
    });
    await openTask();
    assert.equal((await completionState()).acceptDisabled, true, "artifact application alone accepted the task");
    assert.deepEqual(await providerCalls(), [{ provider: "codex", operation: "creator" }], "applying artifacts automatically invoked a reviewer");

    const reviewers = await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>('.task-detail-drawer select[id$="-provider"]');
      return select ? { value: select.value, options: [...select.options].map((option) => option.value) } : null;
    });
    assert.ok(reviewers);
    assert.equal(reviewers.value, "", "reviewer selection must be explicit");
    assert.ok(!reviewers.options.includes("codex"), "the creator was offered as an independent reviewer");
    assert.ok(reviewers.options.includes("claude"));
    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>('.task-detail-drawer select[id$="-provider"]')!;
      select.value = "claude";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await clickNamed(".task-detail-drawer", "^(검토 시작|Start review)$", "Independent Claude review");
    await stage("Passing independent review", async () => (await recordedReceipts()).some(({ receipt }) => receipt.review?.passed === true && receipt.review.principal === "claude"));
    await stage("Fresh acceptance available", async () => !(await completionState()).acceptDisabled);
    assert.deepEqual(await providerCalls(), [{ provider: "codex", operation: "creator" }, { provider: "claude", operation: "review" }]);
    const beforeAcceptance = await fs.readFile(file, "utf8");
    assert.match(beforeAcceptance, /^status: active$/m, "passing review finalized TaskStatus without the person");
    await clickNamed(".task-detail-drawer", "^(수락하고 완료 처리|Accept and mark Done)$", "Prepare fresh acceptance");
    await stage("Fresh confirmation without Remember", () => browser.execute(() => {
      const dialog = document.querySelector(".approval-dialog");
      return Boolean(dialog) && !dialog!.querySelector('input[type="checkbox"]');
    }));
    await clickNamed(".approval-dialog", "^(취소|Cancel)$", "Cancel final acceptance");
    assert.equal(await fs.readFile(file, "utf8"), beforeAcceptance, "cancelled acceptance finalized the task");
    await assert.rejects(fs.stat(archive), { code: "ENOENT" });
    await clickNamed(".task-detail-drawer", "^(수락하고 완료 처리|Accept and mark Done)$", "Prepare acceptance again");
    await clickNamed(".approval-dialog", "^(승인|Approve)$", "Fresh person acceptance");
    await stage("Archived accepted task", async () => {
      try { return /^status: done$/m.test(await fs.readFile(archive, "utf8")); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ENOENT") return false; throw failure; }
    });
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
    const completed = await recordedReceipts();
    assert.equal(completed.length, 1);
    assert.equal(completed[0].receipt.apply?.complete, true);
    assert.ok(completed[0].receipt.creatorPrincipals.includes("codex"));
    assert.equal(completed[0].receipt.review?.passed, true);
    const artifactHash = createHash("sha256").update(await fs.readFile(artifact)).digest("hex");
    assert.ok(completed[0].receipt.review?.binding.artifacts.some((item) =>
      item.path === "scratchpad/memos/native-task-output.md" && item.sha256 === artifactHash),
    "the passed review is not bound to the actual committed artifact bytes");
    assert.equal(completed[0].receipt.acceptance?.completed, true);
    assert.equal(completed[0].receipt.acceptanceHistory.length, 0);
    assert.match(completed[0].receipt.acceptance?.approvalId ?? "", /.+/);
    const acceptedTask = await fs.readFile(archive, "utf8");
    assert.equal(completed[0].receipt.acceptance?.beforeRevision, createHash("sha256").update(beforeAcceptance).digest("hex"));
    assert.equal(completed[0].receipt.acceptance?.afterRevision, createHash("sha256").update(acceptedTask).digest("hex"));
    const callsBeforeRestart = await providerCalls();
    await browser.reloadSession();
    await openTask("^(완료|Done)$");
    assert.match((await completionState()).text, /이 리비전을 수락했습니다|This revision was accepted/);
    assert.equal((await completionState()).acceptDisabled, true);
    assert.equal(await fs.readFile(archive, "utf8"), acceptedTask);
    assert.deepEqual(await recordedReceipts(), completed, "restart rewrote or duplicated terminal evidence");
    assert.deepEqual(await providerCalls(), callsBeforeRestart, "restart replayed a creator or reviewer process");
  }).timeout(480_000);
});
