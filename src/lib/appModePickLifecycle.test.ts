// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  shouldReapplyAppModePick,
  useAppModePickLifecycle,
  withActiveAppMode,
} from "./appModePickLifecycle";
import { DEFAULT_MARU_SETTINGS, type MaruAppMode, type MaruSettings } from "./settings";

describe("withActiveAppMode", () => {
  it("patches the active mode without touching other ui settings", () => {
    const next = withActiveAppMode(DEFAULT_MARU_SETTINGS, "meetings");
    expect(next.ui.activeAppMode).toBe("meetings");
    expect(next.ui.explorerPaneMode).toBe(DEFAULT_MARU_SETTINGS.ui.explorerPaneMode);
    expect(next.tasks).toBe(DEFAULT_MARU_SETTINGS.tasks);
  });

  it("maps the explorer pane for the files and pkm modes", () => {
    expect(withActiveAppMode(DEFAULT_MARU_SETTINGS, "files").ui.explorerPaneMode).toBe("files");
    expect(withActiveAppMode(DEFAULT_MARU_SETTINGS, "pkm").ui.explorerPaneMode).toBe("documents");
  });
});

describe("shouldReapplyAppModePick", () => {
  const base = {
    settingsWorkPath: "/work/a",
    settingsWritable: true,
    storedAppMode: "pkm",
  } as const;

  it("does nothing without a pending pick or a settings path", () => {
    expect(shouldReapplyAppModePick({ ...base, picked: null })).toBe(false);
    expect(shouldReapplyAppModePick({ ...base, picked: "meetings", settingsWorkPath: null })).toBe(false);
  });

  it("re-applies while the stored settings still differ from the pick", () => {
    expect(shouldReapplyAppModePick({ ...base, picked: "meetings" })).toBe(true);
    expect(
      shouldReapplyAppModePick({ ...base, picked: "meetings", settingsWritable: false }),
    ).toBe(true);
  });

  it("re-applies an already-matching pick once a save is possible", () => {
    // The pick reached the in-memory settings before they were writable but
    // never reached disk; a writable settings path means save it now.
    expect(shouldReapplyAppModePick({ ...base, picked: "pkm" })).toBe(true);
  });

  it("leaves read-only settings alone once they already show the pick", () => {
    expect(
      shouldReapplyAppModePick({ ...base, picked: "pkm", settingsWritable: false }),
    ).toBe(false);
  });
});

interface PickLifecycleProps {
  settingsWorkPath: string | null;
  settingsWritable: boolean;
  storedAppMode: MaruAppMode;
}

/** Mounts the lifecycle hook with a pending pick and records what it saves. */
function mountPickLifecycle(initialProps: PickLifecycleProps) {
  const userPickRef: { current: MaruAppMode | null } = { current: "meetings" };
  let applied: MaruSettings = DEFAULT_MARU_SETTINGS;
  const updateSettings = vi.fn((updater: (current: MaruSettings) => MaruSettings) => {
    applied = updater(applied);
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  function Probe(props: { value: PickLifecycleProps }) {
    useAppModePickLifecycle({ ...props.value, userPickRef, updateSettings });
    return null;
  }
  const rerender = (props: PickLifecycleProps) =>
    void act(() => root.render(createElement(Probe, { value: props })));
  rerender(initialProps);
  return {
    userPickRef,
    updateSettings,
    applied: () => applied,
    rerender,
    unmount: () => void act(() => root.unmount()),
  };
}

describe("useAppModePickLifecycle", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it("keeps the pick when the settings path changes before the save echoes (#387 review)", () => {
    // Boot moves from its private fallback path to the preferred writable
    // public workspace; hydration on the new path re-reads the old stored
    // mode. ui.activeAppMode is global, so the pick must survive the path
    // change and be re-applied until the persisted settings confirm it.
    const lifecycle = mountPickLifecycle({
      settingsWorkPath: "/private-fallback",
      settingsWritable: false,
      storedAppMode: "pkm",
    });
    expect(lifecycle.applied().ui.activeAppMode).toBe("meetings");
    lifecycle.updateSettings.mockClear();

    lifecycle.rerender({
      settingsWorkPath: "/public-preferred",
      settingsWritable: true,
      storedAppMode: "pkm",
    });
    expect(lifecycle.userPickRef.current).toBe("meetings");
    expect(lifecycle.updateSettings).toHaveBeenCalled();
    expect(lifecycle.applied().ui.activeAppMode).toBe("meetings");
    lifecycle.unmount();
  });

  it("keeps the pick across a workspace switch while the stored mode is stale", () => {
    const lifecycle = mountPickLifecycle({
      settingsWorkPath: "/work/a",
      settingsWritable: true,
      storedAppMode: "pkm",
    });
    lifecycle.updateSettings.mockClear();

    lifecycle.rerender({
      settingsWorkPath: "/work/b",
      settingsWritable: true,
      storedAppMode: "pkm",
    });
    expect(lifecycle.userPickRef.current).toBe("meetings");
    expect(lifecycle.applied().ui.activeAppMode).toBe("meetings");
    lifecycle.unmount();
  });

  it("stops re-applying once the pick shows in read-only stored settings", () => {
    const lifecycle = mountPickLifecycle({
      settingsWorkPath: "/work/a",
      settingsWritable: false,
      storedAppMode: "pkm",
    });
    lifecycle.updateSettings.mockClear();

    lifecycle.rerender({
      settingsWorkPath: "/work/a",
      settingsWritable: false,
      storedAppMode: "meetings",
    });
    expect(lifecycle.updateSettings).not.toHaveBeenCalled();
    lifecycle.unmount();
  });
});
