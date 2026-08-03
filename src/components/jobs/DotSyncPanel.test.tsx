// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DotSyncOverview } from "../../lib/api";

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  run: vi.fn(),
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    dotSyncOverview: mocks.overview,
    dotSyncRun: mocks.run,
  };
});

import { LocaleContext } from "../../lib/i18n";
import { DotSyncPanel } from "./DotSyncPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const missing: DotSyncOverview = {
  cli: {
    available: false,
    compatible: false,
    path: null,
    version: null,
    minimumVersion: "2.63.0",
    message: null,
  },
  mirror: null,
  peer: null,
};

const configured: DotSyncOverview = {
  cli: { ...missing.cli, available: true, compatible: true, version: "2.63.0" },
  mirror: {
    schemaVersion: 1,
    kind: "mirror",
    profile: "sync",
    configured: true,
    workspacePath: "/work",
    storeDir: "/work/.dotfiles/sync",
    target: { kind: "local", spec: "local:/mirror", path: "/mirror" },
    localExists: true,
    targetExists: true,
    paused: false,
    lockHeld: false,
    owner: "mac-a",
    canPush: true,
    machineNames: ["mac-a"],
    filterMode: "include",
    allowCount: 0,
    submoduleCount: 0,
    propagation: { create: true, update: true, delete: false },
    maxDelete: 1000,
    lastPullAt: null,
    lastPushAt: "2026-08-04T00:00:00Z",
    lastIntakeAt: null,
    conflictCount: 0,
    logPath: "/log",
    includePath: "/include",
    excludePath: "/exclude",
    ignorePath: "/ignore",
    allowPath: "/allow",
    jobs: [{ id: "mirror-push", action: "push", label: "com.dotfiles.sync", intervalSeconds: 600, mode: "clean", state: "running", lastRunAt: null }],
  },
  peer: null,
};

const configuredWithDisabledPeer: DotSyncOverview = {
  ...configured,
  peer: {
    schemaVersion: 1,
    kind: "peer",
    profile: {
      ...configured.mirror!,
      kind: "peer-profile",
      profile: "peer",
      target: {
        kind: "ssh",
        spec: "ssh:user@peer:/work",
        host: "user@peer",
        path: "/work",
      },
      jobs: [],
    },
    job: {
      id: "peer-sync",
      action: "peer-sync",
      label: "com.dotfiles.peer",
      intervalSeconds: 0,
      mode: "safe-bidirectional",
      state: "not-installed",
      lastRunAt: null,
    },
    lastExitCode: null,
    runCount: null,
    homePathsPath: "/work/.dotfiles/peer/home-paths.txt",
  },
};

const t = (key: string, vars?: Record<string, string | number>) => {
  let result = key;
  for (const [name, value] of Object.entries(vars ?? {})) {
    result = result.replace(`{${name}}`, String(value));
  }
  return result;
};

describe("DotSyncPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function render() {
    await act(async () => {
      root.render(
        <LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
          <DotSyncPanel />
        </LocaleContext.Provider>,
      );
    });
    await act(async () => {});
  }

  it("renders mirror scheduler state and runs a preview through the typed action", async () => {
    mocks.overview.mockResolvedValue(configured);
    mocks.run.mockResolvedValue({ stdout: "preview", stderr: "", overview: configured });
    await render();

    expect(container.textContent).toContain("com.dotfiles.sync");
    const preview = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("system.dotSync.previewPush"),
    );
    await act(async () => preview?.click());
    expect(mocks.run).toHaveBeenCalledWith({
      type: "runMirror",
      direction: "push",
      mode: "clean",
      dryRun: true,
    });
    expect(container.textContent).toContain("preview");
  });

  it("requires confirmation before installing a missing dot CLI", async () => {
    mocks.overview.mockResolvedValue(missing);
    mocks.run.mockResolvedValue({ stdout: "installed", stderr: "", overview: configured });
    await render();

    const install = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("system.dotSync.install"),
    );
    await act(async () => install?.click());
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(mocks.run).toHaveBeenCalledWith({ type: "installCli" });
  });

  it("preserves an explicitly disabled peer schedule when saving", async () => {
    mocks.overview.mockResolvedValue(configuredWithDisabledPeer);
    mocks.run.mockResolvedValue({ stdout: "saved", stderr: "", overview: configuredWithDisabledPeer });
    await render();

    const editButtons = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) => button.textContent?.includes("system.dotSync.edit"),
    );
    await act(async () => editButtons.at(-1)?.click());
    const intervalLabel = [...container.querySelectorAll<HTMLLabelElement>("label")].find(
      (label) => label.textContent?.includes("system.dotSync.peerInterval"),
    );
    expect(intervalLabel?.querySelector("select")?.value).toBe("0");

    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("system.dotSync.savePeer"),
    );
    await act(async () => save?.click());
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      type: "configurePeer",
      intervalSeconds: 0,
    }));
  });
});
