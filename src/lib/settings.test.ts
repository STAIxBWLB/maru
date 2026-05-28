import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANCHOR_SETTINGS,
  applyWorkspaceCommsOverrides,
  applyWorkspaceMeetingsOverrides,
  applyWorkspaceTasksOverrides,
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
        filesBrowserMode: "list",
        filesSortKey: "modifiedDesc",
        filesListAttributes: ["size", "bad", "parent", "size", "git"],
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
          terminalDock: "right",
          terminalWidth: 2048,
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
    expect(settings.ui.filesBrowserMode).toBe("list");
    expect(settings.ui.filesSortKey).toBe("modifiedDesc");
    expect(settings.ui.filesListAttributes).toEqual(["size", "parent", "git"]);
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
    expect(settings.ui.layout.terminalDock).toBe("right");
    expect(settings.ui.layout.terminalWidth).toBe(2048);
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

  it("parses meetings mode and normalizes meetings settings", () => {
    const settings = normalizeAnchorSettings({
      ui: {
        activeAppMode: "meetings",
      },
      meetings: {
        enabled: false,
        root: " meetings ",
        filenameTemplate: " MM-DD {type} - {topic}.md ",
        guides: {
          quickStart: " docs/QUICK_START.md ",
          glossary: " docs/GLOSSARY.md ",
          people: " docs/PEOPLE.md ",
          tagStandards: " docs/TAGS.md ",
          notesGuidelines: " docs/NOTES.md ",
        },
        hooks: {
          autoTaskExtract: false,
          autoVaultExtract: false,
          autoVaultConnect: true,
          appendVaultLog: false,
        },
        defaultTypes: "회의, 상담, 회의, 강의",
        calendarStartHour: 99,
      },
    });

    expect(settings.ui.activeAppMode).toBe("meetings");
    expect(settings.meetings.enabled).toBe(false);
    expect(settings.meetings.root).toBe("meetings");
    expect(settings.meetings.filenameTemplate).toBe("MM-DD {type} - {topic}.md");
    expect(settings.meetings.guides.quickStart).toBe("docs/QUICK_START.md");
    expect(settings.meetings.guides.tagStandards).toBe("docs/TAGS.md");
    expect(settings.meetings.hooks.autoTaskExtract).toBe(false);
    expect(settings.meetings.hooks.autoVaultExtract).toBe(false);
    expect(settings.meetings.hooks.autoVaultConnect).toBe(true);
    expect(settings.meetings.hooks.appendVaultLog).toBe(false);
    expect(settings.meetings.defaultTypes).toEqual(["회의", "상담", "강의"]);
    expect(settings.meetings.calendarStartHour).toBe(23);
  });

  it("parses tasks mode and normalizes tasks settings", () => {
    const settings = normalizeAnchorSettings({
      ui: {
        activeAppMode: "tasks",
      },
      tasks: {
        enabled: false,
        root: " tasks ",
        timezone: " Asia/Seoul ",
        gwsBinary: " /opt/bin/gws ",
        defaultView: "week",
        weekStartsOn: 0,
        calendarStartHour: 99,
        defaultTaskList: " personal ",
        defaultCalendar: " work ",
        hooks: {
          autoVaultExtract: true,
          appendVaultLog: false,
        },
      },
    });

    expect(settings.ui.activeAppMode).toBe("tasks");
    expect(settings.tasks.enabled).toBe(false);
    expect(settings.tasks.root).toBe("tasks");
    expect(settings.tasks.timezone).toBe("Asia/Seoul");
    expect(settings.tasks.gwsBinary).toBe("/opt/bin/gws");
    expect(settings.tasks.defaultView).toBe("week");
    expect(settings.tasks.weekStartsOn).toBe(0);
    expect(settings.tasks.calendarStartHour).toBe(23);
    expect(settings.tasks.defaultTaskList).toBe("personal");
    expect(settings.tasks.defaultCalendar).toBe("work");
    expect(settings.tasks.hooks.autoVaultExtract).toBe(true);
    expect(settings.tasks.hooks.appendVaultLog).toBe(false);
  });

  it("parses e2e mode for the guided Anchor flow", () => {
    const settings = normalizeAnchorSettings({
      ui: {
        activeAppMode: "e2e",
      },
    });

    expect(settings.ui.activeAppMode).toBe("e2e");
  });

  it("normalizes diagram workspace state", () => {
    const settings = normalizeAnchorSettings({
      diagram: {
        lastDocument: "  roadmap  ",
      },
    });

    expect(settings.diagram.lastDocument).toBe("roadmap");
    expect(normalizeAnchorSettings({ diagram: { lastDocument: "" } }).diagram.lastDocument).toBeNull();
  });

  it("parses catalog and studio modes for document operations", () => {
    expect(
      normalizeAnchorSettings({
        ui: {
          activeAppMode: "catalog",
        },
      }).ui.activeAppMode,
    ).toBe("catalog");
    expect(
      normalizeAnchorSettings({
        ui: {
          activeAppMode: "studio",
        },
      }).ui.activeAppMode,
    ).toBe("studio");
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

  it("applies workspace meeting note overrides without rewriting base meetings defaults", () => {
    const base = normalizeAnchorSettings({
      meetings: {
        root: "meetings",
        defaultTypes: ["회의", "상담"],
        hooks: { autoVaultConnect: true },
      },
    }).meetings;

    const effective = applyWorkspaceMeetingsOverrides(base, {
      meeting_notes: {
        enabled: false,
        root: "meetings/notes",
        filename_template: "MM-DD {topic}.md",
        guides: {
          quick_start: "docs/QUICK_START.md",
          tag_standards: "docs/TAGS.md",
        },
        hooks: {
          auto_vault_connect: false,
          append_vault_log: false,
        },
        default_types: ["강의", "워크숍"],
        calendar_start_hour: 7,
      },
    });

    expect(base.enabled).toBe(true);
    expect(base.root).toBe("meetings");
    expect(effective.enabled).toBe(false);
    expect(effective.root).toBe("meetings/notes");
    expect(effective.filenameTemplate).toBe("MM-DD {topic}.md");
    expect(effective.guides.quickStart).toBe("docs/QUICK_START.md");
    expect(effective.guides.tagStandards).toBe("docs/TAGS.md");
    expect(effective.hooks.autoVaultConnect).toBe(false);
    expect(effective.hooks.appendVaultLog).toBe(false);
    expect(effective.defaultTypes).toEqual(["강의", "워크숍"]);
    expect(effective.calendarStartHour).toBe(7);
  });

  it("applies workspace task-management overrides without rewriting base tasks defaults", () => {
    const base = normalizeAnchorSettings({
      tasks: {
        root: "tasks",
        defaultView: "list",
        hooks: { appendVaultLog: true },
      },
    }).tasks;

    const effective = applyWorkspaceTasksOverrides(base, {
      task_management: {
        enabled: false,
        root: "ops/tasks",
        timezone: "Asia/Seoul",
        gws_binary: "/usr/local/bin/gws",
        default_view: "day",
        week_starts_on: "sunday",
        calendar_start_hour: 7,
        hooks: {
          auto_vault_extract: true,
          append_vault_log: false,
        },
        google: {
          tasks: {
            default_list: "work",
          },
          calendar: {
            default_calendar: "teaching",
          },
        },
      },
    });

    expect(base.root).toBe("tasks");
    expect(effective.enabled).toBe(false);
    expect(effective.root).toBe("ops/tasks");
    expect(effective.timezone).toBe("Asia/Seoul");
    expect(effective.gwsBinary).toBe("/usr/local/bin/gws");
    expect(effective.defaultView).toBe("day");
    expect(effective.weekStartsOn).toBe(0);
    expect(effective.calendarStartHour).toBe(7);
    expect(effective.defaultTaskList).toBe("work");
    expect(effective.defaultCalendar).toBe("teaching");
    expect(effective.hooks.autoVaultExtract).toBe(true);
    expect(effective.hooks.appendVaultLog).toBe(false);
  });

  it("defaults first-run terminal layout to collapsed shell autoload", () => {
    const settings = normalizeAnchorSettings({});

    expect(settings.ui.explorerPaneMode).toBe("documents");
    expect(settings.ui.activeAppMode).toBe("pkm");
    expect(settings.ui.activeWorkspaceVisibility).toBe("private");
    expect(settings.ui.editorViewMode).toBe("source");
    expect(settings.ui.rightPaneTab).toBe("workspace");
    expect(settings.ui.workspaceFileFilter).toBe("all");
    expect(settings.ui.filesListAttributes).toEqual(
      DEFAULT_ANCHOR_SETTINGS.ui.filesListAttributes,
    );
    expect(settings.meetings.root).toBe("meetings");
    expect(settings.tasks.root).toBe("tasks");
    expect(settings.tasks.defaultView).toBe("week");
    expect(settings.meetings.defaultTypes).toEqual(
      DEFAULT_ANCHOR_SETTINGS.meetings.defaultTypes,
    );
    expect(settings.ui.binaryFileIncludePatterns).toEqual(
      DEFAULT_ANCHOR_SETTINGS.ui.binaryFileIncludePatterns,
    );
    expect(settings.ui.documentViews).toEqual([]);
    expect(settings.ui.fileQueueDefaultOperation).toBe("copy");
    expect(settings.ui.layout.terminalOpen).toBe(false);
    expect(settings.ui.layout.terminalDock).toBe("bottom");
    expect(settings.ui.layout.terminalWidth).toBe(640);
    expect(settings.terminal.defaultPanelOpen).toBe(false);
    expect(settings.terminal.autoLaunch).toBe("shell");
  });

  it("normalizes Files list attributes and preserves explicit all-off state", () => {
    expect(
      normalizeAnchorSettings({ ui: { filesListAttributes: ["binary", "size", "binary"] } })
        .ui.filesListAttributes,
    ).toEqual(["binary", "size"]);
    expect(
      normalizeAnchorSettings({ ui: { filesListAttributes: ["unknown"] } }).ui
        .filesListAttributes,
    ).toEqual(DEFAULT_ANCHOR_SETTINGS.ui.filesListAttributes);
    expect(normalizeAnchorSettings({ ui: { filesListAttributes: [] } }).ui.filesListAttributes)
      .toEqual([]);
  });

  it("accepts the evidence binder right-pane tab", () => {
    const settings = normalizeAnchorSettings({ ui: { rightPaneTab: "evidence" } });
    expect(settings.ui.rightPaneTab).toBe("evidence");
  });

  it("uses persisted layout over legacy terminal defaults", () => {
    const settings = normalizeAnchorSettings({
      ui: {
        layout: {
          documentsPaneOpen: false,
          documentsPaneWidth: 420,
          outlineOpen: false,
          outlinePaneWidth: 360,
          terminalOpen: true,
          terminalHeight: 300,
          terminalDock: "right",
          terminalWidth: 1800,
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
      documentsPaneOpen: false,
      documentsPaneWidth: 420,
      outlineOpen: false,
      outlinePaneWidth: 360,
      terminalOpen: true,
      terminalHeight: 300,
      terminalDock: "right",
      terminalWidth: 1800,
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

  it("normalizes terminal dock while preserving uncapped right-dock widths", () => {
    expect(normalizeAnchorSettings({ ui: { layout: { terminalDock: "side" } } }).ui.layout
      .terminalDock).toBe("bottom");
    expect(normalizeAnchorSettings({ ui: { layout: { terminalWidth: 12 } } }).ui.layout
      .terminalWidth).toBe(320);
    expect(normalizeAnchorSettings({ ui: { layout: { terminalWidth: 4096 } } }).ui.layout
      .terminalWidth).toBe(4096);
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
