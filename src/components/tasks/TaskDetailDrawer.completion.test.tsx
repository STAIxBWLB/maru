// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unmountReactRoot } from "../../lib/testing/unmountReactRoot";
import type { TaskEntry } from "../../lib/tasks";
import { TaskDetailDrawer } from "./TaskDetailDrawer";

const api = vi.hoisted(() => ({
  readDocument: vi.fn(),
  readTaskCompletion: vi.fn(),
  setTaskCompletionPolicy: vi.fn(),
  startTaskCompletionReview: vi.fn(),
  prepareTaskCompletionAcceptance: vi.fn(),
  finalizeTaskCompletion: vi.fn(),
}));
vi.mock("../../lib/api", () => ({ readDocument: api.readDocument, isTauri: () => false }));
vi.mock("../../lib/taskCompletion", () => ({
  readTaskCompletion: api.readTaskCompletion,
  setTaskCompletionPolicy: api.setTaskCompletionPolicy,
  startTaskCompletionReview: api.startTaskCompletionReview,
  prepareTaskCompletionAcceptance: api.prepareTaskCompletionAcceptance,
  finalizeTaskCompletion: api.finalizeTaskCompletion,
}));
vi.mock("../../lib/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../lib/agents", () => ({ findSkill: () => null }));
vi.mock("./TaskFormFields", () => ({ TaskFormFields: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const workPath = "/fixture/work";
const tasksRoot = "notes/tasks";
const sourceRevision = "fresh-task-source";
const taskPath = `${tasksRoot}/active/task.md`;
const entry: TaskEntry = {
  absPath: `${workPath}/${taskPath}`, relPath: taskPath, fileName: "task.md", title: "Custom-root task",
  bucket: "active", status: "active", priority: "none", project: null,
  projects: [], projectKeys: [], projectLabels: [], topics: [], due: null, calendarStart: null,
  calendarEnd: null, size: 0, modifiedAt: null, frontmatter: {},
};
const completionView = {
  required: false, sourceRevision, reviewProviders: [], canReview: false, canAccept: false, acceptedCurrent: false,
};
let root: Root;
let container: HTMLDivElement;
const onOpenSkillCompose = vi.fn();
const onChanged = vi.fn();

async function render(configuredRoot = tasksRoot) {
  await act(async () => {
    root.render(<TaskDetailDrawer
      {...{ tasksRoot: configuredRoot }}
      workPath={workPath} entry={entry} metadata={null} loading={false} labelMode="title"
      skills={[]} collapsed={false} onToggleCollapsed={vi.fn()} onOpenSkillCompose={onOpenSkillCompose}
      onSaveDetails={vi.fn()} onDirtyChange={vi.fn()} onCompletionChanged={onChanged}
      onConfirmApproval={vi.fn().mockResolvedValue(null)}
    />);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  api.readTaskCompletion.mockResolvedValue(completionView);
  api.setTaskCompletionPolicy.mockResolvedValue(completionView);
  api.readDocument.mockResolvedValue({ revision: sourceRevision, meta: { maruCompletionRequired: true } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await unmountReactRoot(root);
  container.remove();
});

describe("TaskDetailDrawer custom-root completion", () => {
  it("forwards the configured root through the real completion section when enabling policy", async () => {
    await render();
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    await act(async () => { checkbox!.click(); });

    expect(api.setTaskCompletionPolicy).toHaveBeenCalledExactlyOnceWith(workPath, taskPath, true, sourceRevision, tasksRoot);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it.each(["tasks.actions.runSkill", "tasks.actions.otherSkill"])(
    "binds %s execution to the configured root and freshly read source", async (action) => {
      await render();
      const button = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === action);
      expect(button).toBeDefined();
      await act(async () => { button!.click(); });

      expect(api.readDocument).toHaveBeenCalledExactlyOnceWith(workPath, taskPath);
      expect(onOpenSkillCompose).toHaveBeenCalledTimes(1);
      expect(onOpenSkillCompose.mock.calls[0][3]).toBe(workPath);
      expect(onOpenSkillCompose.mock.calls[0][5]).toEqual({
        taskExecution: { requestId: expect.any(String), taskPath, sourceRevision, tasksRoot },
      });
    },
  );

  it("preserves an explicitly empty task root in tracked execution metadata", async () => {
    await render("");
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === "tasks.actions.runSkill");
    expect(button).toBeDefined();
    await act(async () => { button!.click(); });

    expect(onOpenSkillCompose.mock.calls[0][5]).toEqual({
      taskExecution: { requestId: expect.any(String), taskPath, sourceRevision, tasksRoot: "" },
    });
  });

  it("does not dispatch a pending run after the configured task root changes", async () => {
    let resolveRead!: (value: { revision: string; meta: { maruCompletionRequired: boolean } }) => void;
    api.readDocument.mockReturnValue(new Promise((resolve) => { resolveRead = resolve; }));
    await render();
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === "tasks.actions.runSkill");
    expect(button).toBeDefined();
    await act(async () => { button!.click(); });
    await render("other/tasks");
    await act(async () => { resolveRead({ revision: sourceRevision, meta: { maruCompletionRequired: true } }); });

    expect(onOpenSkillCompose).not.toHaveBeenCalled();
  });
});
