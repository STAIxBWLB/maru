import { describe, expect, it } from "vitest";
import { DEFAULT_ANCHOR_SETTINGS, normalizeAnchorSettings } from "./settings";

describe("normalizeAnchorSettings", () => {
  it("returns defaults for invalid or broken input", () => {
    expect(normalizeAnchorSettings(null)).toEqual(DEFAULT_ANCHOR_SETTINGS);
    expect(normalizeAnchorSettings("not-json")).toEqual(DEFAULT_ANCHOR_SETTINGS);
  });

  it("merges partial settings with terminal defaults", () => {
    const settings = normalizeAnchorSettings({
      ui: {
        explorerPaneMode: "files",
        documentBrowserMode: "tree",
        documentLabelMode: "filename",
        workspaceFileFilter: "tracked",
        collapsedTreeFolders: ["projects/rise"],
        collapsedFileFolders: ["assets"],
        documentTreeStateInitialized: true,
        fileTreeStateInitialized: true,
        fileQueueDefaultOperation: "move",
        themeMode: "dark",
        accentColor: "#445566",
        layout: {
          documentsPaneWidth: 999,
          outlinePaneWidth: 100,
          editorSplitOpen: true,
          editorSplitRatio: 0.9,
          terminalSplitOpen: true,
          terminalSplitRatio: 0.1,
        },
      },
      terminal: {
        defaultPanelOpen: false,
        lastHeight: 900,
        autoLaunch: "codex",
        launchers: {
          codex: {
            enabled: false,
            label: "Local Codex",
          },
        },
      },
    });

    expect(settings.ui.explorerPaneMode).toBe("files");
    expect(settings.ui.documentBrowserMode).toBe("tree");
    expect(settings.ui.documentLabelMode).toBe("filename");
    expect(settings.ui.workspaceFileFilter).toBe("tracked");
    expect(settings.ui.collapsedTreeFolders).toEqual(["projects/rise"]);
    expect(settings.ui.collapsedFileFolders).toEqual(["assets"]);
    expect(settings.ui.documentTreeStateInitialized).toBe(true);
    expect(settings.ui.fileTreeStateInitialized).toBe(true);
    expect(settings.ui.fileQueueDefaultOperation).toBe("move");
    expect(settings.ui.themeMode).toBe("dark");
    expect(settings.ui.accentColor).toBe("#445566");
    expect(settings.ui.layout.editorSplitOpen).toBe(true);
    expect(settings.ui.layout.documentsPaneWidth).toBe(560);
    expect(settings.ui.layout.outlinePaneWidth).toBe(240);
    expect(settings.ui.layout.editorSplitRatio).toBe(0.7);
    expect(settings.ui.layout.terminalSplitOpen).toBe(true);
    expect(settings.ui.layout.terminalSplitRatio).toBe(0.3);
    expect(settings.ui.layout.terminalOpen).toBe(false);
    expect(settings.ui.layout.terminalHeight).toBe(520);
    expect(settings.terminal.defaultPanelOpen).toBe(false);
    expect(settings.terminal.lastHeight).toBe(520);
    expect(settings.terminal.autoLaunch).toBe("codex");
    expect(settings.terminal.launchers.codex.enabled).toBe(false);
    expect(settings.terminal.launchers.codex.label).toBe("Local Codex");
    expect(settings.terminal.launchers.claude.enabled).toBe(true);
    expect(settings.terminal.launchers.shell.enabled).toBe(true);
    expect(settings.ai).toEqual({ providers: {}, defaults: {} });
  });

  it("defaults first-run terminal layout to collapsed shell autoload", () => {
    const settings = normalizeAnchorSettings({});

    expect(settings.ui.explorerPaneMode).toBe("documents");
    expect(settings.ui.workspaceFileFilter).toBe("all");
    expect(settings.ui.fileQueueDefaultOperation).toBe("copy");
    expect(settings.ui.layout.terminalOpen).toBe(false);
    expect(settings.terminal.defaultPanelOpen).toBe(false);
    expect(settings.terminal.autoLaunch).toBe("shell");
  });

  it("uses persisted layout over legacy terminal defaults", () => {
    const settings = normalizeAnchorSettings({
      ui: {
        layout: {
          documentTypesPaneOpen: false,
          documentsPaneOpen: false,
          documentsPaneWidth: 420,
          outlineOpen: false,
          outlinePaneWidth: 360,
          terminalOpen: true,
          terminalHeight: 300,
          terminalMaximized: true,
          editorSplitOpen: true,
          editorSplitRatio: 0.4,
          terminalSplitOpen: true,
          terminalSplitRatio: 0.6,
          windowBounds: { x: 10, y: 20, width: 1200, height: 800 },
          windowMaximized: false,
        },
      },
      terminal: {
        defaultPanelOpen: false,
        lastHeight: 200,
      },
    });

    expect(settings.ui.layout).toMatchObject({
      documentTypesPaneOpen: false,
      documentsPaneOpen: false,
      documentsPaneWidth: 420,
      outlineOpen: false,
      outlinePaneWidth: 360,
      terminalOpen: true,
      terminalHeight: 300,
      terminalMaximized: true,
      editorSplitOpen: true,
      editorSplitRatio: 0.4,
      terminalSplitOpen: true,
      terminalSplitRatio: 0.6,
      windowBounds: { x: 10, y: 20, width: 1200, height: 800 },
      windowMaximized: false,
    });
    expect(settings.terminal.defaultPanelOpen).toBe(true);
    expect(settings.terminal.lastHeight).toBe(300);
  });

  it("migrates legacy AI runtime labels into terminal launcher settings", () => {
    const settings = normalizeAnchorSettings({
      ai: {
        runtimes: {
          "claude-code": {
            enabled: false,
            label: "Claude Local",
          },
        },
      },
    });

    expect(settings.terminal.launchers.claude.enabled).toBe(false);
    expect(settings.terminal.launchers.claude.label).toBe("Claude Local");
    expect(settings.ai).toEqual({ providers: {}, defaults: {} });
  });
});
