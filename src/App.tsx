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
import { NewDocumentDialog } from "./components/NewDocumentDialog";
import { OutlinePane } from "./components/OutlinePane";
import { Sidebar } from "./components/Sidebar";
import { SystemPane } from "./components/SystemPane";
import { TerminalPanel } from "./components/TerminalPanel";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import {
  addWorkspaceRoot,
  createDocument,
  createVersion,
  fetchGmailUnread,
  getSampleVaultPath,
  listWorkspaceRoots,
  readDocument,
  revealInFileManager,
  readVaultCache,
  refreshWorkspaceCapabilities,
  removeWorkspaceRoot,
  saveDocument,
  scanInboxDrop,
  scanVault,
  setActiveWorkspaceRoot,
  startInboxWatcher,
  stopInboxWatcher,
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
import {
  buildDocumentIndex,
  getRecentEntries,
  type DocumentIndex,
} from "./lib/documentIndex";
import { buildGmailMessageStates, type GmailMessageState } from "./lib/gmail";
import { LocaleContext, assertParityOrThrow, useLocaleState } from "./lib/i18n";
import {
  buildInboxItemStates,
  type InboxDecision,
  type InboxItemState,
} from "./lib/inbox";
import { useKeyboardShortcuts } from "./lib/useKeyboardShortcuts";
import type {
  DocumentPayload,
  GitStatus,
  GmailMessage,
  InboxClassification,
  InboxDropItem,
  VaultEntry,
  WorkspaceRegistry,
  WorkspaceRootEntry,
  WorkspaceVisibility,
} from "./lib/types";
import {
  DEFAULT_ANCHOR_SETTINGS,
  normalizeAnchorSettings,
  type AnchorSettings,
  type DocumentBrowserMode,
} from "./lib/settings";
import { applyThemePreference, applyThemeVars, buildThemeVars } from "./lib/theme";
import {
  openSettingsWindow,
  restoreMainWindowLayout,
  startWindowDrag,
  subscribeMainWindowLayout,
} from "./lib/windowLayout";
import { resolveWikilinkTarget } from "./lib/wikilinkSuggestions";
import { mergeFreshEntry, planVaultStartup } from "./lib/vaultStartup";
import {
  providerLabel,
  workspaceCan,
  workspaceCapabilities,
  workspaceWriteReason,
  workspaceWriteStatus,
} from "./lib/workspaceCapabilities";
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
  relPaths: string[];
}

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

type AppMode = "pkm" | "inbox";

interface InboxCarry {
  decision: InboxDecision;
  classification: InboxClassification | null;
  classifying: boolean;
  classifyError: string | null;
}

function tabIdForEntry(entry: VaultEntry): string {
  return entry.path;
}

function titleFromWikilinkTarget(target: string): string {
  const cleaned = target.trim().replace(/\.(md|markdown)$/i, "");
  const leaf = cleaned.split("/").filter(Boolean).pop();
  return leaf ?? cleaned;
}

export default function App() {
  const params =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  if (params?.get("window") === "settings") {
    return <SettingsWindowRoot workPath={params.get("workPath")} />;
  }
  return <MainApp />;
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
      }
    }).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
  }, [workPath]);

  const updateSettings = useCallback(
    (nextSettings: AnchorSettings) => {
      const normalized = normalizeAnchorSettings(nextSettings);
      setSettings(normalized);
      if (!workPath) return;
      void saveAnchorSettings(workPath, normalized).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
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
            <div className="toast">
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
  const [explorerVisibility, setExplorerVisibility] =
    useState<WorkspaceVisibility>("private");
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [queryByVisibility, setQueryByVisibility] = useState<Record<WorkspaceVisibility, string>>({
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
  const [editorViewMode, setEditorViewMode] = useState<EditorViewMode>("source");
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
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsSaverRef = useRef<DebouncedSaver<AnchorSettings> | null>(null);
  const collapsedTreeHydratedRef = useRef(false);

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
  const [appMode, setAppMode] = useState<AppMode>("pkm");
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
  const entries = explorerWorkspaceState.entries;
  const query = queryByVisibility[explorerVisibility];
  const typeFilter = typeFilterByVisibility[explorerVisibility];
  const collapsedTreeFolders = collapsedTreeFoldersByVisibility[explorerVisibility];
  const documentIndex = useMemo<DocumentIndex>(() => buildDocumentIndex(entries), [entries]);
  const resolvedActiveTabId = activeTabId ?? tabs[0]?.id ?? null;
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === resolvedActiveTabId) ?? null,
    [tabs, resolvedActiveTabId],
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
  const layoutSettings = anchorSettings.ui.layout;
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
      tabs.map((tab) => ({
        id: tab.id,
        title: tab.document.title,
        relPath: tab.document.relPath,
        dirty: tab.draftContent !== tab.document.content,
      })),
    [tabs],
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

  useEffect(() => {
    let cancelled = false;
    setSettingsLoaded(false);
    if (!settingsWorkPath) {
      setAnchorSettings(normalizeAnchorSettings(DEFAULT_ANCHOR_SETTINGS));
      setSettingsLoaded(true);
      return;
    }
    void readAnchorSettings(settingsWorkPath)
      .then((settings) => {
        if (!cancelled) {
          setAnchorSettings(settings);
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
  }, [settingsWorkPath]);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    void listenAnchorSettingsUpdated((payload) => {
      if (payload.workPath === settingsWorkPath) {
        setAnchorSettings(normalizeAnchorSettings(payload.settings));
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
      return;
    }
    const saver = createDebouncedSaver<AnchorSettings>(
      (settings) => saveAnchorSettings(settingsWorkPath, settings),
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

  const updateSettings = useCallback(
    (updater: AnchorSettings | ((current: AnchorSettings) => AnchorSettings)) => {
      setAnchorSettings((current) => {
        const next = normalizeAnchorSettings(
          typeof updater === "function" ? updater(current) : updater,
        );
        if (settingsWritable && settingsWorkPath) {
          const saver = settingsSaverRef.current;
          if (saver) {
            saver.schedule(next);
          } else {
            void saveAnchorSettings(settingsWorkPath, next).catch((err) => {
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
      private: anchorSettings.ui.collapsedTreeFolders,
    }));
  }, [anchorSettings.ui.collapsedTreeFolders, settingsLoaded]);

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
      window.localStorage.setItem(
        openTabsKeyForWorkspace(workspacePath),
        JSON.stringify({
          activeRelPath:
            activeTab?.workspacePath === workspacePath ? activeTab.entry.relPath : null,
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
  }, [activeTab, tabs, lastOpenKeyForWorkspace, openTabsKeyForWorkspace]);

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
      const messages = await fetchGmailUnread(20);
      setGmailMessages(messages);
    } catch (err) {
      setGmailError(err instanceof Error ? err.message : String(err));
    } finally {
      setGmailLoading(false);
    }
  }, []);

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
        setTabs((prev) => {
          const otherWorkspaceTabs = prev.filter((tab) => tab.workspacePath !== path);
          return [...otherWorkspaceTabs, primaryTab];
        });
        setActiveTabId(primaryTab.id);
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
        const initialVisibility: WorkspaceVisibility =
          registry.activeByVisibility.private || registry.workspaces.some((w) => w.visibility === "private")
            ? "private"
            : "public";
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
        setActiveTabId(existingTab.id);
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
        setActiveTabId(newTab.id);
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
      lastOpenKeyForWorkspace,
      pushRecent,
      selectedEntry,
      t,
      tabs,
      workspaceRegistry.workspaces,
    ],
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
      setActiveTabId(restoredTab.id);
      setExplorerVisibility(restoredTab.visibility);
      setPendingSelectedPath(null);
      setDiscardedEdit(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [discardedEdit]);

  const saveCurrent = useCallback(async () => {
    if (!document || !dirty || !activeDocumentWorkspacePath) return;
    if (blockWorkspaceWrite("modify")) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveDocument(activeDocumentWorkspacePath, document.path, draftContent);
      const fresh = await scanVault(activeDocumentWorkspacePath);
      updateWorkspaceState(activeDocumentWorkspacePath, { entries: fresh });
      updateActiveTab((tab) => {
        const freshEntry = fresh.find((entry) => entry.path === tab.entry.path) ?? tab.entry;
        return { ...tab, entry: freshEntry, document: saved, draftContent: saved.content };
      });
      setGitRefreshTick((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [
    document,
    dirty,
    activeDocumentWorkspacePath,
    draftContent,
    updateActiveTab,
    blockWorkspaceWrite,
    updateWorkspaceState,
  ]);

  const snapshotCurrent = useCallback(async () => {
    if (!document || !activeDocumentWorkspacePath) return;
    if (blockWorkspaceWrite("create")) return;
    setError(null);
    try {
      const snapshot = await createVersion(
        activeDocumentWorkspacePath,
        document.path,
        document.title,
        draftContent,
        t("snapshot.summary"),
      );
      const fresh = await scanVault(activeDocumentWorkspacePath);
      updateWorkspaceState(activeDocumentWorkspacePath, { entries: fresh });
      updateActiveTab((tab) => {
        const freshEntry = fresh.find((entry) => entry.path === tab.entry.path) ?? tab.entry;
        return { ...tab, entry: freshEntry };
      });
      setError(t("snapshot.success", { path: snapshot.relPath }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [
    document,
    activeDocumentWorkspacePath,
    draftContent,
    t,
    updateActiveTab,
    blockWorkspaceWrite,
    updateWorkspaceState,
  ]);

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
      setActiveTabId(newTab.id);
      setPendingSelectedPath(null);
      pushRecent(entry.path);
    },
    [
      activeDocumentWorkspace,
      activeDocumentWorkspacePath,
      explorerVisibility,
      pushRecent,
      blockWorkspaceWrite,
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
    } else {
      void refreshCurrent();
    }
  }, [appMode, refreshCurrent, refreshGmail, refreshInbox]);

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
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab) return;
      setActiveTabId(tabId);
      setExplorerVisibility(tab.visibility);
      pushRecent(tab.entry.path);
    },
    [tabs, pushRecent],
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
        if (resolvedActiveTabId === tabId) {
          const fallback = next[Math.min(closingIndex, next.length - 1)] ?? null;
          setActiveTabId(fallback?.id ?? null);
        }
        return next;
      });
    },
    [resolvedActiveTabId, tabs],
  );

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
      const ta = editorTextareaRef.current;
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
    setEditorViewMode("source");
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(jump);
    });
  }, []);

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
        case "toggle-preview":
          setEditorViewMode((mode) => (mode === "preview" ? "rich" : "preview"));
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
          setAppMode("inbox");
          break;
        case "open-docs":
          setAppMode("pkm");
          break;
        case "add-workspace":
          openAddWorkspaceDialog();
          break;
        case "open-settings":
          openPreferences();
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
      updateLayoutSettings,
      outlineOpen,
    ],
  );

  useKeyboardShortcuts(
    {
      "mod+s": () => void saveCurrent(),
      "mod+shift+s": () => void snapshotCurrent(),
      "mod+n": openNewDocumentDialog,
      "mod+k": () => setCommandPaletteOpen((v) => !v),
      "mod+p": () => setEditorViewMode((mode) => (mode === "preview" ? "rich" : "preview")),
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
      closeTab,
      resolvedActiveTabId,
      updateLayoutSettings,
      outlineOpen,
    ],
  );

  const modeClass = appMode === "inbox" ? " inbox-mode" : "";
  const shellClass = `app-shell${modeClass}${outlineOpen ? "" : " outline-closed"}${
    documentTypesPaneOpen ? "" : " types-closed"
  }${documentsPaneOpen ? "" : " documents-closed"}`;
  const themeVars = useMemo(() => buildThemeVars(anchorSettings), [anchorSettings]);

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
      <div className={shellClass} style={themeVars}>
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
          <div style={{ width: 14 }} />
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
            <span style={{ opacity: 0.55 }}>{t("sidebar.commandPalette")}</span>
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
            onClick={() => setAppMode("pkm")}
            title={t("mode.pkm")}
            aria-label={t("mode.pkm")}
          >
            <FileText size={20} />
          </button>
          <button
            type="button"
            className={appMode === "inbox" ? "activity-button active" : "activity-button"}
            onClick={() => setAppMode("inbox")}
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
            onRefresh={() => {
              void refreshInbox();
              void refreshGmail();
            }}
            onClassify={(id) => void classifyItem(id)}
            onDecide={decideInboxItem}
            onDecideGmail={decideGmailItem}
          />
        ) : (
          <>
            {documentsPaneOpen ? (
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
                collapsedTreeFolders={collapsedTreeFolders}
                onQueryChange={setExplorerQuery}
                onBrowserModeChange={setDocumentBrowserMode}
                onCollapsedTreeFoldersChange={setCollapsedTreeFolders}
                onSelect={selectEntry}
                onRevealInFinder={revealTargetInFinder}
                onClose={() => updateLayoutSettings({ documentsPaneOpen: false })}
                searchInputRef={searchInputRef}
                vaultPath={explorerWorkspacePath}
              />
            ) : null}

            <EditorPane
              document={document}
              openingEntry={openingEntry}
              draftContent={draftContent}
              saving={saving}
              dirty={dirty}
              outlineOpen={outlineOpen}
              activeWorkspaceLabel={activeDocumentWorkspace?.label ?? null}
              readOnly={!activeWorkspaceCanModify}
              canSnapshot={activeWorkspaceCanCreate}
              readOnlyReason={activeWorkspaceWriteReason}
              viewMode={editorViewMode}
              tabs={editorTabSummaries}
              activeTabId={resolvedActiveTabId}
              entries={activeDocumentEntries}
              onChange={setDraftContent}
              onSelectTab={selectTab}
              onCloseTab={closeTab}
              onSave={saveCurrent}
              onSnapshot={snapshotCurrent}
              onToggleOutline={() => updateLayoutSettings({ outlineOpen: !outlineOpen })}
              onViewModeChange={setEditorViewMode}
              onWikilinkClick={handleWikilinkClick}
              textareaRef={editorTextareaRef}
            />

            {outlineOpen ? (
              <OutlinePane
                document={document}
                draftContent={draftContent}
                entries={activeDocumentEntries}
                readOnly={!activeWorkspaceCanModify}
                onJumpToLine={jumpToOutlineLine}
                onClose={() => updateLayoutSettings({ outlineOpen: false })}
                onUpdateField={updateField}
                onSelectEntry={selectEntry}
                onMissingWikilink={handleWikilinkClick}
              />
            ) : null}
          </>
        )}

        <TerminalPanel
          cwd={activeDocumentWorkspacePath}
          settings={anchorSettings}
          open={anchorSettings.ui.layout.terminalOpen}
          height={anchorSettings.ui.layout.terminalHeight}
          onOpenChange={(terminalOpen) => updateLayoutSettings({ terminalOpen })}
          onHeightChange={(terminalHeight) => updateLayoutSettings({ terminalHeight })}
        />

        <div className="toast-stack">
          {error ? (
            <div
              className={
                error.startsWith(t("snapshot.success", { path: "" }).slice(0, 4))
                  ? "toast notice"
                  : "toast"
              }
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
            <div className="toast notice">
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
        <CommandPalette
          open={commandPaletteOpen}
          documentIndex={documentIndex}
          onClose={closeCommandPalette}
          onSelectEntry={selectEntry}
          onRunCommand={runCommand}
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
