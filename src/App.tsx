import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type React from "react";
import {
  AlertTriangle,
  Clock3,
  Command,
  FileText,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCcw,
  Settings2,
  X,
} from "lucide-react";
import { AddWorkspaceDialog } from "./components/AddWorkspaceDialog";
import { CommandPalette } from "./components/CommandPalette";
import { CommitDialog } from "./components/CommitDialog";
import { DocumentList } from "./components/DocumentList";
import { EditorPane, type EditorViewMode } from "./components/EditorPane";
import { GitStatusBadge } from "./components/GitStatusBadge";
import { InboxPane } from "./components/InboxPane";
import { InboxSettingsDialog } from "./components/InboxSettingsDialog";
import { NewDocumentDialog } from "./components/NewDocumentDialog";
import { OutlinePane } from "./components/OutlinePane";
import { Sidebar } from "./components/Sidebar";
import { SystemPane } from "./components/SystemPane";
import { TerminalPanel } from "./components/TerminalPanel";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { WorkspaceFilesPane } from "./components/WorkspaceFilesPane";
import {
  applyFileQueue,
  addWorkspaceRoot,
  createDocument,
  createVersion,
  DEFAULT_INBOX_SETTINGS,
  describeFileQueueSources,
  duplicateDocument,
  fetchGmailUnread,
  getSampleVaultPath,
  gitStatus,
  listWorkspaceRoots,
  moveDocument,
  readDocument,
  revealInFileManager,
  readInboxSettings,
  readVaultCache,
  refreshWorkspaceCapabilities,
  removeWorkspaceRoot,
  saveDocument,
  saveInboxSettings,
  scanInboxDrop,
  scanWorkspaceFiles,
  scanVault,
  setActiveWorkspaceRoot,
  startInboxWatcher,
  stopInboxWatcher,
  trashDocument,
  updateFrontmatterField,
} from "./lib/api";
import {
  readAnchorSettings,
  registerWorkspaceRoots,
  saveAnchorSettings,
  listenAnchorSettingsUpdated,
  updateAnchorWorkspace,
} from "./lib/anchorDir";
import { classifyInboxItem } from "./lib/aiInvoke";
import { createDebouncedSaver, type DebouncedSaver } from "./lib/debouncedSave";
import { documentDisplayName } from "./lib/document";
import {
  replaceEditorTabIds,
  tabIdsToCloseOthers,
  tabIdsToCloseRight,
  tabIdsToCloseSaved,
} from "./lib/editorTabActions";
import {
  buildDocumentIndex,
  getRecentEntries,
  type DocumentIndex,
} from "./lib/documentIndex";
import { buildGmailMessageStates, type GmailMessageState } from "./lib/gmail";
import { LocaleContext, assertParityOrThrow, useLocaleState } from "./lib/i18n";
import { listenForMenuCommand } from "./lib/menu";
import {
  buildInboxItemStates,
  type InboxDecision,
  type InboxItemState,
} from "./lib/inbox";
import { useKeyboardShortcuts } from "./lib/useKeyboardShortcuts";
import type { TerminalKind } from "./lib/terminal";
import {
  checkAppUpdate,
  installAppUpdate,
  listenForCheckUpdatesMenu,
  relaunchApp,
  updaterAvailable,
  type AppUpdateCheckResult,
  type AppUpdateInfo,
  type AppUpdateProgress,
} from "./lib/updater";
import type {
  DocumentPayload,
  FileQueueApplyOutcome,
  FileQueueItem,
  FileQueueSourceInfo,
  FileStoreOperation,
  GitStatus,
  GmailMessage,
  InboxClassification,
  InboxDropItem,
  InboxSettings,
  VaultEntry,
  WorkspaceFileEntry,
  WorkspaceRegistry,
  WorkspaceRootEntry,
  WorkspaceVisibility,
} from "./lib/types";
import {
  isSameParentMove,
  targetDirForDropTarget,
  type ExplorerDragItem,
  type ExplorerDragPayload,
} from "./lib/fileDrag";
import {
  DEFAULT_ANCHOR_SETTINGS,
  normalizeAnchorSettings,
  type AnchorSettings,
  type AnchorAppMode,
  type DocumentBrowserMode,
  type EditorViewModeSetting,
  type ExplorerPaneMode,
  type RightPaneTab,
  type WorkspaceFileFilter,
  type WorkspaceVisibilitySetting,
} from "./lib/settings";
import { applyThemePreference, applyThemeVars, buildThemeVars } from "./lib/theme";
import {
  openSettingsWindow,
  restoreMainWindowLayout,
  startWindowDrag,
  subscribeMainWindowLayout,
} from "./lib/windowLayout";
import { resolveWikilinkTarget } from "./lib/wikilinkSuggestions";
import {
  mergeFreshEntry,
  planVaultStartup,
  shouldLazyScanWorkspaceFiles,
} from "./lib/vaultStartup";
import {
  providerLabel,
  workspaceCan,
  workspaceCapabilities,
  workspaceWriteReason,
  workspaceWriteStatus,
} from "./lib/workspaceCapabilities";
import {
  expandDocumentAncestors,
} from "./lib/documentTree";
import {
  expandWorkspaceFileAncestors,
  isOpenableDocumentFile,
} from "./lib/workspaceFileTree";
import {
  emptyHistory,
  goBack,
  goForward,
  pushHistory,
  type NavHistory,
} from "./lib/neighborhoodHistory";

const LAST_OPEN_KEY = "anchor:lastOpenedNote:v1";
const OPEN_TABS_KEY = "anchor:openTabs:v1";
const RECENT_KEY = "anchor:recent:v1";
const MIN_DOCUMENTS_PANE_WIDTH = 260;
const MAX_DOCUMENTS_PANE_WIDTH = 560;
const MIN_OUTLINE_PANE_WIDTH = 240;
const MAX_OUTLINE_PANE_WIDTH = 520;

type PendingExplorerReveal = {
  pane: ExplorerPaneMode;
  targetPath: string;
};

assertParityOrThrow();

interface EditorTab {
  id: string;
  workspacePath: string;
  visibility: WorkspaceVisibility;
  entry: VaultEntry;
  document: DocumentPayload;
  draftContent: string;
}

interface StoredTabs {
  activeRelPath: string | null;
  leftRelPath: string | null;
  rightRelPath: string | null;
  focusedGroup: EditorGroupId;
  relPaths: string[];
}

type EditorGroupId = "left" | "right";

interface WorkspaceEntriesState {
  entries: VaultEntry[];
  loading: boolean;
  refreshing: boolean;
  startupIoReady: boolean;
}

const EMPTY_WORKSPACE_STATE: WorkspaceEntriesState = {
  entries: [],
  loading: false,
  refreshing: false,
  startupIoReady: false,
};

interface WorkspaceFilesState {
  entries: WorkspaceFileEntry[];
  loading: boolean;
  refreshing: boolean;
}

const EMPTY_WORKSPACE_FILES_STATE: WorkspaceFilesState = {
  entries: [],
  loading: false,
  refreshing: false,
};

type AppMode = AnchorAppMode;

interface InboxCarry {
  decision: InboxDecision;
  classification: InboxClassification | null;
  classifying: boolean;
  classifyError: string | null;
}

type UpdateToast =
  | { kind: "checking" }
  | { kind: "available"; info: AppUpdateInfo }
  | { kind: "notAvailable" }
  | { kind: "downloading"; info: AppUpdateInfo; progress: AppUpdateProgress | null }
  | { kind: "ready"; info: AppUpdateInfo }
  | { kind: "error"; message: string };

function tabIdForEntry(entry: VaultEntry): string {
  return entry.path;
}

function titleFromWikilinkTarget(target: string): string {
  const cleaned = target.trim().replace(/\.(md|markdown)$/i, "");
  const leaf = cleaned.split("/").filter(Boolean).pop();
  return leaf ?? cleaned;
}

function visibilityAvailable(
  registry: WorkspaceRegistry,
  visibility: WorkspaceVisibilitySetting,
): boolean {
  return Boolean(
    registry.activeByVisibility[visibility] ??
      registry.workspaces.find((workspace) => workspace.visibility === visibility),
  );
}

function defaultStartupVisibility(registry: WorkspaceRegistry): WorkspaceVisibility {
  return registry.activeByVisibility.private ||
    registry.workspaces.some((workspace) => workspace.visibility === "private")
    ? "private"
    : "public";
}

function startupSettingsPath(registry: WorkspaceRegistry): string | null {
  return (
    registry.activeByVisibility.private ??
    registry.workspaces.find((workspace) => workspace.visibility === "private")?.path ??
    registry.activeByVisibility.public ??
    registry.workspaces.find((workspace) => workspace.visibility === "public")?.path ??
    null
  );
}

function initialStartupVisibility(
  registry: WorkspaceRegistry,
  settings: AnchorSettings | null,
): WorkspaceVisibility {
  const preferred = settings?.ui.activeWorkspaceVisibility;
  if (preferred && visibilityAvailable(registry, preferred)) return preferred;
  return defaultStartupVisibility(registry);
}

function fileQueueItemFromSource(
  source: FileQueueSourceInfo,
  targetDir: string,
  operation: FileStoreOperation,
  seed: number,
  index: number,
): FileQueueItem {
  return {
    id: `${seed}-${index}-${source.sourceKind}-${source.path}`,
    sourcePath: source.path,
    sourceKind: source.sourceKind,
    sourceRelPath: source.sourceRelPath,
    targetDir,
    operation,
    fileName: source.fileName,
    status: "queued",
    targetPath: null,
    message: null,
  };
}

function sourcesFromExplorerPayload(payload: ExplorerDragPayload): FileQueueSourceInfo[] {
  return payload.items.map((item) => ({
    path: item.path,
    sourceRelPath: item.relPath,
    fileName: item.fileName,
    sourceKind: item.sourceKind,
  }));
}

function dragItemContainsPath(item: ExplorerDragItem, path: string): boolean {
  return item.sourceKind === "directory" ? path.startsWith(`${item.path}/`) : item.path === path;
}

function workspaceForTargetPath(
  workspaces: WorkspaceRootEntry[],
  targetPath: string,
): WorkspaceRootEntry | null {
  return (
    workspaces
      .filter(
        (workspace) =>
          targetPath === workspace.path || targetPath.startsWith(`${workspace.path}/`),
      )
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null
  );
}

function relativePathForWorkspace(workspacePath: string, targetPath: string): string {
  return targetPath.startsWith(`${workspacePath}/`)
    ? targetPath.slice(workspacePath.length + 1)
    : targetPath;
}

export default function App() {
  useSuppressNativeContextMenu();
  const params =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  if (params?.get("window") === "settings") {
    return <SettingsWindowRoot workPath={params.get("workPath")} />;
  }
  return <MainApp />;
}

function useSuppressNativeContextMenu() {
  useEffect(() => {
    const suppressUnhandledContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest(".editor-pane")) return;
      event.preventDefault();
    };
    window.document.addEventListener("contextmenu", suppressUnhandledContextMenu);
    return () => {
      window.document.removeEventListener("contextmenu", suppressUnhandledContextMenu);
    };
  }, []);
}

function SettingsWindowRoot({ workPath }: { workPath: string | null }) {
  const localeValue = useLocaleState();
  const { t } = localeValue;
  const [settings, setSettings] = useState<AnchorSettings>(() =>
    normalizeAnchorSettings(DEFAULT_ANCHOR_SETTINGS),
  );
  const [error, setError] = useState<string | null>(null);
  const themeVars = useMemo(() => buildThemeVars(settings), [settings]);

  useEffect(() => {
    applyThemePreference(settings.ui.themeMode);
    applyThemeVars(themeVars);
  }, [settings.ui.themeMode, themeVars]);

  useEffect(() => {
    let cancelled = false;
    if (!workPath) {
      setSettings(normalizeAnchorSettings(DEFAULT_ANCHOR_SETTINGS));
      return;
    }
    void readAnchorSettings(workPath)
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [workPath]);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    void listenAnchorSettingsUpdated((payload) => {
      if (payload.workPath === workPath) {
        setSettings(normalizeAnchorSettings(payload.settings));
      } else if (payload.globalChanged && workPath) {
        void readAnchorSettings(workPath)
          .then((next) => setSettings(next))
          .catch((err) => setError(err instanceof Error ? err.message : String(err)));
      }
    }).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
  }, [workPath]);

  const updateSettings = useCallback(
    (nextSettings: AnchorSettings) => {
      const normalized = normalizeAnchorSettings(nextSettings);
      setSettings((current) => {
        if (workPath) {
          void saveAnchorSettings(workPath, normalized, current).catch((err) => {
            setError(err instanceof Error ? err.message : String(err));
          });
        }
        return normalized;
      });
    },
    [workPath],
  );

  return (
    <LocaleContext.Provider value={localeValue}>
      <div className="settings-window-shell" style={themeVars}>
        <SystemPane
          workPath={workPath}
          settings={settings}
          onSettingsChange={updateSettings}
        />
        {error ? (
          <div className="toast-stack">
            <div className="toast" title={error}>
              <AlertTriangle size={15} />
              <span>{error}</span>
              <button
                type="button"
                className="icon-button"
                onClick={() => setError(null)}
                aria-label={t("app.errorClose")}
                title={t("app.errorClose")}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </LocaleContext.Provider>
  );
}

function clampPaneWidth(value: number, min: number, max: number): number {
  const upper = Math.max(min, max);
  return Math.round(Math.min(upper, Math.max(min, value)));
}

function MainApp() {
  const localeValue = useLocaleState();
  const { t, locale, setLocale } = localeValue;

  const [workspaceRegistry, setWorkspaceRegistry] = useState<WorkspaceRegistry>({
    workspaces: [],
    activeByVisibility: {
      private: null,
      public: null,
    },
    hiddenDefaults: [],
  });
  const [workspaceStates, setWorkspaceStates] = useState<Record<string, WorkspaceEntriesState>>({});
  const [workspaceFileStates, setWorkspaceFileStates] = useState<Record<string, WorkspaceFilesState>>({});
  const [explorerVisibility, setExplorerVisibility] =
    useState<WorkspaceVisibility>("private");
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [leftActiveTabId, setLeftActiveTabId] = useState<string | null>(null);
  const [rightActiveTabId, setRightActiveTabId] = useState<string | null>(null);
  const [focusedEditorGroup, setFocusedEditorGroup] = useState<EditorGroupId>("left");
  const [queryByVisibility, setQueryByVisibility] = useState<Record<WorkspaceVisibility, string>>({
    private: "",
    public: "",
  });
  const [fileQueryByVisibility, setFileQueryByVisibility] = useState<
    Record<WorkspaceVisibility, string>
  >({
    private: "",
    public: "",
  });
  const [typeFilterByVisibility, setTypeFilterByVisibility] = useState<
    Record<WorkspaceVisibility, string | null>
  >({
    private: null,
    public: null,
  });
  const [collapsedTreeFoldersByVisibility, setCollapsedTreeFoldersByVisibility] = useState<
    Record<WorkspaceVisibility, string[]>
  >({
    private: [],
    public: [],
  });
  const [collapsedFileFoldersByVisibility, setCollapsedFileFoldersByVisibility] = useState<
    Record<WorkspaceVisibility, string[]>
  >({
    private: [],
    public: [],
  });
  const [selectedFilePathsByWorkspace, setSelectedFilePathsByWorkspace] = useState<
    Record<string, string[]>
  >({});
  const [fileQueue, setFileQueue] = useState<FileQueueItem[]>([]);
  const [selectedFileQueueItemIds, setSelectedFileQueueItemIds] = useState<string[]>([]);
  const [pendingExplorerReveal, setPendingExplorerReveal] = useState<PendingExplorerReveal | null>(
    null,
  );
  const [booting, setBooting] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [newDocumentSeed, setNewDocumentSeed] = useState<{
    title: string;
    relPath: string | null;
  } | null>(null);
  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [addWorkspaceDefaultVisibility, setAddWorkspaceDefaultVisibility] =
    useState<WorkspaceVisibility>("private");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [editorViewMode, setEditorViewMode] = useState<EditorViewMode>(
    DEFAULT_ANCHOR_SETTINGS.ui.editorViewMode,
  );
  const [rightPaneTab, setRightPaneTab] = useState<RightPaneTab>(
    DEFAULT_ANCHOR_SETTINGS.ui.rightPaneTab,
  );
  const [pendingSelectedPath, setPendingSelectedPath] = useState<string | null>(null);
  const [recentPaths, setRecentPaths] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(RECENT_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });

  const searchInputRef = useRef<HTMLInputElement>(null);
  const appShellRef = useRef<HTMLDivElement>(null);
  const documentsPaneRef = useRef<HTMLElement>(null);
  const outlinePaneRef = useRef<HTMLElement>(null);
  const editorSplitShellRef = useRef<HTMLDivElement>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const rightEditorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsSaverRef = useRef<DebouncedSaver<AnchorSettings> | null>(null);
  const settingsSaveBaseRef = useRef<AnchorSettings | null>(null);
  const pendingUpdateRef = useRef<AppUpdateCheckResult["update"] | null>(null);
  const installingUpdateRef = useRef(false);
  const collapsedTreeHydratedRef = useRef(false);
  const collapsedFileHydratedRef = useRef(false);

  // Monotonic counter so a slow readDocument from an earlier click cannot
  // overwrite the editor with stale content if the user clicked a later
  // entry in the meantime. Only the latest call wins.
  const selectRequestRef = useRef(0);
  const loadWorkspaceRequestRef = useRef(0);
  // Holds the discarded draft + entry when the user switches away from a
  // dirty document. Surfaces a "Restore" toast button — non-blocking
  // alternative to window.confirm (which Tauri webview suppresses).
  const [discardedEdit, setDiscardedEdit] = useState<
    {
      workspacePath: string;
      visibility: WorkspaceVisibility;
      entry: VaultEntry;
      draft: string;
    } | null
  >(null);

  // Wikilink navigation stack — ⌘[ back / ⌘] forward. In-memory only; tolaria
  // persists this but Phase 1A keeps it ephemeral.
  const [navHistory, setNavHistory] = useState<NavHistory>(emptyHistory);
  // Set to true by navigateBack/Forward to suppress the auto history push
  // inside selectEntry — those paths manage history manually.
  const skipNextHistoryPushRef = useRef(false);
  // Bump on save/snapshot/workspace-switch/refresh so the GitStatusBadge re-polls.
  const [gitRefreshTick, setGitRefreshTick] = useState(0);
  // CommitDialog state — the badge passes the most recent GitStatus so the
  // dialog can show the file counts at the moment the user clicked.
  const [commitDialog, setCommitDialog] = useState<{
    path: string;
    status: GitStatus;
  } | null>(null);

  // Phase 2 inbox surface. Polling scan + notify watcher feed
  // `inboxItems`; per-item classifier output is carried alongside the
  // raw drop item via the InboxItemState shape.
  const [appMode, setAppMode] = useState<AppMode>(DEFAULT_ANCHOR_SETTINGS.ui.activeAppMode);
  const [inboxDrops, setInboxDrops] = useState<InboxDropItem[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxCarry, setInboxCarry] = useState<Map<string, InboxCarry>>(() => new Map());

  // Gmail surface (gws CLI). Sibling section in InboxPane; lives in
  // memory only — accept/reject decisions are not yet propagated back
  // to Gmail labels (follow-up). Empty `gmailError` distinguishes "not
  // yet fetched" from "fetched, no unread".
  const [gmailMessages, setGmailMessages] = useState<GmailMessage[]>([]);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailError, setGmailError] = useState<string | null>(null);
  const [gmailDecisions, setGmailDecisions] = useState<Map<string, InboxDecision>>(
    () => new Map(),
  );
  const [inboxSettings, setInboxSettings] = useState<InboxSettings>(DEFAULT_INBOX_SETTINGS);
  const [inboxSettingsOpen, setInboxSettingsOpen] = useState(false);
  const [inboxSourceFilter, setInboxSourceFilter] = useState<string | null>(null);
  const [updateToast, setUpdateToast] = useState<UpdateToast | null>(null);
  const [terminalLaunchRequest, setTerminalLaunchRequest] = useState<{
    kind: TerminalKind;
    nonce: number;
  } | null>(null);
  const [anchorSettings, setAnchorSettings] = useState<AnchorSettings>(() =>
    normalizeAnchorSettings(DEFAULT_ANCHOR_SETTINGS),
  );
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [, startExplorerTransition] = useTransition();

  const privateWorkspaces = useMemo(
    () => workspaceRegistry.workspaces.filter((workspace) => workspace.visibility === "private"),
    [workspaceRegistry.workspaces],
  );
  const publicWorkspaces = useMemo(
    () => workspaceRegistry.workspaces.filter((workspace) => workspace.visibility === "public"),
    [workspaceRegistry.workspaces],
  );
  const publicWorkspaceAvailable = publicWorkspaces.length > 0;
  const explorerWorkspacePath = workspaceRegistry.activeByVisibility[explorerVisibility];
  const explorerWorkspace = useMemo(
    () =>
      workspaceRegistry.workspaces.find(
        (workspace) => workspace.path === explorerWorkspacePath,
      ) ?? null,
    [workspaceRegistry.workspaces, explorerWorkspacePath],
  );
  const explorerWorkspaceState =
    (explorerWorkspacePath ? workspaceStates[explorerWorkspacePath] : null) ??
    EMPTY_WORKSPACE_STATE;
  const explorerWorkspaceFilesState =
    (explorerWorkspacePath ? workspaceFileStates[explorerWorkspacePath] : null) ??
    EMPTY_WORKSPACE_FILES_STATE;
  const entries = explorerWorkspaceState.entries;
  const fileEntries = explorerWorkspaceFilesState.entries;
  const query = queryByVisibility[explorerVisibility];
  const fileQuery = fileQueryByVisibility[explorerVisibility];
  const typeFilter = typeFilterByVisibility[explorerVisibility];
  const savedCollapsedTreeFolders = collapsedTreeFoldersByVisibility[explorerVisibility];
  const savedCollapsedFileFolders = collapsedFileFoldersByVisibility[explorerVisibility];
  const defaultCollapsedTreeFolders = useMemo(
    () =>
      explorerVisibility === "private" && !anchorSettings.ui.documentTreeStateInitialized
        ? []
        : null,
    [anchorSettings.ui.documentTreeStateInitialized, explorerVisibility],
  );
  const collapsedTreeFolders = defaultCollapsedTreeFolders ?? savedCollapsedTreeFolders;
  const defaultCollapsedFileFolders = useMemo(
    () =>
      explorerVisibility === "private" && !anchorSettings.ui.fileTreeStateInitialized
        ? []
        : null,
    [anchorSettings.ui.fileTreeStateInitialized, explorerVisibility],
  );
  const collapsedFileFolders = defaultCollapsedFileFolders ?? savedCollapsedFileFolders;
  const documentIndex = useMemo<DocumentIndex>(() => buildDocumentIndex(entries), [entries]);
  const selectedFilePaths = explorerWorkspacePath
    ? selectedFilePathsByWorkspace[explorerWorkspacePath] ?? []
    : [];
  const layoutSettings = anchorSettings.ui.layout;
  const editorSplitOpen = layoutSettings.editorSplitOpen && Boolean(rightActiveTabId);
  const leftResolvedTabId = leftActiveTabId ?? activeTabId ?? tabs[0]?.id ?? null;
  const rightResolvedTabId =
    editorSplitOpen && rightActiveTabId
      ? rightActiveTabId
      : null;
  const resolvedActiveTabId =
    focusedEditorGroup === "right" && rightResolvedTabId
      ? rightResolvedTabId
      : leftResolvedTabId;
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === resolvedActiveTabId) ?? null,
    [tabs, resolvedActiveTabId],
  );
  const leftTab = useMemo(
    () => tabs.find((tab) => tab.id === leftResolvedTabId) ?? null,
    [tabs, leftResolvedTabId],
  );
  const rightTab = useMemo(
    () => tabs.find((tab) => tab.id === rightResolvedTabId) ?? null,
    [tabs, rightResolvedTabId],
  );
  const selectedEntry = activeTab?.entry ?? null;
  const document = activeTab?.document ?? null;
  const selectedPath = pendingSelectedPath ?? selectedEntry?.path ?? null;
  const activeDocumentWorkspacePath = activeTab?.workspacePath ?? explorerWorkspacePath;
  const activeDocumentWorkspace = useMemo(
    () =>
      activeDocumentWorkspacePath
        ? workspaceRegistry.workspaces.find(
            (workspace) => workspace.path === activeDocumentWorkspacePath,
          ) ?? null
        : null,
    [workspaceRegistry.workspaces, activeDocumentWorkspacePath],
  );
  const activeDocumentWorkspaceState =
    (activeDocumentWorkspacePath ? workspaceStates[activeDocumentWorkspacePath] : null) ??
    EMPTY_WORKSPACE_STATE;
  const shouldScanExplorerWorkspaceFiles = shouldLazyScanWorkspaceFiles({
    paneMode: anchorSettings.ui.explorerPaneMode,
    startupIoReady: explorerWorkspaceState.startupIoReady,
    hasEntries: explorerWorkspaceFilesState.entries.length > 0,
    loading: explorerWorkspaceFilesState.loading,
    refreshing: explorerWorkspaceFilesState.refreshing,
  });
  const primaryWorkspacePath =
    workspaceRegistry.activeByVisibility.private ??
    privateWorkspaces[0]?.path ??
    workspaceRegistry.activeByVisibility.public ??
    publicWorkspaces[0]?.path ??
    null;
  const inboxWorkspacePath = activeTab?.workspacePath ?? explorerWorkspacePath ?? primaryWorkspacePath;
  const activeDocumentEntries =
    (activeTab ? workspaceStates[activeTab.workspacePath]?.entries : entries) ?? entries;
  const openingEntry =
    pendingSelectedPath && pendingSelectedPath !== document?.path
      ? activeDocumentEntries.find((entry) => entry.path === pendingSelectedPath) ?? null
      : null;
  const draftContent = activeTab?.draftContent ?? "";
  const activeWorkspaceCaps = useMemo(
    () => workspaceCapabilities(activeDocumentWorkspace),
    [activeDocumentWorkspace],
  );
  const activeWorkspaceCanCreate = activeWorkspaceCaps.canCreate;
  const activeWorkspaceCanModify = activeWorkspaceCaps.canModify;
  const selectedQueuedFileQueueItems = useMemo(() => {
    const selected = new Set(selectedFileQueueItemIds);
    return fileQueue.filter((item) => item.status === "queued" && selected.has(item.id));
  }, [fileQueue, selectedFileQueueItemIds]);
  const canApplyFileQueue = useMemo(() => {
    const queued = fileQueue.filter((item) => item.status === "queued");
    if (queued.length === 0) return true;
    return queued.every((item) => {
      const owner = workspaceRegistry.workspaces
        .filter(
          (workspace) =>
            item.targetDir === workspace.path || item.targetDir.startsWith(`${workspace.path}/`),
        )
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (!owner) return false;
      const action = item.operation === "move" ? "renameMove" : "create";
      return workspaceCan(owner, action);
    });
  }, [fileQueue, workspaceRegistry.workspaces]);
  const activeWorkspaceWriteReason = useMemo(
    () => workspaceWriteReason(activeDocumentWorkspace),
    [activeDocumentWorkspace],
  );
  const explorerWorkspaceCaption = useMemo(() => {
    if (!explorerWorkspace) return null;
    const status = workspaceWriteStatus(explorerWorkspace);
    return [
      explorerWorkspace.label,
      providerLabel(explorerWorkspace.provider),
      t(`workspace.writeStatus.${status}`),
    ].join(" · ");
  }, [explorerWorkspace, t]);
  const documentTypesPaneOpen = layoutSettings.documentTypesPaneOpen;
  const documentsPaneOpen = layoutSettings.documentsPaneOpen;
  const outlineOpen = layoutSettings.outlineOpen;

  const systemWorkPath = useMemo(() => {
    const activePrivate = workspaceRegistry.activeByVisibility.private;
    return (
      activePrivate ??
      privateWorkspaces[0]?.path ??
      (explorerWorkspace?.visibility === "private" ? explorerWorkspace.path : null)
    );
  }, [explorerWorkspace, privateWorkspaces, workspaceRegistry.activeByVisibility.private]);
  const settingsWorkPath = useMemo(() => {
    if (
      explorerWorkspace?.visibility === "public" &&
      explorerWorkspace.writePolicy === "direct" &&
      workspaceCan(explorerWorkspace, "modify")
    ) {
      return explorerWorkspace.path;
    }
    return systemWorkPath;
  }, [explorerWorkspace, systemWorkPath]);
  const settingsWorkspace = useMemo(
    () =>
      settingsWorkPath
        ? workspaceRegistry.workspaces.find((workspace) => workspace.path === settingsWorkPath) ?? null
        : null,
    [settingsWorkPath, workspaceRegistry.workspaces],
  );
  const settingsWritable =
    settingsWorkPath != null &&
    (settingsWorkspace?.visibility !== "public" || workspaceCan(settingsWorkspace, "modify"));
  const dirty = useMemo(
    () => Boolean(document && draftContent !== document.content),
    [document, draftContent],
  );

  const recentEntries = useMemo(
    () => getRecentEntries(documentIndex, recentPaths, 8),
    [documentIndex, recentPaths],
  );
  const editorTabSummaries = useMemo(
    () =>
      tabs.map((tab) => {
        const workspace =
          workspaceRegistry.workspaces.find((item) => item.path === tab.workspacePath) ??
          null;
        return {
          id: tab.id,
          title: documentDisplayName(tab.document, anchorSettings.ui.documentLabelMode),
          path: tab.document.path,
          relPath: tab.document.relPath,
          dirty: tab.draftContent !== tab.document.content,
          canRenameMove: workspaceCan(workspace, "renameMove"),
          canCreate: workspaceCan(workspace, "create"),
          canDelete: workspaceCan(workspace, "delete"),
          writeBlockedReason: workspaceWriteReason(workspace, "renameMove"),
        };
      }),
    [anchorSettings.ui.documentLabelMode, tabs, workspaceRegistry.workspaces],
  );

  const lastOpenKeyForWorkspace = useCallback((path: string) => `${LAST_OPEN_KEY}:${path}`, []);
  const openTabsKeyForWorkspace = useCallback((path: string) => `${OPEN_TABS_KEY}:${path}`, []);

  const readStoredTabsForWorkspace = useCallback(
    (path: string): StoredTabs | null => {
      if (typeof window === "undefined") return null;
      try {
        const raw = window.localStorage.getItem(openTabsKeyForWorkspace(path));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<StoredTabs>;
        const relPaths = Array.isArray(parsed.relPaths)
          ? parsed.relPaths.filter((value): value is string => typeof value === "string")
          : [];
        return {
          activeRelPath:
            typeof parsed.activeRelPath === "string" ? parsed.activeRelPath : null,
          leftRelPath:
            typeof parsed.leftRelPath === "string" ? parsed.leftRelPath : null,
          rightRelPath:
            typeof parsed.rightRelPath === "string" ? parsed.rightRelPath : null,
          focusedGroup: parsed.focusedGroup === "right" ? "right" : "left",
          relPaths,
        };
      } catch {
        return null;
      }
    },
    [openTabsKeyForWorkspace],
  );

  const updateWorkspaceState = useCallback(
    (path: string, patch: Partial<WorkspaceEntriesState>) => {
      setWorkspaceStates((current) => ({
        ...current,
        [path]: {
          ...(current[path] ?? EMPTY_WORKSPACE_STATE),
          ...patch,
        },
      }));
    },
    [],
  );

  const updateWorkspaceFileState = useCallback(
    (path: string, patch: Partial<WorkspaceFilesState>) => {
      setWorkspaceFileStates((current) => ({
        ...current,
        [path]: {
          ...(current[path] ?? EMPTY_WORKSPACE_FILES_STATE),
          ...patch,
        },
      }));
    },
    [],
  );

  const updateActiveTab = useCallback(
    (updater: (tab: EditorTab) => EditorTab) => {
      if (!resolvedActiveTabId) return;
      setTabs((prev) =>
        prev.map((tab) => (tab.id === resolvedActiveTabId ? updater(tab) : tab)),
      );
    },
    [resolvedActiveTabId],
  );

  const setDraftContent = useCallback(
    (content: string) => {
      updateActiveTab((tab) => ({ ...tab, draftContent: content }));
    },
    [updateActiveTab],
  );

  const updateTabDraft = useCallback((tabId: string, content: string) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? { ...tab, draftContent: content } : tab)),
    );
  }, []);

  const activateEditorTab = useCallback((tabId: string, group: EditorGroupId = focusedEditorGroup) => {
    if (group === "right") {
      setRightActiveTabId(tabId);
      setFocusedEditorGroup("right");
    } else {
      setLeftActiveTabId(tabId);
      setFocusedEditorGroup("left");
    }
    setActiveTabId(tabId);
  }, [focusedEditorGroup]);

  useEffect(() => {
    let cancelled = false;
    setSettingsLoaded(false);
    if (!settingsWorkPath) {
      if (booting && workspaceRegistry.workspaces.length === 0) {
        return () => {
          cancelled = true;
        };
      }
      setAnchorSettings(normalizeAnchorSettings(DEFAULT_ANCHOR_SETTINGS));
      setSettingsLoaded(true);
      return;
    }
    void readAnchorSettings(settingsWorkPath)
      .then((settings) => {
        if (!cancelled) {
          setAnchorSettings(settings);
          setAppMode(settings.ui.activeAppMode);
          setEditorViewMode(settings.ui.editorViewMode);
          setRightPaneTab(settings.ui.rightPaneTab);
          setSettingsLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAnchorSettings(normalizeAnchorSettings(DEFAULT_ANCHOR_SETTINGS));
          setSettingsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [booting, settingsWorkPath, workspaceRegistry.workspaces.length]);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    void listenAnchorSettingsUpdated((payload) => {
      if (payload.workPath === settingsWorkPath) {
        const next = normalizeAnchorSettings(payload.settings);
        setAnchorSettings(next);
        setAppMode(next.ui.activeAppMode);
        setEditorViewMode(next.ui.editorViewMode);
        setRightPaneTab(next.ui.rightPaneTab);
      } else if (payload.globalChanged && settingsWorkPath) {
        void readAnchorSettings(settingsWorkPath)
          .then((next) => {
            setAnchorSettings(next);
            setAppMode(next.ui.activeAppMode);
            setEditorViewMode(next.ui.editorViewMode);
            setRightPaneTab(next.ui.rightPaneTab);
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)));
      }
    }).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
  }, [settingsWorkPath]);

  useEffect(() => {
    applyThemePreference(anchorSettings.ui.themeMode);
    applyThemeVars(buildThemeVars(anchorSettings));
  }, [anchorSettings]);

  useEffect(() => {
    if (!settingsWritable || !settingsWorkPath) {
      settingsSaverRef.current = null;
      settingsSaveBaseRef.current = null;
      return;
    }
    const saver = createDebouncedSaver<AnchorSettings>(
      async (settings) => {
        const base = settingsSaveBaseRef.current ?? undefined;
        settingsSaveBaseRef.current = null;
        await saveAnchorSettings(settingsWorkPath, settings, base);
      },
      250,
      (err) => {
        setError(err instanceof Error ? err.message : String(err));
      },
    );
    settingsSaverRef.current = saver;
    return () => {
      if (settingsSaverRef.current === saver) {
        settingsSaverRef.current = null;
      }
      void saver.flush();
    };
  }, [settingsWorkPath, settingsWritable]);

  useEffect(() => {
    const flushPendingSettings = () => {
      void settingsSaverRef.current?.flush();
    };
    window.addEventListener("beforeunload", flushPendingSettings);
    window.addEventListener("pagehide", flushPendingSettings);
    return () => {
      window.removeEventListener("beforeunload", flushPendingSettings);
      window.removeEventListener("pagehide", flushPendingSettings);
    };
  }, []);

  const updateSettings = useCallback(
    (updater: AnchorSettings | ((current: AnchorSettings) => AnchorSettings)) => {
      setAnchorSettings((current) => {
        const next = normalizeAnchorSettings(
          typeof updater === "function" ? updater(current) : updater,
        );
        if (settingsWritable && settingsWorkPath) {
          const saver = settingsSaverRef.current;
          if (saver) {
            if (!settingsSaveBaseRef.current) {
              settingsSaveBaseRef.current = current;
            }
            saver.schedule(next);
          } else {
            void saveAnchorSettings(settingsWorkPath, next, current).catch((err) => {
              setError(err instanceof Error ? err.message : String(err));
            });
          }
        }
        return next;
      });
    },
    [settingsWorkPath, settingsWritable],
  );

  const updateLayoutSettings = useCallback(
    (patch: Partial<AnchorSettings["ui"]["layout"]>) => {
      updateSettings((current) => {
        const layout = {
          ...current.ui.layout,
          ...patch,
        };
        return {
          ...current,
          ui: {
            ...current.ui,
            layout,
          },
          terminal: {
            ...current.terminal,
            defaultPanelOpen: layout.terminalOpen,
            lastHeight: layout.terminalHeight,
          },
        };
      });
    },
    [updateSettings],
  );

  const setPersistedAppMode = useCallback(
    (activeAppMode: AppMode) => {
      setAppMode(activeAppMode);
      updateSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          activeAppMode,
        },
      }));
    },
    [updateSettings],
  );

  const setPersistedEditorViewMode = useCallback(
    (editorViewMode: EditorViewModeSetting) => {
      setEditorViewMode(editorViewMode);
      updateSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          editorViewMode,
        },
      }));
    },
    [updateSettings],
  );

  const setPersistedRightPaneTab = useCallback(
    (rightPaneTab: RightPaneTab) => {
      setRightPaneTab(rightPaneTab);
      updateSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          rightPaneTab,
        },
      }));
    },
    [updateSettings],
  );

  const restoredWindowKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!settingsLoaded || !settingsWorkPath) return;
    const key = settingsWorkPath;
    if (restoredWindowKeyRef.current === key) return;
    restoredWindowKeyRef.current = key;
    void restoreMainWindowLayout(anchorSettings.ui.layout).catch(() => {});
  }, [anchorSettings.ui.layout, settingsLoaded, settingsWorkPath]);

  useEffect(() => {
    if (!settingsLoaded || !settingsWritable) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void subscribeMainWindowLayout((patch) => {
      if (!disposed) updateLayoutSettings(patch);
    }).then((off) => {
      if (disposed) off();
      else cleanup = off;
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [settingsLoaded, settingsWritable, updateLayoutSettings]);

  useEffect(() => {
    if (!settingsLoaded || collapsedTreeHydratedRef.current) return;
    collapsedTreeHydratedRef.current = true;
    setCollapsedTreeFoldersByVisibility((current) => ({
      ...current,
      private: anchorSettings.ui.documentTreeStateInitialized
        ? anchorSettings.ui.collapsedTreeFolders
        : current.private,
    }));
  }, [
    anchorSettings.ui.collapsedTreeFolders,
    anchorSettings.ui.documentTreeStateInitialized,
    settingsLoaded,
  ]);

  useEffect(() => {
    if (!settingsLoaded || anchorSettings.ui.activeWorkspaceVisibility === explorerVisibility) {
      return;
    }
    updateSettings((current) => ({
      ...current,
      ui: {
        ...current.ui,
        activeWorkspaceVisibility: explorerVisibility,
      },
    }));
  }, [
    anchorSettings.ui.activeWorkspaceVisibility,
    explorerVisibility,
    settingsLoaded,
    updateSettings,
  ]);

  useEffect(() => {
    if (!settingsLoaded || collapsedFileHydratedRef.current) return;
    collapsedFileHydratedRef.current = true;
    setCollapsedFileFoldersByVisibility((current) => ({
      ...current,
      private: anchorSettings.ui.fileTreeStateInitialized
        ? anchorSettings.ui.collapsedFileFolders
        : current.private,
    }));
  }, [
    anchorSettings.ui.collapsedFileFolders,
    anchorSettings.ui.fileTreeStateInitialized,
    settingsLoaded,
  ]);

  const privateWorkspacePath = workspaceRegistry.activeByVisibility.private;
  const privateWorkspaceState =
    (privateWorkspacePath ? workspaceStates[privateWorkspacePath] : null) ??
    EMPTY_WORKSPACE_STATE;

  useEffect(() => {
    if (!settingsLoaded || anchorSettings.ui.documentTreeStateInitialized) return;
    if (!privateWorkspacePath || !privateWorkspaceState.startupIoReady) return;
    const collapsedFolders: string[] = [];
    setCollapsedTreeFoldersByVisibility((current) => ({
      ...current,
      private: collapsedFolders,
    }));
    updateSettings((current) => ({
      ...current,
      ui: {
        ...current.ui,
        collapsedTreeFolders: collapsedFolders,
        documentTreeStateInitialized: true,
      },
    }));
  }, [
    anchorSettings.ui.documentTreeStateInitialized,
    privateWorkspacePath,
    privateWorkspaceState.startupIoReady,
    settingsLoaded,
    updateSettings,
  ]);

  useEffect(() => {
    if (!settingsLoaded || anchorSettings.ui.fileTreeStateInitialized) return;
    if (!privateWorkspacePath || explorerVisibility !== "private") return;
    if (explorerWorkspaceFilesState.loading || explorerWorkspaceFilesState.entries.length === 0) return;
    const collapsedFolders: string[] = [];
    setCollapsedFileFoldersByVisibility((current) => ({
      ...current,
      private: collapsedFolders,
    }));
    updateSettings((current) => ({
      ...current,
      ui: {
        ...current.ui,
        collapsedFileFolders: collapsedFolders,
        fileTreeStateInitialized: true,
      },
    }));
  }, [
    anchorSettings.ui.fileTreeStateInitialized,
    explorerVisibility,
    explorerWorkspaceFilesState.entries,
    explorerWorkspaceFilesState.loading,
    privateWorkspacePath,
    settingsLoaded,
    updateSettings,
  ]);

  useEffect(() => {
    const ids = new Set(fileQueue.map((item) => item.id));
    setSelectedFileQueueItemIds((current) => current.filter((id) => ids.has(id)));
  }, [fileQueue]);

  const setDocumentBrowserMode = useCallback(
    (mode: DocumentBrowserMode) => {
      updateSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          documentBrowserMode: mode,
        },
      }));
    },
    [updateSettings],
  );

  const setExplorerPaneMode = useCallback(
    (mode: ExplorerPaneMode) => {
      updateSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          explorerPaneMode: mode,
        },
      }));
    },
    [updateSettings],
  );

  const setWorkspaceFileFilter = useCallback(
    (workspaceFileFilter: WorkspaceFileFilter) => {
      updateSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          workspaceFileFilter,
        },
      }));
    },
    [updateSettings],
  );

  const setCollapsedTreeFolders = useCallback(
    (paths: string[]) => {
      setCollapsedTreeFoldersByVisibility((current) => ({
        ...current,
        [explorerVisibility]: paths,
      }));
      if (explorerVisibility === "private") {
        updateSettings((current) => ({
          ...current,
          ui: {
            ...current.ui,
            collapsedTreeFolders: paths,
            documentTreeStateInitialized: true,
          },
        }));
      }
    },
    [explorerVisibility, updateSettings],
  );

  const setCollapsedFileFolders = useCallback(
    (paths: string[]) => {
      setCollapsedFileFoldersByVisibility((current) => ({
        ...current,
        [explorerVisibility]: paths,
      }));
      if (explorerVisibility === "private") {
        updateSettings((current) => ({
          ...current,
          ui: {
            ...current.ui,
            collapsedFileFolders: paths,
            fileTreeStateInitialized: true,
          },
        }));
      }
    },
    [explorerVisibility, updateSettings],
  );

  const setExplorerQuery = useCallback(
    (next: string) => {
      startExplorerTransition(() =>
        setQueryByVisibility((current) => ({
          ...current,
          [explorerVisibility]: next,
        })),
      );
    },
    [explorerVisibility, startExplorerTransition],
  );

  const setWorkspaceFileQuery = useCallback(
    (next: string) => {
      startExplorerTransition(() =>
        setFileQueryByVisibility((current) => ({
          ...current,
          [explorerVisibility]: next,
        })),
      );
    },
    [explorerVisibility, startExplorerTransition],
  );

  const setExplorerTypeFilter = useCallback(
    (next: string | null) => {
      startExplorerTransition(() =>
        setTypeFilterByVisibility((current) => ({
          ...current,
          [explorerVisibility]: next,
        })),
      );
    },
    [explorerVisibility, startExplorerTransition],
  );

  // Best-effort persistence of the chosen mode into .anchor/workspace.json.
  // Failures are silent — this is a UX nicety, not a correctness concern.
  useEffect(() => {
    if (!systemWorkPath) return;
    void updateAnchorWorkspace(systemWorkPath, { lastActiveMode: appMode }).catch(() => {});
  }, [appMode, systemWorkPath]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const byWorkspace = new Map<string, EditorTab[]>();
    for (const tab of tabs) {
      const bucket = byWorkspace.get(tab.workspacePath) ?? [];
      bucket.push(tab);
      byWorkspace.set(tab.workspacePath, bucket);
    }
    for (const [workspacePath, workspaceTabs] of byWorkspace) {
      const relPathForTabId = (tabId: string | null) =>
        tabId
          ? workspaceTabs.find((tab) => tab.id === tabId)?.entry.relPath ?? null
          : null;
      window.localStorage.setItem(
        openTabsKeyForWorkspace(workspacePath),
        JSON.stringify({
          activeRelPath:
            activeTab?.workspacePath === workspacePath ? activeTab.entry.relPath : null,
          leftRelPath: relPathForTabId(leftActiveTabId),
          rightRelPath: relPathForTabId(rightActiveTabId),
          focusedGroup: focusedEditorGroup,
          relPaths: workspaceTabs.map((tab) => tab.entry.relPath),
        } satisfies StoredTabs),
      );
    }
    if (activeTab) {
      window.localStorage.setItem(
        lastOpenKeyForWorkspace(activeTab.workspacePath),
        activeTab.entry.relPath,
      );
    }
  }, [
    activeTab,
    focusedEditorGroup,
    lastOpenKeyForWorkspace,
    leftActiveTabId,
    openTabsKeyForWorkspace,
    rightActiveTabId,
    tabs,
  ]);

  const pushRecent = useCallback((path: string) => {
    setRecentPaths((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, 16);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      }
      return next;
    });
  }, []);

  const inboxItems = useMemo<InboxItemState[]>(
    () => buildInboxItemStates(inboxDrops, inboxCarry),
    [inboxDrops, inboxCarry],
  );

  const gmailItems = useMemo<GmailMessageState[]>(
    () => buildGmailMessageStates(gmailMessages, gmailDecisions),
    [gmailMessages, gmailDecisions],
  );

  const refreshGmail = useCallback(async () => {
    setGmailLoading(true);
    setGmailError(null);
    try {
      const messages = await fetchGmailUnread(inboxWorkspacePath, 20);
      setGmailMessages(messages);
    } catch (err) {
      setGmailError(err instanceof Error ? err.message : String(err));
    } finally {
      setGmailLoading(false);
    }
  }, [inboxWorkspacePath]);

  const decideGmailItem = useCallback((id: string, decision: InboxDecision) => {
    setGmailDecisions((prev) => {
      const next = new Map(prev);
      next.set(id, decision);
      return next;
    });
  }, []);

  const refreshInbox = useCallback(async () => {
    if (!inboxWorkspacePath) {
      setInboxDrops([]);
      return;
    }
    setInboxLoading(true);
    setError(null);
    try {
      setInboxDrops(await scanInboxDrop(inboxWorkspacePath));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInboxLoading(false);
    }
  }, [inboxWorkspacePath]);

  const updateInboxCarry = useCallback(
    (id: string, patch: Partial<InboxCarry>) => {
      setInboxCarry((prev) => {
        const next = new Map(prev);
        const current: InboxCarry = next.get(id) ?? {
          decision: "pending",
          classification: null,
          classifying: false,
          classifyError: null,
        };
        next.set(id, { ...current, ...patch });
        return next;
      });
    },
    [],
  );

  const decideInboxItem = useCallback(
    (id: string, decision: InboxDecision) => {
      updateInboxCarry(id, { decision });
    },
    [updateInboxCarry],
  );

  const classifyItem = useCallback(
    async (id: string) => {
      const target = inboxDrops.find((drop) => drop.id === id);
      if (!target) return;
      updateInboxCarry(id, { classifying: true, classifyError: null });
      try {
        const classification = await classifyInboxItem(target);
        updateInboxCarry(id, { classifying: false, classification });
      } catch (err) {
        updateInboxCarry(id, {
          classifying: false,
          classifyError: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [inboxDrops, updateInboxCarry],
  );

  useEffect(() => {
    if (!inboxWorkspacePath) {
      setInboxSettings(DEFAULT_INBOX_SETTINGS);
      setInboxSourceFilter(null);
      return;
    }
    let cancelled = false;
    void readInboxSettings(inboxWorkspacePath)
      .then((settings) => {
        if (!cancelled) setInboxSettings(settings);
      })
      .catch(() => {
        if (!cancelled) setInboxSettings(DEFAULT_INBOX_SETTINGS);
      });
    return () => {
      cancelled = true;
    };
  }, [inboxWorkspacePath]);

  const persistInboxSettings = useCallback(
    async (next: InboxSettings) => {
      if (!inboxWorkspacePath) return;
      const saved = await saveInboxSettings(inboxWorkspacePath, next);
      setInboxSettings(saved);
      setInboxSettingsOpen(false);
      setInboxSourceFilter(null);
      void refreshInbox();
      void refreshGmail();
    },
    [inboxWorkspacePath, refreshGmail, refreshInbox],
  );

  // First entry into Inbox mode triggers a Gmail fetch. Subsequent
  // refreshes are user-driven via the refresh button / ⌘R.
  useEffect(() => {
    if (appMode !== "inbox") return;
    if (gmailMessages.length > 0 || gmailLoading) return;
    void refreshGmail();
    // Only refire on appMode transitions, not on gmail state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appMode]);

  // Inbox scan + watcher subscription, scoped to the active workspace and
  // deferred until Inbox mode so startup document paint owns the I/O lane.
  // The watcher overlays the polling baseline: any file_event triggers
  // a re-scan rather than a delta apply, which keeps the UI source of
  // truth a single `scan_inbox_drop` snapshot.
  useEffect(() => {
    if (!inboxWorkspacePath) {
      setInboxDrops([]);
      return;
    }
    if (appMode !== "inbox") {
      return;
    }
    let cancelled = false;
    let unlistenFileEvent: (() => void) | null = null;

    void (async () => {
      // Cold scan first — watcher only catches subsequent events.
      void refreshInbox();

      try {
        await startInboxWatcher(inboxWorkspacePath);
      } catch (err) {
        // Most likely cause: <workspace>/inbox/downloads doesn't exist yet.
        // Surface a soft notice but keep polling functional.
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.info("[anchor] inbox watcher not started:", err);
        }
        return;
      }

      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen("inbox://file_event", () => {
          if (!cancelled) void refreshInbox();
        });
        if (cancelled) {
          off();
        } else {
          unlistenFileEvent = off;
        }
      } catch (err) {
        // Browser dev shell — `@tauri-apps/api/event` may not be wired.
        // eslint-disable-next-line no-console
        console.info("[anchor] inbox event listener unavailable:", err);
      }
    })();

    return () => {
      cancelled = true;
      if (unlistenFileEvent) unlistenFileEvent();
      void stopInboxWatcher().catch(() => {
        // best-effort
      });
    };
  }, [inboxWorkspacePath, appMode, refreshInbox]);

  const refreshWorkspaceFiles = useCallback(
    async (path: string, initial = false) => {
      updateWorkspaceFileState(path, initial ? { loading: true } : { refreshing: true });
      try {
        const files = await scanWorkspaceFiles(path);
        updateWorkspaceFileState(path, {
          entries: files,
          loading: false,
          refreshing: false,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        updateWorkspaceFileState(path, { loading: false, refreshing: false });
      }
    },
    [updateWorkspaceFileState],
  );

  useEffect(() => {
    if (!explorerWorkspacePath || !shouldScanExplorerWorkspaceFiles) return;
    void refreshWorkspaceFiles(explorerWorkspacePath, true);
  }, [explorerWorkspacePath, refreshWorkspaceFiles, shouldScanExplorerWorkspaceFiles]);

  const loadWorkspace = useCallback(
    async (
      path: string,
      visibility: WorkspaceVisibility,
      preferRelPath: string | null = null,
    ) => {
      const requestId = ++loadWorkspaceRequestRef.current;
      updateWorkspaceState(path, {
        loading: true,
        refreshing: false,
        startupIoReady: false,
      });
      setError(null);
      const storedTabs = readStoredTabsForWorkspace(path);

      const restorePrimaryTab = async (nextEntries: VaultEntry[]) => {
        if (requestId !== loadWorkspaceRequestRef.current) return false;
        updateWorkspaceState(path, { entries: nextEntries });

        const { candidate, tabEntries } = planVaultStartup(
          nextEntries,
          storedTabs,
          preferRelPath,
        );

        if (!candidate) {
          setTabs((prev) => prev.filter((tab) => tab.workspacePath !== path));
          setActiveTabId((current) => {
            const stillOpen = tabs.some(
              (tab) => tab.id === current && tab.workspacePath !== path,
            );
            return stillOpen ? current : null;
          });
          setLeftActiveTabId((current) =>
            tabs.some((tab) => tab.id === current && tab.workspacePath !== path)
              ? current
              : null,
          );
          setRightActiveTabId(null);
          setFocusedEditorGroup("left");
          setPendingSelectedPath(null);
          updateWorkspaceState(path, { loading: false, startupIoReady: true });
          return true;
        }

        const payload = await readDocument(path, candidate.path);
        if (requestId !== loadWorkspaceRequestRef.current) return false;
        const primaryTab: EditorTab = {
          id: tabIdForEntry(candidate),
          workspacePath: path,
          visibility,
          entry: candidate,
          document: payload,
          draftContent: payload.content,
        };
        const applyStoredTabState = (loadedTabs: EditorTab[]) => {
          const idForRelPath = (relPath: string | null | undefined) =>
            relPath
              ? loadedTabs.find(
                  (tab) => tab.entry.relPath === relPath || tab.entry.path === relPath,
                )?.id ?? null
              : null;
          const leftId =
            idForRelPath(storedTabs?.leftRelPath) ??
            idForRelPath(storedTabs?.activeRelPath) ??
            primaryTab.id;
          const rightId = idForRelPath(storedTabs?.rightRelPath);
          const focusedGroup: EditorGroupId =
            rightId && storedTabs?.focusedGroup === "right" ? "right" : "left";
          setLeftActiveTabId(leftId);
          setRightActiveTabId(rightId);
          setFocusedEditorGroup(focusedGroup);
          setActiveTabId(focusedGroup === "right" && rightId ? rightId : leftId);
        };
        setTabs((prev) => {
          const otherWorkspaceTabs = prev.filter((tab) => tab.workspacePath !== path);
          return [...otherWorkspaceTabs, primaryTab];
        });
        applyStoredTabState([primaryTab]);
        setPendingSelectedPath(null);
        updateWorkspaceState(path, { loading: false, startupIoReady: true });
        pushRecent(candidate.path);

        const rest = tabEntries.slice(1);
        if (rest.length > 0) {
          void (async () => {
            const loaded = await Promise.allSettled(
              rest.map(async (entry) => {
                const payload = await readDocument(path, entry.path);
                return {
                  id: tabIdForEntry(entry),
                  workspacePath: path,
                  visibility,
                  entry,
                  document: payload,
                  draftContent: payload.content,
                } satisfies EditorTab;
              }),
            );
            if (requestId !== loadWorkspaceRequestRef.current) return;
            const nextTabs = loaded.flatMap((result) =>
              result.status === "fulfilled" ? [result.value] : [],
            );
            if (nextTabs.length === 0) return;
            setTabs((prev) => {
              const seen = new Set(prev.map((tab) => tab.id));
              return [
                ...prev,
                ...nextTabs.filter((tab) => {
                  if (seen.has(tab.id)) return false;
                  seen.add(tab.id);
                  return true;
                }),
              ].slice(0, 8);
            });
            applyStoredTabState([primaryTab, ...nextTabs]);
          })();
        }

        return true;
      };

      const mergeFreshEntries = (fresh: VaultEntry[]) => {
        updateWorkspaceState(path, { entries: fresh });
        setTabs((prev) =>
          prev.map((tab) =>
            tab.workspacePath === path ? mergeFreshEntry(tab, fresh) : tab,
          ),
        );
      };

      const runAuthoritativeScan = async (paintAfterScan: boolean) => {
        if (!paintAfterScan) updateWorkspaceState(path, { refreshing: true });
        try {
          const fresh = await scanVault(path);
          if (requestId !== loadWorkspaceRequestRef.current) return;
          if (paintAfterScan) {
            await restorePrimaryTab(fresh);
          } else {
            mergeFreshEntries(fresh);
          }
        } catch (err) {
          if (requestId !== loadWorkspaceRequestRef.current) return;
          setError(err instanceof Error ? err.message : String(err));
          if (paintAfterScan) {
            updateWorkspaceState(path, { loading: false, startupIoReady: true });
          }
        } finally {
          if (requestId === loadWorkspaceRequestRef.current) {
            updateWorkspaceState(path, { refreshing: false });
          }
        }
      };

      try {
        const cached = await readVaultCache(path);
        if (requestId !== loadWorkspaceRequestRef.current) return;
        const paintedFromCache = cached ? await restorePrimaryTab(cached) : false;
        if (paintedFromCache) {
          void runAuthoritativeScan(false);
        } else {
          await runAuthoritativeScan(true);
        }
      } catch {
        await runAuthoritativeScan(true);
      }
    },
    [pushRecent, readStoredTabsForWorkspace, tabs, updateWorkspaceState],
  );

  const switchActiveWorkspace = useCallback(
    async (path: string, visibility: WorkspaceVisibility) => {
      try {
        const registry = await setActiveWorkspaceRoot(path, visibility);
        setWorkspaceRegistry(registry);
        setExplorerVisibility(visibility);
        const lastRel =
          typeof window !== "undefined"
            ? window.localStorage.getItem(lastOpenKeyForWorkspace(path))
            : null;
        await loadWorkspace(path, visibility, lastRel);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [lastOpenKeyForWorkspace, loadWorkspace],
  );

  // Boot: load registry, fall back to a private sample workspace if empty.
  useEffect(() => {
    async function boot() {
      try {
        setBooting(true);
        const registry = await listWorkspaceRoots();
        if (registry.workspaces.length === 0) {
          const samplePath = await getSampleVaultPath();
          const seeded = await addWorkspaceRoot({
            label: "Sample Workspace",
            path: samplePath,
            visibility: "private",
            provider: "local",
            providerId: null,
            externalWriter: null,
            writePolicy: "direct",
            permissionSummary: null,
          });
          setWorkspaceRegistry(seeded);
          if (seeded.activeByVisibility.private) {
            setExplorerVisibility("private");
            await loadWorkspace(seeded.activeByVisibility.private, "private");
            setBooting(false);
          } else {
            setBooting(false);
          }
          return;
        }
        setWorkspaceRegistry(registry);
        let bootSettings: AnchorSettings | null = null;
        const bootSettingsPath = startupSettingsPath(registry);
        if (bootSettingsPath) {
          try {
            bootSettings = await readAnchorSettings(bootSettingsPath);
            setAnchorSettings(bootSettings);
            setAppMode(bootSettings.ui.activeAppMode);
            setEditorViewMode(bootSettings.ui.editorViewMode);
            setRightPaneTab(bootSettings.ui.rightPaneTab);
          } catch {
            bootSettings = null;
          }
        }
        const initialVisibility = initialStartupVisibility(registry, bootSettings);
        setExplorerVisibility(initialVisibility);
        const initialPath =
          registry.activeByVisibility[initialVisibility] ??
          registry.workspaces.find((workspace) => workspace.visibility === initialVisibility)?.path ??
          null;
        if (initialPath) {
          const lastRel =
            typeof window !== "undefined"
              ? window.localStorage.getItem(lastOpenKeyForWorkspace(initialPath))
              : null;
          await loadWorkspace(initialPath, initialVisibility, lastRel);
          setBooting(false);
        } else {
          setBooting(false);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBooting(false);
      }
    }
    void boot();
    // boot only once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAddWorkspace = useCallback(
    async (entry: WorkspaceRootEntry) => {
      const registry = await addWorkspaceRoot(entry);
      setWorkspaceRegistry(registry);
      setExplorerVisibility(entry.visibility);
      await loadWorkspace(entry.path, entry.visibility);
    },
    [loadWorkspace],
  );

  const handleRegisterWorkspace = useCallback(
    async (workPath: string) => {
      const outcome = await registerWorkspaceRoots(workPath);
      setWorkspaceRegistry(outcome.workspaceRegistry);
      setExplorerVisibility("private");
      await loadWorkspace(outcome.privateWorkspacePath, "private");
    },
    [loadWorkspace],
  );

  const handleRefreshWorkspaceCapabilities = useCallback(async (path: string) => {
    try {
      const registry = await refreshWorkspaceCapabilities(path);
      setWorkspaceRegistry(registry);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleRemoveWorkspace = useCallback(
    async (path: string) => {
      const confirmation = window.confirm(`${path}\n\n${t("workspace.remove.confirm")}`);
      if (!confirmation) return;
      const registry = await removeWorkspaceRoot(path);
      setWorkspaceRegistry(registry);
      setWorkspaceStates((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      setTabs((prev) => prev.filter((tab) => tab.workspacePath !== path));
      const nextPath =
        registry.activeByVisibility[explorerVisibility] ??
        registry.activeByVisibility.private ??
        registry.activeByVisibility.public;
      if (nextPath) {
        const nextVisibility =
          registry.workspaces.find((workspace) => workspace.path === nextPath)?.visibility ??
          explorerVisibility;
        setExplorerVisibility(nextVisibility);
        await loadWorkspace(nextPath, nextVisibility);
      }
    },
    [explorerVisibility, loadWorkspace, t],
  );

  const useSampleWorkspace = useCallback(async () => {
    try {
      const samplePath = await getSampleVaultPath();
      const exists = workspaceRegistry.workspaces.find((workspace) => workspace.path === samplePath);
      if (!exists) {
        await handleAddWorkspace({
          label: "Sample Workspace",
          path: samplePath,
          visibility: "private",
          provider: "local",
          providerId: null,
          externalWriter: null,
          writePolicy: "direct",
          permissionSummary: null,
        });
      } else {
        await switchActiveWorkspace(samplePath, exists.visibility);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceRegistry.workspaces, handleAddWorkspace, switchActiveWorkspace]);

  const openNewDocumentDialog = useCallback(() => {
    if (!activeWorkspaceCanCreate) {
      setError(
        t("workspace.writeBlocked", {
          reason:
            workspaceWriteReason(activeDocumentWorkspace, "create") ??
            "workspace capabilities",
        }),
      );
      return;
    }
    setNewDocumentSeed(null);
    setNewDocumentOpen(true);
  }, [activeDocumentWorkspace, activeWorkspaceCanCreate, t]);

  const blockWorkspaceWrite = useCallback(
    (action: "create" | "modify" = "modify") => {
      if (workspaceCan(activeDocumentWorkspace, action)) return false;
      setError(
        t("workspace.writeBlocked", {
          reason:
            workspaceWriteReason(activeDocumentWorkspace, action) ??
            "workspace capabilities",
        }),
      );
      return true;
    },
    [activeDocumentWorkspace, t],
  );

  const selectEntry = useCallback(
    async (entry: VaultEntry) => {
      const owner =
        workspaceRegistry.workspaces
          .filter(
            (workspace) =>
              entry.path === workspace.path || entry.path.startsWith(`${workspace.path}/`),
          )
          .sort((a, b) => b.path.length - a.path.length)[0] ?? explorerWorkspace;
      const workspacePath = owner?.path ?? null;
      const visibility = owner?.visibility ?? explorerVisibility;
      if (!workspacePath) {
        setError(t("workspace.error.noneActive"));
        return false;
      }
      setPendingSelectedPath(entry.path);

      const existingTab = tabs.find(
        (tab) => tab.workspacePath === workspacePath && tab.entry.path === entry.path,
      );
      const isSameEntry = selectedEntry?.path === entry.path;
      // Push the *previous* selection onto history before we replace it.
      // Skip when navigateBack/Forward is the caller — they manage manually.
      const skipHistoryPush = skipNextHistoryPushRef.current;
      skipNextHistoryPushRef.current = false;
      if (!skipHistoryPush && !isSameEntry && selectedEntry) {
        setNavHistory((h) => pushHistory(h, selectedEntry.path));
      }
      if (existingTab) {
        activateEditorTab(existingTab.id, editorSplitOpen ? focusedEditorGroup : "left");
        setExplorerVisibility(existingTab.visibility);
        setPendingSelectedPath(null);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(lastOpenKeyForWorkspace(workspacePath), entry.relPath);
        }
        pushRecent(entry.path);
        return true;
      }

      const reqId = ++selectRequestRef.current;
      setError(null);
      try {
        const payload = await readDocument(workspacePath, entry.path);
        // Drop stale responses — a later click already superseded this one.
        if (reqId !== selectRequestRef.current) return false;
        const newTab: EditorTab = {
          id: tabIdForEntry(entry),
          workspacePath,
          visibility,
          entry,
          document: payload,
          draftContent: payload.content,
        };
        setTabs((prev) => [...prev, newTab]);
        activateEditorTab(newTab.id, editorSplitOpen ? focusedEditorGroup : "left");
        setExplorerVisibility(visibility);
        setPendingSelectedPath(null);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(lastOpenKeyForWorkspace(workspacePath), entry.relPath);
        }
        pushRecent(entry.path);
        return true;
      } catch (err) {
        if (reqId !== selectRequestRef.current) return false;
        setPendingSelectedPath(null);
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [
      explorerVisibility,
      explorerWorkspace,
      activateEditorTab,
      editorSplitOpen,
      focusedEditorGroup,
      lastOpenKeyForWorkspace,
      pushRecent,
      selectedEntry,
      t,
      tabs,
      workspaceRegistry.workspaces,
    ],
  );

  const selectWorkspaceFile = useCallback(
    (entry: WorkspaceFileEntry, additive: boolean) => {
      if (!explorerWorkspacePath) return;
      setSelectedFilePathsByWorkspace((current) => {
        const existing = current[explorerWorkspacePath] ?? [];
        const next = additive
          ? existing.includes(entry.path)
            ? existing.filter((path) => path !== entry.path)
            : [...existing, entry.path]
          : [entry.path];
        return {
          ...current,
          [explorerWorkspacePath]: next,
        };
      });
    },
    [explorerWorkspacePath],
  );

  const openWorkspaceFile = useCallback(
    (entry: WorkspaceFileEntry) => {
      if (!isOpenableDocumentFile(entry)) {
        setError(t("files.openUnsupported"));
        return;
      }
      const docEntry =
        entries.find((item) => item.path === entry.path || item.relPath === entry.relPath) ??
        null;
      if (!docEntry) {
        setError(t("files.openUnavailable"));
        return;
      }
      void selectEntry(docEntry);
    },
    [entries, selectEntry, t],
  );

  const addFileQueueSources = useCallback(
    (
      sources: FileQueueSourceInfo[],
      targetDir: string,
      operation: FileStoreOperation = anchorSettings.ui.fileQueueDefaultOperation,
    ) => {
      if (sources.length === 0) return;
      const addedIds: string[] = [];
      const seed = Date.now();
      setFileQueue((current) => {
        const existing = new Set(
          current
            .filter((item) => item.status === "queued")
            .map((item) => `${item.sourcePath}\u0000${item.targetDir}\u0000${item.sourceKind}`),
        );
        const additions: FileQueueItem[] = [];
        for (const source of sources) {
          const key = `${source.path}\u0000${targetDir}\u0000${source.sourceKind}`;
          if (existing.has(key)) continue;
          existing.add(key);
          const item = fileQueueItemFromSource(source, targetDir, operation, seed, additions.length);
          addedIds.push(item.id);
          additions.push(item);
        }
        return additions.length > 0 ? [...current, ...additions] : current;
      });
      if (addedIds.length > 0) setSelectedFileQueueItemIds(addedIds);
      setPersistedAppMode("pkm");
      if (!outlineOpen) updateLayoutSettings({ outlineOpen: true });
      setPersistedRightPaneTab("files");
    },
    [
      anchorSettings.ui.fileQueueDefaultOperation,
      outlineOpen,
      setPersistedAppMode,
      setPersistedRightPaneTab,
      updateLayoutSettings,
    ],
  );

  const queueWorkspaceFiles = useCallback(
    (files: WorkspaceFileEntry[]) => {
      const workspacePath = explorerWorkspacePath;
      if (!workspacePath || files.length === 0) return;
      addFileQueueSources(
        files.map((file) => ({
          path: file.path,
          sourceRelPath: file.relPath,
          fileName: file.name,
          sourceKind: "file",
        })),
        workspacePath,
      );
    },
    [addFileQueueSources, explorerWorkspacePath],
  );

  const queueExternalFiles = useCallback(
    async (paths: string[]) => {
      const targetDir = activeDocumentWorkspacePath ?? explorerWorkspacePath;
      if (!targetDir || paths.length === 0) return;
      try {
        addFileQueueSources(await describeFileQueueSources(paths), targetDir);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      addFileQueueSources,
      activeDocumentWorkspacePath,
      explorerWorkspacePath,
    ],
  );

  const selectFileQueueItem = useCallback((id: string, additive: boolean) => {
    setSelectedFileQueueItemIds((current) => {
      if (!additive) return [id];
      return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    });
  }, []);

  const updateFileQueueItem = useCallback(
    (id: string, patch: Partial<Pick<FileQueueItem, "targetDir" | "operation">>) => {
      setFileQueue((current) =>
        current.map((item) =>
          item.id === id
            ? { ...item, ...patch, status: "queued", message: null, targetPath: null }
            : item,
        ),
      );
      if (patch.operation) {
        updateSettings((current) => ({
          ...current,
          ui: {
            ...current.ui,
            fileQueueDefaultOperation: patch.operation as FileStoreOperation,
          },
        }));
      }
    },
    [updateSettings],
  );

  const clearFileQueue = useCallback(() => {
    setFileQueue([]);
    setSelectedFileQueueItemIds([]);
  }, []);

  const clearSelectedFileQueueItems = useCallback(() => {
    const selected = new Set(selectedFileQueueItemIds);
    if (selected.size === 0) return;
    setFileQueue((current) => current.filter((item) => !selected.has(item.id)));
    setSelectedFileQueueItemIds([]);
  }, [selectedFileQueueItemIds]);

  const applyQueuedFiles = useCallback(async (itemsOverride?: FileQueueItem[]) => {
    const queued = itemsOverride ?? fileQueue.filter((item) => item.status === "queued");
    if (queued.length === 0) return [];
    const groups = new Map<string, FileQueueItem[]>();
    for (const item of queued) {
      const owner = workspaceRegistry.workspaces
        .filter(
          (workspace) =>
            item.targetDir === workspace.path || item.targetDir.startsWith(`${workspace.path}/`),
        )
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (!owner) {
        setError(t("workspace.error.noneActive"));
        return [];
      }
      const hasMove = item.operation === "move";
      const action = hasMove ? "renameMove" : "create";
      if (!workspaceCan(owner, action)) {
        setError(
          t("workspace.writeBlocked", {
            reason: workspaceWriteReason(owner, action) ?? "workspace capabilities",
          }),
        );
        return [];
      }
      const bucket = groups.get(owner.path) ?? [];
      bucket.push(item);
      groups.set(owner.path, bucket);
    }
    setError(null);
    try {
      const outcomes: FileQueueApplyOutcome[] = (
        await Promise.all(
          Array.from(groups.entries()).map(([workspacePath, items]) =>
            applyFileQueue(workspacePath, items),
          ),
        )
      ).flat();
      const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
      setFileQueue((current) =>
        current.map((item) => {
          const outcome = byId.get(item.id);
          if (!outcome) return item;
          return {
            ...item,
            status: "done",
            targetPath: outcome.targetPath,
            fileName: outcome.fileName,
            message: t("rightPane.files.done"),
          };
        }),
      );
      if (itemsOverride) {
        const appliedIds = new Set(itemsOverride.map((item) => item.id));
        setSelectedFileQueueItemIds((current) => current.filter((id) => !appliedIds.has(id)));
      }
      for (const workspacePath of groups.keys()) {
        await refreshWorkspaceFiles(workspacePath);
        const fresh = await scanVault(workspacePath);
        updateWorkspaceState(workspacePath, { entries: fresh });
      }
      return outcomes;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failedIds = itemsOverride ? new Set(itemsOverride.map((item) => item.id)) : null;
      setFileQueue((current) =>
        current.map((item) =>
          item.status === "queued" && (!failedIds || failedIds.has(item.id))
            ? { ...item, status: "error", message }
            : item,
        ),
      );
      setError(message);
      return [];
    }
  }, [
    fileQueue,
    refreshWorkspaceFiles,
    t,
    updateWorkspaceState,
    workspaceRegistry.workspaces,
  ]);

  const applySelectedFileQueueToDestination = useCallback(
    async (targetPath: string, targetKind: "file" | "directory", operation: FileStoreOperation) => {
      if (selectedQueuedFileQueueItems.length === 0) return;
      const targetDir =
        targetKind === "directory"
          ? targetPath
          : targetPath.split("/").slice(0, -1).join("/");
      if (!targetDir) return;
      const nextItems = selectedQueuedFileQueueItems.map((item) => ({
        ...item,
        targetDir,
        operation,
        status: "queued" as const,
        message: null,
        targetPath: null,
      }));
      setFileQueue((current) =>
        current.map((item) => nextItems.find((next) => next.id === item.id) ?? item),
      );
      await applyQueuedFiles(nextItems);
    },
    [applyQueuedFiles, selectedQueuedFileQueueItems],
  );

  const navigateBack = useCallback(() => {
    if (!selectedEntry) return;
    const { history, target } = goBack(navHistory, selectedEntry.path);
    if (!target) return;
    const entry = activeDocumentEntries.find((e) => e.path === target);
    if (!entry) return;
    setNavHistory(history);
    skipNextHistoryPushRef.current = true;
    void selectEntry(entry);
  }, [selectedEntry, navHistory, activeDocumentEntries, selectEntry]);

  const navigateForward = useCallback(() => {
    if (!selectedEntry) return;
    const { history, target } = goForward(navHistory, selectedEntry.path);
    if (!target) return;
    const entry = activeDocumentEntries.find((e) => e.path === target);
    if (!entry) return;
    setNavHistory(history);
    skipNextHistoryPushRef.current = true;
    void selectEntry(entry);
  }, [selectedEntry, navHistory, activeDocumentEntries, selectEntry]);

  const restoreDiscardedEdit = useCallback(async () => {
    if (!discardedEdit) return;
    const reqId = ++selectRequestRef.current;
    try {
      const payload = await readDocument(discardedEdit.workspacePath, discardedEdit.entry.path);
      if (reqId !== selectRequestRef.current) return;
      const restoredTab: EditorTab = {
        id: tabIdForEntry(discardedEdit.entry),
        workspacePath: discardedEdit.workspacePath,
        visibility: discardedEdit.visibility,
        entry: discardedEdit.entry,
        document: payload,
        draftContent: discardedEdit.draft,
      };
      setTabs((prev) => {
        const exists = prev.some((tab) => tab.id === restoredTab.id);
        return exists
          ? prev.map((tab) => (tab.id === restoredTab.id ? restoredTab : tab))
          : [...prev, restoredTab];
      });
      activateEditorTab(restoredTab.id, "left");
      setExplorerVisibility(restoredTab.visibility);
      setPendingSelectedPath(null);
      setDiscardedEdit(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [discardedEdit]);

  const saveTab = useCallback(async (tabId: string | null) => {
    const target = tabs.find((tab) => tab.id === tabId);
    if (!target || target.draftContent === target.document.content) return;
    const workspace = workspaceRegistry.workspaces.find(
      (item) => item.path === target.workspacePath,
    );
    if (!workspaceCan(workspace ?? null, "modify")) {
      setError(
        t("workspace.writeBlocked", {
          reason: workspaceWriteReason(workspace ?? null, "modify") ?? "workspace capabilities",
        }),
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await saveDocument(
        target.workspacePath,
        target.document.path,
        target.draftContent,
      );
      const fresh = await scanVault(target.workspacePath);
      updateWorkspaceState(target.workspacePath, { entries: fresh });
      void refreshWorkspaceFiles(target.workspacePath);
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== target.id) return tab;
          const freshEntry = fresh.find((entry) => entry.path === tab.entry.path) ?? tab.entry;
          return { ...tab, entry: freshEntry, document: saved, draftContent: saved.content };
        }),
      );
      setGitRefreshTick((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [
    t,
    tabs,
    refreshWorkspaceFiles,
    updateWorkspaceState,
    workspaceRegistry.workspaces,
  ]);

  const saveCurrent = useCallback(async () => {
    await saveTab(resolvedActiveTabId);
  }, [resolvedActiveTabId, saveTab]);

  const snapshotTab = useCallback(async (tabId: string | null) => {
    const target = tabs.find((tab) => tab.id === tabId);
    if (!target) return;
    const workspace = workspaceRegistry.workspaces.find(
      (item) => item.path === target.workspacePath,
    );
    if (!workspaceCan(workspace ?? null, "create")) {
      setError(
        t("workspace.writeBlocked", {
          reason: workspaceWriteReason(workspace ?? null, "create") ?? "workspace capabilities",
        }),
      );
      return;
    }
    setError(null);
    try {
      const snapshot = await createVersion(
        target.workspacePath,
        target.document.path,
        target.document.title,
        target.draftContent,
        t("snapshot.summary"),
      );
      const fresh = await scanVault(target.workspacePath);
      updateWorkspaceState(target.workspacePath, { entries: fresh });
      void refreshWorkspaceFiles(target.workspacePath);
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== target.id) return tab;
          const freshEntry = fresh.find((entry) => entry.path === tab.entry.path) ?? tab.entry;
          return { ...tab, entry: freshEntry };
        }),
      );
      setError(t("snapshot.success", { path: snapshot.relPath }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [
    t,
    tabs,
    refreshWorkspaceFiles,
    updateWorkspaceState,
    workspaceRegistry.workspaces,
  ]);

  const snapshotCurrent = useCallback(async () => {
    await snapshotTab(resolvedActiveTabId);
  }, [resolvedActiveTabId, snapshotTab]);

  const createNew = useCallback(
    async (title: string, docType: string, body: string, targetRelPath: string | null) => {
      if (!activeDocumentWorkspacePath) return;
      if (blockWorkspaceWrite("create")) return;
      const created = await createDocument(
        activeDocumentWorkspacePath,
        title,
        docType,
        body,
        targetRelPath,
      );
      const fresh = await scanVault(activeDocumentWorkspacePath);
      updateWorkspaceState(activeDocumentWorkspacePath, { entries: fresh });
      void refreshWorkspaceFiles(activeDocumentWorkspacePath);
      const entry =
        fresh.find((item) => item.relPath === created.relPath || item.path === created.path) ??
        ({
          path: created.path,
          relPath: created.relPath,
          title: created.title,
          frontmatter: { type: docType },
          updatedAt: null,
          wordCount: 0,
          snippet: "",
          fileKind: "md",
            versionCount: 0,
        } satisfies VaultEntry);
      const payload = await readDocument(activeDocumentWorkspacePath, created.path);
      const newTab: EditorTab = {
        id: tabIdForEntry(entry),
        workspacePath: activeDocumentWorkspacePath,
        visibility: activeDocumentWorkspace?.visibility ?? explorerVisibility,
        entry,
        document: payload,
        draftContent: payload.content,
      };
      setTabs((prev) => {
        const exists = prev.some((tab) => tab.id === newTab.id);
        return exists
          ? prev.map((tab) => (tab.id === newTab.id ? newTab : tab))
          : [...prev, newTab];
      });
      activateEditorTab(newTab.id, "left");
      setPendingSelectedPath(null);
      pushRecent(entry.path);
    },
    [
      activeDocumentWorkspace,
      activeDocumentWorkspacePath,
      explorerVisibility,
      pushRecent,
      blockWorkspaceWrite,
      refreshWorkspaceFiles,
      updateWorkspaceState,
    ],
  );

  const handleWikilinkClick = useCallback(
    (target: string) => {
      const resolved = resolveWikilinkTarget(activeDocumentEntries, target);
      if (resolved) {
        void selectEntry(resolved);
      } else {
        if (blockWorkspaceWrite("create")) return;
        setNewDocumentSeed({
          title: titleFromWikilinkTarget(target),
          relPath: target.trim(),
        });
        setNewDocumentOpen(true);
        setError(null);
      }
    },
    [activeDocumentEntries, selectEntry, blockWorkspaceWrite],
  );

  const updateField = useCallback(
    async (key: string, value: string | string[] | number | boolean | null) => {
      if (!document || !activeDocumentWorkspacePath) return;
      if (blockWorkspaceWrite("modify")) return;
      try {
        const next = await updateFrontmatterField(
          activeDocumentWorkspacePath,
          document.path,
          key,
          value,
        );
        // Refresh draft only when there are no unsaved body edits — never
        // clobber the textarea with an inspector-driven write.
        const fresh = await scanVault(activeDocumentWorkspacePath);
        updateWorkspaceState(activeDocumentWorkspacePath, { entries: fresh });
        void refreshWorkspaceFiles(activeDocumentWorkspacePath);
        updateActiveTab((tab) => {
          const freshEntry = fresh.find((entry) => entry.path === tab.entry.path) ?? tab.entry;
          return {
            ...tab,
            entry: freshEntry,
            document: next,
            draftContent: draftContent === document.content ? next.content : tab.draftContent,
          };
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      document,
      activeDocumentWorkspacePath,
      draftContent,
      updateActiveTab,
      blockWorkspaceWrite,
      refreshWorkspaceFiles,
      updateWorkspaceState,
    ],
  );

  const refreshCurrent = useCallback(async () => {
    if (!explorerWorkspacePath) return;
    const lastRel =
      typeof window !== "undefined"
        ? window.localStorage.getItem(lastOpenKeyForWorkspace(explorerWorkspacePath))
        : null;
    await loadWorkspace(explorerWorkspacePath, explorerVisibility, lastRel);
  }, [
    explorerVisibility,
    explorerWorkspacePath,
    lastOpenKeyForWorkspace,
    loadWorkspace,
  ]);

  const installUpdate = useCallback(
    async (update: AppUpdateCheckResult["update"], info: AppUpdateInfo) => {
      if (installingUpdateRef.current) return;
      installingUpdateRef.current = true;
      setUpdateToast({ kind: "downloading", info, progress: null });
      try {
        await installAppUpdate(update, (progress) => {
          setUpdateToast({ kind: "downloading", info, progress });
        });
        setUpdateToast({ kind: "ready", info });
        await relaunchApp();
      } catch (err) {
        setUpdateToast({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        installingUpdateRef.current = false;
      }
    },
    [],
  );

  const checkForUpdates = useCallback(async (
    options: boolean | { manual?: boolean; autoInstall?: boolean } = false,
  ) => {
    const manual = typeof options === "boolean" ? options : options.manual ?? false;
    const autoInstall =
      typeof options === "boolean" ? false : options.autoInstall ?? false;

    if (!updaterAvailable()) {
      if (manual) setUpdateToast({ kind: "error", message: t("updates.desktopOnly") });
      return;
    }
    if (installingUpdateRef.current) return;
    if (manual) setUpdateToast({ kind: "checking" });
    try {
      const result = await checkAppUpdate();
      if (!result) {
        if (manual) setUpdateToast({ kind: "notAvailable" });
        return;
      }
      pendingUpdateRef.current = result.update;
      if (autoInstall) {
        await installUpdate(result.update, result.info);
        return;
      }
      setUpdateToast({ kind: "available", info: result.info });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (manual) {
        setUpdateToast({ kind: "error", message });
      } else {
        console.info("[anchor] update check failed:", message);
      }
    }
  }, [installUpdate, t]);

  const installPendingUpdate = useCallback(async () => {
    const update = pendingUpdateRef.current;
    if (!update || updateToast?.kind !== "available") return;
    await installUpdate(update, updateToast.info);
  }, [installUpdate, updateToast]);

  useEffect(() => {
    if (!updaterAvailable()) return;
    const timer = window.setTimeout(() => {
      void checkForUpdates({ autoInstall: true });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [checkForUpdates]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenForCheckUpdatesMenu(() => {
      void checkForUpdates(true);
    })
      .then((off) => {
        if (disposed) {
          off();
        } else {
          unlisten = off;
        }
      })
      .catch((err) => {
        console.info("[anchor] update menu listener unavailable:", err);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [checkForUpdates]);

  const focusSearch = useCallback(() => {
    if (!documentsPaneOpen) {
      updateLayoutSettings({ documentsPaneOpen: true });
      window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return;
    }
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [documentsPaneOpen, updateLayoutSettings]);

  const openCommandPalette = useCallback(() => {
    setCommandPaletteOpen(true);
  }, []);

  const closeCommandPalette = useCallback(() => {
    setCommandPaletteOpen(false);
  }, []);

  const openAddWorkspaceDialog = useCallback((visibility: WorkspaceVisibility = explorerVisibility) => {
    setAddWorkspaceDefaultVisibility(visibility);
    setAddWorkspaceOpen(true);
  }, [explorerVisibility]);

  const openPreferences = useCallback(() => {
    void openSettingsWindow(settingsWorkPath).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [settingsWorkPath]);

  const toggleLocale = useCallback(() => {
    setLocale(locale === "ko" ? "en" : "ko");
  }, [locale, setLocale]);

  const refreshActiveSurface = useCallback(() => {
    if (appMode === "inbox") {
      void refreshInbox();
      void refreshGmail();
    } else if (anchorSettings.ui.explorerPaneMode === "files" && explorerWorkspacePath) {
      void refreshWorkspaceFiles(explorerWorkspacePath);
    } else {
      void refreshCurrent();
    }
  }, [
    anchorSettings.ui.explorerPaneMode,
    appMode,
    explorerWorkspacePath,
    refreshCurrent,
    refreshGmail,
    refreshInbox,
    refreshWorkspaceFiles,
  ]);

  const revealTargetInFinder = useCallback(
    (targetPath: string) => {
      const workspacePath =
        workspaceRegistry.workspaces
          .filter(
            (workspace) =>
              targetPath === workspace.path || targetPath.startsWith(`${workspace.path}/`),
          )
          .sort((a, b) => b.path.length - a.path.length)[0]?.path ??
        explorerWorkspacePath;
      if (!workspacePath) return;
      void revealInFileManager(workspacePath, targetPath).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    },
    [explorerWorkspacePath, workspaceRegistry.workspaces],
  );

  const selectTab = useCallback(
    (tabId: string, group: EditorGroupId = focusedEditorGroup) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab) return;
      activateEditorTab(tabId, group);
      setExplorerVisibility(tab.visibility);
      pushRecent(tab.entry.path);
    },
    [activateEditorTab, focusedEditorGroup, tabs, pushRecent],
  );

  const copyTextToClipboard = useCallback((value: string) => {
    void navigator.clipboard.writeText(value).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  const refreshAfterDocumentMutation = useCallback(
    async (workspacePath: string) => {
      const fresh = await scanVault(workspacePath);
      updateWorkspaceState(workspacePath, { entries: fresh });
      await refreshWorkspaceFiles(workspacePath);
      setGitRefreshTick((n) => n + 1);
      return fresh;
    },
    [refreshWorkspaceFiles, updateWorkspaceState],
  );

  const entryFromPayload = useCallback(
    (
      payload: DocumentPayload,
      freshEntries: VaultEntry[],
      fallback: VaultEntry,
    ): VaultEntry =>
      freshEntries.find((entry) => entry.path === payload.path || entry.relPath === payload.relPath) ??
      {
        ...fallback,
        path: payload.path,
        relPath: payload.relPath,
        title: payload.title,
        wordCount: payload.body.split(/\s+/).filter(Boolean).length,
        snippet: payload.body.replace(/\s+/g, " ").slice(0, 220),
        fileKind: payload.fileKind,
        frontmatter: payload.meta,
      },
    [],
  );

  const replaceMovedTab = useCallback(
    (oldTab: EditorTab, payload: DocumentPayload, entry: VaultEntry) => {
      const nextId = tabIdForEntry(entry);
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === oldTab.id
            ? {
                ...tab,
                id: nextId,
                entry,
                document: payload,
                draftContent:
                  oldTab.draftContent === oldTab.document.content
                    ? payload.content
                    : oldTab.draftContent,
              }
            : tab,
        ),
      );
      const replaced = replaceEditorTabIds(
        { activeTabId, leftActiveTabId, rightActiveTabId },
        oldTab.id,
        nextId,
      );
      setActiveTabId(replaced.activeTabId);
      setLeftActiveTabId(replaced.leftActiveTabId);
      setRightActiveTabId(replaced.rightActiveTabId);
      pushRecent(entry.path);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(lastOpenKeyForWorkspace(oldTab.workspacePath), entry.relPath);
      }
    },
    [activeTabId, leftActiveTabId, rightActiveTabId, pushRecent, lastOpenKeyForWorkspace],
  );

  const blockTabWrite = useCallback(
    (
      tab: EditorTab,
      action: "create" | "modify" | "delete" | "renameMove",
    ) => {
      const workspace =
        workspaceRegistry.workspaces.find((item) => item.path === tab.workspacePath) ?? null;
      if (workspaceCan(workspace, action)) return false;
      setError(
        t("workspace.writeBlocked", {
          reason: workspaceWriteReason(workspace, action) ?? "workspace capabilities",
        }),
      );
      return true;
    },
    [t, workspaceRegistry.workspaces],
  );

  const applyExplorerDragSourcesToDestination = useCallback(
    async (
      payload: ExplorerDragPayload,
      targetPath: string,
      targetKind: "file" | "directory",
      operation: FileStoreOperation,
    ) => {
      const targetDir = targetDirForDropTarget(targetPath, targetKind);
      const items =
        operation === "move"
          ? payload.items.filter((item) => !isSameParentMove(item, targetDir))
          : payload.items;
      if (items.length === 0) return;
      if (operation === "move") {
        const dirtyTab = tabs.find(
          (tab) =>
            tab.draftContent !== tab.document.content &&
            items.some((item) => dragItemContainsPath(item, tab.document.path)),
        );
        if (dirtyTab) {
          setError(
            t("rightPane.files.moveDirtyBlocked", {
              path: dirtyTab.document.relPath,
            }),
          );
          return;
        }
      }
      const seed = Date.now();
      const queueItems = sourcesFromExplorerPayload({ ...payload, items }).map((source, index) =>
        fileQueueItemFromSource(source, targetDir, operation, seed, index),
      );
      setFileQueue((current) => [...current, ...queueItems]);
      setSelectedFileQueueItemIds(queueItems.map((item) => item.id));
      setPersistedAppMode("pkm");
      if (!outlineOpen) updateLayoutSettings({ outlineOpen: true });
      setPersistedRightPaneTab("files");
      setError(null);
      const outcomes = await applyQueuedFiles(queueItems);
      if (operation !== "move" || outcomes.length === 0) return;

      const outcomeBySource = new Map(outcomes.map((outcome) => [outcome.sourcePath, outcome]));
      const movedByTabId = new Map<
        string,
        {
          nextId: string;
          workspace: WorkspaceRootEntry;
          nextPath: string;
          relPath: string;
        }
      >();
      for (const tab of tabs) {
        const moved = items
          .map((item) => {
            const outcome = outcomeBySource.get(item.path);
            if (!outcome || !dragItemContainsPath(item, tab.document.path)) return null;
            const nextPath =
              item.sourceKind === "directory"
                ? `${outcome.targetPath}/${tab.document.path.slice(item.path.length + 1)}`
                : outcome.targetPath;
            const workspace =
              workspaceForTargetPath(workspaceRegistry.workspaces, nextPath) ??
              workspaceRegistry.workspaces.find(
                (candidate) => candidate.path === tab.workspacePath,
              ) ??
              null;
            if (!workspace) return null;
            return {
              workspace,
              nextPath,
              relPath: relativePathForWorkspace(workspace.path, nextPath),
            };
          })
          .find(Boolean);
        if (!moved) continue;
        movedByTabId.set(tab.id, {
          ...moved,
          nextId: tabIdForEntry({ ...tab.entry, path: moved.nextPath, relPath: moved.relPath }),
        });
      }
      if (movedByTabId.size === 0) return;
      setTabs((currentTabs) =>
        currentTabs.map((tab) => {
          const moved = movedByTabId.get(tab.id);
          if (!moved) return tab;
          const entry = {
            ...tab.entry,
            path: moved.nextPath,
            relPath: moved.relPath,
          };
          return {
            ...tab,
            id: moved.nextId,
            workspacePath: moved.workspace.path,
            visibility: moved.workspace.visibility,
            entry,
            document: {
              ...tab.document,
              path: moved.nextPath,
              relPath: moved.relPath,
            },
          };
        }),
      );
      const replacements = new Map(
        Array.from(movedByTabId.entries()).map(([tabId, moved]) => [tabId, moved.nextId]),
      );
      const replaceId = (id: string | null) => (id ? replacements.get(id) ?? id : id);
      setActiveTabId((id) => replaceId(id));
      setLeftActiveTabId((id) => replaceId(id));
      setRightActiveTabId((id) => replaceId(id));
      for (const item of movedByTabId.values()) {
        pushRecent(item.nextPath);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(lastOpenKeyForWorkspace(item.workspace.path), item.relPath);
        }
      }
    },
    [
      applyQueuedFiles,
      lastOpenKeyForWorkspace,
      outlineOpen,
      pushRecent,
      setPersistedAppMode,
      setPersistedRightPaneTab,
      t,
      tabs,
      updateLayoutSettings,
      workspaceRegistry.workspaces,
    ],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const closing = tabs.find((tab) => tab.id === tabId);
      if (closing && closing.draftContent !== closing.document.content) {
        setDiscardedEdit({
          workspacePath: closing.workspacePath,
          visibility: closing.visibility,
          entry: closing.entry,
          draft: closing.draftContent,
        });
      }
      setTabs((prev) => {
        const closingIndex = prev.findIndex((tab) => tab.id === tabId);
        if (closingIndex === -1) return prev;
        const next = prev.filter((tab) => tab.id !== tabId);
        const fallback = next[Math.min(closingIndex, next.length - 1)] ?? null;
        if (leftResolvedTabId === tabId) setLeftActiveTabId(fallback?.id ?? null);
        if (rightResolvedTabId === tabId) setRightActiveTabId(null);
        if (resolvedActiveTabId === tabId) setActiveTabId(fallback?.id ?? null);
        return next;
      });
    },
    [leftResolvedTabId, resolvedActiveTabId, rightResolvedTabId, tabs],
  );

  const closeTabsByIds = useCallback(
    (tabIds: string[]) => {
      const closeSet = new Set(tabIds);
      if (closeSet.size === 0) return;
      const dirtyClosing = tabs.find(
        (tab) => closeSet.has(tab.id) && tab.draftContent !== tab.document.content,
      );
      if (dirtyClosing) {
        setDiscardedEdit({
          workspacePath: dirtyClosing.workspacePath,
          visibility: dirtyClosing.visibility,
          entry: dirtyClosing.entry,
          draft: dirtyClosing.draftContent,
        });
      }
      setTabs((prev) => {
        const closingIndex = prev.findIndex((tab) => closeSet.has(tab.id));
        const next = prev.filter((tab) => !closeSet.has(tab.id));
        const fallback = next[Math.min(Math.max(closingIndex, 0), next.length - 1)] ?? null;
        if (leftResolvedTabId && closeSet.has(leftResolvedTabId)) {
          setLeftActiveTabId(fallback?.id ?? null);
        }
        if (rightResolvedTabId && closeSet.has(rightResolvedTabId)) {
          setRightActiveTabId(null);
          updateLayoutSettings({ editorSplitOpen: false });
        }
        if (resolvedActiveTabId && closeSet.has(resolvedActiveTabId)) {
          setActiveTabId(fallback?.id ?? null);
        }
        return next;
      });
    },
    [
      leftResolvedTabId,
      resolvedActiveTabId,
      rightResolvedTabId,
      tabs,
      updateLayoutSettings,
    ],
  );

  const closeOtherTabs = useCallback(
    (tabId: string) => {
      if (!tabs.some((tab) => tab.id === tabId)) return;
      closeTabsByIds(tabIdsToCloseOthers(tabs, tabId));
      setLeftActiveTabId(tabId);
      setRightActiveTabId(null);
      setActiveTabId(tabId);
      setFocusedEditorGroup("left");
      updateLayoutSettings({ editorSplitOpen: false });
    },
    [closeTabsByIds, tabs, updateLayoutSettings],
  );

  const closeTabsToRight = useCallback(
    (tabId: string) => {
      closeTabsByIds(tabIdsToCloseRight(tabs, tabId));
    },
    [closeTabsByIds, tabs],
  );

  const closeSavedTabs = useCallback(() => {
    const summaries = tabs.map((tab) => ({
      id: tab.id,
      dirty: tab.draftContent !== tab.document.content,
    }));
    closeTabsByIds(tabIdsToCloseSaved(summaries));
  }, [closeTabsByIds, tabs]);

  const copyTabName = useCallback(
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (tab) copyTextToClipboard(documentDisplayName(tab.document, anchorSettings.ui.documentLabelMode));
    },
    [anchorSettings.ui.documentLabelMode, copyTextToClipboard, tabs],
  );

  const copyTabPath = useCallback(
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (tab) copyTextToClipboard(tab.document.path);
    },
    [copyTextToClipboard, tabs],
  );

  const copyTabRelativePath = useCallback(
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (tab) copyTextToClipboard(tab.document.relPath);
    },
    [copyTextToClipboard, tabs],
  );

  const renameTabDocument = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab || blockTabWrite(tab, "renameMove")) return;
      const parts = tab.document.relPath.split("/");
      const fileName = parts.pop() ?? tab.document.relPath;
      const currentStem = fileName.replace(/\.(md|markdown)$/i, "");
      const input = window.prompt(t("editor.tabs.rename.prompt"), currentStem);
      if (input == null) return;
      const nextStem = input.trim().replace(/\.(md|markdown)$/i, "");
      if (!nextStem) return;
      if (/[\\/]/.test(nextStem)) {
        setError(t("editor.tabs.rename.invalid"));
        return;
      }
      const targetRelPath = `${parts.length > 0 ? `${parts.join("/")}/` : ""}${nextStem}.md`;
      try {
        const moved = await moveDocument(tab.workspacePath, tab.document.path, targetRelPath);
        const fresh = await refreshAfterDocumentMutation(tab.workspacePath);
        const entry = entryFromPayload(moved, fresh, tab.entry);
        replaceMovedTab(tab, moved, entry);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      blockTabWrite,
      entryFromPayload,
      refreshAfterDocumentMutation,
      replaceMovedTab,
      t,
      tabs,
    ],
  );

  const moveTabDocument = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab || blockTabWrite(tab, "renameMove")) return;
      const input = window.prompt(t("editor.tabs.move.prompt"), tab.document.relPath);
      if (input == null || !input.trim()) return;
      try {
        const moved = await moveDocument(tab.workspacePath, tab.document.path, input);
        const fresh = await refreshAfterDocumentMutation(tab.workspacePath);
        const entry = entryFromPayload(moved, fresh, tab.entry);
        replaceMovedTab(tab, moved, entry);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      blockTabWrite,
      entryFromPayload,
      refreshAfterDocumentMutation,
      replaceMovedTab,
      t,
      tabs,
    ],
  );

  const duplicateTabDocument = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab || blockTabWrite(tab, "create")) return;
      try {
        const duplicated = await duplicateDocument(tab.workspacePath, tab.document.path);
        const fresh = await refreshAfterDocumentMutation(tab.workspacePath);
        const entry = entryFromPayload(duplicated, fresh, tab.entry);
        const newTab: EditorTab = {
          id: tabIdForEntry(entry),
          workspacePath: tab.workspacePath,
          visibility: tab.visibility,
          entry,
          document: duplicated,
          draftContent: duplicated.content,
        };
        setTabs((prev) => {
          const exists = prev.some((item) => item.id === newTab.id);
          return exists
            ? prev.map((item) => (item.id === newTab.id ? newTab : item))
            : [...prev, newTab];
        });
        activateEditorTab(newTab.id, "left");
        setExplorerVisibility(tab.visibility);
        setPendingSelectedPath(null);
        pushRecent(entry.path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      activateEditorTab,
      blockTabWrite,
      entryFromPayload,
      pushRecent,
      refreshAfterDocumentMutation,
      tabs,
    ],
  );

  const trashTabDocument = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab || blockTabWrite(tab, "delete")) return;
      if (
        !window.confirm(
          t("editor.tabs.delete.confirm", {
            path: tab.document.relPath,
          }),
        )
      ) {
        return;
      }
      try {
        const deleted = await trashDocument(tab.workspacePath, tab.document.path);
        await refreshAfterDocumentMutation(tab.workspacePath);
        closeTab(tab.id);
        setError(t("editor.tabs.delete.success", { path: deleted.trashRelPath }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [blockTabWrite, closeTab, refreshAfterDocumentMutation, t, tabs],
  );

  const revealTabInFinder = useCallback(
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (tab) revealTargetInFinder(tab.document.path);
    },
    [revealTargetInFinder, tabs],
  );

  const revealTabInExplorer = useCallback(
    (tabId: string, group: EditorGroupId) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab) return;
      const activePane = anchorSettings.ui.explorerPaneMode;
      setPersistedAppMode("pkm");
      if (!documentsPaneOpen) updateLayoutSettings({ documentsPaneOpen: true });
      setExplorerVisibility(tab.visibility);
      if (activePane === "documents") {
        setDocumentBrowserMode("tree");
        setExplorerQuery("");
        setExplorerTypeFilter(null);
        setCollapsedTreeFoldersByVisibility((current) => {
          const existing = current[tab.visibility] ?? [];
          return {
            ...current,
            [tab.visibility]: expandDocumentAncestors(existing, tab.entry.relPath),
          };
        });
      } else {
        setWorkspaceFileFilter("all");
        setWorkspaceFileQuery("");
        setCollapsedFileFoldersByVisibility((current) => {
          const existing = current[tab.visibility] ?? [];
          return {
            ...current,
            [tab.visibility]: expandWorkspaceFileAncestors(existing, tab.entry.relPath),
          };
        });
        setSelectedFilePathsByWorkspace((current) => ({
          ...current,
          [tab.workspacePath]: [tab.document.path],
        }));
        void refreshWorkspaceFiles(tab.workspacePath);
      }
      selectTab(tab.id, group);
      setPendingExplorerReveal({ pane: activePane, targetPath: tab.document.path });
    },
    [
      anchorSettings.ui.explorerPaneMode,
      documentsPaneOpen,
      refreshWorkspaceFiles,
      selectTab,
      setDocumentBrowserMode,
      setExplorerQuery,
      setExplorerTypeFilter,
      setWorkspaceFileFilter,
      setWorkspaceFileQuery,
      setPersistedAppMode,
      tabs,
      updateLayoutSettings,
    ],
  );

  const closeRightEditorPane = useCallback(() => {
    setRightActiveTabId(null);
    setFocusedEditorGroup("left");
    if (leftResolvedTabId) setActiveTabId(leftResolvedTabId);
    updateLayoutSettings({ editorSplitOpen: false });
  }, [leftResolvedTabId, updateLayoutSettings]);

  const closeAllCleanTabs = useCallback(() => {
    const dirtyTabs = tabs.filter((tab) => tab.draftContent !== tab.document.content);
    setTabs(dirtyTabs);
    const fallback = dirtyTabs[0]?.id ?? null;
    setLeftActiveTabId(fallback);
    setRightActiveTabId(null);
    setActiveTabId(fallback);
    setFocusedEditorGroup("left");
    updateLayoutSettings({ editorSplitOpen: false });
    if (dirtyTabs.length > 0) {
      setError(t("editor.tabs.closeAll.dirtyKept", { count: dirtyTabs.length }));
    }
  }, [tabs, t, updateLayoutSettings]);

  const splitEditorRight = useCallback(() => {
    const target = activeTab ?? leftTab ?? tabs[0] ?? null;
    if (!target) return;
    setRightActiveTabId(target.id);
    setActiveTabId(target.id);
    setFocusedEditorGroup("right");
    updateLayoutSettings({ editorSplitOpen: true });
  }, [activeTab, leftTab, tabs, updateLayoutSettings]);

  const splitTerminalRight = useCallback(() => {
    updateLayoutSettings({ terminalOpen: true, terminalSplitOpen: true });
  }, [updateLayoutSettings]);

  const splitActiveSurfaceRight = useCallback(() => {
    const active = window.document.activeElement as HTMLElement | null;
    if (active?.closest(".terminal-panel")) {
      splitTerminalRight();
      return;
    }
    splitEditorRight();
  }, [splitEditorRight, splitTerminalRight]);

  const selectTabByIndex = useCallback(
    (index: number) => {
      const tab = tabs[index];
      if (tab) selectTab(tab.id);
    },
    [tabs, selectTab],
  );

  const handleCommitClick = useCallback(
    (status: GitStatus) => {
      if (blockWorkspaceWrite("modify")) return;
      if (!activeDocumentWorkspacePath) return;
      setCommitDialog({ path: activeDocumentWorkspacePath, status });
    },
    [activeDocumentWorkspacePath, blockWorkspaceWrite],
  );

  const jumpToOutlineLine = useCallback((line: number) => {
    const jump = () => {
      const ta =
        focusedEditorGroup === "right"
          ? rightEditorTextareaRef.current
          : editorTextareaRef.current;
      if (!ta) return false;
      const lines = ta.value.split("\n");
      let pos = 0;
      for (let i = 0; i < line && i < lines.length; i++) pos += lines[i].length + 1;
      ta.focus();
      ta.setSelectionRange(pos, pos + (lines[line]?.length ?? 0));
      const lineHeight = parseFloat(getComputedStyle(ta).lineHeight || "20");
      ta.scrollTop = Math.max(0, line * lineHeight - ta.clientHeight / 3);
      return true;
    };
    if (jump()) return;
    setPersistedEditorViewMode("source");
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(jump);
    });
  }, [focusedEditorGroup, setPersistedEditorViewMode]);

  const runCommand = useCallback(
    (id: string) => {
      switch (id) {
        case "new-document":
          openNewDocumentDialog();
          break;
        case "save":
          void saveCurrent();
          break;
        case "snapshot":
          void snapshotCurrent();
          break;
        case "split-right":
          splitEditorRight();
          break;
        case "close-all-tabs":
          closeAllCleanTabs();
          break;
        case "toggle-preview":
          setPersistedEditorViewMode(editorViewMode === "preview" ? "rich" : "preview");
          break;
        case "toggle-outline":
          updateLayoutSettings({ outlineOpen: !outlineOpen });
          break;
        case "toggle-locale":
          toggleLocale();
          break;
        case "refresh-workspace":
          refreshActiveSurface();
          break;
        case "open-inbox":
          setPersistedAppMode("inbox");
          break;
        case "open-docs":
          setPersistedAppMode("pkm");
          break;
        case "add-workspace":
          openAddWorkspaceDialog();
          break;
        case "open-settings":
          openPreferences();
          break;
        case "check-updates":
          void checkForUpdates(true);
          break;
      }
    },
    [
      saveCurrent,
      snapshotCurrent,
      refreshActiveSurface,
      toggleLocale,
      openAddWorkspaceDialog,
      openNewDocumentDialog,
      openPreferences,
      checkForUpdates,
      splitEditorRight,
      closeAllCleanTabs,
      editorViewMode,
      setPersistedAppMode,
      setPersistedEditorViewMode,
      updateLayoutSettings,
      outlineOpen,
    ],
  );

  useKeyboardShortcuts(
    {
      "mod+s": () => void saveCurrent(),
      "mod+shift+s": () => void snapshotCurrent(),
      "mod+n": openNewDocumentDialog,
      "mod+d": splitActiveSurfaceRight,
      "mod+k": () => setCommandPaletteOpen((v) => !v),
      "mod+p": () =>
        setPersistedEditorViewMode(editorViewMode === "preview" ? "rich" : "preview"),
      "mod+\\": () => updateLayoutSettings({ outlineOpen: !outlineOpen }),
      "mod+f": focusSearch,
      "mod+r": refreshActiveSurface,
      "mod+shift+l": toggleLocale,
      "mod+,": openPreferences,
      "mod+[": navigateBack,
      "mod+]": navigateForward,
      "mod+1": () => selectTabByIndex(0),
      "mod+2": () => selectTabByIndex(1),
      "mod+3": () => selectTabByIndex(2),
      "mod+4": () => selectTabByIndex(3),
      "mod+5": () => selectTabByIndex(4),
      "mod+6": () => selectTabByIndex(5),
      "mod+7": () => selectTabByIndex(6),
      "mod+8": () => selectTabByIndex(7),
      "mod+w": () => {
        if (resolvedActiveTabId) closeTab(resolvedActiveTabId);
      },
    },
    [
      saveCurrent,
      snapshotCurrent,
      focusSearch,
      toggleLocale,
      refreshActiveSurface,
      navigateBack,
      navigateForward,
      selectTabByIndex,
      openNewDocumentDialog,
      openPreferences,
      splitActiveSurfaceRight,
      closeTab,
      editorViewMode,
      resolvedActiveTabId,
      setPersistedEditorViewMode,
      updateLayoutSettings,
      outlineOpen,
    ],
  );

  const selectAdjacentTab = useCallback(
    (delta: number) => {
      if (tabs.length === 0) return;
      const currentIndex = Math.max(
        0,
        tabs.findIndex((tab) => tab.id === resolvedActiveTabId),
      );
      const nextIndex = (currentIndex + delta + tabs.length) % tabs.length;
      selectTab(tabs[nextIndex].id);
    },
    [resolvedActiveTabId, selectTab, tabs],
  );

  const openCommitDialogFromMenu = useCallback(async () => {
    if (!activeDocumentWorkspacePath) return;
    if (blockWorkspaceWrite("modify")) return;
    try {
      const status = await gitStatus(activeDocumentWorkspacePath);
      setCommitDialog({ path: activeDocumentWorkspacePath, status });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeDocumentWorkspacePath, blockWorkspaceWrite]);

  const runMenuCommand = useCallback(
    (id: string) => {
      switch (id) {
        case "file.new_document":
          openNewDocumentDialog();
          break;
        case "file.save":
          void saveCurrent();
          break;
        case "file.snapshot":
          void snapshotCurrent();
          break;
        case "file.add_workspace":
          openAddWorkspaceDialog();
          break;
        case "file.preferences":
          openPreferences();
          break;
        case "view.documents":
          setExplorerPaneMode("documents");
          break;
        case "view.files":
          setExplorerPaneMode("files");
          break;
        case "view.toggle_types":
          updateLayoutSettings({ documentTypesPaneOpen: !documentTypesPaneOpen });
          break;
        case "view.toggle_documents":
          updateLayoutSettings({ documentsPaneOpen: !documentsPaneOpen });
          break;
        case "view.toggle_right":
          updateLayoutSettings({ outlineOpen: !outlineOpen });
          break;
        case "view.command_palette":
          setCommandPaletteOpen((value) => !value);
          break;
        case "go.back":
          navigateBack();
          break;
        case "go.forward":
          navigateForward();
          break;
        case "go.private_workspace": {
          const path = workspaceRegistry.activeByVisibility.private;
          if (path) void switchActiveWorkspace(path, "private");
          break;
        }
        case "go.public_workspace": {
          const path = workspaceRegistry.activeByVisibility.public;
          if (path) void switchActiveWorkspace(path, "public");
          break;
        }
        case "go.previous_tab":
          selectAdjacentTab(-1);
          break;
        case "go.next_tab":
          selectAdjacentTab(1);
          break;
        case "terminal.shell":
        case "terminal.claude":
        case "terminal.codex":
          setTerminalLaunchRequest({
            kind: id.split(".")[1] as TerminalKind,
            nonce: Date.now(),
          });
          updateLayoutSettings({ terminalOpen: true });
          break;
        case "terminal.split":
          splitTerminalRight();
          break;
        case "workspace.refresh":
          refreshActiveSurface();
          break;
        case "workspace.reveal":
          if (explorerWorkspacePath) revealTargetInFinder(explorerWorkspacePath);
          break;
        case "workspace.commit":
          void openCommitDialogFromMenu();
          break;
      }
    },
    [
      documentTypesPaneOpen,
      documentsPaneOpen,
      explorerWorkspacePath,
      navigateBack,
      navigateForward,
      openAddWorkspaceDialog,
      openCommitDialogFromMenu,
      openNewDocumentDialog,
      openPreferences,
      outlineOpen,
      refreshActiveSurface,
      revealTargetInFinder,
      saveCurrent,
      selectAdjacentTab,
      setExplorerPaneMode,
      snapshotCurrent,
      splitTerminalRight,
      switchActiveWorkspace,
      updateLayoutSettings,
      workspaceRegistry.activeByVisibility.private,
      workspaceRegistry.activeByVisibility.public,
    ],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenForMenuCommand((id) => {
      runMenuCommand(id);
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch((err) => {
        console.info("[anchor] menu listener unavailable:", err);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [runMenuCommand]);

  const modeClass = appMode === "inbox" ? " inbox-mode" : "";
  const terminalMaximizedClass =
    anchorSettings.ui.layout.terminalOpen && anchorSettings.ui.layout.terminalMaximized
      ? " terminal-maximized"
      : "";
  const shellClass = `app-shell${modeClass}${outlineOpen ? "" : " outline-closed"}${
    documentTypesPaneOpen ? "" : " types-closed"
  }${documentsPaneOpen ? "" : " documents-closed"}${terminalMaximizedClass}`;
  const themeVars = useMemo(() => buildThemeVars(anchorSettings), [anchorSettings]);
  const shellStyle = useMemo(
    () =>
      ({
        ...themeVars,
        "--documents-col": documentsPaneOpen
          ? `${layoutSettings.documentsPaneWidth}px`
          : "0px",
        "--outline-col": outlineOpen ? `${layoutSettings.outlinePaneWidth}px` : "0px",
      }) as React.CSSProperties & Record<`--${string}`, string>,
    [
      documentsPaneOpen,
      layoutSettings.documentsPaneWidth,
      layoutSettings.outlinePaneWidth,
      outlineOpen,
      themeVars,
    ],
  );
  const editorSplitStyle =
    editorSplitOpen && rightTab
      ? {
          gridTemplateColumns: `${layoutSettings.editorSplitRatio}fr 6px ${1 - layoutSettings.editorSplitRatio}fr`,
        }
      : undefined;

  const startEditorSplitResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const shell = editorSplitShellRef.current;
      if (!shell) return;
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      handle.setPointerCapture(pointerId);

      const update = (clientX: number) => {
        const rect = shell.getBoundingClientRect();
        if (rect.width <= 0) return;
        const editorSplitRatio = Math.min(
          0.7,
          Math.max(0.3, (clientX - rect.left) / rect.width),
        );
        updateLayoutSettings({ editorSplitRatio });
      };
      update(event.clientX);

      const cleanup = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      };
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== pointerId) return;
        update(move.clientX);
      };
      const onEnd = (end: PointerEvent) => {
        if (end.pointerId !== pointerId) return;
        cleanup();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    },
    [updateLayoutSettings],
  );

  const startDocumentsPaneResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      handle.setPointerCapture(pointerId);

      const update = (clientX: number) => {
        const paneRect = documentsPaneRef.current?.getBoundingClientRect();
        if (!paneRect) return;
        updateLayoutSettings({
          documentsPaneWidth: clampPaneWidth(
            clientX - paneRect.left,
            MIN_DOCUMENTS_PANE_WIDTH,
            MAX_DOCUMENTS_PANE_WIDTH,
          ),
        });
      };
      update(event.clientX);

      const cleanup = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      };
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== pointerId) return;
        update(move.clientX);
      };
      const onEnd = (end: PointerEvent) => {
        if (end.pointerId !== pointerId) return;
        cleanup();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    },
    [updateLayoutSettings],
  );

  const startOutlinePaneResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const shellRect = appShellRef.current?.getBoundingClientRect();
      const paneRect = outlinePaneRef.current?.getBoundingClientRect();
      if (!shellRect || !paneRect) return;
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      handle.setPointerCapture(pointerId);

      const update = (clientX: number) => {
        updateLayoutSettings({
          outlinePaneWidth: clampPaneWidth(
            paneRect.right - clientX,
            MIN_OUTLINE_PANE_WIDTH,
            MAX_OUTLINE_PANE_WIDTH,
          ),
        });
      };
      update(event.clientX);

      const cleanup = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      };
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== pointerId) return;
        update(move.clientX);
      };
      const onEnd = (end: PointerEvent) => {
        if (end.pointerId !== pointerId) return;
        cleanup();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    },
    [updateLayoutSettings],
  );

  const renderEditorPane = (
    group: EditorGroupId,
    tab: EditorTab | null,
    tabId: string | null,
  ) => {
    const workspace = tab
      ? workspaceRegistry.workspaces.find((item) => item.path === tab.workspacePath) ?? null
      : activeDocumentWorkspace;
    const caps = workspaceCapabilities(workspace);
    const readOnlyReason = workspaceWriteReason(workspace);
    const groupTabs =
      group === "right" && tab
        ? editorTabSummaries.filter((summary) => summary.id === tab.id)
        : editorTabSummaries;
    return (
      <EditorPane
        document={tab?.document ?? null}
        openingEntry={group === "left" ? openingEntry : null}
        draftContent={tab?.draftContent ?? ""}
        saving={saving && resolvedActiveTabId === tabId}
        dirty={Boolean(tab && tab.draftContent !== tab.document.content)}
        outlineOpen={outlineOpen}
        activeWorkspaceLabel={workspace?.label ?? null}
        documentLabel={
          tab ? documentDisplayName(tab.document, anchorSettings.ui.documentLabelMode) : null
        }
        readOnly={!caps.canModify}
        canSnapshot={caps.canCreate}
        readOnlyReason={readOnlyReason}
        viewMode={editorViewMode}
        tabs={groupTabs}
        activeTabId={tabId}
        entries={tab ? workspaceStates[tab.workspacePath]?.entries ?? entries : entries}
        onChange={(content) => {
          if (!tabId) return;
          activateEditorTab(tabId, group);
          updateTabDraft(tabId, content);
        }}
        onSelectTab={(nextTabId) => selectTab(nextTabId, group)}
        onCloseTab={(nextTabId) => {
          if (group === "right") closeRightEditorPane();
          else closeTab(nextTabId);
        }}
        onCloseOtherTabs={closeOtherTabs}
        onCloseTabsToRight={closeTabsToRight}
        onCloseSavedTabs={closeSavedTabs}
        onCloseAllTabs={closeAllCleanTabs}
        onCopyTabName={copyTabName}
        onCopyTabPath={copyTabPath}
        onCopyTabRelativePath={copyTabRelativePath}
        onRenameTab={(nextTabId) => void renameTabDocument(nextTabId)}
        onMoveTab={(nextTabId) => void moveTabDocument(nextTabId)}
        onDuplicateTab={(nextTabId) => void duplicateTabDocument(nextTabId)}
        onDeleteTab={(nextTabId) => void trashTabDocument(nextTabId)}
        onOpenTabPreview={(nextTabId) => {
          selectTab(nextTabId, group);
          setPersistedEditorViewMode("preview");
        }}
        onRevealTabInFinder={revealTabInFinder}
        onRevealTabInExplorer={(nextTabId) => revealTabInExplorer(nextTabId, group)}
        onSave={() => void saveTab(tabId)}
        onSnapshot={() => void snapshotTab(tabId)}
        onSplitRight={splitEditorRight}
        onFocusPane={() => {
          if (tabId) activateEditorTab(tabId, group);
        }}
        onToggleOutline={() => updateLayoutSettings({ outlineOpen: !outlineOpen })}
        onViewModeChange={setPersistedEditorViewMode}
        onWikilinkClick={handleWikilinkClick}
        textareaRef={group === "right" ? rightEditorTextareaRef : editorTextareaRef}
      />
    );
  };

  const handleTopbarPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (
      target.closest(
        "button,input,select,textarea,a,[role='button'],[data-no-drag='true']",
      )
    ) {
      return;
    }
    void startWindowDrag().catch(() => {});
  }, []);

  return (
    <LocaleContext.Provider value={localeValue}>
      <div className={shellClass} style={shellStyle} ref={appShellRef}>
        <header
          className="topbar"
          data-tauri-drag-region
          onPointerDown={handleTopbarPointerDown}
        >
          <div className="brand-mark" aria-hidden="true">
            A
          </div>
          <div className="brand-name">
            {t("app.title")} <span>{t("app.subtitle.work")}</span>
          </div>
          <div className="topbar-system-spacer" />
          <WorkspaceSwitcher
            registry={workspaceRegistry}
            activePath={explorerWorkspacePath}
            visibility={explorerVisibility}
            onSelectWorkspace={switchActiveWorkspace}
            onAddWorkspace={openAddWorkspaceDialog}
            onRemoveWorkspace={handleRemoveWorkspace}
            onRefreshCapabilities={handleRefreshWorkspaceCapabilities}
            onUseSample={useSampleWorkspace}
          />
          <GitStatusBadge
            vaultPath={activeDocumentWorkspacePath}
            enabled={
              Boolean(activeDocumentWorkspacePath) &&
              activeDocumentWorkspaceState.startupIoReady
            }
            refreshTrigger={gitRefreshTick}
            onCommitClick={activeWorkspaceCanModify ? handleCommitClick : undefined}
          />

          <div className="topbar-spacer" />

          <button
            type="button"
            className="topbar-pill"
            onClick={openCommandPalette}
            title={t("cmdk.openHint")}
          >
            <span className="topbar-muted-label">{t("sidebar.commandPalette")}</span>
            <span className="kbd">⌘</span>
            <span className="kbd">K</span>
          </button>
          <button
            type="button"
            className="topbar-pill"
            onClick={toggleLocale}
            title={t("app.locale.label")}
            aria-label={t("app.locale.label")}
          >
            {t(locale === "ko" ? "app.locale.ko" : "app.locale.en")}
          </button>
          <button
            type="button"
            className={explorerWorkspaceState.refreshing ? "icon-button refreshing" : "icon-button"}
            onClick={refreshActiveSurface}
            title={t("app.refresh")}
            aria-label={t("app.refresh")}
          >
            <RefreshCcw size={14} />
          </button>
        </header>

        <nav className="activity-rail" aria-label={t("activity.label")}>
          <button
            type="button"
            className={appMode === "pkm" ? "activity-button active" : "activity-button"}
            onClick={() => setPersistedAppMode("pkm")}
            title={t("mode.pkm")}
            aria-label={t("mode.pkm")}
          >
            <FileText size={20} />
          </button>
          <button
            type="button"
            className={appMode === "inbox" ? "activity-button active" : "activity-button"}
            onClick={() => setPersistedAppMode("inbox")}
            title={t("mode.inbox")}
            aria-label={t("mode.inbox")}
          >
            <Inbox size={20} />
          </button>
          <button
            type="button"
            className="activity-button"
            onClick={openCommandPalette}
            title={t("sidebar.commandPalette")}
            aria-label={t("sidebar.commandPalette")}
          >
            <Command size={19} />
          </button>
          <button
            type="button"
            className={documentTypesPaneOpen ? "activity-button active" : "activity-button"}
            onClick={() =>
              updateLayoutSettings({ documentTypesPaneOpen: !documentTypesPaneOpen })
            }
            title={
              documentTypesPaneOpen
                ? t("layout.hideDocumentTypes")
                : t("layout.showDocumentTypes")
            }
            aria-label={
              documentTypesPaneOpen
                ? t("layout.hideDocumentTypes")
                : t("layout.showDocumentTypes")
            }
          >
            {documentTypesPaneOpen ? <PanelLeftClose size={19} /> : <PanelLeftOpen size={19} />}
          </button>
          <button
            type="button"
            className={documentsPaneOpen ? "activity-button active" : "activity-button"}
            onClick={() => updateLayoutSettings({ documentsPaneOpen: !documentsPaneOpen })}
            title={documentsPaneOpen ? t("layout.hideDocuments") : t("layout.showDocuments")}
            aria-label={
              documentsPaneOpen ? t("layout.hideDocuments") : t("layout.showDocuments")
            }
          >
            <FileText size={19} />
          </button>
          <span className="activity-spacer" />
          {settingsWorkPath ? (
            <button
              type="button"
              className="activity-button"
              onClick={openPreferences}
              title={t("mode.system")}
              aria-label={t("mode.system")}
            >
              <Settings2 size={20} />
            </button>
          ) : null}
        </nav>

        {documentTypesPaneOpen ? (
          <Sidebar
            contentCount={documentIndex.contentCount}
            typeCounts={documentIndex.typeCounts}
            recentEntries={recentEntries}
            selectedPath={selectedPath}
            typeFilter={typeFilter}
            onTypeFilter={setExplorerTypeFilter}
            onNewDocument={openNewDocumentDialog}
            canCreateDocument={activeWorkspaceCanCreate}
            onSelectRecent={selectEntry}
            onOpenCommandPalette={openCommandPalette}
            onClose={() => updateLayoutSettings({ documentTypesPaneOpen: false })}
          />
        ) : null}

        {appMode === "inbox" ? (
          <InboxPane
            items={inboxItems}
            loading={inboxLoading}
            gmailMessages={gmailItems}
            gmailLoading={gmailLoading}
            gmailError={gmailError}
            sourceFilter={inboxSourceFilter}
            onSourceFilter={setInboxSourceFilter}
            onRefresh={() => {
              void refreshInbox();
              void refreshGmail();
            }}
            onOpenSettings={() => setInboxSettingsOpen(true)}
            onClassify={(id) => void classifyItem(id)}
            onDecide={decideInboxItem}
            onDecideGmail={decideGmailItem}
          />
        ) : (
          <>
            {documentsPaneOpen && anchorSettings.ui.explorerPaneMode === "documents" ? (
              <DocumentList
                documentIndex={documentIndex}
                selectedPath={selectedPath}
                query={query}
                loading={(booting || explorerWorkspaceState.loading) && entries.length === 0}
                typeFilter={typeFilter}
                workspaceVisibility={explorerVisibility}
                publicWorkspaceAvailable={publicWorkspaceAvailable}
                activeWorkspaceLabel={explorerWorkspaceCaption}
                onWorkspaceVisibilityChange={(visibility) => {
                  setExplorerVisibility(visibility);
                  const nextPath = workspaceRegistry.activeByVisibility[visibility];
                  if (nextPath && !workspaceStates[nextPath]?.entries.length) {
                    void loadWorkspace(nextPath, visibility);
                  }
                }}
                onAddPublicWorkspace={() => openAddWorkspaceDialog("public")}
                browserMode={anchorSettings.ui.documentBrowserMode}
                documentLabelMode={anchorSettings.ui.documentLabelMode}
                collapsedTreeFolders={collapsedTreeFolders}
                onQueryChange={setExplorerQuery}
                onBrowserModeChange={setDocumentBrowserMode}
                onCollapsedTreeFoldersChange={setCollapsedTreeFolders}
                onSelect={selectEntry}
                onRevealInFinder={revealTargetInFinder}
                onRefresh={() => void refreshCurrent()}
                refreshing={explorerWorkspaceState.refreshing}
                onClose={() => updateLayoutSettings({ documentsPaneOpen: false })}
                searchInputRef={searchInputRef}
                paneRef={documentsPaneRef}
                vaultPath={explorerWorkspacePath}
                paneMode={anchorSettings.ui.explorerPaneMode}
                onPaneModeChange={setExplorerPaneMode}
                pendingRevealTargetPath={
                  pendingExplorerReveal?.pane === "documents"
                    ? pendingExplorerReveal.targetPath
                    : null
                }
                onRevealHandled={() => setPendingExplorerReveal(null)}
                selectedFileQueueCount={selectedQueuedFileQueueItems.length}
                onApplyFileQueueToDestination={(targetPath, targetKind, operation) => {
                  void applySelectedFileQueueToDestination(targetPath, targetKind, operation);
                }}
                onApplyExplorerDragToDestination={(payload, targetPath, targetKind, operation) => {
                  void applyExplorerDragSourcesToDestination(
                    payload,
                    targetPath,
                    targetKind,
                    operation,
                  );
                }}
              />
            ) : null}
            {documentsPaneOpen && anchorSettings.ui.explorerPaneMode === "files" ? (
              <WorkspaceFilesPane
                entries={fileEntries}
                selectedPaths={selectedFilePaths}
                query={fileQuery}
                loading={
                  (booting ||
                    explorerWorkspaceFilesState.loading ||
                    shouldScanExplorerWorkspaceFiles) &&
                  fileEntries.length === 0
                }
                refreshing={explorerWorkspaceFilesState.refreshing}
                workspaceVisibility={explorerVisibility}
                publicWorkspaceAvailable={publicWorkspaceAvailable}
                activeWorkspaceLabel={explorerWorkspaceCaption}
                paneMode={anchorSettings.ui.explorerPaneMode}
                filter={anchorSettings.ui.workspaceFileFilter}
                binaryIncludePatterns={anchorSettings.ui.binaryFileIncludePatterns}
                collapsedFileFolders={collapsedFileFolders}
                workspacePath={explorerWorkspacePath}
                onWorkspaceVisibilityChange={(visibility) => {
                  setExplorerVisibility(visibility);
                  const nextPath = workspaceRegistry.activeByVisibility[visibility];
                  if (nextPath && !workspaceStates[nextPath]?.entries.length) {
                    void loadWorkspace(nextPath, visibility);
                  }
                }}
                onAddPublicWorkspace={() => openAddWorkspaceDialog("public")}
                onPaneModeChange={setExplorerPaneMode}
                onQueryChange={setWorkspaceFileQuery}
                onFilterChange={setWorkspaceFileFilter}
                onCollapsedFileFoldersChange={setCollapsedFileFolders}
                onSelectFile={selectWorkspaceFile}
                onOpenFile={openWorkspaceFile}
                onQueueFiles={queueWorkspaceFiles}
                onRevealInFinder={revealTargetInFinder}
                onRefresh={() => {
                  if (explorerWorkspacePath) void refreshWorkspaceFiles(explorerWorkspacePath);
                }}
                onClose={() => updateLayoutSettings({ documentsPaneOpen: false })}
                paneRef={documentsPaneRef}
                pendingRevealTargetPath={
                  pendingExplorerReveal?.pane === "files"
                    ? pendingExplorerReveal.targetPath
                    : null
                }
                onRevealHandled={() => setPendingExplorerReveal(null)}
                selectedFileQueueCount={selectedQueuedFileQueueItems.length}
                onApplyFileQueueToDestination={(targetPath, targetKind, operation) => {
                  void applySelectedFileQueueToDestination(targetPath, targetKind, operation);
                }}
                onApplyExplorerDragToDestination={(payload, targetPath, targetKind, operation) => {
                  void applyExplorerDragSourcesToDestination(
                    payload,
                    targetPath,
                    targetKind,
                    operation,
                  );
                }}
              />
            ) : null}
            {documentsPaneOpen ? (
              <div
                className="pane-resize-handle documents-pane-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label={t("layout.resizeDocuments")}
                title={t("layout.resizeDocuments")}
                aria-valuemin={MIN_DOCUMENTS_PANE_WIDTH}
                aria-valuemax={MAX_DOCUMENTS_PANE_WIDTH}
                aria-valuenow={layoutSettings.documentsPaneWidth}
                data-no-drag="true"
                onPointerDown={startDocumentsPaneResize}
              />
            ) : null}

            <div
              className={editorSplitOpen && rightTab ? "editor-split-shell split" : "editor-split-shell"}
              style={editorSplitStyle}
              ref={editorSplitShellRef}
            >
              {renderEditorPane("left", leftTab, leftResolvedTabId)}
              {editorSplitOpen && rightTab ? (
                <div
                  className="editor-split-resize-handle"
                  role="separator"
                  aria-orientation="vertical"
                  aria-valuemin={30}
                  aria-valuemax={70}
                  aria-valuenow={Math.round(layoutSettings.editorSplitRatio * 100)}
                  onPointerDown={startEditorSplitResize}
                />
              ) : null}
              {editorSplitOpen && rightTab
                ? renderEditorPane("right", rightTab, rightResolvedTabId)
                : null}
            </div>

            {outlineOpen ? (
              <div
                className="pane-resize-handle outline-pane-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label={t("layout.resizeOutline")}
                title={t("layout.resizeOutline")}
                aria-valuemin={MIN_OUTLINE_PANE_WIDTH}
                aria-valuemax={MAX_OUTLINE_PANE_WIDTH}
                aria-valuenow={layoutSettings.outlinePaneWidth}
                data-no-drag="true"
                onPointerDown={startOutlinePaneResize}
              />
            ) : null}

            {outlineOpen ? (
              <OutlinePane
                document={document}
                draftContent={draftContent}
                entries={activeDocumentEntries}
                readOnly={!activeWorkspaceCanModify}
                workspacePath={activeDocumentWorkspacePath}
                onJumpToLine={jumpToOutlineLine}
                onClose={() => updateLayoutSettings({ outlineOpen: false })}
                onError={setError}
                onRefreshWorkspace={() => void refreshCurrent()}
                onUpdateField={updateField}
                onSelectEntry={selectEntry}
                onMissingWikilink={handleWikilinkClick}
                fileQueue={fileQueue}
                canApplyFileQueue={canApplyFileQueue}
                onUpdateFileQueueItem={updateFileQueueItem}
                selectedFileQueueItemIds={selectedFileQueueItemIds}
                onSelectFileQueueItem={selectFileQueueItem}
                onQueueExternalFiles={queueExternalFiles}
                onQueueFileSources={addFileQueueSources}
                onApplyFileQueue={applyQueuedFiles}
                onClearFileQueue={clearFileQueue}
                onClearSelectedFileQueueItems={clearSelectedFileQueueItems}
                activeTab={rightPaneTab}
                onTabChange={setPersistedRightPaneTab}
                paneRef={outlinePaneRef}
              />
            ) : null}
          </>
        )}

        <TerminalPanel
          cwd={activeDocumentWorkspacePath}
          settings={anchorSettings}
          launchRequest={terminalLaunchRequest}
          open={anchorSettings.ui.layout.terminalOpen}
          height={anchorSettings.ui.layout.terminalHeight}
          splitOpen={anchorSettings.ui.layout.terminalSplitOpen}
          splitRatio={anchorSettings.ui.layout.terminalSplitRatio}
          maximized={anchorSettings.ui.layout.terminalMaximized}
          onOpenChange={(terminalOpen) => updateLayoutSettings({ terminalOpen })}
          onHeightChange={(terminalHeight) => updateLayoutSettings({ terminalHeight })}
          onSplitOpenChange={(terminalSplitOpen) =>
            updateLayoutSettings({ terminalSplitOpen, terminalOpen: true })
          }
          onSplitRatioChange={(terminalSplitRatio) =>
            updateLayoutSettings({ terminalSplitRatio })
          }
          onMaximizedChange={(terminalMaximized) =>
            updateLayoutSettings({ terminalMaximized, terminalOpen: true })
          }
        />

        <div className="toast-stack">
          {error ? (
            <div
              className={
                error.startsWith(t("snapshot.success", { path: "" }).slice(0, 4))
                  ? "toast notice"
                  : "toast"
              }
              title={error}
            >
              <AlertTriangle size={15} />
              <span>{error}</span>
              <button
                type="button"
                className="icon-button"
                onClick={() => setError(null)}
                aria-label={t("app.errorClose")}
                title={t("app.errorClose")}
              >
                <X size={14} />
              </button>
            </div>
          ) : null}

          {discardedEdit ? (
            <div
              className="toast notice"
              title={t("toast.discardedEdit", { title: discardedEdit.entry.title })}
            >
              <Clock3 size={15} />
              <span>
                {t("toast.discardedEdit", { title: discardedEdit.entry.title })}
              </span>
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => void restoreDiscardedEdit()}
              >
                {t("toast.restore")}
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => setDiscardedEdit(null)}
                aria-label={t("app.errorClose")}
                title={t("app.errorClose")}
              >
                <X size={14} />
              </button>
            </div>
          ) : null}

          {updateToast ? (
            <div
              className={updateToast.kind === "error" ? "toast" : "toast notice"}
              title={
                updateToast.kind === "checking"
                  ? t("updates.checking")
                  : updateToast.kind === "available"
                    ? t("updates.available", { version: updateToast.info.version })
                    : updateToast.kind === "notAvailable"
                      ? t("updates.none")
                      : updateToast.kind === "downloading"
                        ? t("updates.downloading", {
                            progress:
                              updateToast.progress?.percent != null
                                ? `${updateToast.progress.percent}%`
                                : "…",
                          })
                        : updateToast.kind === "ready"
                          ? t("updates.ready")
                          : t("updates.error", { message: updateToast.message })
              }
            >
              {updateToast.kind === "checking" || updateToast.kind === "downloading" ? (
                <RefreshCcw size={15} className="spin" />
              ) : (
                <AlertTriangle size={15} />
              )}
              <span>
                {updateToast.kind === "checking"
                  ? t("updates.checking")
                  : updateToast.kind === "available"
                    ? t("updates.available", { version: updateToast.info.version })
                    : updateToast.kind === "notAvailable"
                      ? t("updates.none")
                      : updateToast.kind === "downloading"
                        ? t("updates.downloading", {
                            progress:
                              updateToast.progress?.percent != null
                                ? `${updateToast.progress.percent}%`
                                : "…",
                          })
                        : updateToast.kind === "ready"
                          ? t("updates.ready")
                          : t("updates.error", { message: updateToast.message })}
              </span>
              {updateToast.kind === "available" ? (
                <button
                  type="button"
                  className="button button-ghost button-sm"
                  onClick={() => void installPendingUpdate()}
                >
                  {t("updates.install")}
                </button>
              ) : null}
              {updateToast.kind !== "downloading" ? (
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setUpdateToast(null)}
                  aria-label={t("app.errorClose")}
                  title={t("app.errorClose")}
                >
                  <X size={14} />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <NewDocumentDialog
          open={newDocumentOpen}
          initialTitle={newDocumentSeed?.title ?? ""}
          initialRelPath={newDocumentSeed?.relPath ?? null}
          onOpenChange={(open) => {
            setNewDocumentOpen(open);
            if (!open) setNewDocumentSeed(null);
          }}
          onCreate={createNew}
        />
        <AddWorkspaceDialog
          open={addWorkspaceOpen}
          defaultVisibility={addWorkspaceDefaultVisibility}
          onOpenChange={setAddWorkspaceOpen}
          onAdd={handleAddWorkspace}
          onRegisterWorkspace={handleRegisterWorkspace}
        />
        <InboxSettingsDialog
          open={inboxSettingsOpen}
          settings={inboxSettings}
          onOpenChange={setInboxSettingsOpen}
          onSave={persistInboxSettings}
        />
        <CommandPalette
          open={commandPaletteOpen}
          documentIndex={documentIndex}
          onClose={closeCommandPalette}
          onSelectEntry={selectEntry}
          onRunCommand={runCommand}
          documentLabelMode={anchorSettings.ui.documentLabelMode}
        />
        <CommitDialog
          open={commitDialog !== null}
          vaultPath={commitDialog?.path ?? null}
          status={commitDialog?.status ?? null}
          onClose={() => setCommitDialog(null)}
          onCommitted={() => setGitRefreshTick((n) => n + 1)}
        />
      </div>
    </LocaleContext.Provider>
  );
}
