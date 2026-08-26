import { describe, expect, it } from "vitest";
import {
  dispatchTerminalPanelTabs,
  getTerminalPanelState,
  getTerminalPanelStoreSnapshot,
  resetTerminalPanelStore,
  setTerminalPanelActiveContext,
  setTerminalPanelError,
  setTerminalPanelLayout,
  setTerminalPanelRequest,
} from "./terminalPanelStore";
import { createTerminalTab, createTerminalTask } from "./terminal";

describe("terminalPanelStore", () => {
  it("keeps task and tab state process-global while context changes independently", () => {
    resetTerminalPanelStore();
    dispatchTerminalPanelTabs({
      type: "createTask",
      task: createTerminalTask("task-1", "Build", "/workspace"),
    });
    dispatchTerminalPanelTabs({
      type: "create",
      tab: createTerminalTab("tab-1", "shell", "Shell", { taskId: "task-1", cwd: "/workspace" }),
    });
    const beforeContext = getTerminalPanelState().tabs;

    setTerminalPanelActiveContext({
      workspaceRoot: "/other-workspace",
      scratchpadRoot: null,
      workspaceVisibility: "private",
      appMode: "files",
      docAbsPath: null,
      docRelPath: null,
      docTitle: null,
      docType: null,
    });

    expect(getTerminalPanelState().tabs).toBe(beforeContext);
    expect(getTerminalPanelState().tabs.tasks).toHaveLength(1);
    expect(getTerminalPanelState().activeContext.workspaceRoot).toBe("/other-workspace");
  });

  it("retains unchanged slice identities across isolated publishes", () => {
    resetTerminalPanelStore();
    const initial = getTerminalPanelStoreSnapshot();
    setTerminalPanelLayout({ open: true });
    const afterLayout = getTerminalPanelStoreSnapshot();
    expect(afterLayout.tabs).toBe(initial.tabs);
    expect(afterLayout.activeContext).toBe(initial.activeContext);
    expect(afterLayout.request).toBe(initial.request);
    expect(afterLayout.error).toBe(initial.error);

    setTerminalPanelRequest({ kind: "shell", nonce: 1 });
    const afterRequest = getTerminalPanelStoreSnapshot();
    expect(afterRequest.tabs).toBe(afterLayout.tabs);
    expect(afterRequest.layout).toBe(afterLayout.layout);
    expect(afterRequest.activeContext).toBe(afterLayout.activeContext);

    setTerminalPanelError("spawn failed");
    expect(getTerminalPanelStoreSnapshot().request).toBe(afterRequest.request);
  });

  it("does not serialize runtime or interaction-only fields", () => {
    resetTerminalPanelStore();
    const serialized = JSON.stringify(getTerminalPanelStoreSnapshot());
    expect(serialized).not.toContain("channel");
    expect(serialized).not.toContain("generation");
    expect(serialized).not.toContain("searchOpen");
    expect(serialized).not.toContain("nativeHandle");
  });
});
