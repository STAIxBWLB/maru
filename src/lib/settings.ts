export type DocumentBrowserMode = "list" | "tree";
export type DocumentLabelMode = "title" | "filename";
export type TerminalLauncherId = "claude" | "codex" | "shell";
export type ThemeMode = "system" | "light" | "dark";

export interface WindowBoundsSettings {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutSettings {
  documentTypesPaneOpen: boolean;
  documentsPaneOpen: boolean;
  outlineOpen: boolean;
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
    documentBrowserMode: DocumentBrowserMode;
    documentLabelMode: DocumentLabelMode;
    collapsedTreeFolders: string[];
    documentTreeStateInitialized: boolean;
    themeMode: ThemeMode;
    accentColor: string;
    layout: LayoutSettings;
  };
  terminal: {
    defaultPanelOpen: boolean;
    lastHeight: number;
    autoLaunch: TerminalLauncherId | null;
    launchers: Record<TerminalLauncherId, TerminalLauncherSettings>;
  };
  ai: Record<string, unknown>;
  inboxChannels: Record<string, unknown>;
  connectors: Record<string, unknown>;
}

export const DEFAULT_ANCHOR_SETTINGS: AnchorSettings = {
  version: 1,
  ui: {
    documentBrowserMode: "tree",
    documentLabelMode: "title",
    collapsedTreeFolders: [],
    documentTreeStateInitialized: false,
    themeMode: "system",
    accentColor: "#2f5a3c",
    layout: {
      documentTypesPaneOpen: true,
      documentsPaneOpen: true,
      outlineOpen: true,
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
      documentBrowserMode: parseBrowserMode(ui.documentBrowserMode) ?? "tree",
      documentLabelMode: parseDocumentLabelMode(ui.documentLabelMode) ?? "title",
      collapsedTreeFolders: parseStringArray(ui.collapsedTreeFolders),
      documentTreeStateInitialized: typeof ui.documentTreeStateInitialized === "boolean"
        ? ui.documentTreeStateInitialized
        : false,
      themeMode: parseThemeMode(ui.themeMode) ?? DEFAULT_ANCHOR_SETTINGS.ui.themeMode,
      accentColor: normalizeHexColor(ui.accentColor, DEFAULT_ANCHOR_SETTINGS.ui.accentColor),
      layout,
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
    inboxChannels: isRecord(value.inboxChannels) ? value.inboxChannels : {},
    connectors: isRecord(value.connectors) ? value.connectors : {},
  };
}

export function serializeAnchorSettings(settings: AnchorSettings): unknown {
  return normalizeAnchorSettings(settings);
}

function cloneDefaultSettings(): AnchorSettings {
  return {
    ...DEFAULT_ANCHOR_SETTINGS,
    ui: {
      ...DEFAULT_ANCHOR_SETTINGS.ui,
      collapsedTreeFolders: [...DEFAULT_ANCHOR_SETTINGS.ui.collapsedTreeFolders],
      documentTreeStateInitialized: DEFAULT_ANCHOR_SETTINGS.ui.documentTreeStateInitialized,
      layout: { ...DEFAULT_ANCHOR_SETTINGS.ui.layout },
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
    inboxChannels: {},
    connectors: {},
  };
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

function parseDocumentLabelMode(value: unknown): DocumentLabelMode | null {
  return value === "title" || value === "filename" ? value : null;
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
    outlineOpen:
      typeof layout.outlineOpen === "boolean"
        ? layout.outlineOpen
        : DEFAULT_ANCHOR_SETTINGS.ui.layout.outlineOpen,
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
