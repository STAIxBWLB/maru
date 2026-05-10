import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANCHOR_SETTINGS,
  applyWorkspaceCommsOverrides,
  normalizeAnchorSettings,
  parseBinaryFileIncludePatternsText,
} from "./settings";

describe("normalizeAnchorSettings", () => {
  it("returns defaults for invalid or broken input", () => {
    expect(normalizeAnchorSettings(null)).toEqual(DEFAULT_ANCHOR_SETTINGS);
    expect(normalizeAnchorSettings("not-json")).toEqual(DEFAULT_ANCHOR_SETTINGS);
  });

  it("merges partial settings with terminal defaults", () => {
    const settings = normalizeAnchorSettings({
      ui: {
        activeAppMode: "inbox",
        activeWorkspaceVisibility: "public",
        editorViewMode: "preview",
        rightPaneTab: "files",
        explorerPaneMode: "files",
        documentBrowserMode: "tree",
        documentLabelMode: "filename",
        workspaceFileFilter: "tracked",
        binaryFileIncludePatterns: ["*.pdf", "*.HWP*", "*.pdf"],
        documentViews: [
          {
            id: "RISE Active",
            label: "RISE Active",
            color: "#884477",
            type: "project",
            status: "active",
            pathPrefix: "/projects/rise/",
            query: " grant ",
          },
          {
            id: "bad",
            label: "No criteria",
            color: "invalid",
          },
        ],
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

    expect(settings.ui.activeAppMode).toBe("inbox");
    expect(settings.ui.activeWorkspaceVisibility).toBe("public");
    expect(settings.ui.editorViewMode).toBe("preview");
    expect(settings.ui.rightPaneTab).toBe("files");
    expect(settings.ui.explorerPaneMode).toBe("files");
    expect(settings.ui.documentBrowserMode).toBe("tree");
    expect(settings.ui.documentLabelMode).toBe("filename");
    expect(settings.ui.workspaceFileFilter).toBe("tracked");
    expect(settings.ui.binaryFileIncludePatterns).toEqual(["*.pdf", "*.HWP*"]);
    expect(settings.ui.documentViews).toEqual([
      {
        id: "rise-active",
        label: "RISE Active",
        color: "#884477",
        type: "project",
        status: "active",
        pathPrefix: "projects/rise",
        query: "grant",
      },
    ]);
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

  it("parses comms mode and clamps comms settings", () => {
    const settings = normalizeAnchorSettings({
      ui: {
        activeAppMode: "comms",
      },
      comms: {
        outlook: {
          enabled: false,
          maxResults: 999,
          m365Path: " /opt/homebrew/bin/m365 ",
        },
        telegram: {
          polling: true,
          intervalSeconds: 5,
          maxResults: "25",
          sessionFile: " ~/.anchor/telegram/session ",
          monitorConfigPath: " ~/workspace/work/.secrets/services/telegram-monitor.config.yaml ",
          legacyAutoDrop: true,
        },
      },
    });

    expect(settings.ui.activeAppMode).toBe("comms");
    expect(settings.comms.outlook.enabled).toBe(false);
    expect(settings.comms.outlook.maxResults).toBe(200);
    expect(settings.comms.outlook.m365Path).toBe("/opt/homebrew/bin/m365");
    expect(settings.comms.telegram.polling).toBe(true);
    expect(settings.comms.telegram.intervalSeconds).toBe(30);
    expect(settings.comms.telegram.maxResults).toBe(25);
    expect(settings.comms.telegram.sessionFile).toBe("~/.anchor/telegram/session");
    expect(settings.comms.telegram.monitorConfigPath).toBe(
      "~/workspace/work/.secrets/services/telegram-monitor.config.yaml",
    );
    expect(settings.comms.telegram.legacyAutoDrop).toBe(true);
  });

  it("applies workspace io provider overrides without rewriting base comms defaults", () => {
    const base = normalizeAnchorSettings({
      comms: {
        outlook: { maxResults: 20 },
        telegram: { intervalSeconds: 60, maxResults: 40 },
      },
    }).comms;

    const effective = applyWorkspaceCommsOverrides(base, {
      io: {
        providers: {
          outlook: {
            enabled: false,
            max_results: 75,
            command: "/usr/local/bin/m365",
          },
          telegram: {
            interval_seconds: 7200,
            max_results: 15,
            python_path: "/opt/anchor/python",
            session_file: "/tmp/telegram.session",
            secrets: {
              monitor_config: "/tmp/telegram-monitor.yaml",
            },
            legacy_auto_drop: true,
          },
        },
      },
    });

    expect(base.outlook.enabled).toBe(true);
    expect(effective.outlook.enabled).toBe(false);
    expect(effective.outlook.maxResults).toBe(75);
    expect(effective.outlook.m365Path).toBe("/usr/local/bin/m365");
    expect(effective.telegram.intervalSeconds).toBe(7200);
    expect(effective.telegram.maxResults).toBe(15);
    expect(effective.telegram.pythonPath).toBe("/opt/anchor/python");
    expect(effective.telegram.sessionFile).toBe("/tmp/telegram.session");
    expect(effective.telegram.monitorConfigPath).toBe("/tmp/telegram-monitor.yaml");
    expect(effective.telegram.legacyAutoDrop).toBe(true);
  });

  it("defaults first-run terminal layout to collapsed shell autoload", () => {
    const settings = normalizeAnchorSettings({});

    expect(settings.ui.explorerPaneMode).toBe("documents");
    expect(settings.ui.activeAppMode).toBe("pkm");
    expect(settings.ui.activeWorkspaceVisibility).toBe("private");
    expect(settings.ui.editorViewMode).toBe("source");
    expect(settings.ui.rightPaneTab).toBe("outline");
    expect(settings.ui.workspaceFileFilter).toBe("all");
    expect(settings.ui.binaryFileIncludePatterns).toEqual(
      DEFAULT_ANCHOR_SETTINGS.ui.binaryFileIncludePatterns,
    );
    expect(settings.ui.documentViews).toEqual([]);
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

  it("normalizes binary include pattern text with comments and case-insensitive duplicates", () => {
    expect(
      parseBinaryFileIncludePatternsText(`
# archives
*.tgz
*.PDF
*.pdf
docs/*.html
`),
    ).toEqual(["*.tgz", "*.PDF", "docs/*.html"]);

    const settings = normalizeAnchorSettings({
      ui: {
        binaryFileIncludePatterns: "# docs\n*.docx\n\n*.pptx",
      },
    });
    expect(settings.ui.binaryFileIncludePatterns).toEqual(["*.docx", "*.pptx"]);
  });
});
