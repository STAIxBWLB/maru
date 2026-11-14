// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unmountReactRoot } from "../../lib/testing/unmountReactRoot";
import { ComposeDialog } from "./ComposeDialog";
import type { SkillRecord } from "../../lib/skills";

const api = vi.hoisted(() => ({
  agentRunStructuredLoop: vi.fn(),
  skillsDispatchBackground: vi.fn(),
  skillsDispatchCompose: vi.fn(),
  skillsDispatchTerminal: vi.fn(),
  skillsRuntimeStatus: vi.fn(),
  prepareMeetingSourceIntake: vi.fn(),
  setError: vi.fn(),
}));
vi.mock("../../lib/skills", () => api);
vi.mock("../../lib/errorStore", () => ({ setError: api.setError }));
vi.mock("../../lib/meetingSourceIntake", () => ({ prepareMeetingSourceIntake: api.prepareMeetingSourceIntake }));
vi.mock("../../lib/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../ui/DialogSurface", () => ({
  DialogSurface: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogSurfaceClose: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogSurfaceTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const skill: SkillRecord = {
  id: "task-management", sourceId: "builtin", name: "task-management",
  relPath: "task-management", absPath: "/fixture/skills/task-management", title: "Tasks",
  tier: "core", valid: true, editable: false, dirty: false,
};
const taskExecution = { requestId: "request-fixture", taskPath: "tasks/active/task.md", sourceRevision: "source-fixture" };
let root: Root;
let container: HTMLDivElement;
const openMeetingWorkbench = vi.fn();

async function render(opted = true, origin?: string, selectedSkill = skill) {
  await act(async () => {
    root.render(<ComposeDialog open skills={[selectedSkill]} defaultRuntime="codex"
      seed={{ skill: selectedSkill, cwd: "/fixture/work", prompt: "Produce the task's artifacts", metadata: opted ? { taskExecution, ...(origin ? { origin } : {}) } : undefined }}
      onClose={vi.fn()} onTerminalDispatch={vi.fn()} onOpenMeetingsWorkbench={openMeetingWorkbench} />);
  });
}
async function click(key: string) {
  const control = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === key);
  expect(control, `missing compose control ${key}`).toBeDefined();
  await act(async () => { control!.click(); });
}
beforeEach(() => {
  vi.resetAllMocks();
  api.skillsRuntimeStatus.mockResolvedValue({ available: true });
  api.skillsDispatchCompose.mockResolvedValue({ prompt: "Composed task directive" });
  api.skillsDispatchBackground.mockResolvedValue("background-run");
  api.agentRunStructuredLoop.mockResolvedValue("creator-run");
  api.prepareMeetingSourceIntake.mockResolvedValue(null);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await unmountReactRoot(root);
  container.remove();
});

describe("ComposeDialog opted task execution", () => {
  it("keeps the current mode and starts no automatic reviewer or execution", async () => {
    await render();
    const background = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "skills.compose.background");
    expect(background?.className).toContain("active");
    expect(api.agentRunStructuredLoop).not.toHaveBeenCalled();
    expect(api.skillsDispatchBackground).not.toHaveBeenCalled();
  });

  it("carries the exact task request only after the person selects tracked Structured mode", async () => {
    await render();
    await click("skills.compose.structured");
    await click("skills.compose.run");
    expect(api.agentRunStructuredLoop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      provider: "codex",
      cwd: "/fixture/work",
      directive: "Composed task directive",
      metadata: expect.objectContaining({ taskExecution, origin: "taskManagementExecution" }),
    }));
    expect(api.skillsDispatchBackground).not.toHaveBeenCalled();
    expect(api.skillsDispatchTerminal).not.toHaveBeenCalled();
  });

  it("forwards the task request through default background execution without overwriting its origin", async () => {
    await render(true, "taskManagementFixture");
    await click("skills.compose.run");
    expect(api.skillsDispatchBackground).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      runtime: "codex",
      cwd: "/fixture/work",
      metadata: expect.objectContaining({ taskExecution, origin: "taskManagementFixture" }),
    }));
    expect(api.agentRunStructuredLoop).not.toHaveBeenCalled();
    expect(api.skillsDispatchTerminal).not.toHaveBeenCalled();
  });

  it("refuses an untracked terminal run instead of silently changing mode", async () => {
    await render();
    await click("skills.compose.terminal");
    await click("skills.compose.run");
    expect(api.setError).toHaveBeenLastCalledWith("tasks.completion.trackedModeRequired");
    expect(api.agentRunStructuredLoop).not.toHaveBeenCalled();
    expect(api.skillsDispatchBackground).not.toHaveBeenCalled();
    expect(api.skillsDispatchTerminal).not.toHaveBeenCalled();
  });

  it("preserves ordinary manual task background execution without completion metadata", async () => {
    await render(false);
    await click("skills.compose.run");
    expect(api.skillsDispatchBackground).toHaveBeenCalledTimes(1);
    const metadata = api.skillsDispatchBackground.mock.calls[0][0].metadata;
    expect(metadata.origin).toBe("skillCompose");
    expect(metadata).not.toHaveProperty("taskExecution");
    expect(api.agentRunStructuredLoop).not.toHaveBeenCalled();
  });

  it("does not silently drop an opted task request when meeting-notes would open an untracked workbench", async () => {
    await render(true, undefined, { ...skill, id: "meeting-notes", name: "meeting-notes" });
    await click("meetings.sourceReview.intake");

    expect(api.setError).toHaveBeenLastCalledWith("tasks.completion.meetingSourceUnsupported");
    expect(api.prepareMeetingSourceIntake).not.toHaveBeenCalled();
    expect(openMeetingWorkbench).not.toHaveBeenCalled();
    expect(api.agentRunStructuredLoop).not.toHaveBeenCalled();
    expect(api.skillsDispatchBackground).not.toHaveBeenCalled();
    expect(api.skillsDispatchTerminal).not.toHaveBeenCalled();
  });

  it("keeps ordinary meeting source intake on its existing workbench path", async () => {
    await render(false, undefined, { ...skill, id: "meeting-notes", name: "meeting-notes" });
    await click("meetings.sourceReview.intake");

    expect(api.prepareMeetingSourceIntake).toHaveBeenCalledTimes(1);
    expect(openMeetingWorkbench).toHaveBeenCalledTimes(1);
    expect(api.agentRunStructuredLoop).not.toHaveBeenCalled();
    expect(api.skillsDispatchBackground).not.toHaveBeenCalled();
    expect(api.skillsDispatchTerminal).not.toHaveBeenCalled();
    expect(api.setError).not.toHaveBeenCalledWith("tasks.completion.meetingSourceUnsupported");
  });
});
