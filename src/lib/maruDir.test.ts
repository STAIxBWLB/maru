// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  isMissingWorkspaceConfigError,
  isWorkspaceConfigShellUnavailableError,
  nextIgnorePatterns,
  resolveWorkspaceConfigLoad,
  writeRecoveryCopy,
  readMaruSettings,
  saveMaruSettings,
  type MaruSettingsUpdatedPayload,
} from "./maruDir";
import { applyIncomingShellSettings, getPendingShellSettingsRevision, getShellSettings, getShellSettingsSaveOrigin, resetShellSettingsStoreForTests, updateShellSettings } from "./shellSettingsStore";
import { DEFAULT_MARU_SETTINGS, normalizeMaruSettings, type MaruSettings } from "./settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));

describe("isMissingWorkspaceConfigError", () => {
  it("accepts only the backend's exact missing-config error prefix", () => {
    expect(
      isMissingWorkspaceConfigError(
        "workspace.config.yaml not found at /workspace/plain/workspace.config.yaml",
      ),
    ).toBe(true);
    expect(
      isMissingWorkspaceConfigError(
        new Error(
          "workspace.config.yaml not found at /workspace/plain/workspace.config.yaml",
        ),
      ),
    ).toBe(true);
    expect(
      isMissingWorkspaceConfigError(
        "Cannot parse workspace.config.yaml: invalid type at line 2",
      ),
    ).toBe(false);
    expect(
      isMissingWorkspaceConfigError(
        "Cannot read workspace.config.yaml: Permission denied",
      ),
    ).toBe(false);
    expect(isMissingWorkspaceConfigError("workspace.config.yaml not found")).toBe(false);
    expect(
      isMissingWorkspaceConfigError({
        message: "workspace.config.yaml not found at /workspace/plain/workspace.config.yaml",
      }),
    ).toBe(true);
    expect(
      isMissingWorkspaceConfigError({
        message: "Cannot parse workspace.config.yaml: invalid YAML",
      }),
    ).toBe(false);
  });

  it("accepts only the exact browser shell-unavailable error", async () => {
    const exact = "workspace.config.yaml requires the Tauri shell";
    expect(isWorkspaceConfigShellUnavailableError(exact)).toBe(true);
    expect(isWorkspaceConfigShellUnavailableError(new Error(exact))).toBe(true);
    expect(isWorkspaceConfigShellUnavailableError(`${exact}.`)).toBe(false);
    expect(
      isWorkspaceConfigShellUnavailableError(
        `Cannot read workspace.config.yaml: ${exact}`,
      ),
    ).toBe(false);

    await expect(
      resolveWorkspaceConfigLoad("/workspace/browser", async () => {
        throw new Error(exact);
      }),
    ).resolves.toMatchObject({
      workPath: "/workspace/browser",
      status: "ready",
      config: null,
      error: null,
    });
    await expect(
      resolveWorkspaceConfigLoad("/workspace/broken", async () => {
        throw new Error(`${exact}.`);
      }),
    ).resolves.toMatchObject({
      workPath: "/workspace/broken",
      status: "error",
      config: null,
      error: `${exact}.`,
    });
  });
});

describe("nextIgnorePatterns", () => {
  const doc = {
    relPath: ".maruignore",
    patterns: ["archive", "*.png"],
    builtin: [".DS_Store"],
  };

  it("appends a new pattern at the end", () => {
    expect(nextIgnorePatterns(doc, "drafts/tmp.md")).toEqual([
      "archive",
      "*.png",
      "drafts/tmp.md",
    ]);
  });

  it("trims before comparing", () => {
    expect(nextIgnorePatterns(doc, "  drafts/a.md ")).toEqual([
      "archive",
      "*.png",
      "drafts/a.md",
    ]);
  });

  it("returns null when the pattern changes nothing", () => {
    expect(nextIgnorePatterns(doc, "archive")).toBeNull();
    expect(nextIgnorePatterns(doc, "  *.png  ")).toBeNull();
    expect(nextIgnorePatterns(doc, ".DS_Store")).toBeNull();
    expect(nextIgnorePatterns(doc, "   ")).toBeNull();
    expect(nextIgnorePatterns(doc, "# a comment")).toBeNull();
  });
});

describe("writeRecoveryCopy", () => {
  const originalTauriInternals = window.__TAURI_INTERNALS__;

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    window.__TAURI_INTERNALS__ = originalTauriInternals;
  });

  it("throws outside the Tauri shell without invoking anything", async () => {
    delete window.__TAURI_INTERNALS__;
    await expect(
      writeRecoveryCopy("/workspace", "notes/draft.md", "body", "flush timed out"),
    ).rejects.toThrow("Recovery copies require the Tauri shell");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("invokes write_recovery_copy with the raw arguments inside the Tauri shell", async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue(".maru/recovery/20260102-030405-draft-1a2b3c4d.md");
    await expect(
      writeRecoveryCopy("/workspace", "notes/draft.md", "body", "flush timed out"),
    ).resolves.toBe(".maru/recovery/20260102-030405-draft-1a2b3c4d.md");
    expect(invoke).toHaveBeenCalledWith("write_recovery_copy", {
      workPath: "/workspace",
      filePath: "notes/draft.md",
      content: "body",
      reason: "flush timed out",
    });
  });
});

describe("settings save/read causality", () => {
  const original = window.__TAURI_INTERNALS__;
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockReset(); vi.mocked(emit).mockReset();
    vi.mocked(emit).mockResolvedValue(undefined);
    resetShellSettingsStoreForTests();
  });
  afterEach(() => { window.__TAURI_INTERNALS__ = original; });

  it("emits merged readback rather than submitted values, so mismatched persisted values cannot acknowledge intent", async () => {
    const base = getShellSettings();
    const chosen = updateShellSettings((current) => ({ ...current, ui: { ...current.ui, layout: { ...current.ui.layout, terminalSplitOpen: true } } }));
    const disk = normalizeMaruSettings(DEFAULT_MARU_SETTINGS);
    disk.ui.collapsedTreeFolders = ["backend-preserved-workspace-field"];
    vi.mocked(invoke).mockImplementation(async (command) => command === "save_maru_settings" ? { globalChanged: true, workspaceChanged: false } : disk);
    await saveMaruSettings("/fixture", chosen, base);
    const payload = vi.mocked(emit).mock.calls[0][1] as MaruSettingsUpdatedPayload;
    expect(payload.settings.ui.layout.terminalSplitOpen).toBe(false);
    expect(payload.settings.ui.collapsedTreeFolders).toEqual(["backend-preserved-workspace-field"]);
    expect(payload.saveOrigin).toEqual(getShellSettingsSaveOrigin(chosen));
    applyIncomingShellSettings(payload.settings, payload.saveOrigin);
    expect(getShellSettings().ui.layout.terminalSplitOpen).toBe(true);
    expect(getPendingShellSettingsRevision()).toBeGreaterThan(0);
  });

  it("failed earlier save cannot be acknowledged by an unrelated success that omits its field", async () => {
    const initial = getShellSettings();
    const chosen = updateShellSettings((current) => ({ ...current, ui: { ...current.ui, layout: { ...current.ui.layout, terminalSplitOpen: true } } }));
    vi.mocked(invoke).mockRejectedValueOnce(new Error("first write failed"));
    await expect(saveMaruSettings("/fixture", chosen, initial)).rejects.toThrow("first write failed");
    expect(emit).not.toHaveBeenCalled();
    const unrelated = updateShellSettings((current) => ({ ...current, ui: { ...current.ui, themeMode: "dark" } }));
    const disk = normalizeMaruSettings(DEFAULT_MARU_SETTINGS);
    // A successful backend patch may still read back a different guarded
    // field (e.g. another writer won). A submitted matching value is no ack.
    vi.mocked(invoke).mockImplementation(async (command) => command === "save_maru_settings" ? { globalChanged: true, workspaceChanged: false } : disk);
    await saveMaruSettings("/fixture", unrelated, chosen);
    const saveArgs = vi.mocked(invoke).mock.calls.find((call) => call[0] === "save_maru_settings" && call[1] && (call[1] as { value: MaruSettings }).value.ui.themeMode === "dark")![1] as { baseValue: MaruSettings };
    expect(saveArgs.baseValue.ui.layout.terminalSplitOpen).toBe(false);
    const payload = vi.mocked(emit).mock.calls[0][1] as MaruSettingsUpdatedPayload;
    applyIncomingShellSettings(payload.settings, payload.saveOrigin);
    expect(getPendingShellSettingsRevision()).toBeGreaterThan(0);
    expect(getShellSettings().ui.layout.terminalSplitOpen).toBe(true);
    disk.ui.layout.terminalSplitOpen = true;
    await saveMaruSettings("/fixture", unrelated, chosen);
    const acknowledged = vi.mocked(emit).mock.calls[1][1] as MaruSettingsUpdatedPayload;
    applyIncomingShellSettings(acknowledged.settings, acknowledged.saveOrigin);
    expect(getPendingShellSettingsRevision()).toBe(0);
  });

  it("tags a read at invocation time so a late result cannot erase an acknowledged newer split", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const reading = readMaruSettings("/fixture");
    const chosen = updateShellSettings((current) => ({ ...current, ui: { ...current.ui, layout: { ...current.ui.layout, terminalSplitOpen: true } } }));
    applyIncomingShellSettings(normalizeMaruSettings(chosen), getShellSettingsSaveOrigin(chosen));
    expect(getPendingShellSettingsRevision()).toBe(0);
    finish(DEFAULT_MARU_SETTINGS);
    applyIncomingShellSettings(await reading);
    expect(getShellSettings().ui.layout.terminalSplitOpen).toBe(true);
  });

  it("keeps an object-to-null layout clear distinct from its actual persisted base", async () => {
    const disk = normalizeMaruSettings(DEFAULT_MARU_SETTINGS);
    disk.ui.layout.windowBounds = { x: 20, y: 30, width: 1000, height: 800 };
    applyIncomingShellSettings(disk);
    const before = getShellSettings();
    const cleared = updateShellSettings((current) => ({ ...current, ui: { ...current.ui, layout: { ...current.ui.layout, windowBounds: null } } }));
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "save_maru_settings") {
        const request = args as { value: MaruSettings; baseValue: MaruSettings };
        expect(request.baseValue.ui.layout.windowBounds).toEqual(before.ui.layout.windowBounds);
        expect(request.value.ui.layout.windowBounds).toBeNull();
        disk.ui.layout.windowBounds = null;
        return { globalChanged: true, workspaceChanged: false };
      }
      return disk;
    });
    await saveMaruSettings("/fixture", cleared, before);
    const payload = vi.mocked(emit).mock.calls[0][1] as MaruSettingsUpdatedPayload;
    applyIncomingShellSettings(payload.settings, payload.saveOrigin);
    expect(getShellSettings().ui.layout.windowBounds).toBeNull();
    expect(getPendingShellSettingsRevision()).toBe(0);
  });

  it("persists an explicit unchanged UI default after learning a different actual disk mode", async () => {
    const disk = normalizeMaruSettings(DEFAULT_MARU_SETTINGS);
    disk.ui.activeAppMode = "today";
    const uiDefault = getShellSettings();
    const picked = updateShellSettings((current) => current, ["ui.activeAppMode"]);
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "save_maru_settings") {
        const request = args as { value: MaruSettings; baseValue: MaruSettings };
        // Model the backend's changed-leaf contract: equal base/value is a
        // successful noop and does not persist the submitted UI default.
        if (request.value.ui.activeAppMode !== request.baseValue.ui.activeAppMode) disk.ui.activeAppMode = request.value.ui.activeAppMode;
        return { globalChanged: true, workspaceChanged: false };
      }
      return disk;
    });
    await saveMaruSettings("/fixture", picked, uiDefault);
    const noop = vi.mocked(emit).mock.calls[0][1] as MaruSettingsUpdatedPayload;
    expect(noop.settings.ui.activeAppMode).toBe("today");
    applyIncomingShellSettings(noop.settings, noop.saveOrigin);
    expect(getPendingShellSettingsRevision()).toBeGreaterThan(0);
    const retried = updateShellSettings((current) => current);
    await saveMaruSettings("/fixture", retried, getShellSettings());
    const persisted = vi.mocked(emit).mock.calls[1][1] as MaruSettingsUpdatedPayload;
    expect(persisted.settings.ui.activeAppMode).toBe("pkm");
    applyIncomingShellSettings(persisted.settings, persisted.saveOrigin);
    expect(getPendingShellSettingsRevision()).toBe(0);
    expect((await readMaruSettings("/fixture")).ui.activeAppMode).toBe("pkm");
  });
});
