import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARU_SETTINGS,
  applyWorkspaceCommsOverrides,
  applyWorkspaceMeetingsOverrides,
  applyWorkspaceTasksOverrides,
  normalizeMaruSettings,
  parseBinaryFileIncludePatternsText,
  resolveClassifierRuntime,
  serializeMaruSettings,
} from "./settings";

describe("normalizeMaruSettings", () => {
  it("returns defaults for invalid or broken input", () => {
    expect(normalizeMaruSettings(null)).toEqual(DEFAULT_MARU_SETTINGS);
    expect(normalizeMaruSettings("not-json")).toEqual(DEFAULT_MARU_SETTINGS);
  });

  it("accepts the 'both' document label mode and falls back for unknown values", () => {
    expect(normalizeMaruSettings({ ui: { documentLabelMode: "both" } }).ui.documentLabelMode).toBe(
      "both",
    );
    expect(
      normalizeMaruSettings({ ui: { documentLabelMode: "nonsense" } }).ui.documentLabelMode,
    ).toBe("title");
  });

  it("accepts the shareOutbox right-pane tab and falls back for unknown values", () => {
    expect(normalizeMaruSettings({ ui: { rightPaneTab: "shareOutbox" } }).ui.rightPaneTab).toBe(
      "shareOutbox",
    );
    expect(normalizeMaruSettings({ ui: { rightPaneTab: "bogus" } }).ui.rightPaneTab).toBe(
      "workspace",
    );
  });

  it("does not persist Telegram monitor secrets in Maru settings", () => {
    const settings = normalizeMaruSettings({
      comms: {
        telegram: {
          apiHash: "super-secret-hash",
          botToken: "super-bot-token",
          monitorConfigPath: "~/workspace/work/.maru/secrets/services/telegram-monitor.config.yaml",
        },
      },
    });
    const serializedSettings = serializeMaruSettings(settings);
    const serialized = JSON.stringify(serializedSettings);
    expect(serialized).not.toMatch(/"apiHash"\s*:/);
    expect(serialized).not.toMatch(/"botToken"\s*:/);
    expect(serialized).not.toContain("super-secret-hash");
    expect(serialized).not.toContain("super-bot-token");
  });

  it("merges partial settings with terminal defaults", () => {
    const settings = normalizeMaruSettings({
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
        favorites: [
          {
            kind: "file",
            relPath: "projects/rise/plan.md",
            label: "RISE Plan",
            addedAt: "2026-07-08T00:00:00Z",
          },
          {
            kind: "file",
            relPath: "projects/rise/plan.md",
            label: "Duplicate",
            addedAt: "2026-07-08T01:00:00Z",
          },
          {
            kind: "directory",
            relPath: "projects/rise/",
            label: "",
            addedAt: "",
          },
          {
            kind: "file",
            relPath: "../escape.md",
            label: "Bad",
            addedAt: "2026-07-08T02:00:00Z",
          },
          {
            kind: "file",
            relPath: "/absolute.md",
            label: "Bad",
            addedAt: "2026-07-08T03:00:00Z",
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
          editorSplitSurface: "graph",
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
    expect(settings.ui.editorPaneViewModes).toEqual({
      left: "preview",
      right: "preview",
    });
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
    expect(settings.ui.favorites).toEqual([
      {
        kind: "file",
        relPath: "projects/rise/plan.md",
        label: "RISE Plan",
        addedAt: "2026-07-08T00:00:00Z",
      },
      {
        kind: "directory",
        relPath: "projects/rise",
        label: "rise",
        addedAt: "",
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
    expect(settings.ui.layout.editorSplitSurface).toBe("graph");
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
    expect(settings.ai).toEqual({
      defaultRuntime: "claude",
      classifierRuntime: "inherit",
      permissionMode: "plan",
      commandOverrides: { claude: null, codex: null },
      extra: {},
    });
  });

  it("parses comms mode and clamps comms settings", () => {
    const settings = normalizeMaruSettings({
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
          sessionFile: " ~/.maru/telegram/session ",
          monitorConfigPath: " ~/workspace/work/.maru/secrets/services/telegram-monitor.config.yaml ",
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
    expect(settings.comms.telegram.sessionFile).toBe("~/.maru/telegram/session");
    expect(settings.comms.telegram.monitorConfigPath).toBe(
      "~/workspace/work/.maru/secrets/services/telegram-monitor.config.yaml",
    );
    expect(settings.comms.telegram.legacyAutoDrop).toBe(true);
  });

  it("parses meetings mode and normalizes meetings settings", () => {
    const settings = normalizeMaruSettings({
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
    const settings = normalizeMaruSettings({
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
    expect(settings.tasks.hooks.appendVaultLog).toBe(false);
  });

  it("applies the Maru Today defaults when the today block is missing", () => {
    const settings = normalizeMaruSettings({ tasks: {} });
    expect(settings.tasks.today).toEqual({
      enabled: true,
      dayStart: "03:30",
      sleepStart: "21:30",
      notificationEnabled: true,
      autoOpenFirstDailyLaunch: true,
      autoPlan: true,
      dailyFocusCapMinutes: 480,
      provisionalEstimateMinutes: 30,
      availabilityCalendars: [],
      calendarDestination: "defaultCalendar",
      calendarBlockSyncPolicy: "explicit",
      googleCompletionPolicy: "on-explicit-complete",
      journalRoot: "tasks/daily",
    });
  });

  it("normalizes the today block defensively and rejects invalid day times", () => {
    const settings = normalizeMaruSettings({
      tasks: {
        today: {
          enabled: "yes",
          dayStart: "3:30",
          sleepStart: "24:00",
          notificationEnabled: false,
          dailyFocusCapMinutes: -5,
          provisionalEstimateMinutes: 45,
          availabilityCalendars: ["personal", 42],
          calendarDestination: "  ",
          journalRoot: " journal/daily ",
        },
      },
    });
    const today = settings.tasks.today;
    expect(today.enabled).toBe(true);
    expect(today.dayStart).toBe("03:30");
    expect(today.sleepStart).toBe("21:30");
    expect(today.notificationEnabled).toBe(false);
    expect(today.dailyFocusCapMinutes).toBe(480);
    expect(today.provisionalEstimateMinutes).toBe(45);
    expect(today.availabilityCalendars).toEqual(["personal"]);
    expect(today.calendarDestination).toBe("defaultCalendar");
    expect(today.journalRoot).toBe("journal/daily");
  });

  it("accepts valid today overrides including boundary day times", () => {
    const settings = normalizeMaruSettings({
      tasks: {
        today: {
          dayStart: "00:00",
          sleepStart: "23:59",
          autoPlan: false,
          dailyFocusCapMinutes: 240,
        },
      },
    });
    expect(settings.tasks.today.dayStart).toBe("00:00");
    expect(settings.tasks.today.sleepStart).toBe("23:59");
    expect(settings.tasks.today.autoPlan).toBe(false);
    expect(settings.tasks.today.dailyFocusCapMinutes).toBe(240);
  });

  it("keeps the today block intact through workspace task overrides", () => {
    const base = normalizeMaruSettings({
      tasks: { today: { dayStart: "04:00", autoPlan: false } },
    }).tasks;
    const effective = applyWorkspaceTasksOverrides(base, {
      task_management: { root: "ops/tasks" },
    });
    expect(effective.today).toEqual(base.today);
    expect(effective.today.dayStart).toBe("04:00");
  });

  it("parses e2e mode for the guided Maru flow", () => {
    const settings = normalizeMaruSettings({
      ui: {
        activeAppMode: "e2e",
      },
    });

    expect(settings.ui.activeAppMode).toBe("e2e");
  });

  it("round-trips the sites app mode", () => {
    const settings = normalizeMaruSettings({
      ui: {
        activeAppMode: "sites",
      },
    });

    expect(settings.ui.activeAppMode).toBe("sites");
  });

  it("normalizes diagram workspace state", () => {
    const settings = normalizeMaruSettings({
      diagram: {
        lastDocument: "  roadmap  ",
      },
    });

    expect(settings.diagram.lastDocument).toBe("roadmap");
    expect(normalizeMaruSettings({ diagram: { lastDocument: "" } }).diagram.lastDocument).toBeNull();
  });

  it("normalizes diagram pattern favorites/recents", () => {
    const settings = normalizeMaruSettings({
      diagram: {
        favoritePatterns: ["report.raci", "report.raci", 42, "swot"],
        recentPatterns: ["table", "report.timeline"],
      },
    });

    expect(settings.diagram.favoritePatterns).toEqual(["report.raci", "swot"]);
    expect(settings.diagram.recentPatterns).toEqual(["table", "report.timeline"]);
  });

  it("defaults diagram pattern favorites/recents when missing or malformed", () => {
    const settings = normalizeMaruSettings({
      diagram: {
        favoritePatterns: "report.raci",
        recentPatterns: 7,
      },
    });

    expect(settings.diagram.favoritePatterns).toEqual([]);
    expect(settings.diagram.recentPatterns).toEqual([]);
    const defaults = normalizeMaruSettings({});
    expect(defaults.diagram.favoritePatterns).toEqual([]);
    expect(defaults.diagram.recentPatterns).toEqual([]);
  });

  it("caps diagram recents at 12 entries", () => {
    const settings = normalizeMaruSettings({
      diagram: {
        recentPatterns: Array.from({ length: 20 }, (_, i) => `pattern-${i}`),
      },
    });

    expect(settings.diagram.recentPatterns).toHaveLength(12);
    expect(settings.diagram.recentPatterns[0]).toBe("pattern-0");
  });

  it("persists independent editor pane modes while mirroring the left pane", () => {
    const settings = normalizeMaruSettings({
      ui: {
        editorViewMode: "rich",
        editorPaneViewModes: { left: "source", right: "preview" },
      },
    });
    expect(settings.ui.editorPaneViewModes).toEqual({
      left: "source",
      right: "preview",
    });
    expect(settings.ui.editorViewMode).toBe("source");

    const partial = normalizeMaruSettings({
      ui: {
        editorViewMode: "preview",
        editorPaneViewModes: { left: "invalid", right: "rich" },
      },
    });
    expect(partial.ui.editorPaneViewModes).toEqual({
      left: "preview",
      right: "rich",
    });
  });

  it("migrates graph V2 settings to the canvas-first V3 contract", () => {
    const settings = normalizeMaruSettings({
      graph: {
        schemaVersion: 2,
        source: "workspace",
        mode: "chains",
        localDepth: 3,
        localDirection: "incoming",
        searchAsFilter: true,
        generatedPatterns: ["reports/", " archive/  ", "log.md", ""],
        profiles: {
          workspace: {
            domains: ["research", "projects"],
            types: ["decision"],
            relations: ["supersedes"],
            community: 3,
            showUnresolved: true,
            showGenerated: true,
            minVisibleNeighbors: 2,
          },
        },
        display: { arrows: "all", labels: "high", nodeScale: 1.4, edgeScale: 0.8 },
        panels: {
          filtersOpen: false,
          workbenchOpen: true,
          filterWidth: 300,
          workbenchWidth: 400,
        },
        savedViews: [
          {
            id: "v1",
            name: "Research",
            source: "vault",
            mode: "local",
            localTarget: { ownerWorkspacePath: "/w", relPath: "notes/a.md" },
            profile: { domains: ["research"], minVisibleNeighbors: 1 },
            display: { arrows: "none" },
          },
          { id: "", name: "drop me" },
        ],
      },
    });

    expect(settings.graph.schemaVersion).toBe(3);
    expect(settings.graph.source).toBe("workspace");
    expect(settings.graph.mode).toBe("chains");
    expect(settings.graph.localDepth).toBe(3);
    expect(settings.graph.localDirection).toBe("incoming");
    expect(settings.graph.searchAsFilter).toBe(true);
    expect(settings.graph.generatedPatterns).toEqual(["reports/", "archive/", "log.md"]);
    expect(settings.graph.profiles.workspace).toEqual({
      domains: ["research", "projects"],
      types: ["decision"],
      relations: ["supersedes"],
      community: 3,
      showUnresolved: true,
      showGenerated: true,
      minVisibleNeighbors: 2,
    });
    // Missing profile falls back to defaults.
    expect(settings.graph.profiles.vault).toEqual({
      domains: [],
      types: [],
      relations: [],
      community: null,
      showUnresolved: false,
      showGenerated: false,
      minVisibleNeighbors: 0,
    });
    expect(settings.graph.display).toEqual({
      arrows: "all",
      labels: "high",
      colorMode: "community",
      relationColors: true,
      theme: "dark",
      accent: "violet",
      nodeScale: 1.4,
      edgeScale: 0.8,
    });
    expect(settings.graph.panels).toEqual({
      pinned: false,
      width: 400,
    });
    expect(settings.graph.savedViews).toHaveLength(1);
    expect(settings.graph.savedViews[0].localTarget).toEqual({
      ownerWorkspacePath: "/w",
      relPath: "notes/a.md",
    });
    expect(settings.graph.savedViews[0].display.arrows).toBe("none");
    expect(settings.graph.savedViews[0].display.labels).toBe("balanced");
  });

  it("round-trips graph V3 appearance and drawer settings", () => {
    const settings = normalizeMaruSettings({
      graph: {
        schemaVersion: 3,
        display: {
          arrows: "typed",
          labels: "balanced",
          colorMode: "domain",
          relationColors: true,
          theme: "light",
          accent: "green",
          nodeScale: 1.2,
          edgeScale: 1.1,
        },
        panels: { pinned: true, width: 372 },
      },
    });

    expect(settings.graph.schemaVersion).toBe(3);
    expect(settings.graph.display).toEqual({
      arrows: "typed",
      labels: "balanced",
      colorMode: "domain",
      relationColors: true,
      theme: "light",
      accent: "green",
      nodeScale: 1.2,
      edgeScale: 1.1,
    });
    expect(settings.graph.panels).toEqual({ pinned: true, width: 372 });
  });

  it("migrates V1 graph settings through V2 to V3", () => {
    const settings = normalizeMaruSettings({
      graph: {
        source: "all",
        scope: "all",
        localDepth: 3,
        localDirection: "incoming",
        view: "chains",
        searchAsFilter: true,
        noisePatterns: ["reports/", " archive/  ", "log.md", ""],
        filters: {
          domains: ["research", "projects"],
          types: ["decision", "unknown"],
          community: 3,
          showGhosts: true,
          showNoise: true,
          minDegree: 2,
        },
      },
    });

    expect(settings.graph.schemaVersion).toBe(3);
    // all -> workspace; legacy profile lands only in the previously active source.
    expect(settings.graph.source).toBe("workspace");
    expect(settings.graph.mode).toBe("chains");
    expect(settings.graph.generatedPatterns).toEqual(["reports/", "archive/", "log.md"]);
    expect(settings.graph.profiles.workspace).toEqual({
      domains: ["research", "projects"],
      // showNoise made the legacy "unknown" authored-note bucket visible.
      types: ["decision", "untyped"],
      relations: [],
      community: 3,
      showUnresolved: true,
      showGenerated: true,
      // max(minDegree 2, scope "all" ? 0) = 2.
      minVisibleNeighbors: 2,
    });
    expect(settings.graph.profiles.vault.minVisibleNeighbors).toBe(0);
    expect(settings.graph.profiles.vault.domains).toEqual([]);
  });

  it("maps V1 connected scope into minVisibleNeighbors and drops stale unknown type", () => {
    const connected = normalizeMaruSettings({
      graph: { scope: "connected", filters: { minDegree: 0, types: ["unknown"] } },
    });
    // The untouched legacy connectivity default migrates to sparse-safe zero.
    expect(connected.graph.profiles.vault.minVisibleNeighbors).toBe(0);
    // A lone "unknown" selection was a hidden chip — discarded, not resurrected.
    expect(connected.graph.profiles.vault.types).toEqual([]);

    const all = normalizeMaruSettings({
      graph: { scope: "all", filters: { minDegree: 0 } },
    });
    expect(all.graph.profiles.vault.minVisibleNeighbors).toBe(0);
  });

  it("defaults garbage graph settings to safe values", () => {
    const settings = normalizeMaruSettings({
      graph: {
        schemaVersion: 2,
        source: "everywhere",
        mode: "nonsense",
        searchAsFilter: "yes",
        profiles: {
          vault: {
            domains: "not-an-array",
            types: [1, "decision", null],
            community: "3",
            minVisibleNeighbors: -5,
          },
        },
        display: { arrows: "sometimes", nodeScale: 99, edgeScale: 0 },
        panels: { filterWidth: 12, workbenchWidth: 9999 },
      },
    });

    expect(settings.graph.source).toBe("vault");
    expect(settings.graph.mode).toBe("global");
    expect(settings.graph.localDepth).toBe(2);
    expect(settings.graph.localDirection).toBe("both");
    expect(settings.graph.searchAsFilter).toBe(false);
    expect(settings.graph.profiles.vault.domains).toEqual([]);
    expect(settings.graph.profiles.vault.types).toEqual(["decision"]);
    expect(settings.graph.profiles.vault.community).toBeNull();
    expect(settings.graph.profiles.vault.minVisibleNeighbors).toBe(0);
    expect(settings.graph.display.arrows).toBe("typed");
    expect(settings.graph.display.labels).toBe("balanced");
    expect(settings.graph.display.nodeScale).toBe(2);
    expect(settings.graph.display.edgeScale).toBe(0.5);
    expect(settings.graph.panels.pinned).toBe(false);
    expect(settings.graph.panels.width).toBe(480);
    expect(settings.graph.generatedPatterns).toEqual(["reports/", "log.md"]);
  });

  it("keeps graph back-compat: absent keys get defaults, explicit empties are preserved", () => {
    const settings = normalizeMaruSettings({ graph: { filters: {} } });
    // Absent scope/minDegree migrates to the sparse-safe V3 default.
    expect(settings.graph.profiles.vault.minVisibleNeighbors).toBe(0);
    expect(settings.graph.profiles.vault.showGenerated).toBe(false);
    expect(settings.graph.generatedPatterns).toEqual(["reports/", "log.md"]);
    // A deliberately empty pattern list is respected, not replaced by defaults.
    const empty = normalizeMaruSettings({ graph: { noisePatterns: [] } });
    expect(empty.graph.generatedPatterns).toEqual([]);
    const emptyV2 = normalizeMaruSettings({
      graph: { schemaVersion: 2, generatedPatterns: [] },
    });
    expect(emptyV2.graph.generatedPatterns).toEqual([]);
  });

  it("parses catalog and studio modes for document operations", () => {
    expect(
      normalizeMaruSettings({
        ui: {
          activeAppMode: "catalog",
        },
      }).ui.activeAppMode,
    ).toBe("catalog");
    expect(
      normalizeMaruSettings({
        ui: {
          activeAppMode: "studio",
        },
      }).ui.activeAppMode,
    ).toBe("studio");
  });

  it("applies workspace io provider overrides without rewriting base comms defaults", () => {
    const base = normalizeMaruSettings({
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
            python_path: "/opt/maru/python",
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
    expect(effective.telegram.pythonPath).toBe("/opt/maru/python");
    expect(effective.telegram.sessionFile).toBe("/tmp/telegram.session");
    expect(effective.telegram.monitorConfigPath).toBe("/tmp/telegram-monitor.yaml");
    expect(effective.telegram.legacyAutoDrop).toBe(true);
  });

  it("applies workspace meeting note overrides without rewriting base meetings defaults", () => {
    const base = normalizeMaruSettings({
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
    const base = normalizeMaruSettings({
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
    expect(effective.hooks.appendVaultLog).toBe(false);
  });

  it("defaults first-run terminal layout to collapsed shell autoload", () => {
    const settings = normalizeMaruSettings({});

    expect(settings.ui.explorerPaneMode).toBe("documents");
    expect(settings.ui.activeAppMode).toBe("pkm");
    expect(settings.ui.activeWorkspaceVisibility).toBe("private");
    expect(settings.ui.editorViewMode).toBe("source");
    expect(settings.ui.rightPaneTab).toBe("workspace");
    expect(settings.ui.workspaceFileFilter).toBe("all");
    expect(settings.ui.filesListAttributes).toEqual(
      DEFAULT_MARU_SETTINGS.ui.filesListAttributes,
    );
    expect(settings.meetings.root).toBe("meetings");
    expect(settings.tasks.root).toBe("tasks");
    expect(settings.tasks.defaultView).toBe("week");
    expect(settings.meetings.defaultTypes).toEqual(
      DEFAULT_MARU_SETTINGS.meetings.defaultTypes,
    );
    expect(settings.ui.binaryFileIncludePatterns).toEqual(
      DEFAULT_MARU_SETTINGS.ui.binaryFileIncludePatterns,
    );
    expect(settings.ui.documentViews).toEqual([]);
    expect(settings.ui.favorites).toEqual([]);
    expect(settings.ui.fileQueueDefaultOperation).toBe("copy");
    expect(settings.ui.layout.terminalOpen).toBe(false);
    expect(settings.ui.layout.terminalDock).toBe("bottom");
    expect(settings.ui.layout.terminalWidth).toBe(640);
    expect(settings.terminal.defaultPanelOpen).toBe(false);
    expect(settings.terminal.autoLaunch).toBe("shell");
  });

  it("normalizes Files list attributes and preserves explicit all-off state", () => {
    expect(
      normalizeMaruSettings({ ui: { filesListAttributes: ["binary", "size", "binary"] } })
        .ui.filesListAttributes,
    ).toEqual(["binary", "size"]);
    expect(
      normalizeMaruSettings({ ui: { filesListAttributes: ["unknown"] } }).ui
        .filesListAttributes,
    ).toEqual(DEFAULT_MARU_SETTINGS.ui.filesListAttributes);
    expect(normalizeMaruSettings({ ui: { filesListAttributes: [] } }).ui.filesListAttributes)
      .toEqual([]);
  });

  it("accepts the evidence binder right-pane tab", () => {
    const settings = normalizeMaruSettings({ ui: { rightPaneTab: "evidence" } });
    expect(settings.ui.rightPaneTab).toBe("evidence");
  });

  it("uses persisted layout over legacy terminal defaults", () => {
    const settings = normalizeMaruSettings({
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
          editorSplitSurface: "graph",
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
      editorSplitSurface: "graph",
      editorSplitRatio: 0.4,
      terminalSplitOpen: true,
      terminalSplitRatio: 0.6,
      windowBounds: { x: 10, y: 20, width: 1200, height: 800 },
      windowMaximized: false,
    });
    expect(settings.terminal.defaultPanelOpen).toBe(true);
    expect(settings.terminal.lastHeight).toBe(300);
  });

  it("defaults invalid editor split surfaces to documents", () => {
    expect(
      normalizeMaruSettings({
        ui: { layout: { editorSplitSurface: "preview" } },
      }).ui.layout.editorSplitSurface,
    ).toBe("document");
  });

  it("normalizes terminal dock while preserving uncapped right-dock widths", () => {
    expect(normalizeMaruSettings({ ui: { layout: { terminalDock: "side" } } }).ui.layout
      .terminalDock).toBe("bottom");
    expect(normalizeMaruSettings({ ui: { layout: { terminalWidth: 12 } } }).ui.layout
      .terminalWidth).toBe(320);
    expect(normalizeMaruSettings({ ui: { layout: { terminalWidth: 4096 } } }).ui.layout
      .terminalWidth).toBe(4096);
  });

  it("defaults and clamps Today workspace pane widths", () => {
    const defaults = normalizeMaruSettings({});
    expect(defaults.ui.layout).toMatchObject({
      todaySidebarWidth: 240,
      tasksSidebarWidth: 240,
      calendarAgendaWidth: 280,
      taskDetailsWidth: 400,
    });

    const clamped = normalizeMaruSettings({
      ui: {
        layout: {
          todaySidebarWidth: 20,
          tasksSidebarWidth: 999,
          calendarAgendaWidth: 40,
          taskDetailsWidth: 999,
        },
      },
    });
    expect(clamped.ui.layout).toMatchObject({
      todaySidebarWidth: 200,
      tasksSidebarWidth: 360,
      calendarAgendaWidth: 200,
      taskDetailsWidth: 520,
    });
  });

  it("migrates legacy AI runtime labels into terminal launcher settings", () => {
    const settings = normalizeMaruSettings({
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
    // Legacy `runtimes` is preserved round-trip-safe under `ai.extra`.
    expect(settings.ai.defaultRuntime).toBe("claude");
    expect(settings.ai.extra.runtimes).toEqual({
      "claude-code": { enabled: false, label: "Claude Local" },
    });
  });

  it("normalizes typed AI settings and trims command overrides", () => {
    const settings = normalizeMaruSettings({
      ai: {
        defaultRuntime: "codex",
        classifierRuntime: "claude",
        permissionMode: "acceptEdits",
        commandOverrides: { claude: "  /bin/claude  ", codex: "" },
        providers: { custom: 1 },
      },
    });
    expect(settings.ai.defaultRuntime).toBe("codex");
    expect(settings.ai.classifierRuntime).toBe("claude");
    expect(settings.ai.permissionMode).toBe("acceptEdits");
    expect(settings.ai.commandOverrides).toEqual({ claude: "/bin/claude", codex: null });
    // unmodeled keys are preserved round-trip-safe under extra
    expect(settings.ai.extra.providers).toEqual({ custom: 1 });
    expect(resolveClassifierRuntime(settings.ai)).toBe("claude");
  });

  it("falls back to AI defaults on invalid values", () => {
    const settings = normalizeMaruSettings({
      ai: { defaultRuntime: "gpt", permissionMode: "nope", classifierRuntime: 7 },
    });
    expect(settings.ai.defaultRuntime).toBe("claude");
    expect(settings.ai.permissionMode).toBe("plan");
    expect(settings.ai.classifierRuntime).toBe("inherit");
    expect(resolveClassifierRuntime(settings.ai)).toBe("claude");
  });

  it("round-trips AI settings through serialize/normalize without data loss", () => {
    const custom = normalizeMaruSettings({
      ai: {
        defaultRuntime: "codex",
        classifierRuntime: "inherit",
        permissionMode: "bypassPermissions",
        commandOverrides: { claude: "/usr/bin/claude", codex: null },
        legacyFlag: true,
      },
    });
    const round = normalizeMaruSettings(serializeMaruSettings(custom));
    expect(round.ai).toEqual(custom.ai);
    expect(round.ai.extra.legacyFlag).toBe(true);
  });

  it("normalizes terminal reliability settings", () => {
    const settings = normalizeMaruSettings({
      terminal: {
        copyOnSelect: true,
        shortcuts: {
          paste: "mod+shift+v",
          find: null,
          copy: "bogus",
        },
      },
    });

    expect(settings.terminal.copyOnSelect).toBe(true);
    expect(settings.terminal.shortcuts.paste).toBe("mod+shift+v");
    expect(settings.terminal.shortcuts.find).toBeNull();
    expect(settings.terminal.shortcuts.copy).toBe("mod+c");

    const round = normalizeMaruSettings(serializeMaruSettings(settings));
    expect(round.terminal.copyOnSelect).toBe(true);
    expect(round.terminal.shortcuts).toEqual(settings.terminal.shortcuts);
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

    const settings = normalizeMaruSettings({
      ui: {
        binaryFileIncludePatterns: "# docs\n*.docx\n\n*.pptx",
      },
    });
    expect(settings.ui.binaryFileIncludePatterns).toEqual(["*.docx", "*.pptx"]);
  });
});
