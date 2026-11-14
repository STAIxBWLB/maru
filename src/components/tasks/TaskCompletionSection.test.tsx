// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unmountReactRoot } from "../../lib/testing/unmountReactRoot";
import { TaskCompletionSection } from "./TaskCompletionSection";

const api = vi.hoisted(() => ({
  readTaskCompletion: vi.fn(),
  setTaskCompletionPolicy: vi.fn(),
  startTaskCompletionReview: vi.fn(),
  prepareTaskCompletionAcceptance: vi.fn(),
  finalizeTaskCompletion: vi.fn(),
}));

vi.mock("../../lib/taskCompletion", () => api);
vi.mock("../../lib/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workPath = "/fixture/work";
const taskPath = "tasks/active/task.md";
const token = { taskId: "task-fixture", requestId: "request-fixture", runId: "creator-run", generation: 3 };
const sourceRevision = "source-fixture";
const bindingRevision = "binding-fixture";
const reviewRevision = "review-fixture";
const preparedRequest = {
  id: "approval-fixture",
  kind: "task.completion.accept",
  summary: "Accept the reviewed task",
  target: taskPath,
  payloadPreview: reviewRevision,
  autoApproved: false,
  binding: {
    logicalTarget: "task-fixture",
    payloadHash: "payload-fixture",
    sourceRunId: token.runId,
    sourceRevision,
    baseRevision: reviewRevision,
    policyRevision: "policy-fixture",
  },
};

function view(patch: Record<string, unknown> = {}) {
  return {
    required: true,
    sourceRevision,
    token,
    bindingRevision,
    reviewRevision,
    creatorPrincipal: "codex",
    reviewProviders: ["claude"],
    canReview: true,
    canAccept: false,
    acceptedCurrent: false,
    ...patch,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let root: Root | null = null;
let container: HTMLDivElement;
const onChanged = vi.fn();
const onConfirmApproval = vi.fn();
const onMissionStarted = vi.fn();

async function render(nextTaskPath = taskPath, tasksRoot?: string) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(
      <TaskCompletionSection
        {...(tasksRoot === undefined ? {} : { tasksRoot })}
        workPath={workPath}
        taskPath={nextTaskPath}
        onChanged={onChanged}
        onConfirmApproval={onConfirmApproval}
        onMissionStarted={onMissionStarted}
      />,
    );
  });
}

function button(key: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.trim() === key || element.getAttribute("aria-label") === key);
  expect(found, `missing completion action ${key}`).toBeDefined();
  return found!;
}

function checkbox(): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(found, "the person must have an explicit completion policy control").not.toBeNull();
  return found!;
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}

beforeEach(() => {
  vi.resetAllMocks();
  api.readTaskCompletion.mockResolvedValue(view());
  api.setTaskCompletionPolicy.mockResolvedValue(view());
  api.startTaskCompletionReview.mockResolvedValue({ runId: "reviewer-run" });
  api.prepareTaskCompletionAcceptance.mockResolvedValue({ preparedRequest });
  api.finalizeTaskCompletion.mockResolvedValue(view({ acceptedCurrent: true, canAccept: false }));
  onConfirmApproval.mockResolvedValue("fresh-person-approval");
});

afterEach(async () => {
  if (root) {
    await unmountReactRoot(root);
    root = null;
  }
  container?.remove();
});

describe("TaskCompletionSection opt-in and review", () => {
  it("leaves an ordinary task off and exposes opt-in without final acceptance", async () => {
    api.readTaskCompletion.mockResolvedValue(view({ required: false, token: undefined, canReview: false }));
    await render();

    expect(checkbox().checked).toBe(false);
    const accept = [...container.querySelectorAll("button")].find((element) =>
      element.textContent?.trim() === "tasks.completion.accept");
    expect(!accept || accept.disabled).toBe(true);
    expect(api.prepareTaskCompletionAcceptance).not.toHaveBeenCalled();
    expect(api.finalizeTaskCompletion).not.toHaveBeenCalled();
  });

  it("changes policy only through the UI setter with the loaded source revision", async () => {
    api.readTaskCompletion.mockResolvedValue(view({ required: false, token: undefined, canReview: false }));
    await render();
    await click(checkbox());

    expect(api.setTaskCompletionPolicy).toHaveBeenCalledExactlyOnceWith(workPath, taskPath, true, sourceRevision);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(api.finalizeTaskCompletion).not.toHaveBeenCalled();
  });

  it("passes a configured custom task root to the revision-bound policy setter", async () => {
    const tasksRoot = "notes/tasks";
    const customTask = `${tasksRoot}/active/task.md`;
    api.readTaskCompletion.mockResolvedValue(view({ required: false, token: undefined, canReview: false }));
    await render(customTask, tasksRoot);
    await click(checkbox());

    expect(api.setTaskCompletionPolicy).toHaveBeenCalledExactlyOnceWith(workPath, customTask, true, sourceRevision, tasksRoot);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(api.finalizeTaskCompletion).not.toHaveBeenCalled();
  });

  it("preserves an explicitly empty task root in the policy request", async () => {
    api.readTaskCompletion.mockResolvedValue(view({ required: false, token: undefined, canReview: false }));
    await render("active/task.md", "");
    await click(checkbox());

    expect(api.setTaskCompletionPolicy).toHaveBeenCalledExactlyOnceWith(workPath, "active/task.md", true, sourceRevision, "");
  });

  it("ignores a pending policy result after the configured task root changes", async () => {
    const policy = deferred<ReturnType<typeof view>>();
    api.readTaskCompletion.mockResolvedValue(view({ required: false, token: undefined, canReview: false }));
    api.setTaskCompletionPolicy.mockReturnValue(policy.promise);
    await render(taskPath, "notes/tasks");
    await click(checkbox());
    await render(taskPath, "other/tasks");
    await act(async () => { policy.resolve(view()); });

    expect(onChanged).not.toHaveBeenCalled();
    expect(checkbox().checked).toBe(false);
    expect(api.finalizeTaskCompletion).not.toHaveBeenCalled();
  });

  it.each(["Review has not passed", "Artifact commit is unresolved"])(
    "keeps acceptance blocked when the backend reports %s", async (blockedReason) => {
      api.readTaskCompletion.mockResolvedValue(view({ canAccept: false, blockedReason }));
      await render();

      expect(container.textContent).toContain(blockedReason);
      expect(button("tasks.completion.accept").disabled).toBe(true);
      await click(button("tasks.completion.accept"));
      expect(api.prepareTaskCompletionAcceptance).not.toHaveBeenCalled();
      expect(api.finalizeTaskCompletion).not.toHaveBeenCalled();
    },
  );

  it("starts no reviewer automatically and submits only an explicitly selected provider", async () => {
    await render();
    expect(api.startTaskCompletionReview).not.toHaveBeenCalled();
    expect(button("tasks.completion.review").disabled).toBe(true);
    const select = container.querySelector<HTMLSelectElement>("select");
    expect(select).not.toBeNull();
    expect(select!.value).toBe("");
    expect([...select!.options].some((option) => option.value === "codex" && !option.disabled)).toBe(false);
    await act(async () => {
      select!.value = "claude";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(button("tasks.completion.review").disabled).toBe(false);
    await click(button("tasks.completion.review"));

    expect(api.startTaskCompletionReview).toHaveBeenCalledTimes(1);
    expect(api.startTaskCompletionReview).toHaveBeenCalledWith(workPath, token, bindingRevision, "claude", expect.any(String));
    const requestId = api.startTaskCompletionReview.mock.calls[0][4] as string;
    expect(requestId.trim().length).toBeGreaterThan(0);
    // The complete argument list above leaves no actor, principal or verdict
    // slot. Those identities and the verdict belong to backend evidence.
    expect(api.startTaskCompletionReview.mock.calls[0]).toHaveLength(5);
    expect(api.finalizeTaskCompletion).not.toHaveBeenCalled();
  });
});

describe("TaskCompletionSection fresh person acceptance", () => {
  it("prepares the exact review before asking the person, then finalizes with the returned approval", async () => {
    api.readTaskCompletion.mockResolvedValue(view({ canAccept: true }));
    const confirm = deferred<string | null>();
    onConfirmApproval.mockReturnValue(confirm.promise);
    await render();
    await click(button("tasks.completion.accept"));

    expect(api.prepareTaskCompletionAcceptance).toHaveBeenCalledExactlyOnceWith(workPath, token, reviewRevision);
    expect(onConfirmApproval).toHaveBeenCalledWith(expect.objectContaining({ preparedRequest }));
    expect(api.finalizeTaskCompletion).not.toHaveBeenCalled();
    await act(async () => { confirm.resolve("fresh-person-approval"); });

    expect(api.finalizeTaskCompletion).toHaveBeenCalledExactlyOnceWith(workPath, token, "fresh-person-approval", reviewRevision);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("does not finalize when the person cancels the fresh confirmation", async () => {
    api.readTaskCompletion.mockResolvedValue(view({ canAccept: true }));
    onConfirmApproval.mockResolvedValue(null);
    await render();
    await click(button("tasks.completion.accept"));

    expect(api.prepareTaskCompletionAcceptance).toHaveBeenCalledTimes(1);
    expect(onConfirmApproval).toHaveBeenCalledTimes(1);
    expect(api.finalizeTaskCompletion).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("reads durable backend state again on remount instead of retaining a local applied-run flag", async () => {
    api.readTaskCompletion.mockResolvedValue(view({ canAccept: true }));
    await render();
    await click(button("tasks.completion.accept"));
    expect(api.finalizeTaskCompletion).toHaveBeenCalledTimes(1);
    const readsBeforeRemount = api.readTaskCompletion.mock.calls.length;
    await unmountReactRoot(root!);
    root = null;
    container.remove();
    api.readTaskCompletion.mockResolvedValue(view({
      canAccept: false,
      acceptedCurrent: false,
      blockedReason: "Artifacts changed after the recorded acceptance",
    }));
    await render();

    expect(api.readTaskCompletion).toHaveBeenCalledTimes(readsBeforeRemount + 1);
    expect(container.textContent).toContain("Artifacts changed after the recorded acceptance");
    expect(button("tasks.completion.accept").disabled).toBe(true);
    expect(api.finalizeTaskCompletion).toHaveBeenCalledTimes(1);
  });

  it("discards a late read for the previous task and uses the new task revision for actions", async () => {
    const oldRead = deferred<ReturnType<typeof view>>();
    const nextPath = "tasks/active/other.md";
    api.readTaskCompletion.mockImplementation((_work: string, task: string) => task === taskPath
      ? oldRead.promise
      : Promise.resolve(view({ required: false, sourceRevision: "new-task-source", blockedReason: "Current task evidence" })));
    await render();
    await render(nextPath);
    await act(async () => { oldRead.resolve(view({ canAccept: true, blockedReason: "Obsolete task evidence" })); });

    expect(container.textContent).not.toContain("Obsolete task evidence");
    expect(checkbox().checked).toBe(false);
    await click(checkbox());
    expect(api.setTaskCompletionPolicy).toHaveBeenCalledExactlyOnceWith(workPath, nextPath, true, "new-task-source");
    expect(api.finalizeTaskCompletion).not.toHaveBeenCalled();
  });

  it("does not offer an old prepared acceptance after the selected task changes", async () => {
    const prepare = deferred<{ preparedRequest: typeof preparedRequest }>();
    api.prepareTaskCompletionAcceptance.mockReturnValue(prepare.promise);
    api.readTaskCompletion.mockResolvedValue(view({ canAccept: true }));
    await render();
    await click(button("tasks.completion.accept"));
    api.readTaskCompletion.mockResolvedValue(view({ required: false, canAccept: false }));
    await render("tasks/active/other.md");
    await act(async () => { prepare.resolve({ preparedRequest }); });

    expect(onConfirmApproval).not.toHaveBeenCalled();
    expect(api.finalizeTaskCompletion).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not finalize a previous selection when its confirmation resolves late", async () => {
    const confirm = deferred<string | null>();
    onConfirmApproval.mockReturnValue(confirm.promise);
    api.readTaskCompletion.mockResolvedValue(view({ canAccept: true }));
    await render();
    await click(button("tasks.completion.accept"));
    expect(onConfirmApproval).toHaveBeenCalledTimes(1);
    api.readTaskCompletion.mockResolvedValue(view({ required: false, canAccept: false }));
    await render("tasks/active/other.md");
    await act(async () => { confirm.resolve("fresh-person-approval"); });

    expect(api.finalizeTaskCompletion).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
