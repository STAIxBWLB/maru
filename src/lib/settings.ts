export type DocumentBrowserMode = "list" | "tree";
export type DocumentLabelMode = "title" | "filename";
export type ExplorerPaneMode = "documents" | "files";
export type WorkspaceFileFilter = "all" | "tracked" | "binary";
export type FileQueueDefaultOperation = "copy" | "move";
export type TerminalLauncherId = "claude" | "codex" | "shell";
export type ThemeMode = "system" | "light" | "dark";
export type AnchorAppMode = "pkm" | "inbox" | "comms";
export type WorkspaceVisibilitySetting = "private" | "public";
export type EditorViewModeSetting = "rich" | "source" | "preview";
export type RightPaneTab = "outline" | "files" | "memo" | "info" | "skills";

export interface DocumentViewDefinition {
  id: string;
  label: string;
  color: string;
  type?: string | null;
  status?: string | null;
  pathPrefix?: string | null;
  query?: string | null;
}

export const DEFAULT_BINARY_FILE_INCLUDE_PATTERNS = [
  "*.tgz",
  "*.gz",
  "*.zst",
  "*.ogg",
  "*.mp3",
  "*.wav",
  "*.flac",
  "*.mp4",
  "*.avi",
  "*.mov",
  "*.mkv",
  "*.srt",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.heic",
  "*.ai",
  "*.key",
  "*.pdf",
  "*.hwp*",
  "*.doc",
  "*.docx",
  "*.ppt",
  "*.pptx",
  "*.ppsx",
  "*.pps",
  "*.xls*",
  "*.xlsx",
  "*.xlsm",
  "*.tsv",
  "*.html",
] as const;

export interface WindowBoundsSettings {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutSettings {
  documentTypesPaneOpen: boolean;
  documentsPaneOpen: boolean;
  documentsPaneWidth: number;
  outlineOpen: boolean;
  outlinePaneWidth: number;
  terminalOpen: boolean;
  terminalHeight: number;
  terminalMaximized: boolean;
  editorSplitOpen: boolean;
  editorSplitRatio: number;
  terminalSplitOpen: boolean;
  terminalSplitRatio: number;
  windowBounds?: WindowBoundsSettings | null;
  windowMaximized?: boolean | null;
}

export interface TerminalLauncherSettings {
  enabled: boolean;
  label: string;
  command?: string | null;
  args?: string[];
}

export interface AnchorSettings {
  version: 1;
  ui: {
    activeAppMode: AnchorAppMode;
    activeWorkspaceVisibility: WorkspaceVisibilitySetting;
    editorViewMode: EditorViewModeSetting;
    rightPaneTab: RightPaneTab;
    explorerPaneMode: ExplorerPaneMode;
    documentBrowserMode: DocumentBrowserMode;
    documentLabelMode: DocumentLabelMode;
    workspaceFileFilter: WorkspaceFileFilter;
    binaryFileIncludePatterns: string[];
    documentViews: DocumentViewDefinition[];
    collapsedTreeFolders: string[];
    collapsedFileFolders: string[];
    documentTreeStateInitialized: boolean;
    fileTreeStateInitialized: boolean;
    fileQueueDefaultOperation: FileQueueDefaultOperation;
    themeMode: ThemeMode;
    accentColor: string;
    layout: LayoutSettings;
  };
  scan: {
    includeDotFolders: string[];
  };
  terminal: {
    defaultPanelOpen: boolean;
    lastHeight: number;
    autoLaunch: TerminalLauncherId | null;
    launchers: Record<TerminalLauncherId, TerminalLauncherSettings>;
  };
  ai: Record<string, unknown>;
  comms: CommsSettings;
  inboxChannels: Record<string, unknown>;
  connectors: Record<string, unknown>;
}

export interface CommsSettings {
  outlook: {
    enabled: boolean;
    maxResults: number;
    m365Path: string | null;
  };
  telegram: {
    enabled: boolean;
    polling: boolean;
    intervalSeconds: number;
    maxResults: number;
    pythonPath: string | null;
    scriptPath: string | null;
    sessionFile: string | null;
    legacyAutoDrop: boolean;
  };
}

export const DEFAULT_ANCHOR_SETTINGS: AnchorSettings = {
  version: 1,
  ui: {
    activeAppMode: "pkm",
    activeWorkspaceVisibility: "private",
    editorViewMode: "source",
    rightPaneTab: "outline",
    explorerPaneMode: "documents",
    documentBrowserMode: "tree",
    documentLabelMode: "title",
    workspaceFileFilter: "all",
    binaryFileIncludePatterns: [...DEFAULT_BINARY_FILE_INCLUDE_PATTERNS],
    documentViews: [],
    collapsedTreeFolders: [],
    collapsedFileFolders: [],
    documentTreeStateInitialized: false,
    fileTreeStateInitialized: false,
    fileQueueDefaultOperation: "copy",
    themeMode: "system",
    accentColor: "#2f5a3c",
    layout: {
      documentTypesPaneOpen: true,
      documentsPaneOpen: true,
      documentsPaneWidth: 340,
      outlineOpen: true,
      outlinePaneWidth: 280,
      terminalOpen: false,
      terminalHeight: 260,
      terminalMaximized: false,
      editorSplitOpen: false,
      editorSplitRatio: 0.5,
      terminalSplitOpen: false,
      terminalSplitRatio: 0.5,
      windowBounds: null,
      windowMaximized: null,
    },
  },
  scan: {
    includeDotFolders: [],
  },
  terminal: {
    defaultPanelOpen: false,
    lastHeight: 260,
    autoLaunch: "shell",
    launchers: {
      claude: {
        enabled: true,
        label: "Claude Code",
      },
      codex: {
        enabled: true,
        label: "Codex",
      },
      shell: {
        enabled: true,
        label: "Shell",
      },
    },
  },
  ai: {
    providers: {},
    defaults: {},
  },
  comms: {
    outlook: {
      enabled: true,
      maxResults: 50,
      m365Path: null,
    },
    telegram: {
      enabled: true,
      polling: false,
      intervalSeconds: 60,
      maxResults: 50,
      pythonPath: null,
      scriptPath: null,
      sessionFile: null,
      legacyAutoDrop: false,
    },
  },
  inboxChannels: {},
  connectors: {},
};

export function normalizeAnchorSettings(value: unknown): AnchorSettings {
  if (!isRecord(value)) return cloneDefaultSettings();
  const ui = isRecord(value.ui) ? value.ui : {};
  const terminal = isRecord(value.terminal) ? value.terminal : {};
  const launchers = isRecord(terminal.launchers) ? terminal.launchers : {};
  const legacyAi = isRecord(value.ai) ? value.ai : {};
  const legacyRuntimes = isRecord(legacyAi.runtimes) ? legacyAi.runtimes : {};
  const layout = normalizeLayout(ui.layout, terminal);

  return {
    version: 1,
    ui: {
      activeAppMode: parseAnchorAppMode(ui.activeAppMode) ?? "pkm",
      activeWorkspaceVisibility:
        parseWorkspaceVisibilitySetting(ui.activeWorkspaceVisibility) ?? "private",
      editorViewMode: parseEditorViewModeSetting(ui.editorViewMode) ?? "source",
      rightPaneTab: parseRightPaneTab(ui.rightPaneTab) ?? "outline",
      explorerPaneMode: parseExplorerPaneMode(ui.explorerPaneMode) ?? "documents",
      documentBrowserMode: parseBrowserMode(ui.documentBrowserMode) ?? "tree",
      documentLabelMode: parseDocumentLabelMode(ui.documentLabelMode) ?? "title",
      workspaceFileFilter: parseWorkspaceFileFilter(ui.workspaceFileFilter) ?? "all",
      binaryFileIncludePatterns: normalizeBinaryFileIncludePatterns(
        ui.binaryFileIncludePatterns,
      ),
      documentViews: normalizeDocumentViews(ui.documentViews),
      collapsedTreeFolders: parseStringArray(ui.collapsedTreeFolders),
      collapsedFileFolders: parseStringArray(ui.collapsedFileFolders),
      documentTreeStateInitialized: typeof ui.documentTreeStateInitialized === "boolean"
        ? ui.documentTreeStateInitialized
        : false,
      fileTreeStateInitialized: typeof ui.fileTreeStateInitialized === "boolean"
        ? ui.fileTreeStateInitialized
        : false,
      fileQueueDefaultOperation:
        parseFileQueueDefaultOperation(ui.fileQueueDefaultOperation) ?? "copy",
      themeMode: parseThemeMode(ui.themeMode) ?? DEFAULT_ANCHOR_SETTINGS.ui.themeMode,
      accentColor: normalizeHexColor(ui.accentColor, DEFAULT_ANCHOR_SETTINGS.ui.accentColor),
      layout,
    },
    scan: {
      includeDotFolders: normalizeDotFolderIncludes(value.scan),
    },
    terminal: {
      defaultPanelOpen: layout.terminalOpen,
      lastHeight: layout.terminalHeight,
      autoLaunch: parseAutoLaunch(terminal.autoLaunch),
      launchers: {
        claude: normalizeLauncher(
          launchers.claude ?? legacyRuntimes["claude-code"],
          DEFAULT_ANCHOR_SETTINGS.terminal.launchers.claude,
        ),
        codex: normalizeLauncher(
          launchers.codex ?? legacyRuntimes.codex,
          DEFAULT_ANCHOR_SETTINGS.terminal.launchers.codex,
        ),
        shell: normalizeLauncher(
          launchers.shell,
          DEFAULT_ANCHOR_SETTINGS.terminal.launchers.shell,
        ),
      },
    },
    ai: normalizeFutureAi(value.ai),
    comms: normalizeCommsSettings(value.comms),
    inboxChannels: isRecord(value.inboxChannels) ? value.inboxChannels : {},
    connectors: isRecord(value.connectors) ? value.connectors : {},
  };
}

export function serializeAnchorSettings(settings: AnchorSettings): unknown {
  return normalizeAnchorSettings(settings);
}

export function applyWorkspaceCommsOverrides(
  settings: CommsSettings,
  workspaceConfig: { io?: unknown } | null,
): CommsSettings {
  const io = isRecord(workspaceConfig?.io) ? workspaceConfig.io : null;
  const providers = isRecord(io?.providers) ? io.providers : null;
  if (!providers) return settings;
  const outlook = providerConfig(providers, "outlook", "mso");
  const telegram = providerConfig(providers, "telegram");
  return {
    outlook: {
      ...settings.outlook,
      enabled: readBoolean(outlook, ["enabled"], settings.outlook.enabled),
      maxResults: readInteger(
        outlook,
        ["maxResults", "max_results", "limit"],
        settings.outlook.maxResults,
        1,
        200,
      ),
      m365Path: readOptionalString(
        outlook,
        ["m365Path", "m365_path", "cliPath", "cli_path"],
        settings.outlook.m365Path,
      ),
    },
    telegram: {
      ...settings.telegram,
      enabled: readBoolean(telegram, ["enabled"], settings.telegram.enabled),
      polling: readBoolean(telegram, ["polling"], settings.telegram.polling),
      intervalSeconds: readInteger(
        telegram,
        ["intervalSeconds", "interval_seconds", "pollSeconds", "poll_seconds"],
        settings.telegram.intervalSeconds,
        30,
        3600,
      ),
      maxResults: readInteger(
        telegram,
        ["maxResults", "max_results", "limit"],
        settings.telegram.maxResults,
        1,
        200,
      ),
      pythonPath: readOptionalString(
        telegram,
        ["pythonPath", "python_path"],
        settings.telegram.pythonPath,
      ),
      scriptPath: readOptionalString(
        telegram,
        ["scriptPath", "script_path"],
        settings.telegram.scriptPath,
      ),
      sessionFile: readOptionalString(
        telegram,
        ["sessionFile", "session_file"],
        settings.telegram.sessionFile,
      ),
      legacyAutoDrop: readBoolean(
        telegram,
        ["legacyAutoDrop", "legacy_auto_drop"],
        settings.telegram.legacyAutoDrop,
      ),
    },
  };
}

function cloneDefaultSettings(): AnchorSettings {
  return {
    ...DEFAULT_ANCHOR_SETTINGS,
    ui: {
      ...DEFAULT_ANCHOR_SETTINGS.ui,
      binaryFileIncludePatterns: [
        ...DEFAULT_ANCHOR_SETTINGS.ui.binaryFileIncludePatterns,
      ],
      documentViews: DEFAULT_ANCHOR_SETTINGS.ui.documentViews.map((view) => ({ ...view })),
      collapsedTreeFolders: [...DEFAULT_ANCHOR_SETTINGS.ui.collapsedTreeFolders],
      collapsedFileFolders: [...DEFAULT_ANCHOR_SETTINGS.ui.collapsedFileFolders],
      documentTreeStateInitialized: DEFAULT_ANCHOR_SETTINGS.ui.documentTreeStateInitialized,
      fileTreeStateInitialized: DEFAULT_ANCHOR_SETTINGS.ui.fileTreeStateInitialized,
      layout: { ...DEFAULT_ANCHOR_SETTINGS.ui.layout },
    },
    scan: {
      includeDotFolders: [...DEFAULT_ANCHOR_SETTINGS.scan.includeDotFolders],
    },
    terminal: {
      ...DEFAULT_ANCHOR_SETTINGS.terminal,
      launchers: {
        claude: { ...DEFAULT_ANCHOR_SETTINGS.terminal.launchers.claude },
        codex: { ...DEFAULT_ANCHOR_SETTINGS.terminal.launchers.codex },
        shell: { ...DEFAULT_ANCHOR_SETTINGS.terminal.launchers.shell },
      },
    },
    ai: {
      providers: {},
      defaults: {},
    },
    comms: {
      outlook: { ...DEFAULT_ANCHOR_SETTINGS.comms.outlook },
      telegram: { ...DEFAULT_ANCHOR_SETTINGS.comms.telegram },
    },
    inboxChannels: {},
    connectors: {},
  };
}

function normalizeCommsSettings(value: unknown): CommsSettings {
  const comms = isRecord(value) ? value : {};
  const outlook = isRecord(comms.outlook) ? comms.outlook : {};
  const telegram = isRecord(comms.telegram) ? comms.telegram : {};
  return {
    outlook: {
      enabled: typeof outlook.enabled === "boolean"
        ? outlook.enabled
        : DEFAULT_ANCHOR_SETTINGS.comms.outlook.enabled,
      maxResults: normalizeInteger(
        outlook.maxResults,
        DEFAULT_ANCHOR_SETTINGS.comms.outlook.maxResults,
        1,
        200,
      ),
      m365Path: normalizeOptionalString(outlook.m365Path),
    },
    telegram: {
      enabled: typeof telegram.enabled === "boolean"
        ? telegram.enabled
        : DEFAULT_ANCHOR_SETTINGS.comms.telegram.enabled,
      polling: typeof telegram.polling === "boolean"
        ? telegram.polling
        : DEFAULT_ANCHOR_SETTINGS.comms.telegram.polling,
      intervalSeconds: normalizeInteger(
        telegram.intervalSeconds,
        DEFAULT_ANCHOR_SETTINGS.comms.telegram.intervalSeconds,
        30,
        86400,
      ),
      maxResults: normalizeInteger(
        telegram.maxResults,
        DEFAULT_ANCHOR_SETTINGS.comms.telegram.maxResults,
        1,
        200,
      ),
      pythonPath: normalizeOptionalString(telegram.pythonPath),
      scriptPath: normalizeOptionalString(telegram.scriptPath),
      sessionFile: normalizeOptionalString(telegram.sessionFile),
      legacyAutoDrop: typeof telegram.legacyAutoDrop === "boolean"
        ? telegram.legacyAutoDrop
        : DEFAULT_ANCHOR_SETTINGS.comms.telegram.legacyAutoDrop,
    },
  };
}

function providerConfig(
  providers: Record<string, unknown>,
  ...names: string[]
): Record<string, unknown> | null {
  for (const name of names) {
    const value = providers[name];
    if (isRecord(value)) return value;
  }
  return null;
}

function readBoolean(
  record: Record<string, unknown> | null,
  keys: string[],
  fallback: boolean,
): boolean {
  const value = readKey(record, keys);
  return typeof value === "boolean" ? value : fallback;
}

function readInteger(
  record: Record<string, unknown> | null,
  keys: string[],
  fallback: number,
  min: number,
  max: number,
): number {
  return normalizeInteger(readKey(record, keys), fallback, min, max);
}

function readOptionalString(
  record: Record<string, unknown> | null,
  keys: string[],
  fallback: string | null,
): string | null {
  const value = readKey(record, keys);
  return value === undefined ? fallback : normalizeOptionalString(value);
}

function readKey(record: Record<string, unknown> | null, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeLauncher(
  value: unknown,
  fallback: TerminalLauncherSettings,
): TerminalLauncherSettings {
  if (!isRecord(value)) return { ...fallback };
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : fallback.enabled,
    label: typeof value.label === "string" && value.label.trim() ? value.label : fallback.label,
    command: typeof value.command === "string" ? value.command : null,
    args: parseStringArray(value.args),
  };
}

function parseBrowserMode(value: unknown): DocumentBrowserMode | null {
  return value === "list" || value === "tree" ? value : null;
}

function parseAnchorAppMode(value: unknown): AnchorAppMode | null {
  return value === "pkm" || value === "inbox" || value === "comms" ? value : null;
}

function parseWorkspaceVisibilitySetting(value: unknown): WorkspaceVisibilitySetting | null {
  return value === "private" || value === "public" ? value : null;
}

function parseEditorViewModeSetting(value: unknown): EditorViewModeSetting | null {
  return value === "rich" || value === "source" || value === "preview" ? value : null;
}

function parseRightPaneTab(value: unknown): RightPaneTab | null {
  return value === "outline" || value === "files" || value === "memo" || value === "info"
    || value === "skills"
    ? value
    : null;
}

function parseExplorerPaneMode(value: unknown): ExplorerPaneMode | null {
  return value === "documents" || value === "files" ? value : null;
}

function parseDocumentLabelMode(value: unknown): DocumentLabelMode | null {
  return value === "title" || value === "filename" ? value : null;
}

function parseWorkspaceFileFilter(value: unknown): WorkspaceFileFilter | null {
  return value === "all" || value === "tracked" || value === "binary" ? value : null;
}

function parseFileQueueDefaultOperation(value: unknown): FileQueueDefaultOperation | null {
  return value === "copy" || value === "move" ? value : null;
}

function parseThemeMode(value: unknown): ThemeMode | null {
  return value === "system" || value === "light" || value === "dark" ? value : null;
}

function parseAutoLaunch(value: unknown): TerminalLauncherId | null {
  if (value === null) return null;
  return value === "claude" || value === "codex" || value === "shell"
    ? value
    : DEFAULT_ANCHOR_SETTINGS.terminal.autoLaunch;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function normalizeDotFolderIncludes(value: unknown): string[] {
  const source = isRecord(value) ? value.includeDotFolders : value;
  const includes: string[] = [];
  const seen = new Set<string>();
  for (const item of parseStringArray(source)) {
    const normalized = item.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!normalized || normalized.includes("..") || /[*?]/.test(normalized)) continue;
    const segments = normalized.split("/").filter(Boolean);
    if (!segments.some((segment) => segment.startsWith("."))) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    includes.push(normalized);
  }
  return includes;
}

export function formatBinaryFileIncludePatterns(patterns: readonly string[]): string {
  return patterns.join("\n");
}

export function parseBinaryFileIncludePatternsText(text: string): string[] {
  return normalizePatternList(text.split(/\r?\n/), []);
}

function normalizeBinaryFileIncludePatterns(value: unknown): string[] {
  if (typeof value === "undefined" || value === null) {
    return [...DEFAULT_BINARY_FILE_INCLUDE_PATTERNS];
  }
  if (typeof value === "string") {
    return normalizePatternList(value.split(/\r?\n/), []);
  }
  if (Array.isArray(value)) {
    return normalizePatternList(value, []);
  }
  return [...DEFAULT_BINARY_FILE_INCLUDE_PATTERNS];
}

function normalizeDocumentViews(value: unknown): DocumentViewDefinition[] {
  if (!Array.isArray(value)) return [];
  const views: DocumentViewDefinition[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = normalizeViewToken(item.id);
    const label =
      typeof item.label === "string" && item.label.trim() ? item.label.trim() : null;
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    const color = normalizeHexColor(item.color, "#8f4a80");
    const view: DocumentViewDefinition = { id, label, color };
    const type = normalizeOptionalText(item.type);
    const status = normalizeOptionalText(item.status);
    const pathPrefix = normalizePathPrefix(item.pathPrefix);
    const query = normalizeOptionalText(item.query);
    if (type) view.type = type;
    if (status) view.status = status;
    if (pathPrefix) view.pathPrefix = pathPrefix;
    if (query) view.query = query;
    if (!view.type && !view.status && !view.pathPrefix && !view.query) continue;
    views.push(view);
  }
  return views;
}

function normalizeViewToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return token || null;
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePathPrefix(value: unknown): string | null {
  const text = normalizeOptionalText(value);
  if (!text) return null;
  return text.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizePatternList(values: unknown[], fallback: readonly string[]): string[] {
  const patterns: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const pattern = value.trim().replace(/\\/g, "/");
    if (!pattern || pattern.startsWith("#")) continue;
    const key = pattern.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    patterns.push(pattern);
  }
  return patterns.length > 0 || values.length > 0 ? patterns : [...fallback];
}

function normalizeLayout(value: unknown, legacyTerminal: Record<string, unknown>): LayoutSettings {
  const layout = isRecord(value) ? value : {};
  const terminalOpen =
    typeof layout.terminalOpen === "boolean"
      ? layout.terminalOpen
      : typeof legacyTerminal.defaultPanelOpen === "boolean"
        ? legacyTerminal.defaultPanelOpen
        : DEFAULT_ANCHOR_SETTINGS.ui.layout.terminalOpen;
  const terminalHeight = normalizeTerminalHeight(
    layout.terminalHeight ?? legacyTerminal.lastHeight,
  );
  return {
    documentTypesPaneOpen:
      typeof layout.documentTypesPaneOpen === "boolean"
        ? layout.documentTypesPaneOpen
        : DEFAULT_ANCHOR_SETTINGS.ui.layout.documentTypesPaneOpen,
    documentsPaneOpen:
      typeof layout.documentsPaneOpen === "boolean"
        ? layout.documentsPaneOpen
        : DEFAULT_ANCHOR_SETTINGS.ui.layout.documentsPaneOpen,
    documentsPaneWidth: normalizePaneWidth(
      layout.documentsPaneWidth,
      DEFAULT_ANCHOR_SETTINGS.ui.layout.documentsPaneWidth,
      260,
      560,
    ),
    outlineOpen:
      typeof layout.outlineOpen === "boolean"
        ? layout.outlineOpen
        : DEFAULT_ANCHOR_SETTINGS.ui.layout.outlineOpen,
    outlinePaneWidth: normalizePaneWidth(
      layout.outlinePaneWidth,
      DEFAULT_ANCHOR_SETTINGS.ui.layout.outlinePaneWidth,
      240,
      520,
    ),
    terminalOpen,
    terminalHeight,
    terminalMaximized:
      typeof layout.terminalMaximized === "boolean"
        ? layout.terminalMaximized
        : DEFAULT_ANCHOR_SETTINGS.ui.layout.terminalMaximized,
    editorSplitOpen:
      typeof layout.editorSplitOpen === "boolean"
        ? layout.editorSplitOpen
        : DEFAULT_ANCHOR_SETTINGS.ui.layout.editorSplitOpen,
    editorSplitRatio: normalizeSplitRatio(layout.editorSplitRatio),
    terminalSplitOpen:
      typeof layout.terminalSplitOpen === "boolean"
        ? layout.terminalSplitOpen
        : DEFAULT_ANCHOR_SETTINGS.ui.layout.terminalSplitOpen,
    terminalSplitRatio: normalizeSplitRatio(layout.terminalSplitRatio),
    windowBounds: normalizeWindowBounds(layout.windowBounds),
    windowMaximized:
      typeof layout.windowMaximized === "boolean" ? layout.windowMaximized : null,
  };
}

function normalizeSplitRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(0.7, Math.max(0.3, value));
}

function normalizePaneWidth(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
}

function normalizeWindowBounds(value: unknown): WindowBoundsSettings | null {
  if (!isRecord(value)) return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  if (x == null || y == null || width == null || height == null) return null;
  if (width < 640 || height < 480) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

function normalizeTerminalHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ANCHOR_SETTINGS.terminal.lastHeight;
  }
  return Math.min(520, Math.max(160, Math.round(value)));
}

function normalizeFutureAi(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { ...DEFAULT_ANCHOR_SETTINGS.ai };
  if (isRecord(value.runtimes) || typeof value.defaultRuntime === "string") {
    return { ...DEFAULT_ANCHOR_SETTINGS.ai };
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
