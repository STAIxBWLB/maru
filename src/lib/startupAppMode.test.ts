// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { applyStoredAppMode, bootAppMode } from "./startupAppMode";
import { DEFAULT_MARU_SETTINGS, type MaruAppMode } from "./settings";
import { useWorkspaceBootLifecycle } from "./workspaceBootLifecycle";
import { unmountReactRoot } from "./testing/unmountReactRoot";

const boot = vi.hoisted(() => ({
  registry: vi.fn(), settings: vi.fn(), day: vi.fn(), rollover: vi.fn(), open: vi.fn(),
}));
vi.mock("./api", () => ({ listWorkspaceRoots: boot.registry, addWorkspaceRoot: vi.fn(), getSampleWorkspacePath: vi.fn() }));
vi.mock("./maruDir", () => ({ readMaruSettings: boot.settings }));
vi.mock("./today", () => ({ todayLogicalDay: boot.day, todayRollover: boot.rollover, todayOpen: boot.open }));
vi.mock("./planningModeStore", () => ({ planningModeController: { setLogicalDay: vi.fn(), setTodayRoute: vi.fn() } }));
vi.mock("./workspaceStore", () => ({ activateWorkspace: vi.fn(), setWorkspaceRegistry: vi.fn() }));

describe("bootAppMode", () => {
  it("keeps the stored mode in the default build", () => {
    for (const storedMode of ["pkm", "files", "tasks", "sites"] as MaruAppMode[]) {
      expect(bootAppMode({ storedMode, browserPasskeyBuild: false })).toBe(storedMode);
    }
  });

  it("starts the provisioned passkey build on the Sites browser surface", () => {
    for (const storedMode of ["pkm", "files", "tasks", "graph"] as MaruAppMode[]) {
      expect(bootAppMode({ storedMode, browserPasskeyBuild: true })).toBe("sites");
    }
  });
});

describe("applyStoredAppMode", () => {
  it("applies the stored mode when no pick is pending", () => {
    const pick: { current: MaruAppMode | null } = { current: null };
    expect(applyStoredAppMode(pick, "tasks")).toBe("tasks");
    expect(pick.current).toBeNull();
  });

  it("keeps a pending pick over a stale stored mode", () => {
    const pick: { current: MaruAppMode | null } = { current: "meetings" };
    expect(applyStoredAppMode(pick, "pkm")).toBe("meetings");
    expect(pick.current).toBe("meetings");
  });

  it("lifts the guard once the stored settings catch up with the pick", () => {
    const pick: { current: MaruAppMode | null } = { current: "meetings" };
    expect(applyStoredAppMode(pick, "meetings")).toBe("meetings");
    expect(pick.current).toBeNull();
    expect(applyStoredAppMode(pick, "pkm")).toBe("pkm");
  });

  it("retains a matched explicit pick throughout boot, including save echoes", () => {
    const pick: { current: MaruAppMode | null } = { current: "pkm" };
    for (const booting of [true, true, false]) {
      expect(applyStoredAppMode(pick, "pkm", booting)).toBe("pkm");
      expect(pick.current).toBe(booting ? "pkm" : null);
    }
  });

  it("keeps the default Documents pick when matching hydration and write echoes precede delayed Today IO", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const work = "/fixture/default-documents-boot";
    boot.registry.mockResolvedValue({ workspaces: [{ label: "Fixture", path: work, visibility: "private", provider: "local", writePolicy: "direct" }], activeByVisibility: { private: work }, hiddenDefaults: [] });
    boot.settings.mockResolvedValue(DEFAULT_MARU_SETTINGS);
    boot.day.mockResolvedValue({ logicalDay: "2026-10-06" });
    boot.rollover.mockResolvedValue(null);
    let finishToday!: (snapshot: { dayState: "unstarted" }) => void;
    const todayPending = new Promise<{ dayState: "unstarted" }>((resolve) => { finishToday = resolve; });
    boot.open.mockReturnValue(todayPending);
    const pick: { current: MaruAppMode | null } = { current: null };
    let booting = true;
    let mode: MaruAppMode = DEFAULT_MARU_SETTINGS.ui.activeAppMode;
    const modes: MaruAppMode[] = [];
    const loadWorkspace = vi.fn(async () => {});
    const errors: string[] = [];
    function Host() {
      useWorkspaceBootLifecycle({
        settingsOverlayOpen: false, browserPasskeyBuildRef: { current: false },
        todayAutoOpenPathRef: { current: null }, todayAutoOpenModeRef: { current: null }, userPickedAppModeRef: pick,
        lastOpenKey: () => "fixture:last-open", loadWorkspace,
        setBooting: (value) => { booting = value; }, setAppMode: (value) => { mode = value; modes.push(value); },
        setEditorPaneViewModes: () => {}, setRightPaneTab: () => {}, setError: (value) => { errors.push(value); },
      });
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(Host)); });
      expect(boot.open).toHaveBeenCalledOnce();
      expect(booting).toBe(true);
      // Actual boot is paused in Today IO. These are the same helper calls
      // used by App's settings hydration and two settings-update branches.
      pick.current = "pkm";
      mode = applyStoredAppMode(pick, DEFAULT_MARU_SETTINGS.ui.activeAppMode, booting);
      mode = applyStoredAppMode(pick, "pkm", booting);
      expect(pick.current).toBe("pkm");
      await act(async () => { finishToday({ dayState: "unstarted" }); });
      expect(errors).toEqual([]);
      expect(loadWorkspace).toHaveBeenCalledWith(work, "private", null);
      expect(booting).toBe(false);
      expect(modes).not.toContain("today");
      expect(mode).toBe("pkm");
      expect(pick.current).toBe("pkm");
      expect(applyStoredAppMode(pick, "pkm", booting)).toBe("pkm");
      expect(pick.current).toBeNull();
    } finally {
      await unmountReactRoot(root);
      container.remove();
    }
  });
});
