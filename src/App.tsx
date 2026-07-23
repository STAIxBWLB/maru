import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type React from "react";
import {
  AlertTriangle,
  ChevronUp,
  Clock3,
  Code2,
  Command,
  FileText,
  Globe,
  Inbox,
  LayoutGrid,
  ListTodo,
  MessageSquare,
  Network,
  PanelBottom,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  RefreshCcw,
  Route,
  Settings2,
  SquareTerminal,
  UsersRound,
  WandSparkles,
  Waypoints,
  Workflow,
  X,
} from "lucide-react";
import { AddWorkspaceDialog } from "./components/AddWorkspaceDialog";
import { CommandPalette } from "./components/CommandPalette";
import { CommitDialog } from "./components/CommitDialog";
import { DocumentList } from "./components/DocumentList";
import { EditorPane, type EditorViewMode, type HtmlViewMode } from "./components/EditorPane";
import type { HtmlEditorFlushHandle } from "./components/HtmlVisualEditor";
import { BinaryViewerPane } from "./components/BinaryViewerPane";
import { GitStatusBadge } from "./components/GitStatusBadge";
import { WritingGuidelineSidebar } from "./components/catalog/WritingGuidelineSidebar";
import { EvidenceBinderPane } from "./components/evidence/EvidenceBinderPane";
import { MissionBadge } from "./components/MissionBadge";
import { NewDocumentDialog } from "./components/NewDocumentDialog";
import { OutlinePane } from "./components/OutlinePane";
import { SystemPane } from "./components/SystemPane";
import type {
  TerminalLaunchRequest,
  TerminalPanelHandle,
} from "./components/TerminalPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import {
  buildMaruBackgroundContextEnv,
  scratchpadRootForWorkspace,
  type ActiveTerminalContext,
} from "./lib/terminal";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { WorkspaceFilesPane } from "./components/WorkspaceFilesPane";
import type { FavoriteTarget } from "./components/FavoritesSection";
import { useApprovalGate } from "./approval/ApprovalDialog";
import { markStartup, measureStartup, scheduleStartupIdle } from "./lib/startupProfile";
import {
  ComposeDialog,
  type ComposeDialogSeed,
} from "./components/skills/ComposeDialog";
import { SkillEditorWindowRoot } from "./components/skills/SkillEditorWindow";
import { SkillRunsPanel } from "./components/skills/SkillRunsPanel";
import { SkillsQuickPane } from "./components/skills/SkillsQuickPane";
import {
  applyFileQueue,
  addWorkspaceRoot,
  acceptInboxItem,
  acceptInboxItems,
  binaryViewerClassify,
  binaryViewerPrepareAsset,
  createDocument,
  createVersion,
  DEFAULT_INBOX_RUNTIME_CONFIG,
  decideGmailItem as decideGmailItemApi,
  decideGmailItems,
  decideOutlookItem as decideOutlookItemApi,
  decideOutlookItems,
  acceptTelegramItem,
  rejectTelegramItem,
  detectLegacyTelegramLaunchd,
  describeFileQueueSources,
  duplicateDocument,
  fetchGmailUnread,
  fetchOutlookUnread,
  fetchTelegramRecent,
  getSampleWorkspacePath,
  gitStatus,
  listAiMissions,
  listWorkspaceRoots,
  moveDocument,
  readDocument,
  readAiMissionLog,
  prepareApproval,
  openInFileManager,
  revealInFileManager,
  countInboxProcessedByChannel,
  readInboxProcessedItem,
  readInboxSourceRuns,
  readInboxRuntimeConfig,
  readTelegramMonitorConfig,
  readVaultCache,
  unloadLegacyTelegramLaunchd,
  refreshWorkspaceCapabilities,
  removeWorkspaceRoot,
  recordApproval,
  rejectInboxItem,
  rejectInboxItems,
  saveDocument,
  scanInboxDrop,
  scanInboxEntries,
  scanInboxProcessedItems,
  scanWorkspaceFiles,
  scanVault,
  setActiveWorkspaceRoot,
  stageGmailItems,
  stageInboxDropFiles,
  stageOutlookItems,
  stageTelegramItems,
  startInboxWatcher,
  startVaultWatcher,
  startTelegramPolling,
  stopAiMission,
  stopInboxWatcher,
  stopVaultWatcher,
  stopTelegramPolling,
  telegramPollingStatus,
  removeAgentContextHint,
  terminalHooksInstall,
  terminalHooksStatus,
  terminalHooksUninstall,
  terminalAvailable,
  writeAgentContextHint,
  trashDocument,
  trashInboxItems,
  updateFrontmatterField,
  type BinaryViewerClassification,
  type LegacyLaunchdService,
} from "./lib/api";
import { inboxRootPath, sourceFolderPath } from "./lib/inboxSources";
import {
  exportDispatch,
  exportPlan,
  exportValidate,
  summarizeDispatch,
  summarizeValidation,
  type ExportFormat,
} from "./lib/export";
import {
  studioApplyBody,
  studioDocIdFromDocument,
  type StudioCreateDocumentInput,
  type StudioPackageResult,
} from "./lib/studio";
import {
  readMaruSettings,
  readWorkspaceConfig,
  listWorkspaceProjects,
  registerWorkspaceRoots,
  saveMaruSettings,
  listenMaruSettingsUpdated,
  updateMaruWorkspace,
} from "./lib/maruDir";
import { classifyInboxItem } from "./lib/aiInvoke";
import { createDebouncedSaver, type DebouncedSaver } from "./lib/debouncedSave";
import { documentDisplayName } from "./lib/document";
import { isDiagramEnabled } from "./lib/diagramFlag";
import { isE2EFlowEnabled } from "./lib/e2eFlow";
import {
  nextFallbackTabIdAfterClose,
  orderTabsById,
  replaceEditorTabIds,
  tabIdsToCloseOthers,
  tabIdsToCloseRight,
  tabIdsToCloseSaved,
} from "./lib/editorTabActions";
import {
  ALL_DOCUMENTS_FILTER,
  buildDocumentIndex,
  countDocumentFilter,
  documentFilterDefaultDocType,
  getRecentEntries,
  type BuiltInDocumentView,
  type DocumentFilter,
  type DocumentIndex,
} from "./lib/documentIndex";
import {
  buildGmailMessageStates,
  buildGmailScanQuery,
  gmailRefreshPolicy,
  normalizeGmailRefreshTtl,
  normalizeGmailScanLimit,
  shouldApplyGmailRefreshResult,
  type GmailMessageState,
} from "./lib/gmail";
import { LocaleContext, assertParityOrThrow, useLocaleState } from "./lib/i18n";
import { listenForMenuCommand } from "./lib/menu";
import { currentPlatform, isMacPlatform } from "./lib/platform";
import {
  buildInboxProcessPrompt,
  buildInboxItemStates,
  activeInboxProcessMissions,
  inboxProcessMissions,
  isInboxProcessMission,
  type InboxDecision,
  type InboxItemState,
} from "./lib/inbox";
import { buildOutlookMessageStates, type OutlookMessageState } from "./lib/outlook";
import {
  buildTelegramMessageStates,
  gwsAuthCommand,
  m365LoginCommand,
  telegramFetchOptions,
  telegramLoginCommand,
  type TelegramMessageState,
} from "./lib/telegram";
import { normalizeTelegramMonitorConfig } from "./lib/telegramMonitor";
import {
  SETTINGS_WINDOW_TERMINAL_LAUNCH_EVENT,
  type SettingsWindowTerminalLaunchPayload,
} from "./lib/settingsWindowEvents";
import { useKeyboardShortcuts } from "./lib/useKeyboardShortcuts";
import { useScopedSelectAll } from "./lib/useScopedSelectAll";
import type { TerminalKind } from "./lib/terminal";
import {
  skillsApplyBundleUpdate,
  skillsCheckBundleUpdate,
  skillsListSkills,
  skillsDispatchBackground,
  skillsRuntimeStatus,
  type SkillContextItem,
  type SkillDispatchRuntime,
  type SkillRecord,
  type TerminalDispatchSpec,
} from "./lib/skills";
import { activeTrackedAgentMissions, isTrackedAgentMission } from "./lib/skillRuns";
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
  OutlookMessage,
  TelegramMessage,
  TelegramPollingStatus,
  InboxClassification,
  InboxDropItem,
  InboxEntry,
  InboxProcessedItem,
  InboxProcessedItemDetail,
  InboxSourceRun,
  InboxProcessedStatus,
  InboxRuntimeConfig,
  InboxTrashTarget,
  MissionRecord,
  VaultEntry,
  WorkspaceFileEntry,
  WorkspaceConfig,
  WorkspaceRegistry,
  WorkspaceRootEntry,
  WorkspaceVisibility,
  WorkspaceWritePolicy,
} from "./lib/types";
import {
  isSameParentMove,
  targetDirForDropTarget,
  type ExplorerDragItem,
  type ExplorerDragPayload,
} from "./lib/fileDrag";
import {
  DEFAULT_MARU_SETTINGS,
  applyWorkspaceCommsOverrides,
  applyWorkspaceMeetingsOverrides,
  applyWorkspaceTasksOverrides,
  normalizeMaruSettings,
  resolveClassifierRuntime,
  type MaruSettings,
  type MaruAppMode,
  type DocumentBrowserMode,
  type DocumentViewDefinition,
  type EditorPaneViewModes,
  type EditorViewModeSetting,
  type ExplorerPaneMode,
  type FavoriteItem,
  type FavoriteKind,
  type GraphOpenTarget,
  type FilesBrowserMode,
  type FilesListAttribute,
  type FilesSortKey,
  type RightPaneTab,
  type TerminalDock,
  type WorkspaceFileFilter,
  type WorkspaceVisibilitySetting,
} from "./lib/settings";
import { activeMeetingsMissions } from "./lib/meetings";
import { activeTasksMissions } from "./lib/tasks";
import {
  todayLogicalDay,
  todayNotifyNewDay,
  todayOpen,
  todayRollover,
  type TodayRoute,
} from "./lib/today";
import {
  resolveLaunchRoute,
  resolveNewDayNotice,
  resolveRouteForDayState,
  todayAutoOpenKey,
} from "./lib/todayRouting";
import { onAction as onNotificationAction } from "@tauri-apps/plugin-notification";
import { applyThemePreference, applyThemeVars, buildThemeVars } from "./lib/theme";
import {
  openSettingsWindow,
  restoreMainWindowLayout,
  startWindowDrag,
  subscribeMainWindowLayout,
  tauriAvailable,
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
  EMPTY_WORKSPACE_FILES_PANE_FILTERS,
  expandWorkspaceFileAncestors,
  isOpenableDocumentFile,
  isOpenableFile,
  type WorkspaceFilesPaneFilters,
} from "./lib/workspaceFileTree";
import { usesAssetProtocol } from "./lib/binaryViewer";
import {
  emptyHistory,
  goBack,
  goForward,
  pushHistory,
  type NavHistory,
} from "./lib/neighborhoodHistory";

const LAST_OPEN_KEY = "maru:lastOpenedNote:v1";
const OPEN_TABS_KEY = "maru:openTabs:v1";
const RECENT_KEY = "maru:recent:v1";
const APP_ICON_URL = new URL("./assets/app-icon-dark.png", import.meta.url).href;
const MIN_DOCUMENTS_PANE_WIDTH = 260;
const MAX_DOCUMENTS_PANE_WIDTH = 560;
const MIN_OUTLINE_PANE_WIDTH = 240;
const MAX_OUTLINE_PANE_WIDTH = 520;
const OUTLOOK_REFRESH_TTL_MS = 60_000;
const TELEGRAM_REFRESH_TTL_MS = 60_000;

const LazyGraphView = lazy(() => import("./components/graph/GraphView").then((module) => ({ default: module.GraphView })));
const LazyDiagramMode = lazy(() => import("./components/diagram/DiagramMode").then((module) => ({ default: module.DiagramMode })));
const LazyStudioMode = lazy(() => import("./components/studio/StudioMode").then((module) => ({ default: module.StudioMode })));
const LazyInboxPane = lazy(() => import("./components/InboxPane").then((module) => ({ default: module.InboxPane })));
const LazyCommsPane = lazy(() => import("./components/CommsPane").then((module) => ({ default: module.CommsPane })));
const LazyMeetingsPane = lazy(() => import("./components/meetings/MeetingsPane").then((module) => ({ default: module.MeetingsPane })));
const LazyTodayPane = lazy(() => import("./components/today/TodayPane").then((module) => ({ default: module.TodayPane })));
const LazyCatalogPane = lazy(() => import("./components/catalog/CatalogPane").then((module) => ({ default: module.CatalogPane })));
const LazySitesPane = lazy(() => import("./components/sites/SitesPane").then((module) => ({ default: module.SitesPane })));
const LazyE2EFlowPane = lazy(() => import("./components/e2e/E2EFlowPane").then((module) => ({ default: module.E2EFlowPane })));

interface ProviderRefreshCache {
  fetchedAt: number | null;
  key: string;
}

function shouldSkipProviderRefresh(
  cache: ProviderRefreshCache,
  key: string,
  force: boolean,
  loading: boolean,
  ttlMs: number,
): boolean {
  if (force) return false;
  if (loading) return true;
  return Boolean(
    cache.fetchedAt &&
      cache.key === key &&
      Date.now() - cache.fetchedAt < ttlMs,
  );
}

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

interface BinaryTab {
  kind: "binary";
  id: string;
  workspacePath: string;
  visibility: WorkspaceVisibility;
  fileEntry: WorkspaceFileEntry;
  classification: BinaryViewerClassification;
  status: "ready" | "error";
  error: string | null;
}

type AnyTab = EditorTab | BinaryTab;

function isBinaryTab(tab: AnyTab | null | undefined): tab is BinaryTab {
  return Boolean(tab && (tab as BinaryTab).kind === "binary");
}

function tabIdForWorkspaceFile(entry: WorkspaceFileEntry): string {
  return `binary:${entry.path}`;
}

function favoriteKey(kind: FavoriteKind, relPath: string): string {
  return `${kind}:${relPath.toLowerCase()}`;
}

function normalizeFavoriteTargetRelPath(value: string): string | null {
  const trimmed = value.replace(/\\/g, "/").trim().replace(/\/+$/g, "");
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:\//.test(trimmed)) return null;
  const parts = trimmed.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function favoriteLabelFromRelPath(relPath: string): string {
  return relPath.split("/").filter(Boolean).pop() ?? relPath;
}

function joinWorkspaceRelPath(workspacePath: string, relPath: string): string {
  return `${workspacePath.replace(/\/+$/, "")}/${relPath.replace(/^\/+/, "")}`;
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

type AppMode = MaruAppMode;

interface InboxCarry {
  decision: InboxDecision;
  classification: InboxClassification | null;
  classifying: boolean;
  classifyError: string | null;
}

interface GmailScanStatus {
  fetchedAt: number | null;
  durationMs: number | null;
  query: string | null;
  max: number | null;
  ttlSeconds: number;
}

interface AiOutputEvent {
  invocationId: string;
  stream: string;
  line: string;
}

const DEFAULT_GMAIL_SCAN_STATUS: GmailScanStatus = {
  fetchedAt: null,
  durationMs: null,
  query: null,
  max: null,
  ttlSeconds: DEFAULT_INBOX_RUNTIME_CONFIG.gmail.auto_refresh_ttl_seconds,
};

type UpdateToast =
  | { kind: "checking" }
  | { kind: "available"; info: AppUpdateInfo }
  | { kind: "notAvailable" }
  | { kind: "downloading"; info: AppUpdateInfo; progress: AppUpdateProgress | null }
  | { kind: "ready"; info: AppUpdateInfo }
  | { kind: "skillsUpdated"; version: string }
  | { kind: "error"; message: string };

function tabIdForEntry(entry: VaultEntry): string {
  return entry.path;
}

function titleFromWikilinkTarget(target: string): string {
  const cleaned = target.trim().replace(/\.(md|markdown)$/i, "");
  const leaf = cleaned.split("/").filter(Boolean).pop();
  return leaf ?? cleaned;
}

// (Phase 4 W7) The W5 `appendHubProvenance` helper that emitted
// `<!-- maru:template … -->` comment trailers has been removed: the Hub
// template / guideline metadata now flows into proper frontmatter via
// `CreateDocumentExtras` in lib/api.ts and document::create_document.

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

function formatGmailScanStatus(
  status: GmailScanStatus,
  loading: boolean,
  locale: string,
): string {
  const ttl = formatGmailTtl(status.ttlSeconds);
  if (loading) return status.fetchedAt ? `scanning · TTL ${ttl}` : "scanning";
  if (!status.fetchedAt) return `not scanned · TTL ${ttl}`;
  const updated = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(status.fetchedAt));
  const duration =
    status.durationMs === null ? null : `${(status.durationMs / 1000).toFixed(1)}s`;
  return [`updated ${updated}`, duration, `TTL ${ttl}`].filter(Boolean).join(" · ");
}

function matchesActiveMission(record: MissionRecord): boolean {
  return record.status === "running" || record.status === "idle";
}

function upsertMission(current: MissionRecord[], next: MissionRecord): MissionRecord[] {
  const merged = current.filter((mission) => mission.id !== next.id);
  merged.unshift(next);
  return activeTrackedMissions(merged);
}

function activeTrackedMissions(missions: MissionRecord[]): MissionRecord[] {
  return activeTrackedAgentMissions(missions).sort(
    (a, b) => b.lastOutputAt.localeCompare(a.lastOutputAt) || b.startedAt.localeCompare(a.startedAt),
  );
}

function formatGmailTtl(seconds: number): string {
  const value = normalizeGmailRefreshTtl(seconds);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  if (value % 3600 === 0) return `${value / 3600}h`;
  return `${Math.round(value / 60)}m`;
}

function initialStartupVisibility(
  registry: WorkspaceRegistry,
  settings: MaruSettings | null,
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
    return <SettingsWindowRoot workPath={params.get("workPath")} initialTab={params.get("tab")} />;
  }
  if (params?.get("window") === "skill-editor") {
    return (
      <SkillEditorWindowRoot
        workPath={params.get("workPath")}
        skillId={params.get("skillId")}
      />
    );
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

function SettingsWindowRoot({
  workPath,
  initialTab,
}: {
  workPath: string | null;
  initialTab: string | null;
}) {
  const localeValue = useLocaleState();
  const { t } = localeValue;
  const [settings, setSettings] = useState<MaruSettings>(() =>
    normalizeMaruSettings(DEFAULT_MARU_SETTINGS),
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
      setSettings(normalizeMaruSettings(DEFAULT_MARU_SETTINGS));
      return;
    }
    void readMaruSettings(workPath)
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
    void listenMaruSettingsUpdated((payload) => {
      if (payload.workPath === workPath) {
        setSettings(normalizeMaruSettings(payload.settings));
      } else if (payload.globalChanged && workPath) {
        void readMaruSettings(workPath)
          .then((next) => setSettings(next))
          .catch((err) => setError(err instanceof Error ? err.message : String(err)));
      }
    }).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
  }, [workPath]);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    void listenForMenuCommand((id) => {
      if (id !== "file.close_active" && id !== "window.close") return;
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().close())
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
  }, []);

  const updateSettings = useCallback(
    (nextSettings: MaruSettings) => {
      const normalized = normalizeMaruSettings(nextSettings);
      setSettings((current) => {
        if (workPath) {
          void saveMaruSettings(workPath, normalized, current).catch((err) => {
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
          initialTab={initialTab}
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
  const approvalGate = useApprovalGate();
  const isMac = useMemo(() => isMacPlatform(currentPlatform()), []);

  useEffect(() => {
    markStartup("app:mounted");
  }, []);

  const [workspaceRegistry, setWorkspaceRegistry] = useState<WorkspaceRegistry>({
    workspaces: [],
    activeByVisibility: {
      private: null,
      public: null,
    },
    hiddenDefaults: [],
  });
  const [workspaceConfig, setWorkspaceConfig] = useState<WorkspaceConfig | null>(null);
  const [workspaceStates, setWorkspaceStates] = useState<Record<string, WorkspaceEntriesState>>({});
  const [workspaceFileStates, setWorkspaceFileStates] = useState<Record<string, WorkspaceFilesState>>({});
  const [explorerVisibility, setExplorerVisibility] =
    useState<WorkspaceVisibility>("private");
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [binaryTabs, setBinaryTabs] = useState<BinaryTab[]>([]);
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  // Mirror of `tabs` for close/relaunch guards that run outside React flow
  // (onCloseRequested, update toast actions). Binary tabs are never dirty.
  const tabsRef = useRef<EditorTab[]>([]);
  // Dirty-draft guard: "close" = window close requested, "relaunch" = update
  // ready. Non-null shows the confirm dialog; the action runs on confirm.
  const [pendingDestructiveAction, setPendingDestructiveAction] =
    useState<"close" | "relaunch" | null>(null);
  const closeConfirmedRef = useRef(false);
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
  const [documentFilterByVisibility, setDocumentFilterByVisibility] = useState<
    Record<WorkspaceVisibility, DocumentFilter>
  >({
    private: ALL_DOCUMENTS_FILTER,
    public: ALL_DOCUMENTS_FILTER,
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
  const [filesPaneFilters, setFilesPaneFilters] = useState<WorkspaceFilesPaneFilters>(
    EMPTY_WORKSPACE_FILES_PANE_FILTERS,
  );
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
    docType?: string | null;
    openLibrary?: boolean;
  } | null>(null);
  const [lastExportManifestPath, setLastExportManifestPath] = useState<string | null>(null);
  const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
  const [addWorkspaceDefaultVisibility, setAddWorkspaceDefaultVisibility] =
    useState<WorkspaceVisibility>("private");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [editorPaneViewModes, setEditorPaneViewModes] = useState<EditorPaneViewModes>(
    DEFAULT_MARU_SETTINGS.ui.editorPaneViewModes,
  );
  // HTML document tabs: per pane+tab view mode, never persisted. Keyed
  // `${group}:${tabId}` so the two split panes stay independent.
  const [htmlPaneModes, setHtmlPaneModes] = useState<
    Record<string, { mode: HtmlViewMode; riskAckDigest?: string | null }>
  >({});
  // Only the active tab of each pane is mounted, so per-pane flush refs suffice.
  const leftHtmlFlushRef = useRef<HtmlEditorFlushHandle | null>(null);
  const rightHtmlFlushRef = useRef<HtmlEditorFlushHandle | null>(null);
  const [rightPaneTab, setRightPaneTab] = useState<RightPaneTab>(
    DEFAULT_MARU_SETTINGS.ui.rightPaneTab,
  );
  // Shareable absolute file paths reported by the Inbox selection, fed to the
  // Shared Outbox tab's queue.
  const [inboxShareablePaths, setInboxShareablePaths] = useState<string[]>([]);
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
  const settingsSaverRef = useRef<DebouncedSaver<MaruSettings> | null>(null);
  const settingsSaveBaseRef = useRef<MaruSettings | null>(null);
  const pendingUpdateRef = useRef<AppUpdateCheckResult["update"] | null>(null);
  const installingUpdateRef = useRef(false);
  const collapsedTreeHydratedRef = useRef(false);
  const collapsedFileHydratedRef = useRef(false);
  const gmailScanStatusRef = useRef<GmailScanStatus>(DEFAULT_GMAIL_SCAN_STATUS);
  const gmailLoadingRef = useRef(false);
  const gmailRequestSeqRef = useRef(0);
  const outlookLoadingRef = useRef(false);
  const outlookRefreshCacheRef = useRef<ProviderRefreshCache>({ fetchedAt: null, key: "" });
  const telegramLoadingRef = useRef(false);
  const telegramRefreshCacheRef = useRef<ProviderRefreshCache>({ fetchedAt: null, key: "" });
  const migrationCheckedRef = useRef(false);
  const processingMissionIdsRef = useRef<Set<string>>(new Set());

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
  const [appMode, setAppMode] = useState<AppMode>(DEFAULT_MARU_SETTINGS.ui.activeAppMode);
  // Maru Today launch routing. "all" is the existing Tasks view; the Today
  // pane interprets the other routes and persists them into the day
  // snapshot (best-effort) once its snapshot is loaded.
  const [todayRoute, setTodayRoute] = useState<TodayRoute>("all");
  // New-day fallback banner: `pending` waits for the next window focus,
  // `visible` renders the banner.
  const [todayBannerPending, setTodayBannerPending] = useState(false);
  const [todayBannerVisible, setTodayBannerVisible] = useState(false);
  const [todayRolloverEpoch, setTodayRolloverEpoch] = useState(0);
  // Last logical day seen by the new-day watcher (boot seeds it too).
  const todayLogicalDayRef = useRef<string | null>(null);
  // Workspace whose boot auto-opened Today this launch. The settings-load
  // effect re-applies the persisted mode after boot (and again when `booting`
  // flips) — it must keep the auto-open decision instead of clobbering it.
  // Cleared on the first explicit user mode change.
  const todayAutoOpenPathRef = useRef<string | null>(null);
  const e2eFlowEnabled = useMemo(() => isE2EFlowEnabled(), []);
  const diagramEnabled = useMemo(() => isDiagramEnabled(), []);
  const visibleAppMode: AppMode =
    appMode === "e2e" && !e2eFlowEnabled
      ? "pkm"
      : appMode === "diagram" && !diagramEnabled
        ? "pkm"
        : appMode;
  // Graph mode focus target (NeighborhoodPane "그래프에서 보기" → k-hop focus).
  const [graphOpenTarget, setGraphOpenTarget] = useState<GraphOpenTarget | null>(null);
  const [inboxDrops, setInboxDrops] = useState<InboxDropItem[]>([]);
  const [inboxEntries, setInboxEntries] = useState<InboxEntry[]>([]);
  const [inboxRuntimeConfig, setInboxRuntimeConfig] = useState<InboxRuntimeConfig>(
    DEFAULT_INBOX_RUNTIME_CONFIG,
  );
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxCarry, setInboxCarry] = useState<Map<string, InboxCarry>>(() => new Map());
  const [processedItems, setProcessedItems] = useState<InboxProcessedItem[]>([]);
  const [processedLoading, setProcessedLoading] = useState(false);
  const [processedError, setProcessedError] = useState<string | null>(null);
  const [processedStatusFilter, setProcessedStatusFilter] =
    useState<InboxProcessedStatus | "all">("all");
  const [processedQuery, setProcessedQuery] = useState("");
  const [processedDetail, setProcessedDetail] = useState<InboxProcessedItemDetail | null>(null);
  const [processingMissions, setProcessingMissions] = useState<MissionRecord[]>([]);
  const [processingLogLines, setProcessingLogLines] = useState<Record<string, string[]>>({});
  // Per-source processing run state for the Messages dashboard.
  const [sourceRuns, setSourceRuns] = useState<InboxSourceRun[]>([]);
  const [processedCounts, setProcessedCounts] = useState<Record<string, number>>({});
  const [commsSourceFilter, setCommsSourceFilter] = useState<string | null>(null);

  // Gmail surface (gws CLI). List state is memory-only in Comms, while
  // accept/reject calls write labels/archive through gws.
  const [gmailMessages, setGmailMessages] = useState<GmailMessage[]>([]);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailError, setGmailError] = useState<string | null>(null);
  const [gmailScanStatus, setGmailScanStatus] = useState<GmailScanStatus>(
    DEFAULT_GMAIL_SCAN_STATUS,
  );
  const [gmailDecisions, setGmailDecisions] = useState<Map<string, InboxDecision>>(
    () => new Map(),
  );
  const [outlookMessages, setOutlookMessages] = useState<OutlookMessage[]>([]);
  const [outlookLoading, setOutlookLoading] = useState(false);
  const [outlookError, setOutlookError] = useState<string | null>(null);
  const [outlookStatus, setOutlookStatus] = useState("");
  const [outlookDecisions, setOutlookDecisions] = useState<Map<string, InboxDecision>>(
    () => new Map(),
  );
  const [telegramMessages, setTelegramMessages] = useState<TelegramMessage[]>([]);
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const [telegramPolling, setTelegramPolling] = useState<TelegramPollingStatus>({
    running: false,
    intervalSeconds: 60,
    lastStartedAt: null,
    lastFetchedAt: null,
    lastMessageCount: 0,
    lastError: null,
  });
  const [telegramDecisions, setTelegramDecisions] = useState<Map<string, InboxDecision>>(
    () => new Map(),
  );
  const [migrationServices, setMigrationServices] = useState<LegacyLaunchdService[]>([]);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [inboxSourceFilter, setInboxSourceFilter] = useState<string | null>(null);
  const [inboxFocusTick, setInboxFocusTick] = useState(0);
  const [inboxActionBusy, setInboxActionBusy] = useState(false);
  const [updateToast, setUpdateToast] = useState<UpdateToast | null>(null);
  const [terminalLaunchRequest, setTerminalLaunchRequest] =
    useState<TerminalLaunchRequest | null>(null);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const skillsStartupLoadKeyRef = useRef<string | null>(null);
  const [composeSeed, setComposeSeed] = useState<ComposeDialogSeed | null>(null);
  const [meetingsRequestedView, setMeetingsRequestedView] = useState<
    "transcript" | "external" | null
  >(null);
  const [maruSettings, setMaruSettings] = useState<MaruSettings>(() =>
    normalizeMaruSettings(DEFAULT_MARU_SETTINGS),
  );
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [, startExplorerTransition] = useTransition();
  const scanOptions = useMemo(
    () => ({ includeDotFolders: maruSettings.scan.includeDotFolders }),
    [maruSettings.scan.includeDotFolders],
  );
  const terminalRuntimeCommands = useMemo<Partial<Record<SkillDispatchRuntime, string | null>>>(
    () => ({
      claude: maruSettings.terminal.launchers.claude.command ?? null,
      codex: maruSettings.terminal.launchers.codex.command ?? null,
    }),
    [
      maruSettings.terminal.launchers.claude.command,
      maruSettings.terminal.launchers.codex.command,
    ],
  );
  const aiRuntimeCommands = useMemo<Partial<Record<SkillDispatchRuntime, string | null>>>(
    () => ({
      claude: maruSettings.ai.commandOverrides.claude,
      codex: maruSettings.ai.commandOverrides.codex,
    }),
    [maruSettings.ai.commandOverrides.claude, maruSettings.ai.commandOverrides.codex],
  );

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
  const documentFilter = documentFilterByVisibility[explorerVisibility];
  const savedCollapsedTreeFolders = collapsedTreeFoldersByVisibility[explorerVisibility];
  const savedCollapsedFileFolders = collapsedFileFoldersByVisibility[explorerVisibility];
  const defaultCollapsedTreeFolders = useMemo(
    () =>
      explorerVisibility === "private" && !maruSettings.ui.documentTreeStateInitialized
        ? []
        : null,
    [maruSettings.ui.documentTreeStateInitialized, explorerVisibility],
  );
  const collapsedTreeFolders = defaultCollapsedTreeFolders ?? savedCollapsedTreeFolders;
  const defaultCollapsedFileFolders = useMemo(
    () =>
      explorerVisibility === "private" && !maruSettings.ui.fileTreeStateInitialized
        ? []
        : null,
    [maruSettings.ui.fileTreeStateInitialized, explorerVisibility],
  );
  const collapsedFileFolders = defaultCollapsedFileFolders ?? savedCollapsedFileFolders;
  const documentIndex = useMemo<DocumentIndex>(() => buildDocumentIndex(entries), [entries]);
  const builtInDocumentViewCounts = useMemo<Record<BuiltInDocumentView, number>>(
    () => ({
      inbox: countDocumentFilter(documentIndex, { kind: "view", view: "inbox" }),
      drafts: countDocumentFilter(documentIndex, { kind: "view", view: "drafts" }),
      archive: countDocumentFilter(documentIndex, { kind: "view", view: "archive" }),
      recentlyUpdated: countDocumentFilter(documentIndex, {
        kind: "view",
        view: "recentlyUpdated",
      }),
    }),
    [documentIndex],
  );
  const customDocumentViewCounts = useMemo(
    () =>
      Object.fromEntries(
        maruSettings.ui.documentViews.map((view) => [
          view.id,
          countDocumentFilter(
            documentIndex,
            { kind: "custom", viewId: view.id },
            { customViews: maruSettings.ui.documentViews },
          ),
        ]),
      ),
    [maruSettings.ui.documentViews, documentIndex],
  );
  useEffect(() => {
    const viewIds = new Set(maruSettings.ui.documentViews.map((view) => view.id));
    setDocumentFilterByVisibility((current) => {
      let changed = false;
      const next = { ...current };
      for (const visibility of ["private", "public"] as const) {
        const filter = next[visibility];
        if (filter.kind === "custom" && !viewIds.has(filter.viewId)) {
          next[visibility] = { kind: "all" };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [maruSettings.ui.documentViews]);
  const selectedFilePaths = useMemo(
    () =>
      explorerWorkspacePath
        ? selectedFilePathsByWorkspace[explorerWorkspacePath] ?? []
        : [],
    [explorerWorkspacePath, selectedFilePathsByWorkspace],
  );
  const selectedFilePathSet = useMemo(
    () => new Set(selectedFilePaths),
    [selectedFilePaths],
  );
  const queuedSourcePaths = useMemo(
    () => fileQueue.map((item) => item.sourcePath),
    [fileQueue],
  );
  const selectedWorkspaceFileEntries = useMemo(
    () => fileEntries.filter((entry) => selectedFilePathSet.has(entry.path)),
    [fileEntries, selectedFilePathSet],
  );
  const unorderedAnyTabs = useMemo<AnyTab[]>(() => [...tabs, ...binaryTabs], [tabs, binaryTabs]);
  const orderedAnyTabs = useMemo(
    () => orderTabsById(unorderedAnyTabs, tabOrder),
    [tabOrder, unorderedAnyTabs],
  );
  const layoutSettings = maruSettings.ui.layout;
  const editorSplitOpen =
    layoutSettings.editorSplitOpen &&
    (layoutSettings.editorSplitSurface === "graph" || Boolean(rightActiveTabId));
  const rightGraphOpen =
    editorSplitOpen && layoutSettings.editorSplitSurface === "graph";
  // View-mode reads/writes target the pane that actually shows a document;
  // while the graph owns the right pane, that is always the left pane.
  const focusedDocumentGroup: EditorGroupId =
    focusedEditorGroup === "right" && rightGraphOpen ? "left" : focusedEditorGroup;
  const editorViewMode = editorPaneViewModes[focusedDocumentGroup];
  const firstTabId = orderedAnyTabs[0]?.id ?? null;
  const leftResolvedTabId = leftActiveTabId ?? activeTabId ?? firstTabId;
  const rightResolvedTabId =
    editorSplitOpen &&
    layoutSettings.editorSplitSurface === "document" &&
    rightActiveTabId
      ? rightActiveTabId
      : null;
  const resolvedActiveTabId =
    focusedEditorGroup === "right" && rightResolvedTabId
      ? rightResolvedTabId
      : leftResolvedTabId;
  const findAnyTabById = useCallback(
    (tabId: string | null): AnyTab | null => {
      if (!tabId) return null;
      return (
        tabs.find((tab) => tab.id === tabId) ??
        binaryTabs.find((tab) => tab.id === tabId) ??
        null
      );
    },
    [tabs, binaryTabs],
  );
  const activeTab = useMemo<AnyTab | null>(
    () => findAnyTabById(resolvedActiveTabId),
    [findAnyTabById, resolvedActiveTabId],
  );
  const leftTab = useMemo<AnyTab | null>(
    () => findAnyTabById(leftResolvedTabId),
    [findAnyTabById, leftResolvedTabId],
  );
  const rightTab = useMemo<AnyTab | null>(
    () => findAnyTabById(rightResolvedTabId),
    [findAnyTabById, rightResolvedTabId],
  );
  const activeDocTab = isBinaryTab(activeTab) ? null : (activeTab as EditorTab | null);
  const selectedEntry = activeDocTab?.entry ?? null;
  const document = activeDocTab?.document ?? null;
  const evidenceBinderDocId = useMemo(
    () => (document ? studioDocIdFromDocument(document) : null),
    [document],
  );
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
  const scratchpadRoot = useMemo(() => {
    const privateRoot =
      workspaceRegistry.activeByVisibility.private ?? privateWorkspaces[0]?.path ?? null;
    if (!privateRoot) return null;
    return scratchpadRootForWorkspace(privateRoot);
  }, [privateWorkspaces, workspaceRegistry.activeByVisibility.private]);
  const activeTerminalContext = useMemo<ActiveTerminalContext>(() => {
    const frontmatterType = selectedEntry?.frontmatter?.type;
    return {
      workspaceRoot: activeDocumentWorkspacePath ?? null,
      scratchpadRoot,
      workspaceVisibility: explorerVisibility,
      appMode,
      docAbsPath: selectedEntry?.path ?? document?.path ?? null,
      docRelPath: selectedEntry?.relPath ?? null,
      docTitle: selectedEntry?.title ?? document?.title ?? null,
      docType: typeof frontmatterType === "string" ? frontmatterType : null,
    };
  }, [
    activeDocumentWorkspacePath,
    appMode,
    document?.path,
    document?.title,
    explorerVisibility,
    selectedEntry?.frontmatter?.type,
    selectedEntry?.path,
    selectedEntry?.relPath,
    selectedEntry?.title,
    scratchpadRoot,
  ]);
  const terminalPanelRef = useRef<TerminalPanelHandle | null>(null);
  const shouldScanExplorerWorkspaceFiles = shouldLazyScanWorkspaceFiles({
    paneMode: maruSettings.ui.explorerPaneMode,
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
  // Workspace root used by the Shared Outbox tab — the active document's
  // workspace in Docs, the inbox workspace otherwise.
  const shareWorkspacePath =
    activeDocumentWorkspacePath ?? inboxWorkspacePath ?? primaryWorkspacePath;
  const activeDocumentEntries =
    (activeTab ? workspaceStates[activeTab.workspacePath]?.entries : entries) ?? entries;
  const openingEntry =
    pendingSelectedPath && pendingSelectedPath !== document?.path
      ? activeDocumentEntries.find((entry) => entry.path === pendingSelectedPath) ?? null
      : null;
  const draftContent = activeDocTab?.draftContent ?? "";
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
  const workspaceConfigPath = settingsWorkPath ?? inboxWorkspacePath;
  const settingsWorkspaceStartupReady =
    !settingsWorkPath || Boolean(workspaceStates[settingsWorkPath]?.startupIoReady);
  useEffect(() => {
    let cancelled = false;
    if (!workspaceConfigPath) {
      setWorkspaceConfig(null);
      return () => {
        cancelled = true;
      };
    }
    void readWorkspaceConfig(workspaceConfigPath)
      .then((config) => {
        if (!cancelled) setWorkspaceConfig(config);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceConfigPath]);
  const effectiveCommsSettings = useMemo(
    () => applyWorkspaceCommsOverrides(maruSettings.comms, workspaceConfig),
    [maruSettings.comms, workspaceConfig],
  );
  const effectiveMeetingsSettings = useMemo(
    () => applyWorkspaceMeetingsOverrides(maruSettings.meetings, workspaceConfig),
    [maruSettings.meetings, workspaceConfig],
  );
  const effectiveTasksSettings = useMemo(
    () => applyWorkspaceTasksOverrides(maruSettings.tasks, workspaceConfig),
    [maruSettings.tasks, workspaceConfig],
  );
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
      orderedAnyTabs.map((tab) => {
        if (isBinaryTab(tab)) {
          return {
            id: tab.id,
            title: tab.fileEntry.name,
            path: tab.fileEntry.path,
            relPath: tab.fileEntry.relPath,
            dirty: false,
            canRenameMove: false,
            canCreate: false,
            canDelete: false,
            writeBlockedReason: null,
          };
        }
        const workspace =
          workspaceRegistry.workspaces.find((item) => item.path === tab.workspacePath) ??
          null;
        return {
          id: tab.id,
          title: documentDisplayName(tab.document, maruSettings.ui.documentLabelMode),
          path: tab.document.path,
          relPath: tab.document.relPath,
          dirty: tab.draftContent !== tab.document.content,
          canRenameMove: workspaceCan(workspace, "renameMove"),
          canCreate: workspaceCan(workspace, "create"),
          canDelete: workspaceCan(workspace, "delete"),
          writeBlockedReason: workspaceWriteReason(workspace, "renameMove"),
        };
      }),
    [maruSettings.ui.documentLabelMode, orderedAnyTabs, workspaceRegistry.workspaces],
  );
  const commandPaletteSkillActions = useMemo(
    () =>
      skills.slice(0, 30).map((skill) => ({
        id: `skill:${skill.id}`,
        label: `/skill ${skill.name}`,
        hint: skill.description ?? skill.sourceId,
      })),
    [skills],
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
    // Patch tabsRef synchronously so dirty-check readers (hasDirtyDrafts,
    // onCloseRequested) see an HTML WYSIWYG flush immediately.
    tabsRef.current = tabsRef.current.map((tab) =>
      tab.id === tabId ? { ...tab, draftContent: content } : tab,
    );
  }, []);

  // Flush the live HTML WYSIWYG editor showing `tabId` (if any) so pending
  // iframe edits land in the draft before save/snapshot/close/mode-switch.
  // flushNow routes through onChange -> updateTabDraft; returns the serialized
  // content, or null when the tab is not mounted in a visual HTML editor.
  const flushHtmlDraft = useCallback(
    (tabId: string): string | null => {
      // The same doc can be open in both split panes; flush BOTH so neither
      // pane's pending edit is dropped. Last non-null wins the draft (the most
      // recently serialized content).
      let result: string | null = null;
      if (leftResolvedTabId === tabId) {
        result = leftHtmlFlushRef.current?.flushNow() ?? result;
      }
      if (rightResolvedTabId === tabId) {
        result = rightHtmlFlushRef.current?.flushNow() ?? result;
      }
      return result;
    },
    [leftResolvedTabId, rightResolvedTabId],
  );

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
    const liveIds = unorderedAnyTabs.map((tab) => tab.id);
    const liveIdSet = new Set(liveIds);
    setTabOrder((current) => {
      const next = current.filter((id) => liveIdSet.has(id));
      const seen = new Set(next);
      for (const id of liveIds) {
        if (seen.has(id)) continue;
        next.push(id);
        seen.add(id);
      }
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next;
    });
  }, [unorderedAnyTabs]);

  useEffect(() => {
    let cancelled = false;
    setSettingsLoaded(false);
    if (!settingsWorkPath) {
      if (booting && workspaceRegistry.workspaces.length === 0) {
        return () => {
          cancelled = true;
        };
      }
      setMaruSettings(normalizeMaruSettings(DEFAULT_MARU_SETTINGS));
      setSettingsLoaded(true);
      return;
    }
    void readMaruSettings(settingsWorkPath)
      .then((settings) => {
        if (!cancelled) {
          setMaruSettings(settings);
          // A boot-time Today auto-open beat this load; keep it instead of
          // re-applying the persisted mode over it.
          setAppMode(
            todayAutoOpenPathRef.current === settingsWorkPath
              ? "tasks"
              : settings.ui.activeAppMode,
          );
          setEditorPaneViewModes(settings.ui.editorPaneViewModes);
          setRightPaneTab(settings.ui.rightPaneTab);
          setSettingsLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMaruSettings(normalizeMaruSettings(DEFAULT_MARU_SETTINGS));
          setSettingsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [booting, settingsWorkPath, workspaceRegistry.workspaces.length]);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    void listenMaruSettingsUpdated((payload) => {
      // Unrelated settings saves (layout, outline, …) echo back here with the
      // stored activeAppMode; they must not clobber a boot Today auto-open.
      const keepAutoOpenMode = () => todayAutoOpenPathRef.current === settingsWorkPath;
      if (payload.workPath === settingsWorkPath) {
        const next = normalizeMaruSettings(payload.settings);
        setMaruSettings(next);
        if (!keepAutoOpenMode()) setAppMode(next.ui.activeAppMode);
        setEditorPaneViewModes(next.ui.editorPaneViewModes);
        setRightPaneTab(next.ui.rightPaneTab);
      } else if (payload.globalChanged && settingsWorkPath) {
        void readMaruSettings(settingsWorkPath)
          .then((next) => {
            setMaruSettings(next);
            if (!keepAutoOpenMode()) setAppMode(next.ui.activeAppMode);
            setEditorPaneViewModes(next.ui.editorPaneViewModes);
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
    applyThemePreference(maruSettings.ui.themeMode);
    applyThemeVars(buildThemeVars(maruSettings));
  }, [maruSettings]);

  useEffect(() => {
    if (!settingsWritable || !settingsWorkPath) {
      settingsSaverRef.current = null;
      settingsSaveBaseRef.current = null;
      return;
    }
    const saver = createDebouncedSaver<MaruSettings>(
      async (settings) => {
        const base = settingsSaveBaseRef.current ?? undefined;
        settingsSaveBaseRef.current = null;
        await saveMaruSettings(settingsWorkPath, settings, base);
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

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const hasDirtyDrafts = useCallback(() => {
    // Flush live HTML WYSIWYG editors first; updateTabDraft patches tabsRef
    // synchronously, so the dirty check below sees fresh iframe edits.
    leftHtmlFlushRef.current?.flushNow();
    rightHtmlFlushRef.current?.flushNow();
    return tabsRef.current.some((tab) => tab.draftContent !== tab.document.content);
  }, []);

  const relaunchAfterSettingsFlush = useCallback(async () => {
    try {
      await settingsSaverRef.current?.flush();
      await relaunchApp();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const requestRelaunch = useCallback(async () => {
    if (hasDirtyDrafts()) {
      setPendingDestructiveAction("relaunch");
      return;
    }
    await relaunchAfterSettingsFlush();
  }, [hasDirtyDrafts, relaunchAfterSettingsFlush]);

  const confirmDestructiveAction = useCallback(async () => {
    const action = pendingDestructiveAction;
    setPendingDestructiveAction(null);
    if (action === "relaunch") {
      await relaunchAfterSettingsFlush();
      return;
    }
    if (action === "close") {
      try {
        await settingsSaverRef.current?.flush();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      closeConfirmedRef.current = true;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().close();
      } catch (err) {
        closeConfirmedRef.current = false;
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [pendingDestructiveAction, relaunchAfterSettingsFlush]);

  // Main-window close: flush pending settings writes before the window goes
  // away, and gate on unsaved drafts instead of losing them silently. The
  // Rust side no longer force-destroys windows on CloseRequested, so this
  // handler's preventDefault actually wins.
  useEffect(() => {
    if (!tauriAvailable()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let closing = false;

    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (disposed) return;
        const appWindow = getCurrentWindow();
        if (appWindow.label !== "main") return;
        return appWindow.onCloseRequested(async (event) => {
          // A close confirmed via the dirty-draft dialog replays through
          // here; consume the one-shot guard and let the default close proceed.
          if (closeConfirmedRef.current) {
            closeConfirmedRef.current = false;
            return;
          }
          if (closing) return;
          event.preventDefault();
          if (hasDirtyDrafts()) {
            setPendingDestructiveAction("close");
            return;
          }
          closing = true;
          try {
            await settingsSaverRef.current?.flush();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
          closeConfirmedRef.current = true;
          try {
            await appWindow.close();
          } catch (err) {
            closeConfirmedRef.current = false;
            closing = false;
            setError(err instanceof Error ? err.message : String(err));
          }
        });
      })
      .then((off) => {
        if (!off) return;
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [hasDirtyDrafts]);

  const updateSettings = useCallback(
    (
      updater: MaruSettings | ((current: MaruSettings) => MaruSettings),
      options?: { flush?: boolean },
    ) => {
      setMaruSettings((current) => {
        const next = normalizeMaruSettings(
          typeof updater === "function" ? updater(current) : updater,
        );
        if (settingsWritable && settingsWorkPath) {
          const saver = settingsSaverRef.current;
          if (saver) {
            if (!settingsSaveBaseRef.current) {
              settingsSaveBaseRef.current = current;
            }
            saver.schedule(next);
            if (options?.flush) {
              void saver.flush();
            }
          } else {
            void saveMaruSettings(settingsWorkPath, next, current).catch((err) => {
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
    (
      patch: Partial<MaruSettings["ui"]["layout"]>,
      options?: { flush?: boolean },
    ) => {
      updateSettings((current) => {
        const layout = {
          ...current.ui.layout,
          ...patch,
        };
        // terminal.defaultPanelOpen/lastHeight are legacy migration mirrors
        // that normalizeMaruSettings re-derives from ui.layout — no explicit
        // write here.
        return {
          ...current,
          ui: {
            ...current.ui,
            layout,
          },
        };
      }, options);
    },
    [updateSettings],
  );

  // Keep the latest updater in a ref so the launch listener below registers
  // exactly once: re-registering on workspace/policy changes opens a window
  // where a settings-window emit has no subscriber and is silently lost.
  const updateLayoutSettingsRef = useRef(updateLayoutSettings);
  useEffect(() => {
    updateLayoutSettingsRef.current = updateLayoutSettings;
  }, [updateLayoutSettings]);

  const requestTerminalLaunch = useCallback(
    (kind: TerminalKind) => {
      markStartup("terminal:launch-request", { kind });
      setTerminalLaunchRequest({
        kind,
        nonce: Date.now(),
      });
      updateLayoutSettings({ terminalOpen: true });
    },
    [updateLayoutSettings],
  );

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen(SETTINGS_WINDOW_TERMINAL_LAUNCH_EVENT, (event) => {
          const payload = event.payload as SettingsWindowTerminalLaunchPayload | null;
          if (!payload) return;
          setTerminalLaunchRequest({
            kind: "shell",
            nonce: Date.now(),
            title: "Provider Auth",
            cwd: payload.cwd,
            command: payload.command,
            extraArgs: payload.args,
          });
          updateLayoutSettingsRef.current({ terminalOpen: true });
        }),
      )
      .then((off) => {
        if (disposed) {
          off();
        } else {
          dispose = off;
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
      dispose?.();
    };
  }, []);

  const attachActiveItemToTerminal = useCallback(() => {
    if (!maruSettings.ui.layout.terminalOpen) {
      updateLayoutSettings({ terminalOpen: true });
    }
    return terminalPanelRef.current?.attachActiveItem() ?? false;
  }, [maruSettings.ui.layout.terminalOpen, updateLayoutSettings]);

  const attachPathToTerminal = useCallback(
    (relPath: string | null, absPath: string | null) => {
      if (!maruSettings.ui.layout.terminalOpen) {
        updateLayoutSettings({ terminalOpen: true });
      }
      return terminalPanelRef.current?.attachPath(relPath, absPath) ?? false;
    },
    [maruSettings.ui.layout.terminalOpen, updateLayoutSettings],
  );

  const toggleAgentStatusHooks = useCallback(async () => {
    const workPath = activeDocumentWorkspacePath;
    const scope: "project" | "global" = workPath ? "project" : "global";
    try {
      const status = await terminalHooksStatus(workPath, scope);
      const next = status.claudeInstalled
        ? await terminalHooksUninstall(workPath, scope)
        : await terminalHooksInstall(workPath, scope);
      setError(
        next.claudeInstalled
          ? t("terminal.hooks.enabled", { path: next.claudePath })
          : t("terminal.hooks.disabled", { path: next.claudePath }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeDocumentWorkspacePath, t]);

  const writeAgentContextHintCommand = useCallback(
    async (remove: boolean) => {
      const workPath = activeDocumentWorkspacePath;
      if (!workPath) {
        setError(t("terminal.hint.noWorkspace"));
        return;
      }
      try {
        const targets = ["claude", "agents"];
        const paths = remove
          ? await removeAgentContextHint(workPath, targets)
          : await writeAgentContextHint(workPath, targets);
        setError(
          remove
            ? t("terminal.hint.removed", { count: paths.length })
            : t("terminal.hint.written", { count: paths.length }),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [activeDocumentWorkspacePath, t],
  );

  const refreshSkills = useCallback(async (options: { refresh?: boolean } = {}) => {
    if (!settingsWorkPath) {
      setSkills([]);
      return [];
    }
    setSkillsLoading(true);
    try {
      const next = await measureStartup(
        options.refresh ? "skills:refresh" : "skills:cached-read",
        () => skillsListSkills(settingsWorkPath, options),
        { workPath: settingsWorkPath },
      );
      setSkills(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      setSkillsLoading(false);
    }
  }, [settingsWorkPath]);

  useEffect(() => {
    if (booting || !settingsWorkPath || !settingsWorkspaceStartupReady) return;
    if (skillsStartupLoadKeyRef.current === settingsWorkPath) return;

    const key = settingsWorkPath;
    let cancelled = false;
    let started = false;
    let cancelRefresh: (() => void) | null = null;
    const cancelCached = scheduleStartupIdle(() => {
      started = true;
      skillsStartupLoadKeyRef.current = key;
      void (async () => {
        const cached = await refreshSkills();
        if (cancelled || cached.length > 0) return;
        cancelRefresh = scheduleStartupIdle(() => {
          if (!cancelled) void refreshSkills({ refresh: true });
        }, 2500);
      })();
    });

    return () => {
      cancelled = true;
      cancelCached();
      cancelRefresh?.();
      if (!started && skillsStartupLoadKeyRef.current === key) {
        skillsStartupLoadKeyRef.current = null;
      }
    };
  }, [booting, refreshSkills, settingsWorkPath, settingsWorkspaceStartupReady]);

  const setPersistedAppMode = useCallback(
    (activeAppMode: AppMode) => {
      todayAutoOpenPathRef.current = null; // explicit user choice from here on
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

  const openGraphMode = useCallback(
    (target?: GraphOpenTarget) => {
      setGraphOpenTarget(target ?? null);
      todayAutoOpenPathRef.current = null;
      setAppMode("graph");
      updateSettings((current) => ({
        ...current,
        ui: { ...current.ui, activeAppMode: "graph" },
        graph: target
          ? { ...current.graph, source: target.source, mode: "local" }
          : current.graph,
      }));
    },
    [updateSettings],
  );

  useEffect(() => {
    if (!e2eFlowEnabled && appMode === "e2e") {
      setPersistedAppMode("pkm");
    }
  }, [appMode, e2eFlowEnabled, setPersistedAppMode]);

  useEffect(() => {
    if (!diagramEnabled && appMode === "diagram") {
      setPersistedAppMode("pkm");
    }
  }, [appMode, diagramEnabled, setPersistedAppMode]);

  const setPersistedEditorViewMode = useCallback(
    (editorViewMode: EditorViewModeSetting, group: EditorGroupId = focusedDocumentGroup) => {
      setEditorPaneViewModes((current) => ({ ...current, [group]: editorViewMode }));
      updateSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          editorViewMode:
            group === "left" ? editorViewMode : current.ui.editorPaneViewModes.left,
          editorPaneViewModes: {
            ...current.ui.editorPaneViewModes,
            [group]: editorViewMode,
          },
        },
      }));
    },
    [focusedDocumentGroup, updateSettings],
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
    void restoreMainWindowLayout(maruSettings.ui.layout).catch(() => {});
  }, [maruSettings.ui.layout, settingsLoaded, settingsWorkPath]);

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
      private: maruSettings.ui.documentTreeStateInitialized
        ? maruSettings.ui.collapsedTreeFolders
        : current.private,
    }));
  }, [
    maruSettings.ui.collapsedTreeFolders,
    maruSettings.ui.documentTreeStateInitialized,
    settingsLoaded,
  ]);

  useEffect(() => {
    if (!settingsLoaded || maruSettings.ui.activeWorkspaceVisibility === explorerVisibility) {
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
    maruSettings.ui.activeWorkspaceVisibility,
    explorerVisibility,
    settingsLoaded,
    updateSettings,
  ]);

  useEffect(() => {
    if (!settingsLoaded || collapsedFileHydratedRef.current) return;
    collapsedFileHydratedRef.current = true;
    setCollapsedFileFoldersByVisibility((current) => ({
      ...current,
      private: maruSettings.ui.fileTreeStateInitialized
        ? maruSettings.ui.collapsedFileFolders
        : current.private,
    }));
  }, [
    maruSettings.ui.collapsedFileFolders,
    maruSettings.ui.fileTreeStateInitialized,
    settingsLoaded,
  ]);

  const privateWorkspacePath = workspaceRegistry.activeByVisibility.private;
  const privateWorkspaceState =
    (privateWorkspacePath ? workspaceStates[privateWorkspacePath] : null) ??
    EMPTY_WORKSPACE_STATE;

  useEffect(() => {
    if (!settingsLoaded || maruSettings.ui.documentTreeStateInitialized) return;
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
    maruSettings.ui.documentTreeStateInitialized,
    privateWorkspacePath,
    privateWorkspaceState.startupIoReady,
    settingsLoaded,
    updateSettings,
  ]);

  useEffect(() => {
    if (!settingsLoaded || maruSettings.ui.fileTreeStateInitialized) return;
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
    maruSettings.ui.fileTreeStateInitialized,
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

  const setFilesBrowserMode = useCallback(
    (filesBrowserMode: FilesBrowserMode) => {
      updateSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          filesBrowserMode,
        },
      }));
    },
    [updateSettings],
  );

  const setFilesSortKey = useCallback(
    (filesSortKey: FilesSortKey) => {
      updateSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          filesSortKey,
        },
      }));
    },
    [updateSettings],
  );

  const setFilesListAttributes = useCallback(
    (filesListAttributes: FilesListAttribute[]) => {
      updateSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          filesListAttributes,
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

  const setExplorerDocumentFilter = useCallback(
    (next: DocumentFilter) => {
      startExplorerTransition(() =>
        setDocumentFilterByVisibility((current) => ({
          ...current,
          [explorerVisibility]: next,
        })),
      );
    },
    [explorerVisibility, startExplorerTransition],
  );

  const updateDocumentViews = useCallback(
    (documentViews: DocumentViewDefinition[]) => {
      updateSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          documentViews,
        },
      }));
    },
    [updateSettings],
  );

  // Best-effort persistence of the chosen mode into .maru/workspace.json.
  // Failures are silent — this is a UX nicety, not a correctness concern.
  useEffect(() => {
    if (!systemWorkPath) return;
    void updateMaruWorkspace(systemWorkPath, { lastActiveMode: appMode }).catch(() => {});
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
      const activeDocForStorage =
        activeTab && !isBinaryTab(activeTab) ? (activeTab as EditorTab) : null;
      window.localStorage.setItem(
        openTabsKeyForWorkspace(workspacePath),
        JSON.stringify({
          activeRelPath:
            activeDocForStorage?.workspacePath === workspacePath
              ? activeDocForStorage.entry.relPath
              : null,
          leftRelPath: relPathForTabId(leftActiveTabId),
          rightRelPath: relPathForTabId(rightActiveTabId),
          focusedGroup: focusedEditorGroup,
          relPaths: workspaceTabs.map((tab) => tab.entry.relPath),
        } satisfies StoredTabs),
      );
    }
    if (activeTab && !isBinaryTab(activeTab)) {
      const docTab = activeTab as EditorTab;
      window.localStorage.setItem(
        lastOpenKeyForWorkspace(docTab.workspacePath),
        docTab.entry.relPath,
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
  const inboxSourceFolderKeys = useMemo(
    () => Object.keys(inboxRuntimeConfig.channels ?? {}),
    [inboxRuntimeConfig],
  );

  const gmailItems = useMemo<GmailMessageState[]>(
    () => buildGmailMessageStates(gmailMessages, gmailDecisions),
    [gmailMessages, gmailDecisions],
  );
  const outlookItems = useMemo<OutlookMessageState[]>(
    () => buildOutlookMessageStates(outlookMessages, outlookDecisions),
    [outlookMessages, outlookDecisions],
  );
  const telegramItems = useMemo<TelegramMessageState[]>(
    () => buildTelegramMessageStates(telegramMessages, telegramDecisions),
    [telegramMessages, telegramDecisions],
  );

  const gmailStatus = useMemo(
    () => formatGmailScanStatus(gmailScanStatus, gmailLoading, locale),
    [gmailLoading, gmailScanStatus, locale],
  );

  useEffect(() => {
    processingMissionIdsRef.current = new Set(processingMissions.map((mission) => mission.id));
  }, [processingMissions]);

  const updateGmailScanStatus = useCallback((status: GmailScanStatus) => {
    gmailScanStatusRef.current = status;
    setGmailScanStatus(status);
  }, []);

  const refreshGmail = useCallback(async ({
    force = false,
    runtimeOverride,
  }: {
    force?: boolean;
    runtimeOverride?: InboxRuntimeConfig;
  } = {}) => {
    const runtime = runtimeOverride ?? inboxRuntimeConfig;
    const gmailConfig = runtime.gmail ?? DEFAULT_INBOX_RUNTIME_CONFIG.gmail;
    const ttlSeconds = normalizeGmailRefreshTtl(gmailConfig.auto_refresh_ttl_seconds);
    const max = normalizeGmailScanLimit(gmailConfig.max_results);
    const query = buildGmailScanQuery(gmailConfig);
    const previous = gmailScanStatusRef.current;
    const decision = gmailRefreshPolicy({
      enabled: gmailConfig.enabled && Boolean(inboxWorkspacePath),
      force,
      loading: gmailLoadingRef.current,
      now: Date.now(),
      lastFetchedAt: previous.fetchedAt,
      ttlSeconds,
      query,
      previousQuery: previous.query,
      max,
      previousMax: previous.max,
    });
    if (decision === "disabled") {
      gmailRequestSeqRef.current += 1;
      gmailLoadingRef.current = false;
      setGmailMessages([]);
      setGmailError(null);
      setGmailLoading(false);
      updateGmailScanStatus({
        fetchedAt: null,
        durationMs: null,
        query,
        max,
        ttlSeconds,
      });
      return;
    }
    if (decision !== "start") {
      if (
        previous.query !== query ||
        previous.max !== max ||
        previous.ttlSeconds !== ttlSeconds
      ) {
        updateGmailScanStatus({
          ...previous,
          query,
          max,
          ttlSeconds,
        });
      }
      return;
    }
    const requestId = ++gmailRequestSeqRef.current;
    gmailLoadingRef.current = true;
    setGmailLoading(true);
    setGmailError(null);
    const wallStartedAt = Date.now();
    const perfStartedAt = globalThis.performance?.now() ?? wallStartedAt;
    try {
      const messages = await fetchGmailUnread(inboxWorkspacePath, max, query);
      if (!shouldApplyGmailRefreshResult(requestId, gmailRequestSeqRef.current)) return;
      const wallFinishedAt = Date.now();
      const perfFinishedAt = globalThis.performance?.now() ?? wallFinishedAt;
      setGmailMessages(messages);
      updateGmailScanStatus({
        fetchedAt: wallFinishedAt,
        durationMs: Math.max(0, perfFinishedAt - perfStartedAt),
        query,
        max,
        ttlSeconds,
      });
    } catch (err) {
      if (!shouldApplyGmailRefreshResult(requestId, gmailRequestSeqRef.current)) return;
      setGmailError(err instanceof Error ? err.message : String(err));
    } finally {
      if (shouldApplyGmailRefreshResult(requestId, gmailRequestSeqRef.current)) {
        gmailLoadingRef.current = false;
        setGmailLoading(false);
      }
    }
  }, [inboxRuntimeConfig, inboxWorkspacePath, updateGmailScanStatus]);

  const refreshOutlook = useCallback(async ({ force = false }: { force?: boolean } = {}) => {
    if (!inboxWorkspacePath || !effectiveCommsSettings.outlook.enabled) {
      outlookLoadingRef.current = false;
      outlookRefreshCacheRef.current = { fetchedAt: null, key: "" };
      setOutlookMessages([]);
      setOutlookLoading(false);
      setOutlookError(null);
      setOutlookStatus("");
      return;
    }
    const refreshKey = JSON.stringify({
      workPath: inboxWorkspacePath,
      max: effectiveCommsSettings.outlook.maxResults,
      m365Path: effectiveCommsSettings.outlook.m365Path ?? null,
    });
    if (
      shouldSkipProviderRefresh(
        outlookRefreshCacheRef.current,
        refreshKey,
        force,
        outlookLoadingRef.current,
        OUTLOOK_REFRESH_TTL_MS,
      )
    ) {
      return;
    }
    outlookLoadingRef.current = true;
    setOutlookLoading(true);
    setOutlookError(null);
    const startedAt = Date.now();
    try {
      const messages = await fetchOutlookUnread(
        inboxWorkspacePath,
        effectiveCommsSettings.outlook.maxResults,
        effectiveCommsSettings.outlook.m365Path,
      );
      setOutlookMessages(messages);
      outlookRefreshCacheRef.current = {
        fetchedAt: Date.now(),
        key: refreshKey,
      };
      setOutlookStatus(`${messages.length.toLocaleString(locale)} · ${Date.now() - startedAt}ms`);
    } catch (err) {
      setOutlookError(err instanceof Error ? err.message : String(err));
      setOutlookStatus("");
    } finally {
      outlookLoadingRef.current = false;
      setOutlookLoading(false);
    }
  }, [effectiveCommsSettings.outlook, inboxWorkspacePath, locale]);

  const refreshTelegram = useCallback(async ({ force = false }: { force?: boolean } = {}) => {
    if (!inboxWorkspacePath || !effectiveCommsSettings.telegram.enabled) {
      telegramLoadingRef.current = false;
      telegramRefreshCacheRef.current = { fetchedAt: null, key: "" };
      setTelegramMessages([]);
      setTelegramLoading(false);
      setTelegramError(null);
      return;
    }
    const refreshKey = JSON.stringify({
      workPath: inboxWorkspacePath,
      max: effectiveCommsSettings.telegram.maxResults,
      pythonPath: effectiveCommsSettings.telegram.pythonPath ?? null,
      scriptPath: effectiveCommsSettings.telegram.scriptPath ?? null,
      sessionFile: effectiveCommsSettings.telegram.sessionFile ?? null,
      monitorConfigPath: effectiveCommsSettings.telegram.monitorConfigPath ?? null,
      legacyAutoDrop: effectiveCommsSettings.telegram.legacyAutoDrop,
    });
    if (
      shouldSkipProviderRefresh(
        telegramRefreshCacheRef.current,
        refreshKey,
        force,
        telegramLoadingRef.current,
        TELEGRAM_REFRESH_TTL_MS,
      )
    ) {
      return;
    }
    telegramLoadingRef.current = true;
    setTelegramLoading(true);
    setTelegramError(null);
    try {
      const messages = await fetchTelegramRecent(
        telegramFetchOptions(inboxWorkspacePath, effectiveCommsSettings.telegram),
      );
      setTelegramMessages(messages);
      telegramRefreshCacheRef.current = {
        fetchedAt: Date.now(),
        key: refreshKey,
      };
    } catch (err) {
      setTelegramError(err instanceof Error ? err.message : String(err));
    } finally {
      telegramLoadingRef.current = false;
      setTelegramLoading(false);
    }
  }, [effectiveCommsSettings.telegram, inboxWorkspacePath]);

  const refreshCommsProviders = useCallback(async ({ force = false }: { force?: boolean } = {}) => {
    await Promise.allSettled([
      refreshGmail({ force }),
      refreshOutlook({ force }),
      refreshTelegram({ force }),
    ]);
  }, [refreshGmail, refreshOutlook, refreshTelegram]);

  const refreshInbox = useCallback(async () => {
    if (!inboxWorkspacePath) {
      setInboxDrops([]);
      setInboxEntries([]);
      return;
    }
    setInboxLoading(true);
    setError(null);
    try {
      const [drops, entries] = await Promise.all([
        scanInboxDrop(inboxWorkspacePath, scanOptions),
        scanInboxEntries(inboxWorkspacePath, scanOptions),
      ]);
      setInboxDrops(drops);
      setInboxEntries(entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInboxLoading(false);
    }
  }, [inboxWorkspacePath, scanOptions]);

  const refreshProcessedItems = useCallback(async () => {
    if (!inboxWorkspacePath) {
      setProcessedItems([]);
      setProcessedDetail(null);
      return;
    }
    const statuses =
      processedStatusFilter === "all"
        ? (["done", "failed", "duplicate"] as InboxProcessedStatus[])
        : [processedStatusFilter];
    setProcessedLoading(true);
    setProcessedError(null);
    try {
      const items = await scanInboxProcessedItems(
        inboxWorkspacePath,
        statuses,
        processedQuery,
        120,
      );
      setProcessedItems(items);
    } catch (err) {
      setProcessedError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessedLoading(false);
    }
  }, [inboxWorkspacePath, processedQuery, processedStatusFilter]);

  const refreshSourceRuns = useCallback(async () => {
    if (!inboxWorkspacePath) {
      setSourceRuns([]);
      setProcessedCounts({});
      return;
    }
    try {
      const [runs, counts] = await Promise.all([
        readInboxSourceRuns(inboxWorkspacePath),
        countInboxProcessedByChannel(inboxWorkspacePath),
      ]);
      setSourceRuns(runs);
      setProcessedCounts(counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [inboxWorkspacePath]);

  const selectProcessedItem = useCallback(
    async (item: InboxProcessedItem) => {
      if (!inboxWorkspacePath) return;
      setProcessedError(null);
      try {
        const detail = await readInboxProcessedItem(inboxWorkspacePath, item.itemDir);
        setProcessedDetail(detail);
      } catch (err) {
        setProcessedError(err instanceof Error ? err.message : String(err));
      }
    },
    [inboxWorkspacePath],
  );

  const refreshProcessingMissions = useCallback(async () => {
    try {
      const missions = activeTrackedMissions(await listAiMissions());
      setProcessingMissions(missions);
      processingMissionIdsRef.current = new Set(missions.map((mission) => mission.id));
      const tails = await Promise.all(
        missions.map((mission) =>
          readAiMissionLog(mission.id, 80)
            .then((tail) => [mission.id, tail.lines] as const)
            .catch(() => [mission.id, []] as const),
        ),
      );
      setProcessingLogLines((current) => ({
        ...current,
        ...Object.fromEntries(tails),
      }));
    } catch {
      // Mission listing is a secondary diagnostic surface.
    }
  }, []);

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

  const targetFolderForInboxItem = useCallback(
    (id: string, forcedTargetFolder?: string | null) => {
      const forced = forcedTargetFolder?.trim();
      if (forced) return forced;
      const suggested = inboxCarry.get(id)?.classification?.suggestedFolder?.trim();
      if (suggested) return suggested;
      const target = window.prompt(t("app.prompt.inboxTargetFolder"), "inbox/processed");
      return target?.trim() || null;
    },
    [inboxCarry, t],
  );

  const decideInboxItem = useCallback(
    async (id: string, decision: InboxDecision, forcedTargetFolder?: string | null) => {
      if (!inboxWorkspacePath || decision === "pending") return;
      const targetFolder =
        decision === "accepted" ? targetFolderForInboxItem(id, forcedTargetFolder) : null;
      if (decision === "accepted" && !targetFolder) return;
      const approvalId = await approvalGate.confirmApproval({
        kind: decision === "accepted" ? "inbox.file.accept" : "inbox.file.reject",
        summary:
          decision === "accepted"
            ? t("approval.inbox.accept.summary")
            : t("approval.inbox.reject.summary"),
        target: decision === "accepted" ? targetFolder : "inbox/rejected",
        payloadPreview: id,
      });
      if (!approvalId) return;
      setInboxActionBusy(true);
      setError(null);
      try {
        const outcome =
          decision === "accepted"
            ? await acceptInboxItem(inboxWorkspacePath, id, targetFolder ?? "", approvalId)
            : await rejectInboxItem(inboxWorkspacePath, id, approvalId);
        if (!outcome.ok) throw new Error(outcome.error ?? "Inbox decision failed.");
        updateInboxCarry(id, { decision });
        void refreshInbox();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setInboxActionBusy(false);
      }
    },
    [approvalGate, inboxWorkspacePath, refreshInbox, targetFolderForInboxItem, updateInboxCarry, t],
  );

  const decideGmailItem = useCallback(
    async (id: string, decision: InboxDecision) => {
      if (decision === "pending") return;
      const approvalId = await approvalGate.confirmApproval({
        kind: decision === "accepted" ? "gmail.accept" : "gmail.reject",
        summary:
          decision === "accepted"
            ? t("approval.gmail.accept.summary")
            : t("approval.gmail.reject.summary"),
        target: id,
        payloadPreview: decision === "accepted" ? "add maru-accepted; remove INBOX" : "add maru-rejected",
      });
      if (!approvalId) return;
      setInboxActionBusy(true);
      setGmailError(null);
      try {
        const outcome = await decideGmailItemApi(inboxWorkspacePath, id, decision, approvalId);
        if (!outcome.ok) throw new Error(outcome.error ?? "Gmail decision failed.");
        setGmailDecisions((prev) => {
          const next = new Map(prev);
          next.set(id, decision);
          return next;
        });
      } catch (err) {
        setGmailError(err instanceof Error ? err.message : String(err));
      } finally {
        setInboxActionBusy(false);
      }
    },
    [approvalGate, inboxWorkspacePath, t],
  );

  const decideOutlookItem = useCallback(
    async (id: string, decision: InboxDecision) => {
      if (decision === "pending") return;
      const approvalId = await approvalGate.confirmApproval({
        kind: decision === "accepted" ? "outlook.accept" : "outlook.reject",
        summary:
          decision === "accepted"
            ? t("approval.outlook.accept.summary")
            : t("approval.outlook.reject.summary"),
        target: id,
        payloadPreview: decision === "accepted" ? "add maru-accepted" : "add maru-rejected",
      });
      if (!approvalId) return;
      setOutlookError(null);
      try {
        const outcome = await decideOutlookItemApi(
          inboxWorkspacePath,
          id,
          decision,
          approvalId,
          effectiveCommsSettings.outlook.m365Path,
        );
        if (!outcome.ok) throw new Error(outcome.error ?? "Outlook decision failed.");
        setOutlookDecisions((prev) => {
          const next = new Map(prev);
          next.set(id, decision);
          return next;
        });
      } catch (err) {
        setOutlookError(err instanceof Error ? err.message : String(err));
      }
    },
    [effectiveCommsSettings.outlook.m365Path, approvalGate, inboxWorkspacePath, t],
  );

  const decideTelegramItem = useCallback(
    async (id: string, decision: InboxDecision) => {
      if (!inboxWorkspacePath || decision === "pending") return;
      const message = telegramMessages.find((item) => item.id === id);
      if (!message) return;
      const approvalId = await approvalGate.confirmApproval({
        kind: decision === "accepted" ? "telegram.accept" : "telegram.reject",
        summary:
          decision === "accepted"
            ? t("approval.telegram.accept.summary")
            : t("approval.telegram.reject.summary"),
        target: decision === "accepted" ? "inbox/drop/telegram" : id,
        payloadPreview: message.text,
      });
      if (!approvalId) return;
      setTelegramError(null);
      try {
        const outcome =
          decision === "accepted"
            ? await acceptTelegramItem(inboxWorkspacePath, message, approvalId)
            : await rejectTelegramItem(id, approvalId);
        if (!outcome.ok) throw new Error(outcome.error ?? "Telegram decision failed.");
        setTelegramDecisions((prev) => {
          const next = new Map(prev);
          next.set(id, decision);
          return next;
        });
        if (decision === "accepted") void refreshInbox();
      } catch (err) {
        setTelegramError(err instanceof Error ? err.message : String(err));
      }
    },
    [approvalGate, inboxWorkspacePath, refreshInbox, telegramMessages, t],
  );

  const decideCommsItem = useCallback(
    (provider: "gmail" | "outlook" | "telegram", id: string, decision: Exclude<InboxDecision, "pending">) => {
      if (provider === "gmail") void decideGmailItem(id, decision);
      else if (provider === "outlook") void decideOutlookItem(id, decision);
      else void decideTelegramItem(id, decision);
    },
    [decideGmailItem, decideOutlookItem, decideTelegramItem],
  );

  const decideInboxKeys = useCallback(
    async (
      keys: string[],
      decision: Extract<InboxDecision, "accepted" | "rejected">,
      forcedTargetFolder?: string | null,
    ) => {
      if (!inboxWorkspacePath || keys.length === 0) return;
      const fileIds = keys
        .filter((key) => key.startsWith("file:"))
        .map((key) => key.slice("file:".length));
      const gmailIds = keys
        .filter((key) => key.startsWith("gmail:"))
        .map((key) => key.slice("gmail:".length));

      let fileTargetFolder = forcedTargetFolder?.trim() || null;
      if (decision === "accepted" && fileIds.length > 0 && !fileTargetFolder) {
        const missing = fileIds.filter(
          (id) => !inboxCarry.get(id)?.classification?.suggestedFolder?.trim(),
        );
        if (missing.length > 0) {
          const target = window.prompt(
            t("app.prompt.inboxBulkTargetFolder", { count: missing.length }),
            "inbox/processed",
          );
          fileTargetFolder = target?.trim() || null;
          if (!fileTargetFolder) return;
        }
      }

      const approvalInput = {
        kind: "inbox.bulk",
        summary:
          decision === "accepted"
            ? t("approval.inbox.bulkAccept.summary", { count: keys.length })
            : t("approval.inbox.bulkReject.summary", { count: keys.length }),
        target: fileTargetFolder ?? (decision === "rejected" ? "inbox/rejected" : null),
        payloadPreview: keys.join("\n"),
      };
      try {
        const approvalId = await approvalGate.confirmApproval(approvalInput);
        if (!approvalId) return;
        let gmailApprovalId = approvalId;
        if (fileIds.length > 0 && gmailIds.length > 0) {
          const duplicate = await prepareApproval(approvalInput);
          await recordApproval(duplicate.id, "approved", false);
          gmailApprovalId = duplicate.id;
        }
        setInboxActionBusy(true);
        setError(null);
        setGmailError(null);
        if (fileIds.length > 0) {
          const outcomes =
            decision === "accepted"
              ? await acceptInboxItems(
                  inboxWorkspacePath,
                  fileIds.map((id) => ({
                    id,
                    targetFolder:
                      fileTargetFolder ??
                      inboxCarry.get(id)?.classification?.suggestedFolder ??
                      null,
                  })),
                  approvalId,
                )
              : await rejectInboxItems(inboxWorkspacePath, fileIds, approvalId);
          const failed = outcomes.filter((outcome) => !outcome.ok);
          outcomes
            .filter((outcome) => outcome.ok)
            .forEach((outcome) => updateInboxCarry(outcome.id, { decision }));
          if (failed.length > 0) {
            setError(failed.map((outcome) => outcome.error).filter(Boolean).join("\n"));
          }
        }
        if (gmailIds.length > 0) {
          const outcomes = await decideGmailItems(
            inboxWorkspacePath,
            gmailIds.map((messageId) => ({ messageId, decision })),
            gmailApprovalId,
          );
          const failed = outcomes.filter((outcome) => !outcome.ok);
          setGmailDecisions((prev) => {
            const next = new Map(prev);
            outcomes
              .filter((outcome) => outcome.ok)
              .forEach((outcome) => next.set(outcome.messageId, decision));
            return next;
          });
          if (failed.length > 0) {
            setGmailError(failed.map((outcome) => outcome.error).filter(Boolean).join("\n"));
          }
        }
        void refreshInbox();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (fileIds.length > 0) setError(message);
        if (gmailIds.length > 0) setGmailError(message);
      } finally {
        setInboxActionBusy(false);
      }
    },
    [approvalGate, inboxCarry, inboxWorkspacePath, refreshInbox, updateInboxCarry, t],
  );

  const bulkAcceptInboxKeys = useCallback(
    (keys: string[]) => decideInboxKeys(keys, "accepted"),
    [decideInboxKeys],
  );

  const bulkRejectInboxKeys = useCallback(
    (keys: string[]) => decideInboxKeys(keys, "rejected"),
    [decideInboxKeys],
  );

  const bulkMoveInboxFiles = useCallback(
    (keys: string[]) => {
      const target = window.prompt(t("app.prompt.inboxMoveSelectedFolder"), "inbox/processed");
      const trimmed = target?.trim();
      if (!trimmed) return;
      void decideInboxKeys(keys.filter((key) => key.startsWith("file:")), "accepted", trimmed);
    },
    [decideInboxKeys, t],
  );

  const trashInboxTargets = useCallback(
    async (targets: InboxTrashTarget[]) => {
      if (!inboxWorkspacePath || targets.length === 0) return;
      const title =
        targets.length === 1
          ? targets[0].id
          : t("inbox.menu.selectionTitle", { count: targets.length });
      if (!window.confirm(t("inbox.delete.confirm", { count: targets.length, name: title }))) {
        return;
      }
      const approvalId = await approvalGate.confirmApproval({
        kind: "inbox.file.trash",
        summary: t("inbox.delete.approvalSummary", { count: targets.length }),
        target: "System Trash",
        payloadPreview: targets.map((target) => `${target.kind}: ${target.path}`).join("\n"),
      });
      if (!approvalId) return;
      setInboxActionBusy(true);
      setError(null);
      try {
        const outcomes = await trashInboxItems(inboxWorkspacePath, targets, approvalId);
        const failed = outcomes.filter((outcome) => !outcome.ok);
        if (targets.some((target) => target.kind === "processedItem" && target.path === processedDetail?.item.itemDir)) {
          setProcessedDetail(null);
        }
        await Promise.all([refreshInbox(), refreshProcessedItems()]);
        if (failed.length > 0) {
          setError(
            [
              t("inbox.delete.partialFailure", { count: failed.length }),
              ...failed.map((outcome) => outcome.error).filter(Boolean),
            ].join("\n"),
          );
        } else {
          setError(t("inbox.delete.success", { count: outcomes.length }));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setInboxActionBusy(false);
      }
    },
    [approvalGate, inboxWorkspacePath, processedDetail?.item.itemDir, refreshInbox, refreshProcessedItems, t],
  );

  const processInboxKeys = useCallback(
    async (
      keys: string[],
      channelOverride?: string | null,
      reviewFlow = true,
      processingContext?: string,
    ) => {
      if (!inboxWorkspacePath) return;
      const trimmedContext = processingContext?.trim() ?? "";
      const processSkill =
        skills.find((skill) => skill.name === "inbox-process") ??
        skills.find((skill) => skill.id.endsWith(":inbox-process") || skill.id === "inbox-process");
      if (!processSkill) {
        setError("inbox-process skill is not installed or indexed.");
        return;
      }
      const selectedEntryIds = new Set(
        keys.filter((key) => key.startsWith("entry:")).map((key) => key.slice("entry:".length)),
      );
      const selectedEntries =
        selectedEntryIds.size > 0
          ? inboxEntries.filter((entry) => selectedEntryIds.has(entry.id))
          : channelOverride
            ? inboxEntries.filter((entry) => entry.channel === channelOverride)
            : [];
      if (selectedEntries.length === 0 && !channelOverride) return;

      // Bundle every selected entry into ONE run (한 번에). Channel becomes a
      // per-item field of the review artifact, not a mission boundary.
      const channels =
        selectedEntries.length > 0
          ? [...new Set(selectedEntries.map((entry) => entry.channel).filter(Boolean))].sort()
          : channelOverride
            ? [channelOverride]
            : [];

      setInboxActionBusy(true);
      setError(null);
      try {
        const runtime: SkillDispatchRuntime = maruSettings.ai.defaultRuntime;
        const commandOverride = aiRuntimeCommands[runtime] ?? null;
        const runtimeStatus = await skillsRuntimeStatus({ runtime, commandOverride });
        if (!runtimeStatus.available) {
          throw new Error(
            [
              runtimeStatus.message,
              runtimeStatus.suggestedAction,
            ].filter(Boolean).join(" "),
          );
        }
        const prompt = buildInboxProcessPrompt({
          entries: selectedEntries,
          config: inboxRuntimeConfig,
          channels,
          reviewFlow,
          processingContext: trimmedContext || undefined,
        });
        const context: SkillContextItem[] = selectedEntries.map((entry) => ({
          path: entry.kind === "pendingItem" ? entry.manifestPath ?? entry.path : entry.path,
          kind: entry.kind === "pendingItem" ? "manifest" : "file",
        }));
        const inputPaths = context.map((item) => item.path);
        const invocationId = await skillsDispatchBackground({
          skillId: processSkill.id,
          runtime,
          prompt,
          cwd: inboxWorkspacePath,
          context,
          commandOverride,
          permissionMode: maruSettings.ai.permissionMode,
          metadata: {
            origin: "inboxProcess",
            channel: channels[0] ?? "incoming",
            channels,
            reviewFlow,
            inputPaths,
            workspacePath: inboxWorkspacePath,
            skillName: "inbox-process",
            runtime,
            ...(trimmedContext ? { processingContext: trimmedContext } : {}),
          },
        });
        processingMissionIdsRef.current = new Set([
          ...processingMissionIdsRef.current,
          invocationId,
        ]);
        setProcessingLogLines((current) => ({ ...current, [invocationId]: [] }));
        void refreshProcessingMissions();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setInboxActionBusy(false);
      }
    },
    [
      inboxEntries,
      inboxRuntimeConfig,
      inboxWorkspacePath,
      refreshProcessingMissions,
      aiRuntimeCommands,
      maruSettings.ai.defaultRuntime,
      maruSettings.ai.permissionMode,
      skills,
    ],
  );

  const processCommsChannelNow = useCallback(
    async (channel: string) => {
      if (!inboxWorkspacePath) return;
      if (channel === "kakao") {
        await processInboxKeys([], channel, false);
        return;
      }
      setInboxActionBusy(true);
      setError(null);
      try {
        if (channel === "gws") {
          const gmailConfig = inboxRuntimeConfig.gmail ?? DEFAULT_INBOX_RUNTIME_CONFIG.gmail;
          const messages = await fetchGmailUnread(
            inboxWorkspacePath,
            normalizeGmailScanLimit(gmailConfig.max_results),
            buildGmailScanQuery(gmailConfig),
          );
          setGmailMessages(messages);
          if (messages.length > 0) {
            const approvalId = await approvalGate.confirmApproval({
              kind: "gmail.stage",
              summary: "Write Gmail message envelopes into the configured gws inbox drop.",
              target: "inbox/drop/gws",
              payloadPreview: messages.map((message) => `${message.from}: ${message.subject}`).join("\n"),
            });
            if (!approvalId) return;
            const outcomes = await stageGmailItems(inboxWorkspacePath, messages, approvalId);
            const failed = outcomes.filter((outcome) => !outcome.ok);
            if (failed.length > 0) {
              throw new Error(failed.map((outcome) => outcome.error).filter(Boolean).join("\n"));
            }
          }
        } else if (channel === "mso") {
          const messages = await fetchOutlookUnread(
            inboxWorkspacePath,
            effectiveCommsSettings.outlook.maxResults,
            effectiveCommsSettings.outlook.m365Path,
          );
          setOutlookMessages(messages);
          if (messages.length > 0) {
            const approvalId = await approvalGate.confirmApproval({
              kind: "outlook.stage",
              summary: "Write Outlook message envelopes into the configured mso inbox drop.",
              target: "inbox/drop/mso",
              payloadPreview: messages.map((message) => `${message.from}: ${message.subject}`).join("\n"),
            });
            if (!approvalId) return;
            const outcomes = await stageOutlookItems(inboxWorkspacePath, messages, approvalId);
            const failed = outcomes.filter((outcome) => !outcome.ok);
            if (failed.length > 0) {
              throw new Error(failed.map((outcome) => outcome.error).filter(Boolean).join("\n"));
            }
          }
        } else if (channel === "telegram") {
          const messages = await fetchTelegramRecent(
            telegramFetchOptions(inboxWorkspacePath, effectiveCommsSettings.telegram),
          );
          setTelegramMessages(messages);
          if (messages.length > 0) {
            const approvalId = await approvalGate.confirmApproval({
              kind: "telegram.stage",
              summary: "Write Telegram message envelopes into the configured Telegram inbox drop.",
              target: "inbox/drop/telegram",
              payloadPreview: messages.map((message) => `${message.chatTitle}: ${message.text}`).join("\n"),
            });
            if (!approvalId) return;
            const outcomes = await stageTelegramItems(inboxWorkspacePath, messages, approvalId);
            const failed = outcomes.filter((outcome) => !outcome.ok);
            if (failed.length > 0) {
              throw new Error(failed.map((outcome) => outcome.error).filter(Boolean).join("\n"));
            }
          }
        }
        await refreshInbox();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      } finally {
        setInboxActionBusy(false);
      }
      await processInboxKeys([], channel, false);
    },
    [
      approvalGate,
      effectiveCommsSettings.outlook,
      effectiveCommsSettings.telegram,
      inboxRuntimeConfig.gmail,
      inboxWorkspacePath,
      processInboxKeys,
      refreshInbox,
    ],
  );

  const deepProcessCommsChannel = useCallback(
    async (channel: string) => {
      if (!inboxWorkspacePath || channel !== "telegram") return;
      try {
        const [monitorConfig, projects] = await Promise.all([
          readTelegramMonitorConfig(
            inboxWorkspacePath,
            effectiveCommsSettings.telegram.monitorConfigPath,
          ).then(normalizeTelegramMonitorConfig),
          listWorkspaceProjects(inboxWorkspacePath).catch(() => []),
        ]);
        const projectById = new Map(projects.map((project) => [project.id, project]));
        const chats = monitorConfig.chats
          .filter((chat) => chat.enabled && chat.contexts.length > 0)
          .map((chat) => {
            const projectId = chat.contexts[0];
            const project = projectById.get(projectId) ?? null;
            return {
              chatId: chat.chat_id,
              name: chat.name,
              profile: chat.profile ?? "deep-digest",
              projectId,
              projectPath: project?.path ?? null,
              tags: chat.tags,
            };
          });
        const projectIds = Array.from(new Set(chats.map((chat) => chat.projectId)));
        const projectId = projectIds.length === 1 ? projectIds[0] : null;
        const projectPath = projectId ? projectById.get(projectId)?.path ?? null : null;
        const context = JSON.stringify(
          {
            channel: "telegram",
            profile: "deep-digest",
            projectId,
            projectPath,
            chats,
          },
          null,
          2,
        );
        await processInboxKeys([], "telegram", false, context);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [effectiveCommsSettings.telegram.monitorConfigPath, inboxWorkspacePath, processInboxKeys],
  );

  const stopProcessingMission = useCallback(async (id: string) => {
    try {
      const record = await stopAiMission(id);
      if (isTrackedAgentMission(record)) {
        setProcessingMissions((current) => upsertMission(current, record));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleMeetingsMissionStarted = useCallback(
    (invocationId: string) => {
      processingMissionIdsRef.current = new Set([
        ...processingMissionIdsRef.current,
        invocationId,
      ]);
      setProcessingLogLines((current) => ({ ...current, [invocationId]: [] }));
      setError(`Background skill run started: ${invocationId}`);
      void refreshProcessingMissions();
    },
    [refreshProcessingMissions],
  );

  const stageInboxFiles = useCallback(
    async (sourcePaths: string[]) => {
      if (!inboxWorkspacePath || sourcePaths.length === 0) return;
      setInboxActionBusy(true);
      setError(null);
      try {
        const outcomes = await stageInboxDropFiles(inboxWorkspacePath, { sourcePaths });
        const failed = outcomes.filter((outcome) => !outcome.ok);
        if (failed.length > 0) {
          setError(
            failed
              .map((outcome) => outcome.error ?? `Cannot stage ${outcome.sourcePath}`)
              .join("\n"),
          );
        }
        await refreshInbox();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setInboxActionBusy(false);
      }
    },
    [inboxWorkspacePath, refreshInbox],
  );

  const classifyItem = useCallback(
    async (id: string) => {
      const target = inboxDrops.find((drop) => drop.id === id);
      if (!target) return;
      updateInboxCarry(id, { classifying: true, classifyError: null });
      try {
        const runtime = resolveClassifierRuntime(maruSettings.ai);
        const contextEnv = buildMaruBackgroundContextEnv(
          {
            workspaceRoot: inboxWorkspacePath,
            scratchpadRoot,
            workspaceVisibility: explorerVisibility,
            appMode: "inbox",
            docAbsPath: null,
            docRelPath: target.relPath ?? null,
            docTitle: null,
            docType: null,
          },
          maruSettings.terminal.injectActiveContext,
        );
        const classification = await classifyInboxItem(
          target,
          runtime,
          inboxWorkspacePath,
          maruSettings.ai.commandOverrides[runtime],
          maruSettings.ai.permissionMode,
          contextEnv,
        );
        updateInboxCarry(id, { classifying: false, classification });
      } catch (err) {
        updateInboxCarry(id, {
          classifying: false,
          classifyError: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [
      maruSettings.ai,
      maruSettings.terminal.injectActiveContext,
      explorerVisibility,
      inboxDrops,
      inboxWorkspacePath,
      scratchpadRoot,
      updateInboxCarry,
    ],
  );

  useEffect(() => {
    if (!inboxWorkspacePath) {
      setInboxRuntimeConfig(DEFAULT_INBOX_RUNTIME_CONFIG);
      setInboxSourceFilter(null);
      return;
    }
    let cancelled = false;
    let unlistenConfigEvent: (() => void) | null = null;
    void readInboxRuntimeConfig(inboxWorkspacePath)
      .then((config) => {
        if (!cancelled) setInboxRuntimeConfig(config);
      })
      .catch(() => {
        if (!cancelled) setInboxRuntimeConfig(DEFAULT_INBOX_RUNTIME_CONFIG);
      });
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("inbox://runtime_config_updated", (event) => {
          const payload = event.payload as
            | { workPath?: string; config?: InboxRuntimeConfig }
            | null;
          if (!payload?.config || payload.workPath !== inboxWorkspacePath) return;
          setInboxRuntimeConfig(payload.config);
          setInboxSourceFilter(null);
          void refreshInbox();
          void refreshProcessedItems();
        }),
      )
      .then((off) => {
        if (cancelled) off();
        else unlistenConfigEvent = off;
      })
      .catch(() => {
        // Browser dev shell without Tauri event bridge.
      });
    return () => {
      cancelled = true;
      unlistenConfigEvent?.();
    };
  }, [inboxWorkspacePath, refreshInbox, refreshProcessedItems]);

  useEffect(() => {
    if (appMode !== "comms") return;
    let disposed = false;
    let unlistenTelegram: (() => void) | null = null;
    void telegramPollingStatus()
      .then((status) => {
        if (!disposed) setTelegramPolling(status);
      })
      .catch(() => {});
    if (!isMac) {
      setMigrationServices([]);
    } else if (!migrationCheckedRef.current) {
      migrationCheckedRef.current = true;
      void detectLegacyTelegramLaunchd()
        .then((services) => {
          if (!disposed) setMigrationServices(services);
        })
        .catch(() => {});
    }
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("telegram://messages", (event) => {
          const payload = event.payload as
            | {
                workPath?: string | null;
                messages?: TelegramMessage[];
                status?: TelegramPollingStatus;
              }
            | null;
          if (payload?.workPath && payload.workPath !== inboxWorkspacePath) return;
          if (payload?.messages) setTelegramMessages(payload.messages);
          if (payload?.status) setTelegramPolling(payload.status);
        }),
      )
      .then((off) => {
        if (disposed) off();
        else unlistenTelegram = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlistenTelegram?.();
    };
  }, [appMode, inboxWorkspacePath, isMac]);

  useEffect(() => {
    if (appMode === "inbox" || appMode === "comms") void refreshProcessedItems();
    if (appMode === "comms") void refreshSourceRuns();
    if (!booting && settingsWorkspaceStartupReady && (
      appMode === "inbox" ||
      appMode === "comms" ||
      appMode === "meetings" ||
      appMode === "tasks" ||
      rightPaneTab === "skills"
    )) {
      void refreshProcessingMissions();
    }
  }, [
    appMode,
    booting,
    refreshProcessedItems,
    refreshProcessingMissions,
    refreshSourceRuns,
    rightPaneTab,
    settingsWorkspaceStartupReady,
  ]);

  useEffect(() => {
    let cancelled = false;
    let unlistenMission: (() => void) | null = null;
    let unlistenOutput: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const offMission = await listen<MissionRecord>("ai://mission_update", (event) => {
          const record = event.payload;
          const inboxMission = isInboxProcessMission(record);
          if (!isTrackedAgentMission(record)) return;
          processingMissionIdsRef.current = new Set([
            ...processingMissionIdsRef.current,
            record.id,
          ]);
          setProcessingMissions((current) => upsertMission(current, record));
          if (inboxMission && !matchesActiveMission(record)) {
            void refreshProcessedItems();
            void refreshSourceRuns();
          }
          if (!matchesActiveMission(record)) {
            void readAiMissionLog(record.id, 100)
              .then((tail) =>
                setProcessingLogLines((current) => ({
                  ...current,
                  [record.id]: tail.lines,
                })),
              )
              .catch(() => {});
          }
        });
        const offOutput = await listen<AiOutputEvent>("ai://output", (event) => {
          const payload = event.payload;
          if (!processingMissionIdsRef.current.has(payload.invocationId)) return;
          const line = `[${payload.stream}] ${payload.line}`;
          setProcessingLogLines((current) => {
            const lines = [...(current[payload.invocationId] ?? []), line].slice(-120);
            return { ...current, [payload.invocationId]: lines };
          });
        });
        if (cancelled) {
          offMission();
          offOutput();
        } else {
          unlistenMission = offMission;
          unlistenOutput = offOutput;
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlistenMission?.();
      unlistenOutput?.();
    };
  }, [matchesActiveMission, refreshProcessedItems, refreshSourceRuns]);

  // Inbox scan + watcher subscription, scoped to the active workspace and
  // deferred until Inbox mode so startup document paint owns the I/O lane.
  // The watcher overlays the polling baseline: any file_event triggers
  // a re-scan rather than a delta apply, which keeps the UI source of
  // truth a single `scan_inbox_drop` snapshot.
  useEffect(() => {
    if (!inboxWorkspacePath) {
      setInboxDrops([]);
      setInboxEntries([]);
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
          console.info("[maru] inbox watcher not started:", err);
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
        console.info("[maru] inbox event listener unavailable:", err);
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
        const files = await scanWorkspaceFiles(path, scanOptions);
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
    [scanOptions, updateWorkspaceFileState],
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
      markStartup("workspace:load:start", { path, visibility });
      const requestId = ++loadWorkspaceRequestRef.current;
      updateWorkspaceState(path, {
        loading: true,
        refreshing: false,
        startupIoReady: false,
      });
      setError(null);
      const storedTabs = readStoredTabsForWorkspace(path);

      const restorePrimaryTab = async (nextEntries: VaultEntry[], source: "cache" | "scan") => {
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
          markStartup("workspace:first-usable", { path, source, entries: nextEntries.length });
          return true;
        }

        const payload = await measureStartup(
          "document:primary-read",
          () => readDocument(path, candidate.path),
          { path, documentPath: candidate.path, source },
        );
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
        markStartup("workspace:first-usable", {
          path,
          source,
          entries: nextEntries.length,
          documentPath: candidate.path,
        });
        pushRecent(candidate.path);

        // Hydrate only the primary tab plus one possible split companion.
        // Remaining restored tabs are opened lazily on demand instead of
        // reading up to seven full document bodies during startup.
        const rest = tabEntries.slice(1, 2);
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
          const fresh = await measureStartup(
            "vault:authoritative-scan",
            () => scanVault(path, scanOptions),
            { path, paintAfterScan },
          );
          if (requestId !== loadWorkspaceRequestRef.current) return;
          if (paintAfterScan) {
            await restorePrimaryTab(fresh, "scan");
            markStartup("vault:authoritative-scan-done", {
              path,
              entries: fresh.length,
            });
          } else {
            mergeFreshEntries(fresh);
            markStartup("vault:authoritative-scan-done", {
              path,
              entries: fresh.length,
            });
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
        const cached = await measureStartup("vault:cache-read", () => readVaultCache(path), {
          path,
        });
        if (requestId !== loadWorkspaceRequestRef.current) return;
        const paintedFromCache = cached ? await restorePrimaryTab(cached, "cache") : false;
        if (paintedFromCache) {
          void runAuthoritativeScan(false);
        } else {
          await runAuthoritativeScan(true);
        }
      } catch {
        await runAuthoritativeScan(true);
      }
    },
    [pushRecent, readStoredTabsForWorkspace, scanOptions, tabs, updateWorkspaceState],
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
        markStartup("boot:start");
        setBooting(true);
        const registry = await measureStartup("workspace:registry-read", () =>
          listWorkspaceRoots(),
        );
        if (registry.workspaces.length === 0) {
          const samplePath = await getSampleWorkspacePath();
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
            markStartup("boot:end", {
              initialPath: seeded.activeByVisibility.private,
              initialVisibility: "private",
              seeded: true,
            });
          } else {
            setBooting(false);
            markStartup("boot:end", { initialPath: null, seeded: true });
          }
          return;
        }
        setWorkspaceRegistry(registry);
        let bootSettings: MaruSettings | null = null;
        const bootSettingsPath = startupSettingsPath(registry);
        if (bootSettingsPath) {
          try {
            bootSettings = await measureStartup("settings:startup-read", () =>
              readMaruSettings(bootSettingsPath),
            );
            setMaruSettings(bootSettings);
            // A prior boot pass (StrictMode double-run) may already have
            // auto-opened Today — keep that over the persisted mode.
            if (todayAutoOpenPathRef.current === null) {
              setAppMode(bootSettings.ui.activeAppMode);
            }
            setEditorPaneViewModes(bootSettings.ui.editorPaneViewModes);
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
          // Maru Today: first-eligible-launch auto-open. Best-effort — any
          // failure falls back to the normal persisted-mode restore above.
          const todaySettings = bootSettings?.tasks.today;
          if (todaySettings?.enabled && todaySettings.autoOpenFirstDailyLaunch) {
            try {
              const tasksSettings = bootSettings!.tasks;
              const timezone = tasksSettings.timezone ?? "Asia/Seoul";
              const nowIso = new Date().toISOString();
              const info = await todayLogicalDay(
                initialPath,
                nowIso,
                timezone,
                todaySettings.dayStart,
              );
              todayLogicalDayRef.current = info.logicalDay;
              const lastAutoOpenDay = window.localStorage.getItem(todayAutoOpenKey(initialPath));
              if (lastAutoOpenDay !== info.logicalDay) {
                // Close out a missed day boundary before inspecting the day.
                await todayRollover(
                  initialPath,
                  nowIso,
                  timezone,
                  todaySettings.dayStart,
                  todaySettings.sleepStart,
                ).catch(() => null);
                const snapshot = await todayOpen(
                  initialPath,
                  nowIso,
                  timezone,
                  todaySettings.dayStart,
                  todaySettings.sleepStart,
                );
                const decision = resolveLaunchRoute({
                  enabled: todaySettings.enabled,
                  autoOpen: todaySettings.autoOpenFirstDailyLaunch,
                  lastAutoOpenDay,
                  logicalDay: info.logicalDay,
                  dayState: snapshot.dayState,
                  // The main-window boot has no explicit initial-mode
                  // mechanism; explicit modes only exist in the separate
                  // settings/skill-editor windows, which return earlier.
                  explicitMode: false,
                });
                if (decision) {
                  setTodayRoute(decision.route);
                  setAppMode("tasks");
                  todayAutoOpenPathRef.current = initialPath;
                  window.localStorage.setItem(todayAutoOpenKey(initialPath), info.logicalDay);
                }
              }
            } catch (err) {
              console.warn("today auto-open skipped", err);
            }
          }
          const lastRel =
            typeof window !== "undefined"
              ? window.localStorage.getItem(lastOpenKeyForWorkspace(initialPath))
              : null;
          await loadWorkspace(initialPath, initialVisibility, lastRel);
          setBooting(false);
          markStartup("boot:end", { initialPath, initialVisibility });
        } else {
          setBooting(false);
          markStartup("boot:end", { initialPath: null, initialVisibility });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBooting(false);
        markStartup("boot:error", { message: err instanceof Error ? err.message : String(err) });
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

  const handleSetWorkspaceWritePolicy = useCallback(
    async (path: string, policy: WorkspaceWritePolicy) => {
      const existing = workspaceRegistry.workspaces.find((w) => w.path === path);
      if (!existing) return;
      try {
        // add_workspace_root upserts by path — the registry normalization
        // keeps "managed" intact (vault_list.rs, spec §2.4).
        const registry = await addWorkspaceRoot({ ...existing, writePolicy: policy });
        setWorkspaceRegistry(registry);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspaceRegistry],
  );

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
      const samplePath = await getSampleWorkspacePath();
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

  const openNewDocumentDialog = useCallback((docType?: string, options?: { fromLibrary?: boolean }) => {
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
    const seededDocType =
      docType ?? documentFilterDefaultDocType(documentFilter, maruSettings.ui.documentViews);
    const fromLibrary = options?.fromLibrary === true;
    setNewDocumentSeed(
      seededDocType || fromLibrary
        ? { title: "", relPath: null, docType: seededDocType ?? null, openLibrary: fromLibrary }
        : null,
    );
    setNewDocumentOpen(true);
  }, [
    activeDocumentWorkspace,
    activeWorkspaceCanCreate,
    maruSettings.ui.documentViews,
    documentFilter,
    t,
  ]);

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
    async (entry: VaultEntry, requestedGroup?: EditorGroupId) => {
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
      const targetGroup =
        requestedGroup ??
        (editorSplitOpen && !rightGraphOpen ? focusedEditorGroup : "left");
      // Push the *previous* selection onto history before we replace it.
      // Skip when navigateBack/Forward is the caller — they manage manually.
      const skipHistoryPush = skipNextHistoryPushRef.current;
      skipNextHistoryPushRef.current = false;
      if (!skipHistoryPush && !isSameEntry && selectedEntry) {
        setNavHistory((h) => pushHistory(h, selectedEntry.path));
      }
      if (existingTab) {
        activateEditorTab(existingTab.id, targetGroup);
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
        activateEditorTab(newTab.id, targetGroup);
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
      rightGraphOpen,
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

  const openBinaryWorkspaceFile = useCallback(
    (entry: WorkspaceFileEntry, workspacePath: string, visibility: WorkspaceVisibility) => {
      const tabId = tabIdForWorkspaceFile(entry);
      const existing = binaryTabs.find((tab) => tab.id === tabId);
      const targetGroup =
        editorSplitOpen && !rightGraphOpen ? focusedEditorGroup : "left";
      setExplorerVisibility(visibility);
      if (existing) {
        activateEditorTab(existing.id, targetGroup);
        return;
      }
      void (async () => {
        setError(null);
        try {
          const classification = await binaryViewerClassify(workspacePath, entry.path);
          const assetPath = usesAssetProtocol(classification.category)
            ? await binaryViewerPrepareAsset(workspacePath, entry.path)
            : entry.path;
          const newTab: BinaryTab = {
            kind: "binary",
            id: tabId,
            workspacePath,
            visibility,
            fileEntry: {
              ...entry,
              path: assetPath,
              extension: classification.extension ?? entry.extension,
              fileKind: classification.extension ?? entry.fileKind,
              sizeBytes: classification.sizeBytes || entry.sizeBytes,
            },
            classification,
            status: "ready",
            error: null,
          };
          setBinaryTabs((prev) => {
            const exists = prev.some((tab) => tab.id === newTab.id);
            return exists
              ? prev.map((tab) => (tab.id === newTab.id ? newTab : tab))
              : [...prev, newTab];
          });
          activateEditorTab(newTab.id, targetGroup);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [
      activateEditorTab,
      binaryTabs,
      binaryViewerClassify,
      binaryViewerPrepareAsset,
      editorSplitOpen,
      focusedEditorGroup,
      rightGraphOpen,
    ],
  );

  const openWorkspaceFile = useCallback(
    (entry: WorkspaceFileEntry) => {
      if (isOpenableDocumentFile(entry)) {
        const docEntry =
          entries.find((item) => item.path === entry.path || item.relPath === entry.relPath) ??
          null;
        if (!docEntry) {
          setError(t("files.openUnavailable"));
          return;
        }
        void selectEntry(docEntry);
        return;
      }
      if (!explorerWorkspacePath) {
        setError(t("files.openUnavailable"));
        return;
      }
      openBinaryWorkspaceFile(entry, explorerWorkspacePath, explorerVisibility);
    },
    [
      entries,
      explorerVisibility,
      explorerWorkspacePath,
      openBinaryWorkspaceFile,
      selectEntry,
      t,
    ],
  );

  const isFavorite = useCallback(
    (kind: FavoriteKind, relPath: string) => {
      const normalizedRelPath = normalizeFavoriteTargetRelPath(relPath);
      if (!normalizedRelPath) return false;
      const key = favoriteKey(kind, normalizedRelPath);
      return maruSettings.ui.favorites.some(
        (favorite) => favoriteKey(favorite.kind, favorite.relPath) === key,
      );
    },
    [maruSettings.ui.favorites],
  );

  const removeFavorite = useCallback(
    (favorite: FavoriteItem) => {
      const key = favoriteKey(favorite.kind, favorite.relPath);
      updateSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          favorites: current.ui.favorites.filter(
            (item) => favoriteKey(item.kind, item.relPath) !== key,
          ),
        },
      }));
    },
    [updateSettings],
  );

  const toggleFavorite = useCallback(
    (target: FavoriteTarget) => {
      const relPath = normalizeFavoriteTargetRelPath(target.relPath);
      if (!relPath) return;
      const key = favoriteKey(target.kind, relPath);
      updateSettings((current) => {
        const exists = current.ui.favorites.some(
          (favorite) => favoriteKey(favorite.kind, favorite.relPath) === key,
        );
        const label = target.label.trim();
        const favorites = exists
          ? current.ui.favorites.filter(
              (favorite) => favoriteKey(favorite.kind, favorite.relPath) !== key,
            )
          : [
              {
                kind: target.kind,
                relPath,
                label: label && label !== relPath ? label : favoriteLabelFromRelPath(relPath),
                addedAt: new Date().toISOString(),
              },
              ...current.ui.favorites,
            ];
        return {
          ...current,
          ui: {
            ...current.ui,
            favorites,
          },
        };
      });
    },
    [updateSettings],
  );

  const isFavoriteMissing = useCallback(
    (favorite: FavoriteItem) => {
      const workspacePath = settingsWorkPath ?? explorerWorkspacePath;
      if (!workspacePath) return true;
      const relPath = normalizeFavoriteTargetRelPath(favorite.relPath);
      if (!relPath) return true;
      const targetPath = joinWorkspaceRelPath(workspacePath, relPath);
      const docEntries = workspaceStates[workspacePath]?.entries ?? [];
      const workspaceFileState = workspaceFileStates[workspacePath] ?? EMPTY_WORKSPACE_FILES_STATE;
      const knownFiles = workspaceFileState.entries;
      if (favorite.kind === "file") {
        if (docEntries.some((entry) => entry.relPath === relPath || entry.path === targetPath)) {
          return false;
        }
        if (knownFiles.some((entry) => entry.relPath === relPath || entry.path === targetPath)) {
          return false;
        }
        return knownFiles.length > 0;
      }
      const prefix = `${relPath}/`;
      if (docEntries.some((entry) => entry.relPath.startsWith(prefix))) return false;
      if (knownFiles.some((entry) => entry.relPath.startsWith(prefix))) return false;
      return knownFiles.length > 0;
    },
    [explorerWorkspacePath, settingsWorkPath, workspaceFileStates, workspaceStates],
  );

  const openFavorite = useCallback(
    (favorite: FavoriteItem) => {
      const relPath = normalizeFavoriteTargetRelPath(favorite.relPath);
      const workspacePath = settingsWorkPath ?? explorerWorkspacePath;
      if (!relPath || !workspacePath) {
        setError(t("workspace.error.noneActive"));
        return;
      }
      const workspace =
        workspaceRegistry.workspaces.find((item) => item.path === workspacePath) ?? null;
      const visibility = workspace?.visibility ?? explorerVisibility;
      const targetPath = joinWorkspaceRelPath(workspacePath, relPath);

      void (async () => {
        setPersistedAppMode("pkm");
        if (!documentsPaneOpen) updateLayoutSettings({ documentsPaneOpen: true });
        setExplorerVisibility(visibility);

        let scannedFiles = workspaceFileStates[workspacePath]?.entries ?? [];
        const scanFilesIfNeeded = async () => {
          if (scannedFiles.length > 0) return scannedFiles;
          updateWorkspaceFileState(workspacePath, { loading: true, refreshing: true });
          try {
            scannedFiles = await scanWorkspaceFiles(workspacePath, scanOptions);
            updateWorkspaceFileState(workspacePath, {
              entries: scannedFiles,
              loading: false,
              refreshing: false,
            });
          } catch (err) {
            updateWorkspaceFileState(workspacePath, { loading: false, refreshing: false });
            throw err;
          }
          return scannedFiles;
        };

        try {
          if (favorite.kind === "directory") {
            const docEntries = workspaceStates[workspacePath]?.entries ?? [];
            const files = await scanFilesIfNeeded();
            const prefix = `${relPath}/`;
            const exists =
              docEntries.some((entry) => entry.relPath.startsWith(prefix)) ||
              files.some((entry) => entry.relPath.startsWith(prefix));
            if (!exists) {
              setError(t("favorites.openMissing", { path: relPath }));
              return;
            }
            setExplorerPaneMode("files");
            setFilesBrowserMode("tree");
            setWorkspaceFileFilter("all");
            setFileQueryByVisibility((current) => ({
              ...current,
              [visibility]: "",
            }));
            setFilesPaneFilters(EMPTY_WORKSPACE_FILES_PANE_FILTERS);
            setCollapsedFileFoldersByVisibility((current) => {
              const existing = current[visibility] ?? [];
              return {
                ...current,
                [visibility]: expandWorkspaceFileAncestors(existing, `${relPath}/__favorite__`),
              };
            });
            setPendingExplorerReveal({ pane: "files", targetPath });
            return;
          }

          const docEntries = workspaceStates[workspacePath]?.entries ?? [];
          const docEntry =
            docEntries.find((entry) => entry.relPath === relPath || entry.path === targetPath) ??
            null;
          if (docEntry) {
            void selectEntry(docEntry);
            return;
          }
          const files = await scanFilesIfNeeded();
          const fileEntry =
            files.find((entry) => entry.relPath === relPath || entry.path === targetPath) ?? null;
          if (!fileEntry) {
            setError(t("favorites.openMissing", { path: relPath }));
            return;
          }
          setSelectedFilePathsByWorkspace((current) => ({
            ...current,
            [workspacePath]: [fileEntry.path],
          }));
          openBinaryWorkspaceFile(fileEntry, workspacePath, visibility);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [
      documentsPaneOpen,
      explorerVisibility,
      explorerWorkspacePath,
      openBinaryWorkspaceFile,
      scanOptions,
      selectEntry,
      setExplorerPaneMode,
      setFilesBrowserMode,
      setPersistedAppMode,
      setWorkspaceFileFilter,
      settingsWorkPath,
      t,
      updateLayoutSettings,
      updateWorkspaceFileState,
      workspaceFileStates,
      workspaceRegistry.workspaces,
      workspaceStates,
    ],
  );

  const openSkillCompose = useCallback(
    (
      skill: SkillRecord | null = null,
      contextOverride?: SkillContextItem[],
      prompt?: string,
      cwdOverride?: string | null,
      onDispatched?: ComposeDialogSeed["onDispatched"],
    ) => {
      const context =
        contextOverride ??
        (selectedEntry
          ? [
              {
                path: selectedEntry.path,
                kind: "document",
              },
            ]
          : selectedFilePaths.map((path) => ({
              path,
              kind: "file",
            })));
      setComposeSeed({
        skill,
        context,
        prompt,
        cwd: cwdOverride ?? activeDocumentWorkspacePath ?? explorerWorkspacePath ?? settingsWorkPath,
        onDispatched,
      });
    },
    [
      activeDocumentWorkspacePath,
      explorerWorkspacePath,
      selectedEntry,
      selectedFilePaths,
      settingsWorkPath,
    ],
  );

  const applySkillToFileTarget = useCallback(
    (targetPath: string, targetKind: "file" | "directory") => {
      openSkillCompose(null, [{ path: targetPath, kind: targetKind }]);
      if (!outlineOpen) updateLayoutSettings({ outlineOpen: true });
      setPersistedRightPaneTab("skills");
    },
    [openSkillCompose, outlineOpen, setPersistedRightPaneTab, updateLayoutSettings],
  );

  // The Apply-skill dialog nudge routes meeting-notes work into the dedicated
  // Meetings transcript workbench (step tracking + diff review + followups).
  const openMeetingsWorkbench = useCallback(() => {
    setComposeSeed(null);
    setMeetingsRequestedView("transcript");
    setPersistedAppMode("meetings");
  }, [setPersistedAppMode]);

  const launchSkillTerminal = useCallback((spec: TerminalDispatchSpec) => {
    setTerminalLaunchRequest({
      kind: spec.kind,
      nonce: Date.now(),
      title: spec.title,
      cwd: spec.cwd,
      command: spec.command ?? null,
      extraArgs: spec.extraArgs,
      extraEnv: spec.extraEnv,
    });
    updateLayoutSettings({ terminalOpen: true });
  }, [updateLayoutSettings]);

  const addFileQueueSources = useCallback(
    (
      sources: FileQueueSourceInfo[],
      targetDir: string,
      operation: FileStoreOperation = maruSettings.ui.fileQueueDefaultOperation,
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
      maruSettings.ui.fileQueueDefaultOperation,
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
        const fresh = await scanVault(workspacePath, scanOptions);
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
    scanOptions,
    t,
    updateWorkspaceState,
    workspaceRegistry.workspaces,
  ]);

  const applySelectedFileQueueToDestination = useCallback(
    async (
      targetPath: string,
      targetKind: "file" | "directory",
      operation: FileStoreOperation,
      itemIds?: string[],
    ) => {
      const queuedItems = itemIds
        ? Array.from(new Set(itemIds))
            .map((id) => fileQueue.find((item) => item.id === id))
            .filter(
              (item): item is FileQueueItem =>
                item != null && item.status === "queued",
            )
        : selectedQueuedFileQueueItems;
      if (queuedItems.length === 0) return;
      const targetDir =
        targetKind === "directory"
          ? targetPath
          : targetPath.split("/").slice(0, -1).join("/");
      if (!targetDir) return;
      const nextItems = queuedItems.map((item) => ({
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
    [applyQueuedFiles, fileQueue, selectedQueuedFileQueueItems],
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
    const flushed = tabId ? flushHtmlDraft(tabId) : null;
    const target = tabs.find((tab) => tab.id === tabId);
    if (!target) return;
    const draft = flushed ?? target.draftContent;
    if (draft === target.document.content) return;
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
        draft,
        target.document.revision ?? null,
      );
      const fresh = await scanVault(target.workspacePath, scanOptions);
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
    flushHtmlDraft,
    refreshWorkspaceFiles,
    scanOptions,
    updateWorkspaceState,
    workspaceRegistry.workspaces,
  ]);

  const saveCurrent = useCallback(async () => {
    await saveTab(resolvedActiveTabId);
  }, [resolvedActiveTabId, saveTab]);

  const snapshotTab = useCallback(async (tabId: string | null) => {
    const flushed = tabId ? flushHtmlDraft(tabId) : null;
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
        flushed ?? target.draftContent,
        t("snapshot.summary"),
      );
      const fresh = await scanVault(target.workspacePath, scanOptions);
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
    flushHtmlDraft,
    refreshWorkspaceFiles,
    scanOptions,
    updateWorkspaceState,
    workspaceRegistry.workspaces,
  ]);

  const snapshotCurrent = useCallback(async () => {
    await snapshotTab(resolvedActiveTabId);
  }, [resolvedActiveTabId, snapshotTab]);

  const createDocumentAndOpen = useCallback(
    async ({
      title,
      docType,
      body,
      targetRelPath,
      extras,
    }: StudioCreateDocumentInput): Promise<DocumentPayload | null> => {
      if (!activeDocumentWorkspacePath) return null;
      if (blockWorkspaceWrite("create")) return null;
      // Phase 4 W7: Hub template/guideline metadata flows into proper
      // frontmatter via `extras`, not an HTML comment trailer. Rust core
      // preserves byte-identity for any unrelated fields downstream.
      const created = await createDocument(
        activeDocumentWorkspacePath,
        title,
        docType,
        body,
        targetRelPath,
        extras && (extras.templateSlug || extras.templateId || extras.guidelineIds?.length)
          ? {
              templateId: extras.templateId,
              templateSlug: extras.templateSlug,
              templateVersion: extras.templateVersion,
              guidelineIds: extras.guidelineIds,
              businessUnit: extras.businessUnit,
            }
          : undefined,
      );
      const fresh = await scanVault(activeDocumentWorkspacePath, scanOptions);
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
      return payload;
    },
    [
      activeDocumentWorkspace,
      activeDocumentWorkspacePath,
      explorerVisibility,
      pushRecent,
      blockWorkspaceWrite,
      refreshWorkspaceFiles,
      scanOptions,
      updateWorkspaceState,
    ],
  );

  const createNew = useCallback(
    async (
      title: string,
      docType: string,
      body: string,
      targetRelPath: string | null,
      extras?: import("./components/NewDocumentDialog").NewDocumentExtras,
    ) => {
      await createDocumentAndOpen({ title, docType, body, targetRelPath, extras });
    },
    [createDocumentAndOpen],
  );

  const refreshStudioDocumentMutation = useCallback(
    async (workspacePath: string, payload: DocumentPayload): Promise<DocumentPayload> => {
      const fresh = await scanVault(workspacePath, scanOptions);
      updateWorkspaceState(workspacePath, { entries: fresh });
      void refreshWorkspaceFiles(workspacePath);
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.document.path !== payload.path) return tab;
          const entry = fresh.find((item) => item.path === payload.path) ?? tab.entry;
          return {
            ...tab,
            entry,
            document: payload,
            draftContent: payload.content,
          };
        }),
      );
      return payload;
    },
    [refreshWorkspaceFiles, scanOptions, updateWorkspaceState],
  );

  const applyStudioBody = useCallback(
    async (documentPath: string, bodyMarkdown: string): Promise<DocumentPayload | null> => {
      if (!activeDocumentWorkspacePath) return null;
      if (blockWorkspaceWrite("modify")) return null;
      try {
        const payload = await studioApplyBody(
          activeDocumentWorkspacePath,
          documentPath,
          bodyMarkdown,
        );
        await refreshStudioDocumentMutation(activeDocumentWorkspacePath, payload);
        setError(t("studio.sections.apply.success"));
        return payload;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [activeDocumentWorkspacePath, blockWorkspaceWrite, refreshStudioDocumentMutation, t],
  );

  const freezeStudioPackage = useCallback(
    async (
      documentPath: string,
      bodyMarkdown: string,
      title: string,
    ): Promise<StudioPackageResult | null> => {
      if (!activeDocumentWorkspacePath) return null;
      if (blockWorkspaceWrite("modify")) return null;
      try {
        const payload = await studioApplyBody(
          activeDocumentWorkspacePath,
          documentPath,
          bodyMarkdown,
        );
        await refreshStudioDocumentMutation(activeDocumentWorkspacePath, payload);
        const snapshot = await createVersion(
          activeDocumentWorkspacePath,
          payload.path,
          title,
          payload.content,
          t("studio.package.snapshotSummary"),
        );
        setError(t("studio.package.freeze.success", { path: snapshot.relPath }));
        return {
          document: payload,
          snapshotPath: snapshot.path,
          snapshotRelPath: snapshot.relPath,
        };
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [activeDocumentWorkspacePath, blockWorkspaceWrite, refreshStudioDocumentMutation, t],
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
          document.revision ?? null,
        );
        // Refresh draft only when there are no unsaved body edits — never
        // clobber the textarea with an inspector-driven write.
        const fresh = await scanVault(activeDocumentWorkspacePath, scanOptions);
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
        // Downloaded and installed, but never relaunch on our own: the
        // "ready" toast offers an explicit relaunch action so unsaved
        // drafts are never lost to a surprise restart.
        setUpdateToast({ kind: "ready", info });
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

  const checkForUpdates = useCallback(async (manual = false) => {
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
      // Consent-first: surface an actionable toast; downloading and
      // relaunching only happen from explicit user action.
      setUpdateToast({ kind: "available", info: result.info });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (manual) {
        setUpdateToast({ kind: "error", message });
      } else {
        console.info("[maru] update check failed:", message);
      }
    }
  }, [t]);

  const installPendingUpdate = useCallback(async () => {
    const update = pendingUpdateRef.current;
    if (!update || updateToast?.kind !== "available") return;
    await installUpdate(update, updateToast.info);
  }, [installUpdate, updateToast]);

  useEffect(() => {
    if (!updaterAvailable()) return;
    const timer = window.setTimeout(() => {
      void checkForUpdates();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [checkForUpdates]);

  // Skills bundle OTA: one background check after launch, silently applied
  // only when clean and runtime-compatible (autoApplicable). Network errors
  // stay silent; signature/integrity failures surface as a security warning.
  useEffect(() => {
    if (!updaterAvailable()) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const status = await skillsCheckBundleUpdate();
          if (!status?.updateAvailable || !status.autoApplicable) return;
          const outcome = await skillsApplyBundleUpdate({ repairEnv: false });
          if (outcome) {
            setUpdateToast({
              kind: "skillsUpdated",
              version: outcome.current.displayVersion,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Verification failures of any kind are security-relevant; only
          // plain network/channel unavailability stays silent.
          if (/signature|sha256_mismatch|size_mismatch|metadata_|archive_|bundle_path/.test(message)) {
            setUpdateToast({
              kind: "error",
              message: t("updates.skillsSecurityError", { message }),
            });
          } else {
            console.info("[maru] skills bundle check failed:", message);
          }
        }
      })();
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [t]);

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
        console.info("[maru] update menu listener unavailable:", err);
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

  const openInboxAndFocus = useCallback(() => {
    setPersistedAppMode("inbox");
    setInboxFocusTick((value) => value + 1);
  }, [setPersistedAppMode]);

  const openComms = useCallback(() => {
    setPersistedAppMode("comms");
  }, [setPersistedAppMode]);

  const openMeetings = useCallback(() => {
    setPersistedAppMode("meetings");
  }, [setPersistedAppMode]);

  const openToday = useCallback(
    (route: TodayRoute) => {
      setTodayRoute(route);
      setPersistedAppMode("tasks");
    },
    [setPersistedAppMode],
  );

  // Explicit user navigation to Tasks lands on All Tasks as today.
  const openTasks = useCallback(() => {
    openToday("all");
  }, [openToday]);

  // Resolve the current day's route fresh (prepare vs execute) and open
  // Today. Shared by the new-day banner button and the notification click.
  const openTodayForCurrentDay = useCallback(() => {
    const workPath = inboxWorkspacePath;
    const todaySettings = effectiveTasksSettings.today;
    if (!workPath || !todaySettings.enabled) {
      openToday("prepare");
      return;
    }
    void (async () => {
      let route: TodayRoute = "prepare";
      try {
        const snapshot = await todayOpen(
          workPath,
          new Date().toISOString(),
          effectiveTasksSettings.timezone ?? "Asia/Seoul",
          todaySettings.dayStart,
          todaySettings.sleepStart,
        );
        route = resolveRouteForDayState(snapshot.dayState);
      } catch (err) {
        console.warn("today route resolution failed", err);
      }
      openToday(route);
    })();
  }, [inboxWorkspacePath, effectiveTasksSettings, openToday]);

  // Maru Today: logical-day (03:30) watcher. Recomputes the logical day every
  // minute; on a boundary crossed while running, rolls the store over and
  // surfaces the new day exactly once (native notification, else banner).
  useEffect(() => {
    const workPath = inboxWorkspacePath;
    const todaySettings = effectiveTasksSettings.today;
    if (!workPath || !todaySettings.enabled) return;
    const timezone = effectiveTasksSettings.timezone ?? "Asia/Seoul";
    let cancelled = false;
    let rolloverInFlight = false;

    const tick = async () => {
      let info;
      try {
        info = await todayLogicalDay(
          workPath,
          new Date().toISOString(),
          timezone,
          todaySettings.dayStart,
        );
      } catch {
        return; // non-desktop backend or workspace without .maru — stay silent
      }
      if (cancelled) return;
      const previous = todayLogicalDayRef.current;
      // First tick only seeds the ref; startup is handled by the boot path.
      if (previous === null) {
        todayLogicalDayRef.current = info.logicalDay;
        return;
      }
      if (previous === info.logicalDay || rolloverInFlight) return;
      rolloverInFlight = true;
      const nowIso = new Date().toISOString();
      try {
        await todayRollover(
          workPath,
          nowIso,
          timezone,
          todaySettings.dayStart,
          todaySettings.sleepStart,
        );
      } catch (err) {
        console.warn("today rollover failed", err);
        return;
      } finally {
        rolloverInFlight = false;
      }
      if (cancelled) return;
      todayLogicalDayRef.current = info.logicalDay;
      setTodayRolloverEpoch((epoch) => epoch + 1);
      if (!todaySettings.notificationEnabled) return;
      let sent = false;
      try {
        const outcome = await todayNotifyNewDay(
          workPath,
          info.logicalDay,
          t("today.notify.newDayTitle"),
          t("today.notify.newDayBody"),
        );
        sent = outcome.sent;
      } catch (err) {
        console.warn("today notification failed", err);
      }
      if (
        resolveNewDayNotice({
          notificationEnabled: todaySettings.notificationEnabled,
          sent,
        }) === "banner"
      ) {
        setTodayBannerPending(true);
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [inboxWorkspacePath, effectiveTasksSettings, t]);

  // Show the pending new-day banner on the next window focus.
  useEffect(() => {
    if (!todayBannerPending || todayBannerVisible) return;
    const show = () => setTodayBannerVisible(true);
    window.addEventListener("focus", show);
    return () => window.removeEventListener("focus", show);
  }, [todayBannerPending, todayBannerVisible]);

  // Native notification click → open Today. Best-effort: the plugin listener
  // only exists in the desktop backend; the banner covers everything else.
  useEffect(() => {
    let cancelled = false;
    let unregister: (() => void) | null = null;
    onNotificationAction(() => {
      openTodayForCurrentDay();
    })
      .then((listener) => {
        if (cancelled) {
          void listener.unregister();
          return;
        }
        unregister = () => void listener.unregister();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unregister?.();
    };
  }, [openTodayForCurrentDay]);

  const openSites = useCallback(() => {
    setPersistedAppMode("sites");
  }, [setPersistedAppMode]);

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

  const openInboxSettings = useCallback(() => {
    void openSettingsWindow(settingsWorkPath, "inbox-channels").catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [settingsWorkPath]);

  const openCommsSettings = useCallback(() => {
    void openSettingsWindow(settingsWorkPath, "comms").catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [settingsWorkPath]);

  const openMeetingsSettings = useCallback(() => {
    void openSettingsWindow(settingsWorkPath, "meetings").catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [settingsWorkPath]);

  const openTasksSettings = useCallback(() => {
    void openSettingsWindow(settingsWorkPath, "tasks").catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [settingsWorkPath]);

  const startTelegramPollingFromSettings = useCallback(() => {
    if (!inboxWorkspacePath) return;
    void startTelegramPolling(
      telegramFetchOptions(inboxWorkspacePath, effectiveCommsSettings.telegram),
      effectiveCommsSettings.telegram.intervalSeconds,
    )
      .then(setTelegramPolling)
      .catch((err) => setTelegramError(err instanceof Error ? err.message : String(err)));
  }, [effectiveCommsSettings.telegram, inboxWorkspacePath]);

  const stopTelegramPollingFromSettings = useCallback(() => {
    void stopTelegramPolling()
      .then(setTelegramPolling)
      .catch((err) => setTelegramError(err instanceof Error ? err.message : String(err)));
  }, []);

  const startTelegramLogin = useCallback(() => {
    const command = telegramLoginCommand(effectiveCommsSettings.telegram);
    setTerminalLaunchRequest({
      kind: "shell",
      nonce: Date.now(),
      title: "Telegram Login",
      cwd: inboxWorkspacePath,
      command: command.command,
      extraArgs: command.args,
    });
    updateLayoutSettings({ terminalOpen: true });
  }, [effectiveCommsSettings.telegram, inboxWorkspacePath, updateLayoutSettings]);

  const startGwsAuth = useCallback(() => {
    const command = gwsAuthCommand(inboxRuntimeConfig.gmail?.gws_path ?? null);
    setTerminalLaunchRequest({
      kind: "shell",
      nonce: Date.now(),
      title: "Gmail Auth",
      cwd: inboxWorkspacePath,
      command: command.command,
      extraArgs: command.args,
    });
    updateLayoutSettings({ terminalOpen: true });
  }, [inboxRuntimeConfig.gmail?.gws_path, inboxWorkspacePath, updateLayoutSettings]);

  const startMsoLogin = useCallback(() => {
    const command = m365LoginCommand(effectiveCommsSettings.outlook.m365Path);
    setTerminalLaunchRequest({
      kind: "shell",
      nonce: Date.now(),
      title: "Outlook Auth",
      cwd: inboxWorkspacePath,
      command: command.command,
      extraArgs: command.args,
    });
    updateLayoutSettings({ terminalOpen: true });
  }, [effectiveCommsSettings.outlook.m365Path, inboxWorkspacePath, updateLayoutSettings]);

  const refreshMigrationServices = useCallback(() => {
    if (!isMac) {
      setMigrationServices([]);
      setMigrationBusy(false);
      return;
    }
    setMigrationBusy(true);
    void detectLegacyTelegramLaunchd()
      .then(setMigrationServices)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setMigrationBusy(false));
  }, [isMac]);

  const unloadMigrationService = useCallback(
    (plistPath: string) => {
      if (!isMac) return;
      const ok = window.confirm(t("comms.migration.confirm"));
      if (!ok) return;
      setMigrationBusy(true);
      void unloadLegacyTelegramLaunchd(plistPath)
        .then(() => detectLegacyTelegramLaunchd())
        .then(setMigrationServices)
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setMigrationBusy(false));
    },
    [isMac, t],
  );

  const toggleLocale = useCallback(() => {
    setLocale(locale === "ko" ? "en" : "ko");
  }, [locale, setLocale]);

  const refreshActiveSurface = useCallback(() => {
    if (appMode === "inbox") {
      void refreshInbox();
      void refreshProcessedItems();
      void refreshProcessingMissions();
    } else if (appMode === "comms") {
      void refreshCommsProviders({ force: true });
      void refreshProcessedItems();
      void refreshSourceRuns();
      void refreshProcessingMissions();
    } else if (appMode === "meetings") {
      void refreshProcessingMissions();
    } else if (appMode === "tasks") {
      void refreshProcessingMissions();
    } else if (maruSettings.ui.explorerPaneMode === "files" && explorerWorkspacePath) {
      void refreshWorkspaceFiles(explorerWorkspacePath);
    } else {
      void refreshCurrent();
    }
  }, [
    maruSettings.ui.explorerPaneMode,
    appMode,
    explorerWorkspacePath,
    refreshCurrent,
    refreshCommsProviders,
    refreshInbox,
    refreshProcessedItems,
    refreshProcessingMissions,
    refreshSourceRuns,
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
      const docTab = tabs.find((item) => item.id === tabId);
      if (docTab) {
        activateEditorTab(tabId, group);
        setExplorerVisibility(docTab.visibility);
        pushRecent(docTab.entry.path);
        return;
      }
      const binaryTab = binaryTabs.find((item) => item.id === tabId);
      if (!binaryTab) return;
      activateEditorTab(tabId, group);
      setExplorerVisibility(binaryTab.visibility);
    },
    [activateEditorTab, binaryTabs, focusedEditorGroup, tabs, pushRecent],
  );

  const copyTextToClipboard = useCallback((value: string) => {
    void navigator.clipboard.writeText(value).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  const refreshAfterDocumentMutation = useCallback(
    async (workspacePath: string) => {
      const fresh = await scanVault(workspacePath, scanOptions);
      updateWorkspaceState(workspacePath, { entries: fresh });
      await refreshWorkspaceFiles(workspacePath);
      setGitRefreshTick((n) => n + 1);
      return fresh;
    },
    [refreshWorkspaceFiles, scanOptions, updateWorkspaceState],
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
      setTabOrder((prev) => prev.map((id) => (id === oldTab.id ? nextId : id)));
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
      setTabOrder((prev) => prev.map((id) => replacements.get(id) ?? id));
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
      if (!orderedAnyTabs.some((tab) => tab.id === tabId)) return;
      const fallbackId = nextFallbackTabIdAfterClose(orderedAnyTabs, [tabId], tabId);
      const flushed = flushHtmlDraft(tabId);
      const closing = tabs.find((tab) => tab.id === tabId);
      const closingDraft = closing ? (flushed ?? closing.draftContent) : null;
      if (closing && closingDraft !== null && closingDraft !== closing.document.content) {
        setDiscardedEdit({
          workspacePath: closing.workspacePath,
          visibility: closing.visibility,
          entry: closing.entry,
          draft: closingDraft,
        });
      }
      setTabs((prev) => prev.filter((tab) => tab.id !== tabId));
      setBinaryTabs((prev) => prev.filter((tab) => tab.id !== tabId));
      setTabOrder((prev) => prev.filter((id) => id !== tabId));
      if (leftResolvedTabId === tabId) setLeftActiveTabId(fallbackId);
      if (rightResolvedTabId === tabId) {
        setRightActiveTabId(null);
        setFocusedEditorGroup("left");
        updateLayoutSettings({ editorSplitOpen: false });
      }
      if (resolvedActiveTabId === tabId) setActiveTabId(fallbackId);
    },
    [
      flushHtmlDraft,
      leftResolvedTabId,
      orderedAnyTabs,
      resolvedActiveTabId,
      rightResolvedTabId,
      tabs,
      updateLayoutSettings,
    ],
  );

  const closeTabsByIds = useCallback(
    (tabIds: string[]) => {
      const closeSet = new Set(tabIds);
      if (closeSet.size === 0) return;
      let dirtyClosing: { tab: EditorTab; draft: string } | null = null;
      for (const tab of tabs) {
        if (!closeSet.has(tab.id)) continue;
        const draft = flushHtmlDraft(tab.id) ?? tab.draftContent;
        if (draft !== tab.document.content) {
          dirtyClosing = { tab, draft };
          break;
        }
      }
      if (dirtyClosing) {
        setDiscardedEdit({
          workspacePath: dirtyClosing.tab.workspacePath,
          visibility: dirtyClosing.tab.visibility,
          entry: dirtyClosing.tab.entry,
          draft: dirtyClosing.draft,
        });
      }
      const maruId =
        resolvedActiveTabId && closeSet.has(resolvedActiveTabId)
          ? resolvedActiveTabId
          : tabIds[0];
      const fallbackId = nextFallbackTabIdAfterClose(orderedAnyTabs, closeSet, maruId);
      setTabs((prev) => prev.filter((tab) => !closeSet.has(tab.id)));
      setBinaryTabs((prev) => prev.filter((tab) => !closeSet.has(tab.id)));
      setTabOrder((prev) => prev.filter((id) => !closeSet.has(id)));
      if (leftResolvedTabId && closeSet.has(leftResolvedTabId)) {
        setLeftActiveTabId(fallbackId);
      }
      if (rightResolvedTabId && closeSet.has(rightResolvedTabId)) {
        setRightActiveTabId(null);
        updateLayoutSettings({ editorSplitOpen: false });
      }
      if (resolvedActiveTabId && closeSet.has(resolvedActiveTabId)) {
        setActiveTabId(fallbackId);
      }
    },
    [
      flushHtmlDraft,
      leftResolvedTabId,
      orderedAnyTabs,
      resolvedActiveTabId,
      rightResolvedTabId,
      tabs,
      updateLayoutSettings,
    ],
  );

  const closeOtherTabs = useCallback(
    (tabId: string) => {
      if (!orderedAnyTabs.some((tab) => tab.id === tabId)) return;
      closeTabsByIds(tabIdsToCloseOthers(orderedAnyTabs, tabId));
      setLeftActiveTabId(tabId);
      setRightActiveTabId(null);
      setActiveTabId(tabId);
      setFocusedEditorGroup("left");
      updateLayoutSettings({ editorSplitOpen: false });
    },
    [closeTabsByIds, orderedAnyTabs, updateLayoutSettings],
  );

  const closeTabsToRight = useCallback(
    (tabId: string) => {
      closeTabsByIds(tabIdsToCloseRight(orderedAnyTabs, tabId));
    },
    [closeTabsByIds, orderedAnyTabs],
  );

  const closeSavedTabs = useCallback(() => {
    const summaries = orderedAnyTabs.map((tab) => {
      if (isBinaryTab(tab)) return { id: tab.id, dirty: false };
      return {
        id: tab.id,
        dirty: tab.draftContent !== tab.document.content,
      };
    });
    closeTabsByIds(tabIdsToCloseSaved(summaries));
  }, [closeTabsByIds, orderedAnyTabs]);

  const copyTabName = useCallback(
    (tabId: string) => {
      const docTab = tabs.find((item) => item.id === tabId);
      if (docTab) {
        copyTextToClipboard(
          documentDisplayName(docTab.document, maruSettings.ui.documentLabelMode),
        );
        return;
      }
      const binaryTab = binaryTabs.find((item) => item.id === tabId);
      if (binaryTab) copyTextToClipboard(binaryTab.fileEntry.name);
    },
    [
      maruSettings.ui.documentLabelMode,
      binaryTabs,
      copyTextToClipboard,
      tabs,
    ],
  );

  const copyTabPath = useCallback(
    (tabId: string) => {
      const docTab = tabs.find((item) => item.id === tabId);
      if (docTab) {
        copyTextToClipboard(docTab.document.path);
        return;
      }
      const binaryTab = binaryTabs.find((item) => item.id === tabId);
      if (binaryTab) copyTextToClipboard(binaryTab.fileEntry.path);
    },
    [binaryTabs, copyTextToClipboard, tabs],
  );

  const copyTabRelativePath = useCallback(
    (tabId: string) => {
      const docTab = tabs.find((item) => item.id === tabId);
      if (docTab) {
        copyTextToClipboard(docTab.document.relPath);
        return;
      }
      const binaryTab = binaryTabs.find((item) => item.id === tabId);
      if (binaryTab) copyTextToClipboard(binaryTab.fileEntry.relPath);
    },
    [binaryTabs, copyTextToClipboard, tabs],
  );

  const renameTabDocument = useCallback(
    async (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab || blockTabWrite(tab, "renameMove")) return;
      const parts = tab.document.relPath.split("/");
      const fileName = parts.pop() ?? tab.document.relPath;
      // Preserve the source file's real extension (incl. case): appending a
      // hardcoded `.md` would turn `page.HTML` into `page.HTML.md`, which the
      // backend opens as Markdown — destructive for HTML documents.
      const EXT_RE = /\.(md|markdown|html|htm)$/i;
      const originalExt = fileName.match(EXT_RE)?.[0] ?? ".md";
      const currentStem = fileName.replace(EXT_RE, "");
      const input = window.prompt(t("editor.tabs.rename.prompt"), currentStem);
      if (input == null) return;
      const nextStem = input.trim().replace(EXT_RE, "");
      if (!nextStem) return;
      if (/[\\/]/.test(nextStem)) {
        setError(t("editor.tabs.rename.invalid"));
        return;
      }
      const targetRelPath = `${parts.length > 0 ? `${parts.join("/")}/` : ""}${nextStem}${originalExt}`;
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
      const docTab = tabs.find((item) => item.id === tabId);
      if (docTab) {
        revealTargetInFinder(docTab.document.path);
        return;
      }
      const binaryTab = binaryTabs.find((item) => item.id === tabId);
      if (binaryTab) revealTargetInFinder(binaryTab.fileEntry.path);
    },
    [binaryTabs, revealTargetInFinder, tabs],
  );

  const revealTabInExplorer = useCallback(
    (tabId: string, group: EditorGroupId) => {
      const docTab = tabs.find((item) => item.id === tabId) ?? null;
      const binaryTab = docTab ? null : binaryTabs.find((item) => item.id === tabId) ?? null;
      if (!docTab && !binaryTab) return;
      const visibility = docTab?.visibility ?? binaryTab!.visibility;
      const workspacePath = docTab?.workspacePath ?? binaryTab!.workspacePath;
      const relPath = docTab?.entry.relPath ?? binaryTab!.fileEntry.relPath;
      const targetPath = docTab?.document.path ?? binaryTab!.fileEntry.path;
      const activePane = binaryTab ? "files" : maruSettings.ui.explorerPaneMode;
      setPersistedAppMode("pkm");
      if (!documentsPaneOpen) updateLayoutSettings({ documentsPaneOpen: true });
      if (binaryTab && maruSettings.ui.explorerPaneMode !== "files") {
        setExplorerPaneMode("files");
      }
      setExplorerVisibility(visibility);
      if (activePane === "documents") {
        setDocumentBrowserMode("tree");
        setExplorerQuery("");
        setExplorerDocumentFilter({ kind: "all" });
        setCollapsedTreeFoldersByVisibility((current) => {
          const existing = current[visibility] ?? [];
          return {
            ...current,
            [visibility]: expandDocumentAncestors(existing, relPath),
          };
        });
      } else {
        setWorkspaceFileFilter("all");
        setWorkspaceFileQuery("");
        setCollapsedFileFoldersByVisibility((current) => {
          const existing = current[visibility] ?? [];
          return {
            ...current,
            [visibility]: expandWorkspaceFileAncestors(existing, relPath),
          };
        });
        setSelectedFilePathsByWorkspace((current) => ({
          ...current,
          [workspacePath]: [targetPath],
        }));
        void refreshWorkspaceFiles(workspacePath);
      }
      selectTab(tabId, group);
      setPendingExplorerReveal({ pane: activePane, targetPath });
    },
    [
      maruSettings.ui.explorerPaneMode,
      binaryTabs,
      documentsPaneOpen,
      refreshWorkspaceFiles,
      selectTab,
      setDocumentBrowserMode,
      setExplorerPaneMode,
      setExplorerQuery,
      setExplorerDocumentFilter,
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

  const closeActiveSurface = useCallback(() => {
    const terminalPanel = terminalPanelRef.current;
    if (terminalPanel?.hasFocus()) {
      terminalPanel.closeFocusedTab();
      return;
    }
    if (visibleAppMode !== "pkm") return;
    if (focusedEditorGroup === "right" && (rightResolvedTabId || rightGraphOpen)) {
      closeRightEditorPane();
      return;
    }
    if (leftResolvedTabId) closeTab(leftResolvedTabId);
  }, [
    visibleAppMode,
    closeRightEditorPane,
    closeTab,
    focusedEditorGroup,
    leftResolvedTabId,
    rightGraphOpen,
    rightResolvedTabId,
  ]);

  const requestWindowClose = useCallback(() => {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().close())
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const closeAllCleanTabs = useCallback(() => {
    const dirtyTabs = orderedAnyTabs.filter(
      (tab): tab is EditorTab =>
        !isBinaryTab(tab) && tab.draftContent !== tab.document.content,
    );
    setTabs(dirtyTabs);
    setBinaryTabs([]);
    setTabOrder(dirtyTabs.map((tab) => tab.id));
    const fallback = dirtyTabs[0]?.id ?? null;
    setLeftActiveTabId(fallback);
    setRightActiveTabId(null);
    setActiveTabId(fallback);
    setFocusedEditorGroup("left");
    updateLayoutSettings({ editorSplitOpen: false });
    if (dirtyTabs.length > 0) {
      setError(t("editor.tabs.closeAll.dirtyKept", { count: dirtyTabs.length }));
    }
  }, [orderedAnyTabs, t, updateLayoutSettings]);

  const splitEditorRight = useCallback(() => {
    const target = activeTab ?? leftTab ?? orderedAnyTabs[0] ?? null;
    if (!target) return;
    setRightActiveTabId(target.id);
    setActiveTabId(target.id);
    setFocusedEditorGroup("right");
    updateLayoutSettings({
      editorSplitOpen: true,
      editorSplitSurface: "document",
    });
  }, [activeTab, leftTab, orderedAnyTabs, updateLayoutSettings]);

  const openGraphRight = useCallback(
    (rawTarget?: GraphOpenTarget) => {
      // Reject non-target values (e.g. a MouseEvent when passed as an onClick
      // handler directly) so a plain toolbar click never rewrites graph.source.
      const target =
        rawTarget && typeof rawTarget.source === "string" && rawTarget.localTarget
          ? rawTarget
          : null;
      setGraphOpenTarget(target);
      setRightActiveTabId(null);
      setFocusedEditorGroup("right");
      setPersistedAppMode("pkm");
      updateLayoutSettings({
        editorSplitOpen: true,
        editorSplitSurface: "graph",
        outlineOpen: false,
      });
      if (target) {
        updateSettings((current) => ({
          ...current,
          graph: {
            ...current.graph,
            source: target.source,
            mode: "local",
          },
        }));
      }
    },
    [setPersistedAppMode, updateLayoutSettings, updateSettings],
  );

  const splitTerminalRight = useCallback(() => {
    updateLayoutSettings({ terminalOpen: true, terminalSplitOpen: true });
  }, [updateLayoutSettings]);

  const dockTerminal = useCallback(
    (terminalDock: TerminalDock) => {
      updateLayoutSettings(
        { terminalDock, terminalOpen: true, terminalMaximized: false },
        { flush: true },
      );
    },
    [updateLayoutSettings],
  );

  const handleTerminalOpenChange = useCallback(
    (terminalOpen: boolean) => updateLayoutSettings({ terminalOpen }, { flush: true }),
    [updateLayoutSettings],
  );
  const handleTerminalHeightChange = useCallback(
    (terminalHeight: number) => updateLayoutSettings({ terminalHeight }),
    [updateLayoutSettings],
  );
  const handleTerminalWidthChange = useCallback(
    (terminalWidth: number) => updateLayoutSettings({ terminalWidth }),
    [updateLayoutSettings],
  );
  const handleTerminalSplitOpenChange = useCallback(
    (terminalSplitOpen: boolean) =>
      updateLayoutSettings({ terminalSplitOpen, terminalOpen: true }),
    [updateLayoutSettings],
  );
  const handleTerminalSplitRatioChange = useCallback(
    (terminalSplitRatio: number) => updateLayoutSettings({ terminalSplitRatio }),
    [updateLayoutSettings],
  );
  const handleTerminalMaximizedChange = useCallback(
    (terminalMaximized: boolean) =>
      updateLayoutSettings({ terminalMaximized, terminalOpen: true }),
    [updateLayoutSettings],
  );

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
      const tab = orderedAnyTabs[index];
      if (tab) selectTab(tab.id);
    },
    [orderedAnyTabs, selectTab],
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
        focusedDocumentGroup === "right"
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
  }, [focusedDocumentGroup, setPersistedEditorViewMode]);

  // Track which heading the source editor is scrolled to so the outline can
  // highlight the active one. Source mode only — the textarea has a uniform
  // line height, the same line↔scroll mapping jumpToOutlineLine relies on.
  const [activeOutlineLine, setActiveOutlineLine] = useState<number | null>(null);
  useEffect(() => {
    if (!outlineOpen || rightPaneTab !== "outline" || editorViewMode !== "source") {
      setActiveOutlineLine(null);
      return;
    }
    const ta =
      focusedDocumentGroup === "right"
        ? rightEditorTextareaRef.current
        : editorTextareaRef.current;
    if (!ta) {
      setActiveOutlineLine(null);
      return;
    }
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight || "20") || 20;
    let raf = 0;
    const compute = () => {
      raf = 0;
      // floor, not round: the active line is the one whose top edge has
      // reached the viewport top — matching jumpToOutlineLine's
      // scrollTop = line * lineHeight mapping. round would flip early.
      setActiveOutlineLine(Math.floor(ta.scrollTop / lineHeight));
    };
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(compute);
    };
    compute();
    ta.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ta.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlineOpen, rightPaneTab, editorViewMode, focusedDocumentGroup, document?.path]);

  const exportActiveDocumentBundle = useCallback(async (): Promise<void> => {
    const workspaceRoot = activeDocumentWorkspacePath;
    const sourceAbs = document?.path;
    const sourceRel = document?.relPath;
    if (!workspaceRoot || !sourceAbs || !sourceRel) {
      setError(t("export.error.noDocument"));
      return;
    }
    try {
      const formats: ExportFormat[] = ["docx", "hwpx", "pdf"];
      const resp = await exportPlan({
        workspaceRoot,
        sourcePath: sourceRel,
        formats,
      });
      setLastExportManifestPath(resp.manifest_path);
      const dispatched = await exportDispatch({
        workspaceRoot,
        manifestPath: resp.manifest_path,
        formats,
      });
      setError(
        t("export.success", {
          count: String(dispatched.results.length),
          manifest: resp.manifest_path,
          summary: summarizeDispatch(dispatched),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeDocumentWorkspacePath, document, t]);

  const validateLastExportBundle = useCallback(async (): Promise<void> => {
    if (!lastExportManifestPath) {
      setError(t("export.error.noManifest"));
      return;
    }
    try {
      const report = await exportValidate(lastExportManifestPath);
      setError(
        t("export.validate.success", {
          summary: summarizeValidation(report),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [lastExportManifestPath, t]);

  const runCommand = useCallback(
    (id: string) => {
      if (id.startsWith("skill:")) {
        const skillId = id.slice("skill:".length);
        openSkillCompose(skills.find((skill) => skill.id === skillId) ?? null);
        return;
      }
      switch (id) {
        case "new-document":
          openNewDocumentDialog();
          break;
        case "new-document-from-template":
          openNewDocumentDialog(undefined, { fromLibrary: true });
          break;
        case "open-catalog":
          setPersistedAppMode("catalog");
          break;
        case "open-studio":
          setPersistedAppMode("studio");
          break;
        case "open-diagram":
          if (diagramEnabled) setPersistedAppMode("diagram");
          break;
        case "open-graph":
          setPersistedAppMode("graph");
          break;
        case "open-graph-right":
          openGraphRight();
          break;
        case "open-scratchpad":
        case "new-scratchpad-memo":
        case "new-scratchpad-idea":
        case "review-scratchpad-temp": {
          setPersistedAppMode("pkm");
          if (!outlineOpen) updateLayoutSettings({ outlineOpen: true });
          setPersistedRightPaneTab("memo");
          const action =
            id === "new-scratchpad-memo"
              ? "new-memo"
              : id === "new-scratchpad-idea"
                ? "new-idea"
                : id === "review-scratchpad-temp"
                  ? "review-temp"
                  : null;
          if (action) {
            window.setTimeout(() => {
              window.dispatchEvent(new CustomEvent(`maru:scratchpad:${action}`));
            }, 0);
          }
          break;
        }
        case "export-bundle":
          void exportActiveDocumentBundle();
          break;
        case "export-validate":
          void validateLastExportBundle();
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
        case "attach-active-item":
          void attachActiveItemToTerminal();
          break;
        case "toggle-agent-hooks":
          void toggleAgentStatusHooks();
          break;
        case "write-context-hint":
          void writeAgentContextHintCommand(false);
          break;
        case "remove-context-hint":
          void writeAgentContextHintCommand(true);
          break;
        case "dock-terminal-right":
          dockTerminal("right");
          break;
        case "dock-terminal-bottom":
          dockTerminal("bottom");
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
          openInboxAndFocus();
          break;
        case "open-comms":
          openComms();
          break;
        case "open-meetings":
          openMeetings();
          break;
        case "open-tasks":
          openTasks();
          break;
        case "open-sites":
          openSites();
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
        case "open-skill-compose":
          openSkillCompose(null);
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
      openInboxAndFocus,
      openComms,
      openMeetings,
      openTasks,
      openSites,
      checkForUpdates,
      splitEditorRight,
      attachActiveItemToTerminal,
      requestTerminalLaunch,
      toggleAgentStatusHooks,
      writeAgentContextHintCommand,
      dockTerminal,
      closeAllCleanTabs,
      editorViewMode,
      setPersistedAppMode,
      setPersistedEditorViewMode,
      setPersistedRightPaneTab,
      updateLayoutSettings,
      outlineOpen,
      openGraphRight,
      openSkillCompose,
      skills,
      exportActiveDocumentBundle,
      validateLastExportBundle,
      diagramEnabled,
    ],
  );

  useScopedSelectAll();

  useKeyboardShortcuts(
    {
      "mod+s": () => void saveCurrent(),
      "mod+shift+s": () => void snapshotCurrent(),
      "mod+n": openNewDocumentDialog,
      "mod+d": splitActiveSurfaceRight,
      "mod+i": openInboxAndFocus,
      "mod+shift+m": openComms,
      "mod+shift+t": openTasks,
      "mod+shift+b": openSites,
      "mod+k": () => setCommandPaletteOpen((v) => !v),
      "mod+shift+k": () => openSkillCompose(null),
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
        closeActiveSurface();
      },
    },
    [
      saveCurrent,
      snapshotCurrent,
      focusSearch,
      openInboxAndFocus,
      openComms,
      openTasks,
      openSites,
      toggleLocale,
      refreshActiveSurface,
      navigateBack,
      navigateForward,
      selectTabByIndex,
      openNewDocumentDialog,
      openPreferences,
      openSkillCompose,
      splitActiveSurfaceRight,
      closeActiveSurface,
      editorViewMode,
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
        case "file.close_active":
          closeActiveSurface();
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
          requestTerminalLaunch(id.split(".")[1] as TerminalKind);
          break;
        case "terminal.split":
          splitTerminalRight();
          break;
        case "terminal.dock_right":
          dockTerminal("right");
          break;
        case "terminal.dock_bottom":
          dockTerminal("bottom");
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
        case "window.close":
          requestWindowClose();
          break;
      }
    },
    [
      documentsPaneOpen,
      closeActiveSurface,
      explorerWorkspacePath,
      navigateBack,
      navigateForward,
      openAddWorkspaceDialog,
      openCommitDialogFromMenu,
      openNewDocumentDialog,
      openPreferences,
      outlineOpen,
      refreshActiveSurface,
      requestWindowClose,
      revealTargetInFinder,
      saveCurrent,
      selectAdjacentTab,
      setExplorerPaneMode,
      snapshotCurrent,
      splitTerminalRight,
      dockTerminal,
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
        console.info("[maru] menu listener unavailable:", err);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [runMenuCommand]);

  const modeClassByAppMode: Partial<Record<AppMode, string>> = {
    inbox: " inbox-mode",
    comms: " comms-mode",
    meetings: " meetings-mode",
    tasks: " tasks-mode",
    catalog: " catalog-mode",
    studio: " studio-mode",
    e2e: " e2e-mode",
    diagram: " diagram-mode",
    sites: " sites-mode",
    graph: " graph-mode",
  };
  const graphVaultPath =
    workspaceRegistry.activeByVisibility.public ?? publicWorkspaces[0]?.path ?? null;
  const graphWorkspacePath =
    workspaceRegistry.activeByVisibility.private ?? privateWorkspaces[0]?.path ?? activeDocumentWorkspacePath;
  const graphDataPath =
    maruSettings.graph.source === "vault"
      ? graphVaultPath ?? activeDocumentWorkspacePath
      : graphWorkspacePath ?? activeDocumentWorkspacePath;
  const graphOverlayPath = graphVaultPath ?? graphDataPath;
  const graphEntries = graphDataPath
    ? workspaceStates[graphDataPath]?.entries ?? []
    : activeDocumentEntries;
  const graphSurfaceVisible = visibleAppMode === "graph" || rightGraphOpen;
  const vaultWatchPath = graphSurfaceVisible ? graphDataPath : activeDocumentWorkspacePath;
  useEffect(() => {
    if (!graphSurfaceVisible || !graphDataPath) return;
    const current = workspaceStates[graphDataPath];
    if (current?.startupIoReady || current?.loading || current?.refreshing) return;
    let cancelled = false;
    updateWorkspaceState(graphDataPath, { loading: true });
    void (async () => {
      try {
        const cached = await readVaultCache(graphDataPath);
        if (!cancelled && cached) updateWorkspaceState(graphDataPath, { entries: cached, loading: false, refreshing: true });
        const fresh = await scanVault(graphDataPath, scanOptions);
        if (!cancelled) updateWorkspaceState(graphDataPath, { entries: fresh, loading: false, refreshing: false, startupIoReady: true });
      } catch (err) {
        if (!cancelled) {
          updateWorkspaceState(graphDataPath, { loading: false, refreshing: false });
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [graphDataPath, graphSurfaceVisible, scanOptions, updateWorkspaceState, workspaceStates]);
  useEffect(() => {
    if (!graphSurfaceVisible || !graphDataPath || !vaultWatchPath) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    void startVaultWatcher(vaultWatchPath).catch(() => undefined);
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ workspacePath: string; paths: string[] }>("vault://index-delta", (event) => {
          if (event.payload.workspacePath !== vaultWatchPath) return;
          if (refreshTimer) clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => {
            void scanVault(vaultWatchPath, scanOptions).then((fresh) => {
              if (!disposed) updateWorkspaceState(vaultWatchPath, { entries: fresh });
            });
          }, 150);
        }),
      )
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      unlisten?.();
      void stopVaultWatcher().catch(() => undefined);
    };
  }, [graphDataPath, graphSurfaceVisible, scanOptions, updateWorkspaceState, vaultWatchPath]);
  const lastAppModeRef = useRef<AppMode>(visibleAppMode);
  useEffect(() => {
    const previous = lastAppModeRef.current;
    lastAppModeRef.current = visibleAppMode;
    // Keep the right pane available in Docs (pkm) and Inbox — the modes that
    // expose right-pane tabs (workspace / shareOutbox). Auto-close it only for
    // the chrome-less full-screen modes.
    if (
      previous !== visibleAppMode &&
      visibleAppMode !== "pkm" &&
      visibleAppMode !== "inbox" &&
      outlineOpen
    ) {
      updateLayoutSettings({ outlineOpen: false });
    }
  }, [outlineOpen, visibleAppMode, updateLayoutSettings]);
  useEffect(() => {
    // Inbox selection only feeds the Shared Outbox queue while in Inbox mode.
    if (visibleAppMode !== "inbox" && inboxShareablePaths.length > 0) {
      setInboxShareablePaths([]);
    }
  }, [visibleAppMode, inboxShareablePaths.length]);
  const modeClass = modeClassByAppMode[visibleAppMode] ?? "";
  // In-DOM overlays that cover the content area; the native sites webview
  // cannot stack under DOM modals, so SitesPane hides it while any is open.
  const sitesOverlayOpen =
    commandPaletteOpen ||
    newDocumentOpen ||
    addWorkspaceOpen ||
    composeSeed !== null ||
    commitDialog !== null ||
    approvalGate.open;
  const terminalMaximizedClass =
    maruSettings.ui.layout.terminalOpen && maruSettings.ui.layout.terminalMaximized
      ? " terminal-maximized"
      : "";
  const terminalDockClass =
    layoutSettings.terminalDock === "right" ? " terminal-dock-right" : " terminal-dock-bottom";
  const shellClass = `app-shell${modeClass}${outlineOpen ? "" : " outline-closed"}${
    documentsPaneOpen ? "" : " documents-closed"
  }${terminalMaximizedClass}${terminalDockClass}`;
  const themeVars = useMemo(() => buildThemeVars(maruSettings), [maruSettings]);
  const shellStyle = useMemo(
    () =>
      ({
        ...themeVars,
        "--documents-col": documentsPaneOpen
          ? `${layoutSettings.documentsPaneWidth}px`
          : "0px",
        "--outline-col": outlineOpen ? `${layoutSettings.outlinePaneWidth}px` : "0px",
        // In graph mode the canvas column must keep >= 420px, so clamp only the
        // effective terminal column (the stored terminalWidth stays untouched).
        // Graph mode: activity 48px + documents/outline 0 -> 100vw - 48 - 420.
        "--terminal-col":
          layoutSettings.terminalDock === "right"
            ? layoutSettings.terminalOpen
              ? visibleAppMode === "graph"
                ? `min(${layoutSettings.terminalWidth}px, calc(100vw - 468px))`
                : rightGraphOpen
                  ? `min(${layoutSettings.terminalWidth}px, max(40px, calc(100vw - 48px - var(--documents-col) - 720px)))`
                : `${layoutSettings.terminalWidth}px`
              : "40px"
            : "0px",
      }) as React.CSSProperties & Record<`--${string}`, string>,
    [
      documentsPaneOpen,
      layoutSettings.documentsPaneWidth,
      layoutSettings.outlinePaneWidth,
      layoutSettings.terminalDock,
      layoutSettings.terminalOpen,
      layoutSettings.terminalWidth,
      outlineOpen,
      rightGraphOpen,
      themeVars,
      visibleAppMode,
    ],
  );
  const editorSplitStyle =
    editorSplitOpen && (rightTab || rightGraphOpen)
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

  const renderGraphSurface = (placement: "full" | "right") => (
    <LazyGraphView
      key={`${placement}:${maruSettings.graph.source}:${graphDataPath ?? "no-workspace"}`}
      workspacePath={graphDataPath}
      overlayPath={graphOverlayPath}
      entries={graphEntries}
      focusTarget={graphOpenTarget}
      onFocusTargetChange={setGraphOpenTarget}
      onOpenEntry={(entry) => {
        if (placement === "full") setPersistedAppMode("pkm");
        void selectEntry(entry, "left");
      }}
      onCreateNote={handleWikilinkClick}
      graphSettings={maruSettings.graph}
      onGraphSettingsChange={(graph) =>
        updateSettings((current) => ({ ...current, graph }))
      }
      isFavorite={isFavorite}
      onToggleFavorite={toggleFavorite}
      onError={setError}
      onGraphChanged={() => {
        if (!graphDataPath) return;
        void scanVault(graphDataPath, scanOptions).then((fresh) =>
          updateWorkspaceState(graphDataPath, { entries: fresh }),
        );
      }}
    />
  );

  const renderRightGraphPane = () => (
    <section
      className="editor-pane graph-split-pane"
      data-testid="graph-split-pane"
      tabIndex={-1}
      onPointerDownCapture={() => setFocusedEditorGroup("right")}
      onFocusCapture={() => setFocusedEditorGroup("right")}
    >
      <div className="document-tabs-row" aria-label={t("editor.tabs.label")}>
        <div className="document-tab active graph-split-tab">
          <button
            type="button"
            className="document-tab-main"
            aria-current="page"
            onClick={() => setFocusedEditorGroup("right")}
          >
            <Waypoints size={13} aria-hidden />
            <span className="document-tab-title">{t("mode.graph")}</span>
          </button>
          <button
            type="button"
            className="document-tab-close"
            onClick={closeRightEditorPane}
            aria-label={t("editor.tabs.close", { title: t("mode.graph") })}
            title={t("editor.tabs.close", { title: t("mode.graph") })}
          >
            <X size={12} />
          </button>
        </div>
      </div>
      <div className="graph-split-body">{renderGraphSurface("right")}</div>
    </section>
  );

  const renderEditorPane = (
    group: EditorGroupId,
    tab: AnyTab | null,
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
    const docTab = isBinaryTab(tab) ? null : (tab as EditorTab | null);
    const binaryTab = isBinaryTab(tab) ? (tab as BinaryTab) : null;
    const isManagedVaultNote = Boolean(
      workspace?.writePolicy === "managed" &&
        docTab?.document.relPath.startsWith("notes/") &&
        docTab.document.relPath.toLowerCase().endsWith(".md"),
    );
    const htmlKey = docTab ? `${group}:${docTab.id}` : null;
    const htmlState = htmlKey ? htmlPaneModes[htmlKey] : undefined;
    const binaryBody = binaryTab ? (
      <BinaryViewerPane
        entry={binaryTab.fileEntry}
        workspacePath={binaryTab.workspacePath}
        classification={binaryTab.classification}
        onError={(message) => setError(message)}
      />
    ) : null;
    return (
      <EditorPane
        document={docTab?.document ?? null}
        openingEntry={group === "left" ? openingEntry : null}
        draftContent={docTab?.draftContent ?? ""}
        saving={saving && resolvedActiveTabId === tabId && !binaryTab}
        dirty={Boolean(docTab && docTab.draftContent !== docTab.document.content)}
        outlineOpen={outlineOpen}
        activeWorkspaceLabel={workspace?.label ?? null}
        documentLabel={
          docTab
            ? documentDisplayName(docTab.document, maruSettings.ui.documentLabelMode)
            : binaryTab?.fileEntry.name ?? null
        }
        readOnly={!caps.canModify || Boolean(binaryTab)}
        canSnapshot={caps.canCreate && !binaryTab}
        readOnlyReason={readOnlyReason}
        isManagedVaultNote={isManagedVaultNote}
        viewMode={editorPaneViewModes[group]}
        tabs={groupTabs}
        activeTabId={tabId}
        bodyOverride={binaryBody}
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
          setPersistedEditorViewMode("preview", group);
        }}
        onRevealTabInFinder={revealTabInFinder}
        onRevealTabInExplorer={(nextTabId) => revealTabInExplorer(nextTabId, group)}
        onSave={() => void saveTab(tabId)}
        onSnapshot={() => void snapshotTab(tabId)}
        onSplitRight={splitEditorRight}
        onOpenGraphRight={openGraphRight}
        onFocusPane={() => {
          if (tabId) activateEditorTab(tabId, group);
        }}
        onToggleOutline={() => updateLayoutSettings({ outlineOpen: !outlineOpen })}
        onViewModeChange={(mode) => setPersistedEditorViewMode(mode, group)}
        onWikilinkClick={handleWikilinkClick}
        textareaRef={group === "right" ? rightEditorTextareaRef : editorTextareaRef}
        vaultPath={docTab?.workspacePath ?? null}
        htmlViewMode={htmlState?.mode ?? "visual"}
        onHtmlViewModeChange={(mode) => {
          if (!docTab || !htmlKey) return;
          flushHtmlDraft(docTab.id);
          setHtmlPaneModes((prev) => ({ ...prev, [htmlKey]: { ...prev[htmlKey], mode } }));
        }}
        htmlRiskAckDigest={htmlState?.riskAckDigest ?? null}
        onHtmlRiskAck={(digest) => {
          if (!htmlKey) return;
          setHtmlPaneModes((prev) => ({
            ...prev,
            [htmlKey]: {
              ...prev[htmlKey],
              mode: prev[htmlKey]?.mode ?? "visual",
              riskAckDigest: digest,
            },
          }));
        }}
        htmlFlushRef={group === "left" ? leftHtmlFlushRef : rightHtmlFlushRef}
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

    const rect = event.currentTarget.getBoundingClientRect();
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const withinTrafficLightZone =
      event.clientX - rect.left < 112 && event.clientY - rect.top < 44;
    if (isMac && withinTrafficLightZone) return;

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
          <div className="topbar-window-controls-guard" data-no-drag="true" aria-hidden="true" />
          <div className="brand-mark" aria-hidden="true">
            <img className="brand-mark-icon" src={APP_ICON_URL} alt="" draggable={false} />
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
            onSetWritePolicy={handleSetWorkspaceWritePolicy}
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
          <MissionBadge onError={setError} />

          <div className="topbar-spacer" />

          <button
            type="button"
            className="topbar-pill topbar-skill-action"
            onClick={() => openSkillCompose(null)}
            title={t("cmdk.action.skillCompose")}
            aria-label={t("cmdk.action.skillCompose")}
          >
            <WandSparkles size={14} />
            <span>{t("topbar.skill")}</span>
            <span className="kbd">⌘⇧K</span>
          </button>
          <button
            type="button"
            className="topbar-pill topbar-command-action"
            onClick={openCommandPalette}
            title={t("cmdk.openHint")}
          >
            <Command size={14} className="topbar-command-icon" />
            <span className="topbar-muted-label">{t("sidebar.commandPalette")}</span>
            <span className="kbd">⌘</span>
            <span className="kbd">K</span>
          </button>
          <button
            type="button"
            className="topbar-pill topbar-locale-action"
            onClick={toggleLocale}
            title={t("app.locale.label")}
            aria-label={t("app.locale.label")}
          >
            {t(locale === "ko" ? "app.locale.ko" : "app.locale.en")}
          </button>
          <button
            type="button"
            className={
              explorerWorkspaceState.refreshing
                ? "icon-button refreshing topbar-refresh-action"
                : "icon-button topbar-refresh-action"
            }
            onClick={refreshActiveSurface}
            title={t("app.refresh")}
            aria-label={t("app.refresh")}
          >
            <RefreshCcw size={14} />
          </button>
        </header>

        {todayBannerVisible && (
          <div className="today-banner" role="status">
            <p>{t("today.banner.newDay")}</p>
            <div className="today-banner-actions">
              <button
                type="button"
                className="today-banner-open"
                onClick={() => {
                  setTodayBannerVisible(false);
                  setTodayBannerPending(false);
                  openTodayForCurrentDay();
                }}
              >
                {t("today.banner.openToday")}
              </button>
              <button
                type="button"
                className="today-banner-dismiss"
                aria-label={t("today.banner.dismiss")}
                onClick={() => {
                  setTodayBannerVisible(false);
                  setTodayBannerPending(false);
                }}
              >
                {t("today.banner.dismiss")}
              </button>
            </div>
          </div>
        )}

        <nav className="activity-rail" aria-label={t("activity.label")}>
          <button
            type="button"
            className={visibleAppMode === "pkm" ? "activity-button active" : "activity-button"}
            onClick={() => setPersistedAppMode("pkm")}
            title={t("mode.pkm")}
            aria-label={t("mode.pkm")}
          >
            <FileText size={20} />
          </button>
          <button
            type="button"
            className={visibleAppMode === "inbox" ? "activity-button active" : "activity-button"}
            onClick={openInboxAndFocus}
            title={t("mode.inbox")}
            aria-label={t("mode.inbox")}
          >
            <Inbox size={20} />
          </button>
          <button
            type="button"
            className={visibleAppMode === "comms" ? "activity-button active" : "activity-button"}
            onClick={openComms}
            title={t("mode.comms")}
            aria-label={t("mode.comms")}
          >
            <MessageSquare size={20} />
          </button>
          <button
            type="button"
            className={visibleAppMode === "meetings" ? "activity-button active" : "activity-button"}
            onClick={openMeetings}
            title={t("mode.meetings")}
            aria-label={t("mode.meetings")}
          >
            <UsersRound size={20} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className={visibleAppMode === "tasks" ? "activity-button active" : "activity-button"}
            onClick={openTasks}
            title={t("mode.tasks")}
            aria-label={t("mode.tasks")}
          >
            <ListTodo size={20} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className={visibleAppMode === "catalog" ? "activity-button active" : "activity-button"}
            onClick={() => setPersistedAppMode("catalog")}
            title={t("mode.catalog")}
            aria-label={t("mode.catalog")}
          >
            <LayoutGrid size={20} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className={visibleAppMode === "studio" ? "activity-button active" : "activity-button"}
            onClick={() => setPersistedAppMode("studio")}
            title={t("mode.studio")}
            aria-label={t("mode.studio")}
          >
            <Workflow size={20} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className={visibleAppMode === "sites" ? "activity-button active" : "activity-button"}
            onClick={openSites}
            title={t("mode.sites")}
            aria-label={t("mode.sites")}
          >
            <Globe size={20} strokeWidth={1.9} />
          </button>
          {e2eFlowEnabled ? (
            <button
              type="button"
              className={visibleAppMode === "e2e" ? "activity-button active" : "activity-button"}
              onClick={() => setPersistedAppMode("e2e")}
              title={t("mode.e2e")}
              aria-label={t("mode.e2e")}
            >
              <Route size={20} strokeWidth={1.9} />
            </button>
          ) : null}
          {diagramEnabled ? (
            <button
              type="button"
              className={
                visibleAppMode === "diagram" ? "activity-button active" : "activity-button"
              }
              onClick={() => setPersistedAppMode("diagram")}
              title={t("mode.diagram")}
              aria-label={t("mode.diagram")}
            >
              <Network size={20} strokeWidth={1.9} />
            </button>
          ) : null}
          <button
            type="button"
            className={visibleAppMode === "graph" ? "activity-button active" : "activity-button"}
            onClick={() => setPersistedAppMode("graph")}
            title={t("mode.graph")}
            aria-label={t("mode.graph")}
          >
            <Waypoints size={20} strokeWidth={1.9} />
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
            className={outlineOpen ? "activity-button active" : "activity-button"}
            onClick={() => updateLayoutSettings({ outlineOpen: !outlineOpen })}
            title={outlineOpen ? t("layout.hideRightPane") : t("layout.showRightPane")}
            aria-label={
              outlineOpen ? t("layout.hideRightPane") : t("layout.showRightPane")
            }
          >
            {outlineOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
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

        <Suspense fallback={<div className="mode-loading" role="status">…</div>}>
        {visibleAppMode === "e2e" ? (
          <LazyE2EFlowPane
            workPath={inboxWorkspacePath}
            onRevealPath={(path) => {
              if (inboxWorkspacePath) void revealInFileManager(inboxWorkspacePath, path);
            }}
            onError={setError}
          />
        ) : visibleAppMode === "diagram" ? (
          <LazyDiagramMode
            workPath={inboxWorkspacePath ?? settingsWorkPath}
            onError={setError}
            activeDocument={
              activeDocTab &&
              activeDocTab.workspacePath === (inboxWorkspacePath ?? settingsWorkPath)
                ? {
                    path: activeDocTab.document.path,
                    title: activeDocTab.document.title,
                    revision: activeDocTab.document.revision,
                    fileKind: activeDocTab.document.fileKind,
                  }
                : null
            }
            recentDocuments={recentEntries.map((entry) => ({
              path: entry.path,
              title: entry.title,
            }))}
            onSaveDocument={(path, content, expectedRevision) => {
              const root = inboxWorkspacePath ?? settingsWorkPath;
              if (!root) return Promise.reject(new Error("workspace required"));
              return saveDocument(root, path, content, expectedRevision);
            }}
          />
        ) : visibleAppMode === "graph" ? (
          renderGraphSurface("full")
        ) : visibleAppMode === "sites" ? (
          <LazySitesPane overlayOpen={sitesOverlayOpen} onError={setError} />
        ) : visibleAppMode === "studio" ? (
          <LazyStudioMode
            workspaceRoot={activeDocumentWorkspacePath ?? inboxWorkspacePath ?? settingsWorkPath}
            activeDocument={document}
            canCreateDocument={activeWorkspaceCanCreate}
            canModifyDocument={activeWorkspaceCanModify}
            onCreateDocument={createDocumentAndOpen}
            onApplyBody={applyStudioBody}
            onFreezePackage={freezeStudioPackage}
            lintDismissalsByDoc={maruSettings.composer.lintDismissals}
            onLintDismissalsChange={(docId, dismissedIds) => {
              updateSettings((current) => ({
                ...current,
                composer: {
                  ...current.composer,
                  lintDismissals: {
                    ...current.composer.lintDismissals,
                    [docId]: dismissedIds,
                  },
                },
              }));
            }}
            onRevealPath={(path) => {
              const root = activeDocumentWorkspacePath ?? inboxWorkspacePath ?? settingsWorkPath;
              if (root) void revealInFileManager(root, path);
            }}
            onError={setError}
          />
        ) : visibleAppMode === "catalog" ? (
          <LazyCatalogPane
            workspaceRoot={inboxWorkspacePath ?? settingsWorkPath}
            onReveal={(path) => {
              const root = inboxWorkspacePath ?? settingsWorkPath;
              if (root) void revealInFileManager(root, path);
            }}
          />
        ) : visibleAppMode === "inbox" ? (
          <LazyInboxPane
            items={inboxItems}
            entries={inboxEntries}
            loading={inboxLoading}
            processedItems={processedItems}
            processedLoading={processedLoading}
            processedError={processedError}
            processedStatusFilter={processedStatusFilter}
            processedQuery={processedQuery}
            processedDetail={processedDetail}
            processingMissions={inboxProcessMissions(processingMissions)}
            processingLogLines={processingLogLines}
            sourceFilter={inboxSourceFilter}
            onSourceFilter={setInboxSourceFilter}
            sourceFolderKeys={inboxSourceFolderKeys}
            fileDropTarget={inboxRuntimeConfig.file_drop}
            focusRequest={inboxFocusTick}
            actionBusy={inboxActionBusy}
            onRefresh={() => {
              void refreshInbox();
              void refreshProcessedItems();
              void refreshProcessingMissions();
            }}
            onOpenSettings={openInboxSettings}
            onOpenInboxFolder={() => {
              if (!inboxWorkspacePath) return;
              void openInFileManager(
                inboxWorkspacePath,
                inboxRootPath(inboxRuntimeConfig),
              ).catch((err) => setError(err instanceof Error ? err.message : String(err)));
            }}
            onOpenSourceFolder={(key) => {
              if (!inboxWorkspacePath) return;
              void openInFileManager(
                inboxWorkspacePath,
                sourceFolderPath(inboxRuntimeConfig, key),
              ).catch((err) => setError(err instanceof Error ? err.message : String(err)));
            }}
            onClassify={(id) => void classifyItem(id)}
            onDecide={decideInboxItem}
            onBulkAccept={bulkAcceptInboxKeys}
            onBulkReject={bulkRejectInboxKeys}
            onBulkMoveFiles={bulkMoveInboxFiles}
            onProcessEntries={(keys, context) => void processInboxKeys(keys, undefined, true, context)}
            onStageFiles={(paths) => void stageInboxFiles(paths)}
            onProcessedStatusFilter={setProcessedStatusFilter}
            onProcessedQuery={setProcessedQuery}
            onRefreshProcessed={() => void refreshProcessedItems()}
            onSelectProcessedItem={(item) => void selectProcessedItem(item)}
            onRevealPath={(path) => {
              if (inboxWorkspacePath) void revealInFileManager(inboxWorkspacePath, path);
            }}
            onTrashItems={(targets) => void trashInboxTargets(targets)}
            onStopProcessingMission={(id) => void stopProcessingMission(id)}
            workPath={inboxWorkspacePath}
            onConfirmApproval={approvalGate.confirmApproval}
            onProcessApplied={() => {
              void refreshProcessedItems();
              void refreshInbox();
            }}
            onProcessError={setError}
            onShareSelectionChange={setInboxShareablePaths}
          />
        ) : visibleAppMode === "comms" ? (
          <LazyCommsPane
            runtimeConfig={inboxRuntimeConfig}
            sourceRuns={sourceRuns}
            processedCounts={processedCounts}
            processedItems={processedItems}
            processedLoading={processedLoading}
            processedError={processedError}
            processedStatusFilter={processedStatusFilter}
            processedQuery={processedQuery}
            processedDetail={processedDetail}
            processingMissions={activeInboxProcessMissions(processingMissions)}
            processingLogLines={processingLogLines}
            sourceFilter={commsSourceFilter}
            actionBusy={inboxActionBusy}
            telegramPollingStatus={telegramPolling}
            migrationServices={migrationServices}
            migrationBusy={migrationBusy}
            onSourceFilter={setCommsSourceFilter}
            onProcessNow={(channel) => void processCommsChannelNow(channel)}
            onRefresh={refreshActiveSurface}
            onProcessedStatusFilter={setProcessedStatusFilter}
            onProcessedQuery={setProcessedQuery}
            onRefreshProcessed={() => void refreshProcessedItems()}
            onSelectProcessedItem={(item) => void selectProcessedItem(item)}
            onStopProcessingMission={(id) => void stopProcessingMission(id)}
            onRevealPath={(path) => {
              if (inboxWorkspacePath) void revealInFileManager(inboxWorkspacePath, path);
            }}
            onRefreshTelegram={() => void refreshTelegram({ force: true })}
            onGwsReauth={startGwsAuth}
            onMsoReauth={startMsoLogin}
            onStartTelegramPolling={startTelegramPollingFromSettings}
            onStopTelegramPolling={stopTelegramPollingFromSettings}
            onTelegramLogin={startTelegramLogin}
            onDeepProcess={(channel) => void deepProcessCommsChannel(channel)}
            onOpenCommsSettings={openCommsSettings}
            onRefreshMigration={refreshMigrationServices}
            onUnloadMigration={unloadMigrationService}
          />
        ) : visibleAppMode === "meetings" ? (
          <LazyMeetingsPane
            workPath={inboxWorkspacePath}
            settings={maruSettings.meetings}
            effectiveSettings={effectiveMeetingsSettings}
            labelMode={maruSettings.ui.documentLabelMode}
            skills={skills}
            runtimeCommands={aiRuntimeCommands}
            permissionMode={maruSettings.ai.permissionMode}
            processingMissions={activeMeetingsMissions(processingMissions)}
            processingLogLines={processingLogLines}
            onRefreshMissions={refreshProcessingMissions}
            onOpenSettings={openMeetingsSettings}
            onOpenSkillCompose={(skill, context, prompt) =>
              openSkillCompose(skill, context, prompt)
            }
            onMissionStarted={handleMeetingsMissionStarted}
            onStopMission={(id) => void stopProcessingMission(id)}
            onConfirmApproval={approvalGate.confirmApproval}
            onRevealPath={(path) => {
              if (inboxWorkspacePath) void revealInFileManager(inboxWorkspacePath, path);
            }}
            onError={setError}
            requestedView={meetingsRequestedView}
            onViewConsumed={() => setMeetingsRequestedView(null)}
          />
        ) : visibleAppMode === "tasks" ? (
          <LazyTodayPane
            route={todayRoute}
            onRouteChange={setTodayRoute}
            workPath={inboxWorkspacePath}
            effectiveSettings={effectiveTasksSettings}
            layout={layoutSettings}
            onLayoutChange={updateLayoutSettings}
            rolloverEpoch={todayRolloverEpoch}
            tasksProps={{
              workPath: inboxWorkspacePath,
              effectiveSettings: effectiveTasksSettings,
              labelMode: maruSettings.ui.documentLabelMode,
              skills,
              runtimeCommands: aiRuntimeCommands,
              permissionMode: maruSettings.ai.permissionMode,
              defaultRuntime: maruSettings.ai.defaultRuntime,
              processingMissions: activeTasksMissions(processingMissions),
              processingLogLines,
              onRefreshMissions: refreshProcessingMissions,
              onOpenSettings: openTasksSettings,
              onOpenSkillCompose: (skill, context, prompt, cwd, onDispatched) =>
                openSkillCompose(skill, context, prompt, cwd, onDispatched),
              onMissionStarted: handleMeetingsMissionStarted,
              onStopMission: (id) => void stopProcessingMission(id),
              onConfirmApproval: approvalGate.confirmApproval,
              onRevealPath: (path) => {
                if (inboxWorkspacePath) void revealInFileManager(inboxWorkspacePath, path);
              },
              onError: setError,
            }}
          />
        ) : (
          <>
            {documentsPaneOpen && maruSettings.ui.explorerPaneMode === "documents" ? (
              <DocumentList
                documentIndex={documentIndex}
                selectedPath={selectedPath}
                query={query}
                loading={(booting || explorerWorkspaceState.loading) && entries.length === 0}
                documentFilter={documentFilter}
                documentViews={maruSettings.ui.documentViews}
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
                browserMode={maruSettings.ui.documentBrowserMode}
                documentLabelMode={maruSettings.ui.documentLabelMode}
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
                paneMode={maruSettings.ui.explorerPaneMode}
                onPaneModeChange={setExplorerPaneMode}
                pendingRevealTargetPath={
                  pendingExplorerReveal?.pane === "documents"
                    ? pendingExplorerReveal.targetPath
                    : null
                }
                onRevealHandled={() => setPendingExplorerReveal(null)}
                favorites={maruSettings.ui.favorites}
                onOpenFavorite={openFavorite}
                onRemoveFavorite={removeFavorite}
                onToggleFavorite={toggleFavorite}
                isFavorite={isFavorite}
                isFavoriteMissing={isFavoriteMissing}
                selectedFileQueueCount={selectedQueuedFileQueueItems.length}
                onApplyFileQueueToDestination={(targetPath, targetKind, operation, itemIds) => {
                  void applySelectedFileQueueToDestination(
                    targetPath,
                    targetKind,
                    operation,
                    itemIds,
                  );
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
            {documentsPaneOpen && maruSettings.ui.explorerPaneMode === "files" ? (
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
                paneMode={maruSettings.ui.explorerPaneMode}
                filter={maruSettings.ui.workspaceFileFilter}
                browserMode={maruSettings.ui.filesBrowserMode}
                sortKey={maruSettings.ui.filesSortKey}
                filesListAttributes={maruSettings.ui.filesListAttributes}
                paneFilters={filesPaneFilters}
                queuedSourcePaths={queuedSourcePaths}
                binaryIncludePatterns={maruSettings.ui.binaryFileIncludePatterns}
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
                onBrowserModeChange={setFilesBrowserMode}
                onSortKeyChange={setFilesSortKey}
                onFilesListAttributesChange={setFilesListAttributes}
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
                favorites={maruSettings.ui.favorites}
                onOpenFavorite={openFavorite}
                onRemoveFavorite={removeFavorite}
                onToggleFavorite={toggleFavorite}
                isFavorite={isFavorite}
                isFavoriteMissing={isFavoriteMissing}
                selectedFileQueueCount={selectedQueuedFileQueueItems.length}
                onApplyFileQueueToDestination={(targetPath, targetKind, operation, itemIds) => {
                  void applySelectedFileQueueToDestination(
                    targetPath,
                    targetKind,
                    operation,
                    itemIds,
                  );
                }}
                onApplyExplorerDragToDestination={(payload, targetPath, targetKind, operation) => {
                  void applyExplorerDragSourcesToDestination(
                    payload,
                    targetPath,
                    targetKind,
                    operation,
                  );
                }}
                onApplySkillToTarget={applySkillToFileTarget}
                onAttachToTerminal={attachPathToTerminal}
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
              className={
                editorSplitOpen && (rightTab || rightGraphOpen)
                  ? "editor-split-shell split"
                  : "editor-split-shell"
              }
              style={editorSplitStyle}
              ref={editorSplitShellRef}
            >
              {renderEditorPane("left", leftTab, leftResolvedTabId)}
              {editorSplitOpen && (rightTab || rightGraphOpen) ? (
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
              {rightGraphOpen
                ? renderRightGraphPane()
                : editorSplitOpen && rightTab
                  ? renderEditorPane("right", rightTab, rightResolvedTabId)
                  : null}
            </div>

          </>
        )}
        </Suspense>

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
            scratchpadWorkPath={primaryWorkspacePath}
            activeLine={activeOutlineLine}
            onJumpToLine={jumpToOutlineLine}
            onClose={() => updateLayoutSettings({ outlineOpen: false })}
            onError={setError}
            onRefreshWorkspace={() => void refreshCurrent()}
            onUpdateField={updateField}
            onSelectEntry={selectEntry}
            onMissingWikilink={handleWikilinkClick}
            onOpenGraph={(localTarget) =>
              openGraphMode({
                source:
                  activeDocumentWorkspacePath === graphVaultPath ? "vault" : "workspace",
                localTarget,
              })
            }
            isManagedVaultNote={Boolean(
              activeDocumentWorkspace?.writePolicy === "managed" &&
                document?.relPath.startsWith("notes/") &&
                document.relPath.toLowerCase().endsWith(".md"),
            )}
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
            workspaceFileEntries={fileEntries}
            selectedWorkspaceFileEntries={selectedWorkspaceFileEntries}
            filesPaneFilters={filesPaneFilters}
            onFilesPaneFiltersChange={setFilesPaneFilters}
            explorerPaneMode={maruSettings.ui.explorerPaneMode}
            onRevealFileInFinder={revealTargetInFinder}
            activeTab={rightPaneTab}
            onTabChange={setPersistedRightPaneTab}
            paneRef={outlinePaneRef}
            shareWorkspacePath={shareWorkspacePath}
            shareDocumentDirty={Boolean(dirty)}
            inboxShareablePaths={inboxShareablePaths}
            appMode={visibleAppMode}
            contentCount={documentIndex.contentCount}
            typeCounts={documentIndex.typeCounts}
            documentViews={maruSettings.ui.documentViews}
            viewCounts={builtInDocumentViewCounts}
            customViewCounts={customDocumentViewCounts}
            recentEntries={recentEntries}
            selectedPath={selectedPath}
            documentFilter={documentFilter}
            onDocumentFilter={setExplorerDocumentFilter}
            onDocumentViewsChange={updateDocumentViews}
            onNewDocument={openNewDocumentDialog}
            canCreateDocument={activeWorkspaceCanCreate}
            onSelectRecent={selectEntry}
            onOpenCommandPalette={openCommandPalette}
            skillsNode={
              <div className="skills-pane-stack">
                <SkillRunsPanel
                  workPath={activeDocumentWorkspacePath ?? inboxWorkspacePath}
                  missions={activeTrackedAgentMissions(processingMissions)}
                  logLines={processingLogLines}
                  runtimeCommands={aiRuntimeCommands}
                  permissionMode={maruSettings.ai.permissionMode}
                  onRefresh={refreshProcessingMissions}
                  onStopMission={(id) => void stopProcessingMission(id)}
                  onMissionStarted={handleMeetingsMissionStarted}
                  onConfirmApproval={approvalGate.confirmApproval}
                  onError={setError}
                />
                <SkillsQuickPane
                  skills={skills}
                  loading={skillsLoading}
                  appMode={appMode}
                  onRefresh={refreshSkills}
                  onRunSkill={(skill) => openSkillCompose(skill)}
                />
              </div>
            }
            guidelineNode={
              <WritingGuidelineSidebar
                workspaceRoot={activeDocumentWorkspacePath}
                documentBody={draftContent || document?.content || ""}
                frontmatter={document?.meta ?? null}
              />
            }
            evidenceNode={
              <EvidenceBinderPane
                workspaceRoot={activeDocumentWorkspacePath}
                docId={evidenceBinderDocId}
                documentPath={document?.path ?? null}
                onError={setError}
              />
            }
          />
        ) : null}

        <TerminalPanel
          ref={terminalPanelRef}
          cwd={activeDocumentWorkspacePath}
          activeContext={activeTerminalContext}
          settings={maruSettings}
          launchRequest={terminalLaunchRequest}
          open={maruSettings.ui.layout.terminalOpen}
          height={maruSettings.ui.layout.terminalHeight}
          dock={maruSettings.ui.layout.terminalDock}
          width={maruSettings.ui.layout.terminalWidth}
          splitOpen={maruSettings.ui.layout.terminalSplitOpen}
          splitRatio={maruSettings.ui.layout.terminalSplitRatio}
          maximized={maruSettings.ui.layout.terminalMaximized}
          onOpenChange={handleTerminalOpenChange}
          onHeightChange={handleTerminalHeightChange}
          onDockChange={dockTerminal}
          onWidthChange={handleTerminalWidthChange}
          onSplitOpenChange={handleTerminalSplitOpenChange}
          onSplitRatioChange={handleTerminalSplitRatioChange}
          onMaximizedChange={handleTerminalMaximizedChange}
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
                          : updateToast.kind === "skillsUpdated"
                            ? t("updates.skillsUpdated", { version: updateToast.version })
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
                          : updateToast.kind === "skillsUpdated"
                            ? t("updates.skillsUpdated", { version: updateToast.version })
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
              {updateToast.kind === "ready" ? (
                <button
                  type="button"
                  className="button button-ghost button-sm"
                  onClick={() => void requestRelaunch()}
                >
                  {t("updates.relaunchNow")}
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

        {pendingDestructiveAction ? (
          <div className="dialog-backdrop">
            <section className="task-new-dialog" role="alertdialog" aria-modal="true">
              <header>
                <div>
                  <h2>{t("app.unsaved.title")}</h2>
                  <p>
                    {pendingDestructiveAction === "close"
                      ? t("app.unsaved.closeBody")
                      : t("app.unsaved.relaunchBody")}
                  </p>
                </div>
              </header>
              <footer>
                <button
                  type="button"
                  className="button button-ghost button-sm"
                  onClick={() => setPendingDestructiveAction(null)}
                >
                  {t("dialog.cancel")}
                </button>
                <button
                  type="button"
                  className="button button-primary button-sm"
                  onClick={() => void confirmDestructiveAction()}
                >
                  {t("app.unsaved.confirm")}
                </button>
              </footer>
            </section>
          </div>
        ) : null}

        <NewDocumentDialog
          open={newDocumentOpen}
          workspaceRoot={activeDocumentWorkspacePath}
          initialTitle={newDocumentSeed?.title ?? ""}
          initialRelPath={newDocumentSeed?.relPath ?? null}
          initialDocType={newDocumentSeed?.docType ?? "reference"}
          initialOpenLibrary={newDocumentSeed?.openLibrary ?? false}
          entries={activeDocumentEntries}
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
        {approvalGate.dialog}
        <ComposeDialog
          open={composeSeed !== null}
          skills={skills}
          seed={composeSeed}
          onClose={() => setComposeSeed(null)}
          onTerminalDispatch={launchSkillTerminal}
          onBackgroundDispatch={(invocationId) => {
            handleMeetingsMissionStarted(invocationId);
            setPersistedRightPaneTab("skills");
          }}
          terminalRuntimeCommands={terminalRuntimeCommands}
          aiRuntimeCommands={aiRuntimeCommands}
          defaultRuntime={maruSettings.ai.defaultRuntime}
          permissionMode={maruSettings.ai.permissionMode}
          meetingsWorkspacePath={inboxWorkspacePath}
          onOpenMeetingsWorkbench={openMeetingsWorkbench}
          onError={setError}
        />
        <CommandPalette
          open={commandPaletteOpen}
          documentIndex={documentIndex}
          onClose={closeCommandPalette}
          onSelectEntry={selectEntry}
          onRunCommand={runCommand}
          documentLabelMode={maruSettings.ui.documentLabelMode}
          skillActions={commandPaletteSkillActions}
          diagramEnabled={diagramEnabled}
        />
        <CommitDialog
          open={commitDialog !== null}
          vaultPath={commitDialog?.path ?? null}
          status={commitDialog?.status ?? null}
          aiRuntime={maruSettings.ai.defaultRuntime}
          aiCommandOverride={aiRuntimeCommands[maruSettings.ai.defaultRuntime] ?? null}
          onConfirmApproval={approvalGate.confirmApproval}
          onClose={() => setCommitDialog(null)}
          onCommitted={() => setGitRefreshTick((n) => n + 1)}
        />
      </div>
    </LocaleContext.Provider>
  );
}
