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
  Bot,
  ChevronUp,
  Clock3,
  Code2,
  Command,
  Diff,
  FileText,
  FolderOpen,
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
  PanelTopOpen,
  PenLine,
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
import { AgentUsageBar } from "./components/AgentUsageBar";
import { WritingGuidelineSidebar } from "./components/catalog/WritingGuidelineSidebar";
import { EvidenceBinderPane } from "./components/evidence/EvidenceBinderPane";
import { MissionBadge } from "./components/MissionBadge";
import { NewDocumentDialog } from "./components/NewDocumentDialog";
import { OutlinePane } from "./components/OutlinePane";
import type { TasksPaneProps } from "./components/tasks/TasksPane";
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
  binaryViewerOpenExternal,
  binaryViewerPrepareAsset,
  checkGwsAuth,
  checkMsoAuth,
  checkTelegramAuth,
  createDocument,
  createVersion,
  DEFAULT_INBOX_RUNTIME_CONFIG,
  decideGmailItems,
  detectLegacyTelegramLaunchd,
  describeFileQueueSources,
  duplicateDocument,
  fetchGmailUnread,
  fetchOutlookUnread,
  fetchTelegramRecent,
  getSampleWorkspacePath,
  gitStatus,
  kgDocumentRefs,
  listWorkspaceRoots,
  moveDocument,
  readDocument,
  readAiMissionLog,
  prepareApproval,
  openInFileManager,
  revealInFileManager,
  readInboxProcessedItem,
  readInboxSourceRuns,
  readKakaoRelayStatus,
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
  scanInboxProcessedSnapshot,
  scanWorkspaceEntries,
  setActiveWorkspaceRoot,
  stageGmailItems,
  stageInboxDropFiles,
  stageKakaoRelayNew,
  stageOutlookItems,
  stageTelegramItems,
  startTelegramPolling,
  stopAiMission,
  stopTelegramPolling,
  telegramPollingStatus,
  vaultGraphRoot,
  removeAgentContextHint,
  terminalHooksInstall,
  terminalHooksStatus,
  terminalHooksUninstall,
  terminalAvailable,
  writeAgentContextHint,
  trashDocument,
  trashInboxItems,
  updateFrontmatterField,
  type LegacyLaunchdService,
} from "./lib/api";
import { inboxRootPath, sourceFolderPath } from "./lib/inboxSources";
import { kakaoRelayAuthStatus, type KakaoRelayStatus } from "./lib/kakaoRelay";
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
  addMaruIgnorePattern,
  readMaruSettings,
  listWorkspaceProjects,
  registerWorkspaceRoots,
  saveMaruSettings,
  listenMaruIgnoreUpdated,
  listenMaruSettingsUpdated,
  updateMaruWorkspace,
} from "./lib/maruDir";
import { classifyInboxItem } from "./lib/aiInvoke";
import { createDebouncedSaver, type DebouncedSaver } from "./lib/debouncedSave";
import { documentDisplayName } from "./lib/document";
import { isHtmlFileKind } from "./lib/htmlDocument";
import { refStepsByParagraph, uniqueRefNodePaths } from "./lib/kgRefs";
import type { KgRefStep } from "./lib/kgRefs";
import type { DraftGraphFocusRequest } from "./lib/draftGraphRelations";
import { isDiagramEnabled } from "./lib/diagramFlag";
import { isE2EFlowEnabled } from "./lib/e2eFlow";
import {
  orderTabsById,
  tabIdsToCloseOthers,
  tabIdsToCloseRight,
  tabIdsToCloseSaved,
} from "./lib/editorTabActions";
import {
  activateEditorTab,
  appendRestoredDocTabs,
  closeTabs,
  getEditorTabsState,
  insertBinaryTab,
  insertDocTab,
  mapDocTabs,
  orderedTabsInState,
  patchEditorIds,
  removeWorkspaceDocTabs,
  replaceAllDocTabs,
  resetWorkspaceTabs,
  resolveEditorTabIds,
  restoreWorkspaceTabs,
  transformTabs,
  updateTabDraft,
  useActiveTabIds,
  useBinaryTabs,
  useDocTabs,
  useFocusedEditorGroup,
  useTabOrder,
  type AnyTab,
  type BinaryTab,
  type EditorGroupId,
  type EditorTab,
  type EditorTabIdsPatch,
  type StoredTabs,
} from "./lib/editorTabsStore";
import {
  buildDocumentIndex,
  countDocumentFilter,
  documentFilterDefaultDocType,
  getRecentEntries,
  type BuiltInDocumentView,
  type DocumentFilter,
  type DocumentIndex,
} from "./lib/documentIndex";
import {
  buildGmailScanQuery,
  normalizeGmailScanLimit,
} from "./lib/gmail";
import { LocaleContext, useLocaleState } from "./lib/i18n";
import { listenForMenuCommand } from "./lib/menu";
import { currentPlatform, isMacPlatform } from "./lib/platform";
import {
  buildInboxProcessPrompt,
  buildInboxItemStates,
  inboxProcessMissions,
  isInboxProcessMission,
  type InboxDecision,
  type InboxItemState,
} from "./lib/inbox";
import {
  gwsAuthCommand,
  m365LoginCommand,
  telegramFetchOptions,
  telegramLoginCommand,
} from "./lib/telegram";
import { normalizeTelegramMonitorConfig } from "./lib/telegramMonitor";
import {
  SETTINGS_TERMINAL_LAUNCH_EVENT,
  type SettingsTerminalLaunchPayload,
} from "./lib/settingsEvents";
import { useKeyboardShortcuts } from "./lib/useKeyboardShortcuts";
import { browserPasskeyBuildOnce } from "./lib/browserPasskeys";
import { bootAppMode } from "./lib/startupAppMode";
import {
  buildSiteViewOpenRequests,
  requestSiteViewCloseActive,
  subscribeSiteViewOpenRequests,
  unroutedSiteViewOpenRequestId,
  type SiteViewOpenRequest,
} from "./lib/siteView";
import { useScopedSelectAll } from "./lib/useScopedSelectAll";
import type { TerminalKind } from "./lib/terminal";
import {
  skillsListSkills,
  type SkillContextItem,
  type SkillDispatchRuntime,
  type SkillRecord,
  type TerminalDispatchSpec,
} from "./lib/skills";
import { activeTrackedAgentMissions, isTrackedAgentMission } from "./lib/skillRuns";
import {
  agentErrorMessage,
  inlineAgentRuntime,
  listAgents,
  requireAgent,
  runAgent,
  type AgentRecord,
} from "./lib/agents";
import type {
  DocumentPayload,
  FileQueueApplyOutcome,
  FileQueueItem,
  FileQueueSourceInfo,
  FileStoreOperation,
  GitStatus,
  KgNodeRef,
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
  ProviderAuthStatus,
  VaultEntry,
  WorkspaceFileEntry,
  WorkspaceMutationOutcome,
  WorkspaceRegistry,
  WorkspaceRootEntry,
  WorkspaceVisibility,
  WorkspaceWritePolicy,
} from "./lib/types";
import { ingestMissionUpdate, missionStoreLoadStamp, useTrackedMissions } from "./lib/useActiveMissions";
import { setError, useError } from "./lib/errorStore";
import { setTelegramMessages, setTelegramPolling, useTelegramPolling } from "./lib/telegramEventsStore";
import { useAiOutputLog } from "./lib/useAiOutputLog";
import { useDestructiveActionGuard } from "./lib/useDestructiveActionGuard";
import { useInboxEvents } from "./lib/useInboxEvents";
import { useTelegramEvents } from "./lib/useTelegramEvents";
import { useUpdaterToasts } from "./lib/useUpdaterToasts";
// App overlay/dialog UI state: external store (src/lib/appOverlayStore.ts).
// Openers write through the module actions; render sites read slices via the
// per-slice hooks, so dialogs re-render without touching MainApp state.
import {
  closeAddWorkspaceDialog,
  closeCommandPalette,
  closeCommitDialog,
  closeCompose,
  closeNewDocumentDialog,
  getAppOverlayStoreState,
  openAddWorkspaceDialog as openAddWorkspaceDialogStore,
  openCommandPalette,
  openCommitDialog,
  openCompose,
  openNewDocumentDialog as openNewDocumentDialogStore,
  openSettings,
  useAddWorkspaceDialog,
  useCommandPaletteOpen,
  useCommitDialog,
  useComposeSeed,
  useNewDocumentDialog,
  useSettingsOverlay,
  useSitesOverlayOpen,
} from "./lib/appOverlayStore";
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
  readWorkspaceM365AuthConfig,
  resolveClassifierRuntime,
  validateWorkspaceM365ProviderConfig,
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
  type FilesListAttribute,
  type FilesSortKey,
  type SortKey,
  type RightPaneTab,
  type RightWorkbenchSurface,
  type TerminalDock,
  type TerminalTheme,
  type ToolPanelSurface,
  type WorkspaceFileFilter,
  type WorkspaceVisibilitySetting,
} from "./lib/settings";
import {
  availableRightWorkbenchSurface,
  minimumWorkbenchWidth,
  resolveWorkbenchPlacement,
  shouldCloseRightSites,
} from "./lib/workbenchLayout";
import { useWorkspaceConfigLoad } from "./lib/useWorkspaceConfigLoad";
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
import {
  applyThemePreference,
  applyThemeVars,
  buildThemeVars,
  subscribeToSystemTheme,
} from "./lib/theme";
import {
  restoreMainWindowLayout,
  startWindowDrag,
  subscribeMainWindowLayout,
} from "./lib/windowLayout";
import { resolveWikilinkTarget } from "./lib/wikilinkSuggestions";
import {
  isCurrentWorkspaceFilesScanRequest,
  mergeFreshEntry,
  planVaultStartup,
  shouldLazyScanWorkspaceFiles,
  workspaceFileScanPaneMode,
  workspaceFilesScanStatusAfterFailure,
} from "./lib/vaultStartup";
// Workspace system: external store (src/lib/workspaceStore.ts). Slices
// subscribe via useSyncExternalStore; orchestrators read the current state at
// call time with getWorkspaceStoreState() instead of capturing it in deps.
import {
  EMPTY_WORKSPACE_FILES_STATE,
  EMPTY_WORKSPACE_STATE,
  activateWorkspace,
  getWorkspaceStoreState,
  pruneCustomDocumentFilters,
  removeWorkspaceState,
  rescanWorkspaceEntries,
  setCollapsedFileFoldersByVisibility,
  setCollapsedTreeFoldersByVisibility,
  setDocumentFilterByVisibility,
  setExplorerVisibility,
  setFileQueryByVisibility,
  setQueryByVisibility,
  setSelectedFilePathsByWorkspace,
  setWorkspaceRegistry,
  updateWorkspaceFileState,
  updateWorkspaceState,
  useCollapsedFileFoldersByVisibility,
  useCollapsedTreeFoldersByVisibility,
  useDocumentFilterByVisibility,
  useExplorerVisibility,
  useFileQueryByVisibility,
  useQueryByVisibility,
  useSelectedFilePathsByWorkspace,
  useVaultWatcherSync,
  useWorkspaceFileStates,
  useWorkspaceRegistry,
  useWorkspaceStates,
} from "./lib/workspaceStore";
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
  isOpenableDocumentFile,
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
const MIN_DOCUMENTS_PANE_WIDTH = 260;
const MAX_DOCUMENTS_PANE_WIDTH = 560;
const MIN_OUTLINE_PANE_WIDTH = 240;
const MAX_OUTLINE_PANE_WIDTH = 520;

const LazyGraphView = lazy(() => import("./components/graph/GraphView").then((module) => ({ default: module.GraphView })));
const LazyDiagramMode = lazy(() => import("./components/diagram/DiagramMode").then((module) => ({ default: module.DiagramMode })));
const LazyStudioMode = lazy(() => import("./components/studio/StudioMode").then((module) => ({ default: module.StudioMode })));
const LazyInboxPane = lazy(() => import("./components/InboxPane").then((module) => ({ default: module.InboxPane })));
const LazyDraftsPane = lazy(() => import("./components/drafts/DraftsPane").then((module) => ({ default: module.DraftsPane })));
const LazyGapPane = lazy(() => import("./components/gap/GapPane").then((module) => ({ default: module.GapPane })));
const LazyAgentsPane = lazy(() => import("./components/agents/AgentsPane").then((module) => ({ default: module.AgentsPane })));
const LazyCommsPane = lazy(() => import("./components/CommsPane").then((module) => ({ default: module.CommsPane })));
const LazyMeetingsPane = lazy(() => import("./components/meetings/MeetingsPane").then((module) => ({ default: module.MeetingsPane })));
const LazyTodayPane = lazy(() => import("./components/today/TodayPane").then((module) => ({ default: module.TodayPane })));
const LazyCatalogPane = lazy(() => import("./components/catalog/CatalogPane").then((module) => ({ default: module.CatalogPane })));
const LazySitesPane = lazy(() => import("./components/sites/SitesPane").then((module) => ({ default: module.SitesPane })));
const LazyE2EFlowPane = lazy(() => import("./components/e2e/E2EFlowPane").then((module) => ({ default: module.E2EFlowPane })));
const LazyFilesWorkbench = lazy(() =>
  import("./components/FilesWorkbench").then((module) => ({
    default: module.FilesWorkbench,
  })),
);
const LazySettingsSurface = lazy(() => import("./components/settings/SettingsSurface"));

type PendingExplorerReveal = {
  pane: ExplorerPaneMode;
  targetPath: string;
};

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

type AppMode = MaruAppMode;

interface ActivityModeButtonProps {
  label: string;
  active: boolean;
  secondaryActive?: boolean;
  icon: React.ReactNode;
  onOpenPrimary: () => void;
  onOpenRight?: () => void;
  openRightLabel?: string;
}

function ActivityModeButton({
  label,
  active,
  secondaryActive = false,
  icon,
  onOpenPrimary,
  onOpenRight,
  openRightLabel,
}: ActivityModeButtonProps) {
  return (
    <div className={secondaryActive ? "activity-item secondary-active" : "activity-item"}>
      <button
        type="button"
        className={active ? "activity-button active" : "activity-button"}
        onClick={(event) => {
          if (event.altKey && onOpenRight) onOpenRight();
          else onOpenPrimary();
        }}
        title={onOpenRight && openRightLabel ? `${label} · ${openRightLabel}` : label}
        aria-label={label}
      >
        {icon}
      </button>
      {onOpenRight ? (
        <button
          type="button"
          className="activity-open-right"
          onClick={onOpenRight}
          title={openRightLabel ?? label}
          aria-label={openRightLabel ?? label}
        >
          <PanelRightOpen size={11} />
        </button>
      ) : null}
    </div>
  );
}

interface InboxCarry {
  decision: InboxDecision;
  classification: InboxClassification | null;
  classifying: boolean;
  classifyError: string | null;
}

// Shared empty list so `?? NO_ENTRIES` keeps a stable identity: a fresh `[]`
// every render re-keys the graph model, tears the canvas down, and restarts
// FA2 on the rebuilt renderer — mid-flight camera math then lands wrong and,
// with settle re-fit disabled, stays wrong (graph.spec.ts:342 flake, and
// visible graph churn during a workspace scan).
const NO_ENTRIES: VaultEntry[] = [];
type KgReferenceSource = "editor" | "drafts" | "gap";

interface KgEditorTabContext {
  workspacePath: string;
  docPath: string;
}

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

function matchesActiveMission(record: MissionRecord): boolean {
  return record.status === "running" || record.status === "idle";
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

  const workspaceRegistry = useWorkspaceRegistry();
  const workspaceStates = useWorkspaceStates();
  const workspaceFileStates = useWorkspaceFileStates();
  const workspaceFileRequestSeqRef = useRef<Record<string, number>>({});
  const explorerVisibility = useExplorerVisibility();
  // Editor tab system: external store (src/lib/editorTabsStore.ts). Slices
  // subscribe via useSyncExternalStore; orchestrators read the current state
  // at call time with getEditorTabsState() instead of capturing it in deps.
  const tabs = useDocTabs();
  const binaryTabs = useBinaryTabs();
  const tabOrder = useTabOrder();
  const { activeTabId, leftActiveTabId, rightActiveTabId } = useActiveTabIds();
  const focusedEditorGroup = useFocusedEditorGroup();
  const [focusedWorkbenchSide, setFocusedWorkbenchSide] = useState<EditorGroupId>("left");
  const queryByVisibility = useQueryByVisibility();
  const fileQueryByVisibility = useFileQueryByVisibility();
  const documentFilterByVisibility = useDocumentFilterByVisibility();
  const collapsedTreeFoldersByVisibility = useCollapsedTreeFoldersByVisibility();
  const collapsedFileFoldersByVisibility = useCollapsedFileFoldersByVisibility();
  const selectedFilePathsByWorkspace = useSelectedFilePathsByWorkspace();
  const [fileQueue, setFileQueue] = useState<FileQueueItem[]>([]);
  const [selectedFileQueueItemIds, setSelectedFileQueueItemIds] = useState<string[]>([]);
  const [filesPaneFilters, setFilesPaneFilters] = useState<WorkspaceFilesPaneFilters>(
    EMPTY_WORKSPACE_FILES_PANE_FILTERS,
  );
  const [pendingExplorerReveal, setPendingExplorerReveal] = useState<PendingExplorerReveal | null>(
    null,
  );
  const [pendingOpenedSiteUrls, setPendingOpenedSiteUrls] = useState<SiteViewOpenRequest[]>([]);
  const nextOpenedSiteUrlIdRef = useRef(0);
  const routedOpenedSiteUrlIdRef = useRef(0);
  const [booting, setBooting] = useState(true);
  const [saving, setSaving] = useState(false);
  // Global error toast lives in the error store (step 9); setError is a
  // module action now, so every call site below keeps its old shape.
  const error = useError();
  // Overlay/dialog UI state lives in the app overlay store (step 9); these
  // per-slice hooks keep the same render-scope names MainApp had before.
  const newDocumentDialog = useNewDocumentDialog();
  const settingsOverlay = useSettingsOverlay();
  const commandPaletteOpen = useCommandPaletteOpen();
  const addWorkspaceDialog = useAddWorkspaceDialog();
  const [lastExportManifestPath, setLastExportManifestPath] = useState<string | null>(null);
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
  const collapsedTreeHydratedRef = useRef(false);
  const collapsedFileHydratedRef = useRef(false);
  const processedRequestSeqRef = useRef(0);
  const processedDetailRequestSeqRef = useRef(0);
  const processedItemsRef = useRef<InboxProcessedItem[]>([]);
  const processedItemsKeyRef = useRef("");
  const commsReadinessRequestSeqRef = useRef(0);
  const commsDashboardRequestSeqRef = useRef(0);
  const migrationCheckedRef = useRef(false);
  const processingMissionIdsRef = useRef<Set<string>>(new Set());
  const processingMissionsRef = useRef<MissionRecord[]>([]);
  const prevProcessingMissionsRef = useRef<MissionRecord[] | null>(null);
  const prevMissionLoadStampRef = useRef(missionStoreLoadStamp());

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
  const commitDialog = useCommitDialog();

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
  const [todayRefreshEpoch, setTodayRefreshEpoch] = useState(0);
  // Last logical day seen by the new-day watcher (boot seeds it too).
  const todayLogicalDayRef = useRef<string | null>(null);
  // Workspace whose boot auto-opened Today this launch. The settings-load
  // effect re-applies the persisted mode after boot (and again when `booting`
  // flips) — it must keep the auto-open decision instead of clobbering it.
  // Cleared on the first explicit user mode change.
  const todayAutoOpenPathRef = useRef<string | null>(null);
  // Fixed for the process lifetime; see bootAppMode for why the provisioned
  // browser-passkey build must land on Sites at launch.
  const browserPasskeyBuildRef = useRef(false);
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
  // KG reference visualization (kg_refs Phase 4). Session-local, on-demand:
  // nothing is computed until the user clicks the per-document triggers.
  const [kgRefFocus, setKgRefFocus] = useState<{
    source: "editor" | "drafts" | "gap";
    docPath: string;
    /** nodePaths are relative to this root, which is the document's workspace —
     *  the graph may be reading a nested vault/ instead. */
    docRoot: string;
    nodePaths: string[];
    /** Same references grouped by the paragraph that cites them, so the graph
     *  can walk the document instead of lighting everything up at once. */
    steps: KgRefStep[];
    nonce: number;
  } | null>(null);
  // Reference-focus requests are session-local but can outlive the editor
  // action that started them. Every new owner invalidates older requests so a
  // late editor response cannot overwrite a drafts/gap overlay or reopen the
  // graph panel after the user moved on.
  const kgRefRequestRef = useRef(0);
  const kgRefOwnerRef = useRef<KgReferenceSource | null>(null);
  const kgEditorTabsRef = useRef(new Map<string, KgEditorTabContext>());
  const kgActiveEditorRef = useRef<KgEditorTabContext | null>(null);
  const [kgHighlight, setKgHighlight] = useState<{
    docPath: string;
    refs: KgNodeRef[];
  } | null>(null);
  const [inboxDrops, setInboxDrops] = useState<InboxDropItem[]>([]);
  const [inboxEntries, setInboxEntries] = useState<InboxEntry[]>([]);
  const [inboxRuntimeConfig, setInboxRuntimeConfig] = useState<InboxRuntimeConfig>(
    DEFAULT_INBOX_RUNTIME_CONFIG,
  );
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxCarry, setInboxCarry] = useState<Map<string, InboxCarry>>(() => new Map());
  const [processedItems, setProcessedItems] = useState<InboxProcessedItem[]>([]);
  const [processedLoading, setProcessedLoading] = useState(false);
  const [processedRefreshing, setProcessedRefreshing] = useState(false);
  const [processedError, setProcessedError] = useState<string | null>(null);
  const [processedStatusFilter, setProcessedStatusFilter] =
    useState<InboxProcessedStatus | "all">("all");
  const [processedQuery, setProcessedQuery] = useState("");
  const [processedDeferredQuery, setProcessedDeferredQuery] = useState("");
  const [processedDetail, setProcessedDetail] = useState<InboxProcessedItemDetail | null>(null);
  // Tracked agent missions (skill + structured-loop) come from the shared
  // ai://mission_update store in lib/useActiveMissions — the same store
  // MissionBadge/AgentUsageBar use — instead of a second local listener.
  const processingMissions = useTrackedMissions();
  const [processingLogLines, setProcessingLogLines] = useState<Record<string, string[]>>({});
  // Per-source processing run state for the Messages dashboard.
  const [sourceRuns, setSourceRuns] = useState<InboxSourceRun[]>([]);
  const [processedCounts, setProcessedCounts] = useState<Record<string, number>>({});
  const [commsSourceFilter, setCommsSourceFilter] = useState<string | null>(null);
  const [commsAuthStatuses, setCommsAuthStatuses] = useState<
    Record<string, ProviderAuthStatus | null>
  >({});
  const [kakaoRelayStatus, setKakaoRelayStatus] = useState<KakaoRelayStatus | null>(null);
  const [commsRefreshing, setCommsRefreshing] = useState(false);

  // Provider accept/reject decisions are memory-only (kept for the bulk
  // inbox flow and a future comms list); writes go through gws/mws CLIs.
  const [, setGmailError] = useState<string | null>(null);
  const [gmailDecisions, setGmailDecisions] = useState<Map<string, InboxDecision>>(
    () => new Map(),
  );
  const [outlookDecisions, setOutlookDecisions] = useState<Map<string, InboxDecision>>(
    () => new Map(),
  );
  // Telegram messages/polling live in the telegram events store (step 9): the
  // listener hook writes them; refreshCommsDashboard and the polling toggles
  // write polling through the same store action names as before.
  const telegramPolling = useTelegramPolling();
  const [telegramDecisions, setTelegramDecisions] = useState<Map<string, InboxDecision>>(
    () => new Map(),
  );
  const [migrationServices, setMigrationServices] = useState<LegacyLaunchdService[]>([]);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [inboxSourceFilter, setInboxSourceFilter] = useState<string | null>(null);
  const [inboxFocusTick, setInboxFocusTick] = useState(0);
  const [inboxActionBusy, setInboxActionBusy] = useState(false);
  // App-update + skills-bundle toast state and flows live in the updater
  // toasts hook (step 9); the JSX below only reads the returned values.
  const { updateToast, installPendingUpdate, dismissUpdateToast, checkForUpdates } =
    useUpdaterToasts(t);
  const [terminalLaunchRequest, setTerminalLaunchRequest] =
    useState<TerminalLaunchRequest | null>(null);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  // Agent records back every AI feature's backend/permission/prompt choice.
  // Builtin seeds always resolve, so an empty list only ever means the registry
  // read failed; `requireAgent` turns that into a visible error at dispatch.
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const skillsStartupLoadKeyRef = useRef<string | null>(null);
  const composeSeed = useComposeSeed();
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
      claude:
        maruSettings.terminal.launchers.claude.command ??
        maruSettings.ai.commandOverrides.claude,
      codex:
        maruSettings.terminal.launchers.codex.command ??
        maruSettings.ai.commandOverrides.codex,
      kimi:
        maruSettings.terminal.launchers.kimi.command ??
        maruSettings.ai.commandOverrides.kimi,
      kiro:
        maruSettings.terminal.launchers.kiro.command ??
        maruSettings.ai.commandOverrides.kiro,
    }),
    [
      maruSettings.terminal.launchers.claude.command,
      maruSettings.terminal.launchers.codex.command,
      maruSettings.terminal.launchers.kimi.command,
      maruSettings.terminal.launchers.kiro.command,
      maruSettings.ai.commandOverrides.claude,
      maruSettings.ai.commandOverrides.codex,
      maruSettings.ai.commandOverrides.kimi,
      maruSettings.ai.commandOverrides.kiro,
    ],
  );
  const aiRuntimeCommands = useMemo<Partial<Record<SkillDispatchRuntime, string | null>>>(
    () => ({
      claude: maruSettings.ai.commandOverrides.claude,
      codex: maruSettings.ai.commandOverrides.codex,
      kimi: maruSettings.ai.commandOverrides.kimi,
      kiro: maruSettings.ai.commandOverrides.kiro,
    }),
    [
      maruSettings.ai.commandOverrides.claude,
      maruSettings.ai.commandOverrides.codex,
      maruSettings.ai.commandOverrides.kimi,
      maruSettings.ai.commandOverrides.kiro,
    ],
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
  const workspaceEntryNodes = explorerWorkspaceFilesState.nodes;
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
  // Resolve the provisioned-passkey build once and land on the browser surface
  // Apple requires at launch. The boot paths that apply the stored mode also
  // consult browserPasskeyBuildRef, so this only has to cover the case where
  // the signature check resolves after they already ran.
  useEffect(() => {
    let cancelled = false;
    void browserPasskeyBuildOnce().then((isPasskeyBuild) => {
      if (cancelled) return;
      browserPasskeyBuildRef.current = isPasskeyBuild;
      if (isPasskeyBuild) setAppMode("sites");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const viewIds = new Set(maruSettings.ui.documentViews.map((view) => view.id));
    pruneCustomDocumentFilters(viewIds);
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
  const explorerOpenDocumentPaths = useMemo(
    () =>
      explorerWorkspacePath
        ? tabs
            .filter((tab) => tab.workspacePath === explorerWorkspacePath)
            .map((tab) => tab.entry.path)
        : [],
    [explorerWorkspacePath, tabs],
  );
  const explorerDirtyDocumentPaths = useMemo(
    () =>
      explorerWorkspacePath
        ? tabs
            .filter(
              (tab) =>
                tab.workspacePath === explorerWorkspacePath &&
                tab.draftContent !== tab.document.content,
            )
            .map((tab) => tab.entry.path)
        : [],
    [explorerWorkspacePath, tabs],
  );
  const explorerWorkspaceCaps = useMemo(
    () => workspaceCapabilities(explorerWorkspace),
    [explorerWorkspace],
  );
  const unorderedAnyTabs = useMemo<AnyTab[]>(() => [...tabs, ...binaryTabs], [tabs, binaryTabs]);
  const orderedAnyTabs = useMemo(
    () => orderTabsById(unorderedAnyTabs, tabOrder),
    [tabOrder, unorderedAnyTabs],
  );
  const layoutSettings = maruSettings.ui.layout;
  const availableRightSurface = availableRightWorkbenchSurface(
    maruSettings.ui.rightWorkbenchSurface,
    { e2e: e2eFlowEnabled, diagram: diagramEnabled },
  );
  const workbenchPlacement = resolveWorkbenchPlacement({
    visibleAppMode,
    splitOpen: layoutSettings.editorSplitOpen,
    rightSurface: availableRightSurface,
    hasRightEditorTab: Boolean(rightActiveTabId),
  });
  const editorSplitOpen = workbenchPlacement.rightEditorOpen;
  const rightWorkbenchMode = workbenchPlacement.rightMode;
  const rightWorkbenchOpen = workbenchPlacement.rightOpen && rightWorkbenchMode !== null;
  const surfaceMode = rightWorkbenchMode ?? visibleAppMode;
  const panelGraphOpen =
    layoutSettings.terminalOpen && layoutSettings.toolPanelSurface === "graph";
  const editorViewMode = editorPaneViewModes[focusedEditorGroup];
  const firstTabId = orderedAnyTabs[0]?.id ?? null;
  const leftResolvedTabId = leftActiveTabId ?? activeTabId ?? firstTabId;
  const rightResolvedTabId =
    editorSplitOpen && rightActiveTabId
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
  kgEditorTabsRef.current = new Map(
    tabs.map((tab) => [
      tab.id,
      { workspacePath: tab.workspacePath, docPath: tab.document.relPath },
    ]),
  );
  kgActiveEditorRef.current = activeDocTab
    ? { workspacePath: activeDocTab.workspacePath, docPath: activeDocTab.document.relPath }
    : null;
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
      appMode: surfaceMode,
      docAbsPath: selectedEntry?.path ?? document?.path ?? null,
      docRelPath: selectedEntry?.relPath ?? null,
      docTitle: selectedEntry?.title ?? document?.title ?? null,
      docType: typeof frontmatterType === "string" ? frontmatterType : null,
    };
  }, [
    activeDocumentWorkspacePath,
    surfaceMode,
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
    paneMode: workspaceFileScanPaneMode({
      visibleAppMode: rightWorkbenchMode === "files" ? "files" : visibleAppMode,
      outlineOpen: layoutSettings.outlineOpen,
      rightPaneTab,
      explorerPaneMode: maruSettings.ui.explorerPaneMode,
    }),
    startupIoReady: explorerWorkspaceState.startupIoReady,
    scanStatus: explorerWorkspaceFilesState.scanStatus,
    loading: explorerWorkspaceFilesState.loading,
    refreshing: explorerWorkspaceFilesState.refreshing,
  });
  const primaryWorkspacePath =
    workspaceRegistry.activeByVisibility.private ??
    privateWorkspaces[0]?.path ??
    workspaceRegistry.activeByVisibility.public ??
    publicWorkspaces[0]?.path ??
    null;
  const primaryWorkspaceEntries = primaryWorkspacePath
    ? workspaceStates[primaryWorkspacePath]?.entries ?? NO_ENTRIES
    : NO_ENTRIES;
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
  const {
    state: workspaceConfigLoad,
    reload: reloadWorkspaceConfig,
  } = useWorkspaceConfigLoad(workspaceConfigPath, {
    validator: validateWorkspaceM365ProviderConfig,
  });
  const useDedicatedInboxConfig =
    Boolean(inboxWorkspacePath) && inboxWorkspacePath !== workspaceConfigPath;
  const {
    state: dedicatedInboxWorkspaceConfigLoad,
    reload: reloadDedicatedInboxWorkspaceConfig,
  } = useWorkspaceConfigLoad(inboxWorkspacePath, {
    enabled: useDedicatedInboxConfig,
    validator: validateWorkspaceM365ProviderConfig,
  });
  const inboxWorkspaceConfigLoad = useDedicatedInboxConfig
    ? dedicatedInboxWorkspaceConfigLoad
    : workspaceConfigLoad;
  const workspaceConfig =
    workspaceConfigLoad.status === "ready" ? workspaceConfigLoad.config : null;
  const inboxWorkspaceConfig =
    inboxWorkspaceConfigLoad.status === "ready"
      ? inboxWorkspaceConfigLoad.config
      : null;
  const inboxWorkspaceConfigReady =
    inboxWorkspaceConfigLoad.workPath === inboxWorkspacePath &&
    inboxWorkspaceConfigLoad.status === "ready";
  const retryInboxWorkspaceConfig = useCallback(
    () =>
      useDedicatedInboxConfig
        ? reloadDedicatedInboxWorkspaceConfig()
        : reloadWorkspaceConfig(),
    [
      reloadDedicatedInboxWorkspaceConfig,
      reloadWorkspaceConfig,
      useDedicatedInboxConfig,
    ],
  );
  const reportedInboxWorkspaceConfigErrorRef = useRef<string | null>(null);
  useEffect(() => {
    const configError =
      inboxWorkspaceConfigLoad.workPath === inboxWorkspacePath &&
      inboxWorkspaceConfigLoad.status === "error"
        ? inboxWorkspaceConfigLoad.error
        : null;
    if (configError) {
      reportedInboxWorkspaceConfigErrorRef.current = configError;
      setError(configError);
      return;
    }
    const previous = reportedInboxWorkspaceConfigErrorRef.current;
    if (previous) {
      reportedInboxWorkspaceConfigErrorRef.current = null;
      setError((current) => (current === previous ? null : current));
    }
  }, [
    inboxWorkspaceConfigLoad.error,
    inboxWorkspaceConfigLoad.status,
    inboxWorkspaceConfigLoad.workPath,
    inboxWorkspacePath,
  ]);
  const settingsWorkspaceStartupReady =
    !settingsWorkPath || Boolean(workspaceStates[settingsWorkPath]?.startupIoReady);
  const effectiveCommsSettings = useMemo(
    () => applyWorkspaceCommsOverrides(maruSettings.comms, inboxWorkspaceConfig),
    [inboxWorkspaceConfig, maruSettings.comms],
  );
  const workspaceM365AuthConfig = useMemo(
    () => readWorkspaceM365AuthConfig(inboxWorkspaceConfig),
    [inboxWorkspaceConfig],
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

  // Flush the live HTML WYSIWYG editor showing `tabId` (if any) so pending
  // iframe edits land in the draft before save/snapshot/close/mode-switch.
  // flushNow routes through onChange -> updateTabDraft (store action, sync);
  // returns the serialized content, or null when the tab is not mounted in a
  // visual HTML editor.
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
            bootAppMode({
              storedMode:
                todayAutoOpenPathRef.current === settingsWorkPath
                  ? "tasks"
                  : settings.ui.activeAppMode,
              browserPasskeyBuild: browserPasskeyBuildRef.current,
            }),
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
        if (!keepAutoOpenMode()) {
          setAppMode(
            bootAppMode({
              storedMode: next.ui.activeAppMode,
              browserPasskeyBuild: browserPasskeyBuildRef.current,
            }),
          );
        }
        setEditorPaneViewModes(next.ui.editorPaneViewModes);
        setRightPaneTab(next.ui.rightPaneTab);
      } else if (payload.globalChanged && settingsWorkPath) {
        void readMaruSettings(settingsWorkPath)
          .then((next) => {
            setMaruSettings(next);
            if (!keepAutoOpenMode()) {
              setAppMode(
                bootAppMode({
                  storedMode: next.ui.activeAppMode,
                  browserPasskeyBuild: browserPasskeyBuildRef.current,
                }),
              );
            }
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
    const apply = () => {
      applyThemePreference(maruSettings.ui.themeMode);
      applyThemeVars(buildThemeVars(maruSettings));
    };
    apply();
    return subscribeToSystemTheme(maruSettings.ui.themeMode, apply);
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

  const hasDirtyDrafts = useCallback(() => {
    // Flush live HTML WYSIWYG editors first; updateTabDraft publishes to the
    // store synchronously, so the dirty check below sees fresh iframe edits.
    leftHtmlFlushRef.current?.flushNow();
    rightHtmlFlushRef.current?.flushNow();
    return getEditorTabsState().tabs.some((tab) => tab.draftContent !== tab.document.content);
  }, []);

  // Dirty-draft guard behind window close and update relaunch: pending action
  // state, one-shot close replay, and the onCloseRequested subscription all
  // live in the guard hook now (settings flush semantics unchanged).
  const {
    pendingDestructiveAction,
    requestRelaunch,
    requestWindowClose,
    confirmDestructiveAction,
    cancelDestructiveAction,
  } = useDestructiveActionGuard({ hasDirtyDrafts, settingsSaverRef });

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
      updateLayoutSettings({ terminalOpen: true, toolPanelSurface: "terminal" });
    },
    [updateLayoutSettings],
  );

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen(SETTINGS_TERMINAL_LAUNCH_EVENT, (event) => {
          const payload = event.payload as SettingsTerminalLaunchPayload | null;
          if (!payload) return;
          setTerminalLaunchRequest({
            kind: "shell",
            nonce: Date.now(),
            title: "Provider Auth",
            cwd: payload.cwd,
            command: payload.command,
            extraArgs: payload.args,
          });
          updateLayoutSettingsRef.current({
            terminalOpen: true,
            toolPanelSurface: "terminal",
          });
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
    if (
      !maruSettings.ui.layout.terminalOpen ||
      maruSettings.ui.layout.toolPanelSurface !== "terminal"
    ) {
      updateLayoutSettings({ terminalOpen: true, toolPanelSurface: "terminal" });
    }
    return terminalPanelRef.current?.attachActiveItem() ?? false;
  }, [
    maruSettings.ui.layout.terminalOpen,
    maruSettings.ui.layout.toolPanelSurface,
    updateLayoutSettings,
  ]);

  const attachPathToTerminal = useCallback(
    (relPath: string | null, absPath: string | null) => {
      if (
        !maruSettings.ui.layout.terminalOpen ||
        maruSettings.ui.layout.toolPanelSurface !== "terminal"
      ) {
        updateLayoutSettings({ terminalOpen: true, toolPanelSurface: "terminal" });
      }
      return terminalPanelRef.current?.attachPath(relPath, absPath) ?? false;
    },
    [
      maruSettings.ui.layout.terminalOpen,
      maruSettings.ui.layout.toolPanelSurface,
      updateLayoutSettings,
    ],
  );

  const toggleAgentStatusHooks = useCallback(async () => {
    const workPath = activeDocumentWorkspacePath;
    const scope: "project" | "global" = workPath ? "project" : "global";
    try {
      const status = await terminalHooksStatus(workPath, scope);
      const allInstalled = status.claudeInstalled && status.kimiInstalled;
      const next = allInstalled
        ? await terminalHooksUninstall(workPath, scope)
        : await terminalHooksInstall(workPath, scope);
      const paths = [next.claudePath, next.kimiPath].join(", ");
      setError(
        next.claudeInstalled && next.kimiInstalled
          ? t("terminal.hooks.enabled", { paths })
          : t("terminal.hooks.disabled", { paths }),
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

  // Inline agent: git_generate_commit_message already takes a runtime and a
  // command override, so agentifying it is only a question of where those two
  // values come from.
  const commitMessageRuntime = useMemo(
    () => inlineAgentRuntime(agents, "commit-message", maruSettings.ai),
    [agents, maruSettings.ai],
  );

  const refreshAgents = useCallback(async () => {
    try {
      setAgents(await listAgents());
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshAgents();
  }, [refreshAgents]);

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
          explorerPaneMode:
            activeAppMode === "files"
              ? "files"
              : activeAppMode === "pkm"
                ? "documents"
                : current.ui.explorerPaneMode,
        },
      }));
    },
    [updateSettings],
  );

  const setPersistedRightWorkbenchSurface = useCallback(
    (rightWorkbenchSurface: RightWorkbenchSurface) => {
      updateSettings((current) => ({
        ...current,
        ui: { ...current.ui, rightWorkbenchSurface },
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
      // Full graph mode replaces a graph-surfaced tool panel (same rule as
      // openGraphWorkspace) so two canvases never show at once.
      if (layoutSettings.toolPanelSurface === "graph") {
        updateLayoutSettings({
          terminalOpen: false,
          toolPanelSurface: "terminal",
          terminalMaximized: false,
        });
      }
    },
    [layoutSettings.toolPanelSurface, updateSettings, updateLayoutSettings],
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

  useEffect(() => {
    if (maruSettings.ui.rightWorkbenchSurface === availableRightSurface) return;
    updateSettings((current) => ({
      ...current,
      ui: {
        ...current.ui,
        rightWorkbenchSurface: availableRightSurface,
        layout: { ...current.ui.layout, editorSplitOpen: false },
      },
    }));
  }, [availableRightSurface, maruSettings.ui.rightWorkbenchSurface, updateSettings]);

  const setPersistedEditorViewMode = useCallback(
    (editorViewMode: EditorViewModeSetting, group: EditorGroupId = focusedEditorGroup) => {
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
    [focusedEditorGroup, updateSettings],
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

  // Draft handoff into gap mode: the pane consumes it once on mount, so a
  // later rail-button revisit does not reselect the same draft.
  const [gapDraftId, setGapDraftId] = useState<string | null>(null);
  const openGapAnalysis = useCallback(
    (draftId?: string) => {
      setGapDraftId(draftId ?? null);
      setPersistedAppMode("gap");
    },
    [setPersistedAppMode],
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
    if (maruSettings.ui.documentTreeStateInitialized) {
      setCollapsedTreeFoldersByVisibility("private", maruSettings.ui.collapsedTreeFolders);
    }
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
    if (maruSettings.ui.fileTreeStateInitialized) {
      setCollapsedFileFoldersByVisibility("private", maruSettings.ui.collapsedFileFolders);
    }
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
    setCollapsedTreeFoldersByVisibility("private", collapsedFolders);
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
    if (explorerWorkspaceFilesState.scanStatus !== "ready") return;
    const collapsedFolders: string[] = [];
    setCollapsedFileFoldersByVisibility("private", collapsedFolders);
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
    explorerWorkspaceFilesState.scanStatus,
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

  const setDocumentSortKey = useCallback(
    (documentSortKey: SortKey) => {
      updateSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          documentSortKey,
        },
      }));
    },
    [updateSettings],
  );

  const setScratchpadSortKey = useCallback(
    (scratchpadSortKey: SortKey) => {
      updateSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          scratchpadSortKey,
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
      setCollapsedTreeFoldersByVisibility(explorerVisibility, paths);
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
      setCollapsedFileFoldersByVisibility(explorerVisibility, paths);
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
      startExplorerTransition(() => setQueryByVisibility(explorerVisibility, next));
    },
    [explorerVisibility, startExplorerTransition],
  );

  const setWorkspaceFileQuery = useCallback(
    (next: string) => {
      startExplorerTransition(() => setFileQueryByVisibility(explorerVisibility, next));
    },
    [explorerVisibility, startExplorerTransition],
  );

  const setExplorerDocumentFilter = useCallback(
    (next: DocumentFilter) => {
      startExplorerTransition(() => setDocumentFilterByVisibility(explorerVisibility, next));
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

  useEffect(() => {
    processingMissionIdsRef.current = new Set(processingMissions.map((mission) => mission.id));
    processingMissionsRef.current = processingMissions;
  }, [processingMissions]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setProcessedDeferredQuery(processedQuery.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [processedQuery]);

  useEffect(() => {
    processedDetailRequestSeqRef.current += 1;
    setProcessedDetail(null);
  }, [
    processedDeferredQuery,
    processedStatusFilter,
    commsSourceFilter,
    inboxSourceFilter,
  ]);

  useEffect(() => {
    processedRequestSeqRef.current += 1;
    processedDetailRequestSeqRef.current += 1;
    commsReadinessRequestSeqRef.current += 1;
    commsDashboardRequestSeqRef.current += 1;
    processedItemsRef.current = [];
    processedItemsKeyRef.current = "";
    setProcessedItems([]);
    setProcessedCounts({});
    setProcessedDetail(null);
    setProcessedError(null);
    setCommsRefreshing(false);
  }, [inboxWorkspacePath]);

  // Watcher bursts coalesce: a refresh requested while one is in flight
  // re-runs once after it lands, so the two scans never overlap and the
  // trailing event is not dropped. The guard refs outlive any single
  // useCallback closure, so each pass re-reads the scan inputs from
  // inboxScanInputRef: a requeue triggered by a workspace switch must scan
  // the new workspace, not the one captured when the loop started.
  const inboxRefreshInFlightRef = useRef(false);
  const inboxRefreshPendingRef = useRef(false);
  const inboxScanInputRef = useRef({ workspacePath: inboxWorkspacePath, scanOptions });
  const refreshInbox = useCallback(async () => {
    inboxScanInputRef.current = { workspacePath: inboxWorkspacePath, scanOptions };
    if (!inboxWorkspacePath && !inboxRefreshInFlightRef.current) {
      setInboxDrops([]);
      setInboxEntries([]);
      return;
    }
    if (inboxRefreshInFlightRef.current) {
      inboxRefreshPendingRef.current = true;
      return;
    }
    inboxRefreshInFlightRef.current = true;
    try {
      do {
        inboxRefreshPendingRef.current = false;
        const { workspacePath, scanOptions: options } = inboxScanInputRef.current;
        if (!workspacePath) {
          setInboxDrops([]);
          setInboxEntries([]);
          continue;
        }
        setInboxLoading(true);
        setError(null);
        try {
          const [drops, entries] = await Promise.all([
            scanInboxDrop(workspacePath, options),
            scanInboxEntries(workspacePath, options),
          ]);
          // The workspace may have switched mid-scan; a requeued pass is
          // already pending for the new one, so drop the stale results.
          if (inboxScanInputRef.current.workspacePath === workspacePath) {
            setInboxDrops(drops);
            setInboxEntries(entries);
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setInboxLoading(false);
        }
      } while (inboxRefreshPendingRef.current);
    } finally {
      inboxRefreshInFlightRef.current = false;
    }
  }, [inboxWorkspacePath, scanOptions]);

  const refreshProcessedItems = useCallback(async () => {
    const requestId = ++processedRequestSeqRef.current;
    if (!inboxWorkspacePath) {
      processedItemsRef.current = [];
      processedItemsKeyRef.current = "";
      setProcessedItems([]);
      setProcessedCounts({});
      setProcessedDetail(null);
      setProcessedLoading(false);
      setProcessedRefreshing(false);
      return;
    }
    const statuses =
      processedStatusFilter === "all"
        ? (["done", "failed", "duplicate"] as InboxProcessedStatus[])
        : [processedStatusFilter];
    const channel =
      surfaceMode === "comms"
        ? commsSourceFilter
        : surfaceMode === "inbox"
          ? inboxSourceFilter
          : null;
    const requestKey = JSON.stringify([
      inboxWorkspacePath,
      channel,
      statuses,
      processedDeferredQuery,
    ]);
    const sameQuery = processedItemsKeyRef.current === requestKey;
    if (!sameQuery) {
      processedItemsRef.current = [];
      setProcessedItems([]);
      setProcessedDetail(null);
    }
    const hasLastGood = sameQuery && processedItemsRef.current.length > 0;
    setProcessedLoading(!hasLastGood);
    setProcessedRefreshing(hasLastGood);
    setProcessedError(null);
    try {
      const request = {
        workPath: inboxWorkspacePath,
        channel,
        statuses,
        query: processedDeferredQuery || null,
        limit: 120,
      };
      const snapshot =
        surfaceMode === "comms"
          ? await scanInboxProcessedSnapshot(request)
          : {
              items: await scanInboxProcessedItems(request),
              counts: null,
            };
      if (requestId !== processedRequestSeqRef.current) return;
      const { items } = snapshot;
      processedItemsRef.current = items;
      processedItemsKeyRef.current = requestKey;
      setProcessedItems(items);
      if (snapshot.counts) setProcessedCounts(snapshot.counts);
      setProcessedDetail((current) =>
        current && items.some((item) => item.itemDir === current.item.itemDir)
          ? current
          : null,
      );
    } catch (err) {
      if (requestId !== processedRequestSeqRef.current) return;
      setProcessedError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === processedRequestSeqRef.current) {
        setProcessedLoading(false);
        setProcessedRefreshing(false);
      }
    }
  }, [
    surfaceMode,
    commsSourceFilter,
    inboxSourceFilter,
    inboxWorkspacePath,
    processedDeferredQuery,
    processedStatusFilter,
  ]);

  const refreshSourceRuns = useCallback(async () => {
    if (!inboxWorkspacePath) {
      setSourceRuns([]);
      return;
    }
    try {
      const runs = await readInboxSourceRuns(inboxWorkspacePath);
      setSourceRuns(runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [inboxWorkspacePath]);

  const refreshCommsReadiness = useCallback(async () => {
    const requestId = ++commsReadinessRequestSeqRef.current;
    if (!inboxWorkspacePath) {
      setCommsAuthStatuses({});
      setKakaoRelayStatus(null);
      return;
    }
    const checks: Array<Promise<ProviderAuthStatus>> = [];
    if (inboxRuntimeConfig.gmail?.enabled !== false) {
      checks.push(checkGwsAuth(inboxWorkspacePath));
    }
    if (inboxWorkspaceConfigReady && effectiveCommsSettings.outlook.enabled) {
      checks.push(
        checkMsoAuth(
          inboxWorkspacePath,
          effectiveCommsSettings.outlook.m365Path,
        ).catch(
          (err): ProviderAuthStatus => ({
            provider: "mso",
            state: "error",
            detail: err instanceof Error ? err.message : String(err),
            cliPath: effectiveCommsSettings.outlook.m365Path,
            account: null,
          }),
        ),
      );
    }
    if (effectiveCommsSettings.telegram.enabled) {
      checks.push(
        checkTelegramAuth(
          telegramFetchOptions(
            inboxWorkspacePath,
            effectiveCommsSettings.telegram,
          ),
        ),
      );
    }
    const kakaoRelayCheck = readKakaoRelayStatus(inboxWorkspacePath).catch(() => null);
    checks.push(
      kakaoRelayCheck.then(
        (relay): ProviderAuthStatus =>
          relay
            ? kakaoRelayAuthStatus(relay)
            : {
                provider: "kakao",
                state: "cli_missing",
                detail: null,
                cliPath: null,
                account: null,
              },
      ),
    );
    const results = await Promise.allSettled(checks);
    const kakaoRelay = await kakaoRelayCheck;
    if (requestId !== commsReadinessRequestSeqRef.current) return;
    setKakaoRelayStatus(kakaoRelay);
    const statuses: Record<string, ProviderAuthStatus | null> = {};
    for (const result of results) {
      if (result.status === "fulfilled") {
        statuses[result.value.provider] = result.value;
      }
    }
    setCommsAuthStatuses(statuses);
  }, [
    effectiveCommsSettings.outlook,
    effectiveCommsSettings.telegram,
    inboxRuntimeConfig.gmail?.enabled,
    inboxWorkspaceConfigReady,
    inboxWorkspacePath,
  ]);

  const selectProcessedItem = useCallback(
    async (item: InboxProcessedItem) => {
      if (!inboxWorkspacePath) return;
      const requestId = ++processedDetailRequestSeqRef.current;
      setProcessedError(null);
      try {
        const detail = await readInboxProcessedItem(inboxWorkspacePath, item.itemDir);
        if (requestId !== processedDetailRequestSeqRef.current) return;
        setProcessedDetail(detail);
      } catch (err) {
        if (requestId !== processedDetailRequestSeqRef.current) return;
        setProcessedError(err instanceof Error ? err.message : String(err));
      }
    },
    [inboxWorkspacePath],
  );

  // Log tails only — the mission list itself streams from the shared
  // ai://mission_update store (useTrackedMissions), so there is nothing to
  // re-list here.
  const refreshProcessingMissions = useCallback(async () => {
    try {
      const missions = processingMissionsRef.current;
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
      // Mission log tails are a secondary diagnostic surface.
    }
  }, []);

  const refreshCommsDashboard = useCallback(async (
    options: { retryWorkspaceConfig?: boolean } = {},
  ) => {
    const requestId = ++commsDashboardRequestSeqRef.current;
    setCommsRefreshing(true);
    try {
      if (options.retryWorkspaceConfig) {
        await retryInboxWorkspaceConfig();
      }
      const polling = telegramPollingStatus()
        .then((status) => {
          if (requestId === commsDashboardRequestSeqRef.current) {
            setTelegramPolling(status);
          }
        })
        .catch(() => {});
      const migration = isMac
        ? detectLegacyTelegramLaunchd()
            .then((services) => {
              if (requestId === commsDashboardRequestSeqRef.current) {
                setMigrationServices(services);
                migrationCheckedRef.current = true;
              }
            })
            .catch(() => {})
        : Promise.resolve().then(() => {
            if (requestId === commsDashboardRequestSeqRef.current) {
              setMigrationServices([]);
            }
          });
      await Promise.allSettled([
        refreshCommsReadiness(),
        refreshSourceRuns(),
        refreshProcessingMissions(),
        polling,
        migration,
      ]);
    } finally {
      if (requestId === commsDashboardRequestSeqRef.current) {
        setCommsRefreshing(false);
      }
    }
  }, [
    isMac,
    refreshCommsReadiness,
    refreshProcessingMissions,
    refreshSourceRuns,
    retryInboxWorkspaceConfig,
  ]);

  // Latest-callback ref so the comms-mode effect below re-runs only on mode or
  // workspace changes — not every time a filter recreates the dashboard
  // callback (which would re-subscribe the telegram listener and re-run the
  // provider auth CLI checks on each keystroke).
  const refreshCommsDashboardRef = useRef(refreshCommsDashboard);
  useEffect(() => {
    refreshCommsDashboardRef.current = refreshCommsDashboard;
  }, [refreshCommsDashboard]);

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
        setError(agentErrorMessage(err, t));
      } finally {
        setInboxActionBusy(false);
      }
    },
    [approvalGate, inboxWorkspacePath, refreshInbox, targetFolderForInboxItem, updateInboxCarry, t],
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
        const invocationId = await runAgent(requireAgent(agents, "inbox-triage"), {
          skills,
          ai: maruSettings.ai,
          workPath: inboxWorkspacePath,
          prompt,
          context,
          metadata: {
            origin: "inboxProcess",
            channel: channels[0] ?? "incoming",
            channels,
            reviewFlow,
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
      agents,
      inboxEntries,
      inboxRuntimeConfig,
      inboxWorkspacePath,
      refreshProcessingMissions,
      maruSettings.ai,
      skills,
    ],
  );

  const processCommsChannelNow = useCallback(
    async (channel: string) => {
      if (!inboxWorkspacePath) return;
      if (channel === "mso" && !inboxWorkspaceConfigReady) return;
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
        } else if (channel === "kakao") {
          // Dry-run first (copies nothing, does not advance the relay
          // cursor) so the approval preview reflects exactly what a real
          // stage would write. A declined approval leaves nothing behind,
          // and the next run shows the same preview.
          const preview = await stageKakaoRelayNew(inboxWorkspacePath, true, null);
          if (preview.stagedMessages + preview.stagedMedia > 0) {
            const approvalId = await approvalGate.confirmApproval({
              kind: "kakao.stage",
              summary: t("comms.kakao.stage.summary"),
              target: "inbox/drop/kakao",
              payloadPreview: Object.entries(preview.perRoom)
                .map(([room, count]) =>
                  t("comms.kakao.stage.previewLine", { room, count: count.staged }),
                )
                .join("\n"),
            });
            if (!approvalId) return;
            const staged = await stageKakaoRelayNew(inboxWorkspacePath, false, approvalId);
            if (staged.errors.length > 0) {
              throw new Error(staged.errors.join("\n"));
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
      inboxWorkspaceConfigReady,
      inboxWorkspacePath,
      processInboxKeys,
      refreshInbox,
      t,
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
        ingestMissionUpdate(record);
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

  /** Same tracking, no banner: a successful start is not an error. */
  const trackMissionQuietly = useCallback(
    (invocationId: string) => {
      processingMissionIdsRef.current = new Set([
        ...processingMissionIdsRef.current,
        invocationId,
      ]);
      setProcessingLogLines((current) => ({ ...current, [invocationId]: [] }));
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
        // Inline agent: classification is a typed request/response under a hard
        // timeout, not a tracked mission, so only the backend comes from the
        // record. `ai.classifierRuntime` remains the fallback when the registry
        // could not be read.
        const { runtime, commandOverride, enabled } = inlineAgentRuntime(
          agents,
          "inbox-classify",
          { ...maruSettings.ai, defaultRuntime: resolveClassifierRuntime(maruSettings.ai) },
        );
        // Switching the agent off has to stop the feature, not silently keep
        // spawning a CLI. Inline features have no mission for runAgent to refuse.
        if (!enabled) throw new Error("agent_disabled: inbox-classify");
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
          commandOverride,
          maruSettings.ai.permissionMode,
          contextEnv,
        );
        updateInboxCarry(id, { classifying: false, classification });
      } catch (err) {
        updateInboxCarry(id, {
          classifying: false,
          classifyError: agentErrorMessage(err, t),
        });
      }
    },
    [
      agents,
      maruSettings.ai,
      maruSettings.terminal.injectActiveContext,
      explorerVisibility,
      inboxDrops,
      inboxWorkspacePath,
      scratchpadRoot,
      updateInboxCarry,
    ],
  );

  // Event subscriptions extracted in step 9: inbox runtime config + notify
  // watcher, the telegram comms mirror, and the ai://output log tail live in
  // dedicated hooks now, with the same gating and handler bodies.
  useInboxEvents({
    inboxWorkspacePath,
    surfaceModeInbox: surfaceMode === "inbox",
    refreshInbox,
    refreshProcessedItems,
    setInboxRuntimeConfig,
    setInboxSourceFilter,
    setInboxDrops,
    setInboxEntries,
  });
  useTelegramEvents({
    enabled:
      surfaceMode === "comms" &&
      inboxWorkspaceConfigLoad.status !== "idle" &&
      inboxWorkspaceConfigLoad.status !== "pending",
    configStatus: inboxWorkspaceConfigLoad.status,
    inboxWorkspacePath,
    refreshCommsDashboardRef,
  });
  useAiOutputLog(processingMissionIdsRef, setProcessingLogLines);

  useEffect(() => {
    // In comms this is also the filter/search refetch path: the callback
    // identity changes with the query and channel, re-running this effect.
    if (surfaceMode === "inbox" || surfaceMode === "comms") void refreshProcessedItems();
    if (!booting && settingsWorkspaceStartupReady && (
      surfaceMode === "inbox" ||
      surfaceMode === "meetings" ||
      surfaceMode === "tasks" ||
      rightPaneTab === "skills"
    )) {
      void refreshProcessingMissions();
    }
  }, [
    surfaceMode,
    booting,
    refreshProcessedItems,
    refreshProcessingMissions,
    rightPaneTab,
    settingsWorkspaceStartupReady,
  ]);

  // Mission-completion side effects. These used to live in App's own
  // ai://mission_update listener; the shared store (useTrackedMissions) owns
  // that subscription now, so this diffs the tracked list against the previous
  // render and fires the same calls on the same transitions. A record only
  // changes identity when the store ingested an event for it — except when the
  // store ingests a whole listAiMissions snapshot (initial subscribe, webview
  // reload, StrictMode re-subscribe): every record in it is freshly
  // deserialized, so a load-stamp change resets the baseline instead of
  // replaying up to MAX_TRACKED log reads for missions that finished long ago.
  // The old listener reacted to events only and never to a listed snapshot.
  useEffect(() => {
    const previous = prevProcessingMissionsRef.current;
    prevProcessingMissionsRef.current = processingMissions;
    const loadStamp = missionStoreLoadStamp();
    const snapshotReloaded = loadStamp !== prevMissionLoadStampRef.current;
    prevMissionLoadStampRef.current = loadStamp;
    if (previous === null || snapshotReloaded || previous === processingMissions) return;
    const previousById = new Map(previous.map((mission) => [mission.id, mission]));
    for (const record of processingMissions) {
      if (previousById.get(record.id) === record) continue;
      const inboxMission = isInboxProcessMission(record);
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
    }
  }, [processingMissions, refreshProcessedItems, refreshSourceRuns]);

  const refreshWorkspaceFiles = useCallback(
    async (path: string, initial = false) => {
      const requestSeq = (workspaceFileRequestSeqRef.current[path] ?? 0) + 1;
      workspaceFileRequestSeqRef.current[path] = requestSeq;
      updateWorkspaceFileState(path, initial ? { loading: true } : { refreshing: true });
      try {
        const snapshot = await scanWorkspaceEntries(path, scanOptions);
        if (
          !isCurrentWorkspaceFilesScanRequest(
            workspaceFileRequestSeqRef.current,
            path,
            requestSeq,
          )
        ) {
          return;
        }
        const files = snapshot.entries
          .filter(
            (entry) =>
              entry.kind === "file" ||
              (entry.kind === "symlink" && entry.targetKind === "file"),
          )
          .map((entry) => ({
            path: entry.path,
            relPath: entry.relPath,
            name: entry.name,
            extension: entry.extension,
            fileKind: entry.fileKind,
            sizeBytes: entry.sizeBytes,
            updatedAt: entry.updatedAt,
            gitTracked: entry.gitTracked,
            binary: entry.binary,
          }));
        updateWorkspaceFileState(path, {
          entries: files,
          nodes: snapshot.entries,
          scanStatus: "ready",
          loading: false,
          refreshing: false,
        });
      } catch (err) {
        if (
          !isCurrentWorkspaceFilesScanRequest(
            workspaceFileRequestSeqRef.current,
            path,
            requestSeq,
          )
        ) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        const previous = getWorkspaceStoreState().fileStates[path] ?? EMPTY_WORKSPACE_FILES_STATE;
        updateWorkspaceFileState(path, {
          scanStatus: workspaceFilesScanStatusAfterFailure(previous.scanStatus),
          loading: false,
          refreshing: false,
        });
      }
    },
    [scanOptions],
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
          resetWorkspaceTabs(path);
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
        const storedTabIdsFor = (loadedTabs: EditorTab[]) => {
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
          return {
            leftActiveTabId: leftId,
            rightActiveTabId: rightId,
            focusedEditorGroup: focusedGroup,
          };
        };
        restoreWorkspaceTabs(path, primaryTab, storedTabIdsFor([primaryTab]));
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
            appendRestoredDocTabs(nextTabs, storedTabIdsFor([primaryTab, ...nextTabs]));
          })();
        }

        return true;
      };

      // The rescan already published the entries; this only merges them into
      // the open tabs of this workspace.
      const mergeFreshEntries = (fresh: VaultEntry[]) => {
        mapDocTabs((tab) => (tab.workspacePath === path ? mergeFreshEntry(tab, fresh) : tab));
      };

      const runAuthoritativeScan = async (paintAfterScan: boolean) => {
        if (!paintAfterScan) updateWorkspaceState(path, { refreshing: true });
        try {
          const scanned = await measureStartup(
            "vault:authoritative-scan",
            () => rescanWorkspaceEntries(path, scanOptions),
            { path, paintAfterScan },
          );
          if (requestId !== loadWorkspaceRequestRef.current) return;
          // A watcher delta (or a newer rescan) superseded this response; the
          // store already holds the freshest entries for this path, so keep
          // the load lifecycle moving with those.
          const fresh = scanned ?? getWorkspaceStoreState().states[path]?.entries ?? [];
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
    [pushRecent, readStoredTabsForWorkspace, scanOptions, updateWorkspaceState],
  );

  const switchActiveWorkspace = useCallback(
    async (path: string, visibility: WorkspaceVisibility) => {
      try {
        const registry = await setActiveWorkspaceRoot(path, visibility);
        activateWorkspace(registry, visibility);
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
            activateWorkspace(seeded, "private");
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
              setAppMode(
                bootAppMode({
                  storedMode: bootSettings.ui.activeAppMode,
                  browserPasskeyBuild: browserPasskeyBuildRef.current,
                }),
              );
            }
            setEditorPaneViewModes(bootSettings.ui.editorPaneViewModes);
            setRightPaneTab(bootSettings.ui.rightPaneTab);
          } catch {
            bootSettings = null;
          }
        }
        const initialVisibility = initialStartupVisibility(registry, bootSettings);
        activateWorkspace(registry, initialVisibility);
        const initialPath =
          registry.activeByVisibility[initialVisibility] ??
          registry.workspaces.find((workspace) => workspace.visibility === initialVisibility)?.path ??
          null;
        if (initialPath) {
          // Maru Today: first-eligible-launch auto-open. Best-effort — any
          // failure falls back to the normal persisted-mode restore above.
          // A `?window=settings` deep link seeds the settings overlay at
          // mount (this effect closes over the initial value), and explicit
          // navigation wins without probing Today at all.
          const todaySettings = bootSettings?.tasks.today;
          if (
            settingsOverlay === null &&
            todaySettings?.enabled &&
            todaySettings.autoOpenFirstDailyLaunch
          ) {
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
                  // mechanism other than the settings-overlay seed, which is
                  // already handled by skipping this block entirely.
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
      activateWorkspace(registry, entry.visibility);
      await loadWorkspace(entry.path, entry.visibility);
    },
    [loadWorkspace],
  );

  const handleRegisterWorkspace = useCallback(
    async (workPath: string) => {
      const outcome = await registerWorkspaceRoots(workPath);
      activateWorkspace(outcome.workspaceRegistry, "private");
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
      removeWorkspaceState(path);
      removeWorkspaceDocTabs(path);
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
    openNewDocumentDialogStore(
      seededDocType || fromLibrary
        ? { title: "", relPath: null, docType: seededDocType ?? null, openLibrary: fromLibrary }
        : null,
    );
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

      const existingTab = getEditorTabsState().tabs.find(
        (tab) => tab.workspacePath === workspacePath && tab.entry.path === entry.path,
      );
      const isSameEntry = selectedEntry?.path === entry.path;
      const targetGroup =
        requestedGroup ?? (editorSplitOpen ? getEditorTabsState().focusedEditorGroup : "left");
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
        insertDocTab(newTab, { activate: true, group: targetGroup });
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
      editorSplitOpen,
      lastOpenKeyForWorkspace,
      pushRecent,
      selectedEntry,
      t,
      workspaceRegistry.workspaces,
    ],
  );

  const setWorkspaceFileSelection = useCallback(
    (paths: string[]) => {
      if (!explorerWorkspacePath) return;
      setSelectedFilePathsByWorkspace(explorerWorkspacePath, paths);
    },
    [explorerWorkspacePath],
  );

  const openBinaryWorkspaceFile = useCallback(
    (entry: WorkspaceFileEntry, workspacePath: string, visibility: WorkspaceVisibility) => {
      const tabId = tabIdForWorkspaceFile(entry);
      const existing = getEditorTabsState().binaryTabs.find((tab) => tab.id === tabId);
      const targetGroup = editorSplitOpen ? getEditorTabsState().focusedEditorGroup : "left";
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
          insertBinaryTab(newTab, { activate: true, group: targetGroup });
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [
      binaryViewerClassify,
      binaryViewerPrepareAsset,
      editorSplitOpen,
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
        return workspaceFileState.scanStatus === "ready";
      }
      const prefix = `${relPath}/`;
      if (docEntries.some((entry) => entry.relPath.startsWith(prefix))) return false;
      if (knownFiles.some((entry) => entry.relPath.startsWith(prefix))) return false;
      return workspaceFileState.scanStatus === "ready";
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
        setPersistedAppMode("files");
        setExplorerVisibility(visibility);
        try {
          // Read at call time: the scan may have completed while the async
          // gap above was in flight.
          if (getWorkspaceStoreState().fileStates[workspacePath]?.scanStatus !== "ready") {
            await refreshWorkspaceFiles(workspacePath, true);
          }
          setWorkspaceFileFilter("all");
          setFileQueryByVisibility(visibility, "");
          setFilesPaneFilters(EMPTY_WORKSPACE_FILES_PANE_FILTERS);
          setPendingExplorerReveal({ pane: "files", targetPath });
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [
      explorerVisibility,
      explorerWorkspacePath,
      refreshWorkspaceFiles,
      setPersistedAppMode,
      setWorkspaceFileFilter,
      settingsWorkPath,
      workspaceRegistry.workspaces,
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
      openCompose({
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
    closeCompose();
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
      // The backend composed all selected context into this provider argv.
      // Prepending the terminal's active-context flags would also put Codex
      // --add-dir before its /bin/zsh -lc wrapper and break the command.
      prependContextArgs: false,
    });
    updateLayoutSettings({ terminalOpen: true, toolPanelSurface: "terminal" });
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
      if (visibleAppMode !== "files") {
        setPersistedAppMode("pkm");
        if (!outlineOpen) updateLayoutSettings({ outlineOpen: true });
      }
      setPersistedRightPaneTab("files");
    },
    [
      maruSettings.ui.fileQueueDefaultOperation,
      outlineOpen,
      setPersistedAppMode,
      setPersistedRightPaneTab,
      updateLayoutSettings,
      visibleAppMode,
    ],
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
        await rescanWorkspaceEntries(workspacePath, scanOptions);
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
      insertDocTab(restoredTab, { activate: true, group: "left" });
      setExplorerVisibility(restoredTab.visibility);
      setPendingSelectedPath(null);
      setDiscardedEdit(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [discardedEdit]);

  const saveTab = useCallback(async (tabId: string | null) => {
    const flushed = tabId ? flushHtmlDraft(tabId) : null;
    const target = getEditorTabsState().tabs.find((tab) => tab.id === tabId);
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
      const fresh = await rescanWorkspaceEntries(target.workspacePath, scanOptions);
      void refreshWorkspaceFiles(target.workspacePath);
      mapDocTabs((tab) => {
        if (tab.id !== target.id) return tab;
        const freshEntry = fresh?.find((entry) => entry.path === tab.entry.path) ?? tab.entry;
        return { ...tab, entry: freshEntry, document: saved, draftContent: saved.content };
      });
      setGitRefreshTick((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [
    t,
    flushHtmlDraft,
    refreshWorkspaceFiles,
    scanOptions,
    workspaceRegistry.workspaces,
  ]);

  const saveCurrent = useCallback(async () => {
    await saveTab(resolvedActiveTabId);
  }, [resolvedActiveTabId, saveTab]);

  const snapshotTab = useCallback(async (tabId: string | null) => {
    const flushed = tabId ? flushHtmlDraft(tabId) : null;
    const target = getEditorTabsState().tabs.find((tab) => tab.id === tabId);
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
      const fresh = await rescanWorkspaceEntries(target.workspacePath, scanOptions);
      void refreshWorkspaceFiles(target.workspacePath);
      mapDocTabs((tab) => {
        if (tab.id !== target.id) return tab;
        const freshEntry = fresh?.find((entry) => entry.path === tab.entry.path) ?? tab.entry;
        return { ...tab, entry: freshEntry };
      });
      setError(t("snapshot.success", { path: snapshot.relPath }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [
    t,
    flushHtmlDraft,
    refreshWorkspaceFiles,
    scanOptions,
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
      const fresh = await rescanWorkspaceEntries(activeDocumentWorkspacePath, scanOptions);
      void refreshWorkspaceFiles(activeDocumentWorkspacePath);
      const entry =
        fresh?.find((item) => item.relPath === created.relPath || item.path === created.path) ??
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
      insertDocTab(newTab, { activate: true, group: "left" });
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
      const fresh = await rescanWorkspaceEntries(workspacePath, scanOptions);
      void refreshWorkspaceFiles(workspacePath);
      mapDocTabs((tab) => {
        if (tab.document.path !== payload.path) return tab;
        const entry = fresh?.find((item) => item.path === payload.path) ?? tab.entry;
        return {
          ...tab,
          entry,
          document: payload,
          draftContent: payload.content,
        };
      });
      return payload;
    },
    [refreshWorkspaceFiles, scanOptions],
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
        openNewDocumentDialogStore({
          title: titleFromWikilinkTarget(target),
          relPath: target.trim(),
        });
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
        const fresh = await rescanWorkspaceEntries(activeDocumentWorkspacePath, scanOptions);
        void refreshWorkspaceFiles(activeDocumentWorkspacePath);
        mapDocTabs((tab) => {
          if (tab.id !== resolvedActiveTabId) return tab;
          const freshEntry = fresh?.find((entry) => entry.path === tab.entry.path) ?? tab.entry;
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
      resolvedActiveTabId,
      blockWorkspaceWrite,
      refreshWorkspaceFiles,
      scanOptions,
    ],
  );

  const refreshCurrent = useCallback(async () => {
    if (!explorerWorkspacePath) return;
    if (visibleAppMode === "files") {
      await refreshWorkspaceFiles(explorerWorkspacePath);
      return;
    }
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
    refreshWorkspaceFiles,
    visibleAppMode,
  ]);

  // Both scans read `.maruignore`, and the document list and the file tree
  // are loaded independently — refreshing only the active one leaves the
  // other showing a row the user just hid.
  const refreshAfterIgnoreChange = useCallback(async () => {
    if (!explorerWorkspacePath) return;
    await refreshCurrent();
    if (
      visibleAppMode !== "files" &&
      explorerWorkspaceFilesState.scanStatus === "ready"
    ) {
      await refreshWorkspaceFiles(explorerWorkspacePath);
    }
  }, [
    explorerWorkspaceFilesState.scanStatus,
    explorerWorkspacePath,
    refreshCurrent,
    refreshWorkspaceFiles,
    visibleAppMode,
  ]);

  // The scan honours `.maruignore`, so an edit in Settings > Ignore list
  // leaves every loaded list stale until we rescan.
  useEffect(() => {
    let dispose: (() => void) | null = null;
    void listenMaruIgnoreUpdated((payload) => {
      if (payload.workPath === explorerWorkspacePath) void refreshAfterIgnoreChange();
    }).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
  }, [explorerWorkspacePath, refreshAfterIgnoreChange]);

  // "Hide from the list" is an edit to `.maruignore`: the scan reads that
  // file, so the rescan is what actually drops the row. Settings > Ignore list
  // is where it comes back.
  const ignoreEntry = useCallback(
    async (relPath: string) => {
      if (!explorerWorkspacePath || !relPath) return;
      try {
        await addMaruIgnorePattern(explorerWorkspacePath, relPath);
        await refreshAfterIgnoreChange();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [explorerWorkspacePath, refreshAfterIgnoreChange],
  );

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
  // Paused while the settings overlay is up — a `?window=settings` deep link
  // session then records no Today probes at all.
  useEffect(() => {
    const workPath = inboxWorkspacePath;
    const todaySettings = effectiveTasksSettings.today;
    if (!workPath || !todaySettings.enabled || settingsOverlay !== null) return;
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
  }, [inboxWorkspacePath, effectiveTasksSettings, settingsOverlay, t]);

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

  const openAddWorkspaceDialog = useCallback((visibility: WorkspaceVisibility = explorerVisibility) => {
    openAddWorkspaceDialogStore(visibility);
  }, [explorerVisibility]);

  const openPreferences = useCallback(() => {
    openSettings();
  }, []);

  const openInboxSettings = useCallback(() => {
    openSettings("inbox-channels");
  }, []);

  const openCommsSettings = useCallback(() => {
    openSettings("comms");
  }, []);

  const openMeetingsSettings = useCallback(() => {
    openSettings("meetings");
  }, []);

  const openTasksSettings = useCallback(() => {
    openSettings("tasks");
  }, []);

  const startTelegramPollingFromSettings = useCallback(() => {
    if (!inboxWorkspacePath) return;
    void startTelegramPolling(
      telegramFetchOptions(inboxWorkspacePath, effectiveCommsSettings.telegram),
      effectiveCommsSettings.telegram.intervalSeconds,
    )
      .then(setTelegramPolling)
      // Polling status failures had a dedicated state once; nothing renders
      // it anymore, so start/stop failures stay silent (unchanged behavior).
      .catch(() => {});
  }, [effectiveCommsSettings.telegram, inboxWorkspacePath]);

  const stopTelegramPollingFromSettings = useCallback(() => {
    void stopTelegramPolling()
      .then(setTelegramPolling)
      .catch(() => {});
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
    updateLayoutSettings({ terminalOpen: true, toolPanelSurface: "terminal" });
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
    updateLayoutSettings({ terminalOpen: true, toolPanelSurface: "terminal" });
  }, [inboxRuntimeConfig.gmail?.gws_path, inboxWorkspacePath, updateLayoutSettings]);

  const startMsoLogin = useCallback(() => {
    if (!inboxWorkspaceConfigReady) return;
    const command = m365LoginCommand(
      effectiveCommsSettings.outlook.m365Path,
      workspaceM365AuthConfig,
    );
    setTerminalLaunchRequest({
      kind: "shell",
      nonce: Date.now(),
      title: "Outlook Auth",
      cwd: inboxWorkspacePath,
      command: command.command,
      extraArgs: command.args,
    });
    updateLayoutSettings({ terminalOpen: true, toolPanelSurface: "terminal" });
  }, [
    effectiveCommsSettings.outlook.m365Path,
    inboxWorkspaceConfigReady,
    inboxWorkspacePath,
    updateLayoutSettings,
    workspaceM365AuthConfig,
  ]);

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

  const unloadMigrationServices = useCallback(
    async (plistPaths: string[]) => {
      if (!isMac || plistPaths.length === 0) return;
      setMigrationBusy(true);
      const failures: string[] = [];
      try {
        for (const plistPath of plistPaths) {
          try {
            await unloadLegacyTelegramLaunchd(plistPath);
          } catch (err) {
            failures.push(
              `${plistPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        const remaining = await detectLegacyTelegramLaunchd();
        setMigrationServices(remaining);
        if (failures.length > 0) {
          setError(
            t("comms.migration.partialFailure", {
              count: failures.length,
              details: failures.join("\n"),
            }),
          );
        }
      } finally {
        setMigrationBusy(false);
      }
    },
    [isMac, t],
  );

  const toggleLocale = useCallback(() => {
    setLocale(locale === "ko" ? "en" : "ko");
  }, [locale, setLocale]);

  const refreshActiveSurface = useCallback(() => {
    if (surfaceMode === "inbox") {
      void refreshInbox();
      void refreshProcessedItems();
      void refreshProcessingMissions();
    } else if (surfaceMode === "comms") {
      void refreshCommsDashboard({ retryWorkspaceConfig: true });
      void refreshProcessedItems();
    } else if (surfaceMode === "meetings") {
      void refreshProcessingMissions();
    } else if (surfaceMode === "tasks") {
      setTodayRefreshEpoch((epoch) => epoch + 1);
      void refreshProcessingMissions();
    } else if (surfaceMode === "files" && explorerWorkspacePath) {
      void refreshWorkspaceFiles(explorerWorkspacePath);
    } else {
      void refreshCurrent();
    }
  }, [
    surfaceMode,
    explorerWorkspacePath,
    refreshCurrent,
    refreshCommsDashboard,
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
    (tabId: string, group?: EditorGroupId) => {
      const { tabs: docTabs, binaryTabs: binTabs } = getEditorTabsState();
      const docTab = docTabs.find((item) => item.id === tabId);
      if (docTab) {
        activateEditorTab(tabId, group);
        setExplorerVisibility(docTab.visibility);
        pushRecent(docTab.entry.path);
        return;
      }
      const binaryTab = binTabs.find((item) => item.id === tabId);
      if (!binaryTab) return;
      activateEditorTab(tabId, group);
      setExplorerVisibility(binaryTab.visibility);
    },
    [pushRecent],
  );

  const copyTextToClipboard = useCallback((value: string) => {
    void navigator.clipboard.writeText(value).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  const refreshAfterDocumentMutation = useCallback(
    async (workspacePath: string): Promise<VaultEntry[] | null> => {
      const fresh = await rescanWorkspaceEntries(workspacePath, scanOptions);
      await refreshWorkspaceFiles(workspacePath);
      setGitRefreshTick((n) => n + 1);
      return fresh;
    },
    [refreshWorkspaceFiles, scanOptions],
  );

  const entryFromPayload = useCallback(
    (
      payload: DocumentPayload,
      freshEntries: VaultEntry[] | null,
      fallback: VaultEntry,
    ): VaultEntry =>
      (freshEntries ?? []).find((entry) => entry.path === payload.path || entry.relPath === payload.relPath) ??
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
      transformTabs({
        mapDocTab: (tab) =>
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
        mapTabId: (id) => (id === oldTab.id ? nextId : id),
      });
      pushRecent(entry.path);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(lastOpenKeyForWorkspace(oldTab.workspacePath), entry.relPath);
      }
    },
    [pushRecent, lastOpenKeyForWorkspace],
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
        const dirtyTab = getEditorTabsState().tabs.find(
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
      for (const tab of getEditorTabsState().tabs) {
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
      const replacements = new Map(
        Array.from(movedByTabId.entries()).map(([tabId, moved]) => [tabId, moved.nextId]),
      );
      transformTabs({
        mapDocTab: (tab) => {
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
        },
        mapTabId: (id) => replacements.get(id) ?? id,
      });
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
      updateLayoutSettings,
      workspaceRegistry.workspaces,
    ],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const state = getEditorTabsState();
      if (!orderedTabsInState(state).some((tab) => tab.id === tabId)) return;
      const flushed = flushHtmlDraft(tabId);
      const closing = state.tabs.find((tab) => tab.id === tabId);
      const closingDraft = closing ? (flushed ?? closing.draftContent) : null;
      if (closing && closingDraft !== null && closingDraft !== closing.document.content) {
        setDiscardedEdit({
          workspacePath: closing.workspacePath,
          visibility: closing.visibility,
          entry: closing.entry,
          draft: closingDraft,
        });
      }
      const { rightClosed } = closeTabs(
        [tabId],
        { leftResolvedTabId, rightResolvedTabId, resolvedActiveTabId },
        { resetFocusOnRightClose: true },
      );
      if (rightClosed) updateLayoutSettings({ editorSplitOpen: false });
    },
    [
      flushHtmlDraft,
      leftResolvedTabId,
      resolvedActiveTabId,
      rightResolvedTabId,
      updateLayoutSettings,
    ],
  );

  const closeTabsByIds = useCallback(
    (tabIds: string[], postIds?: EditorTabIdsPatch) => {
      const closeSet = new Set(tabIds);
      if (closeSet.size === 0) return;
      let dirtyClosing: { tab: EditorTab; draft: string } | null = null;
      for (const tab of getEditorTabsState().tabs) {
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
      const { rightClosed } = closeTabs(
        tabIds,
        { leftResolvedTabId, rightResolvedTabId, resolvedActiveTabId },
        postIds ? { postIds } : undefined,
      );
      if (rightClosed) updateLayoutSettings({ editorSplitOpen: false });
    },
    [
      flushHtmlDraft,
      leftResolvedTabId,
      resolvedActiveTabId,
      rightResolvedTabId,
      updateLayoutSettings,
    ],
  );

  const handleFilesFilesystemMutated = useCallback(
    (
      outcomes: WorkspaceMutationOutcome[],
      effect: "refresh" | "move" | "trash",
    ) => {
      const completed = outcomes.filter(
        (outcome) => outcome.status === "done" && outcome.sourcePath,
      );
      if (effect === "trash") {
        const sources = completed.map((outcome) => outcome.sourcePath as string);
        const affectedIds = orderedTabsInState(getEditorTabsState())
          .filter((tab) => {
            const path = isBinaryTab(tab) ? tab.fileEntry.path : tab.entry.path;
            return sources.some(
              (source) => path === source || path.startsWith(`${source}/`),
            );
          })
          .map((tab) => tab.id);
        closeTabsByIds(affectedIds);
      } else if (effect === "move") {
        const mappings = completed
          .filter((outcome) => outcome.targetPath)
          .map((outcome) => ({
            source: outcome.sourcePath as string,
            target: outcome.targetPath as string,
          }))
          .sort((a, b) => b.source.length - a.source.length);
        const remapPath = (path: string) => {
          const mapping = mappings.find(
            (item) => path === item.source || path.startsWith(`${item.source}/`),
          );
          if (!mapping) return path;
          return `${mapping.target}${path.slice(mapping.source.length)}`;
        };
        const remapId = (id: string) => {
          if (id.startsWith("binary:")) {
            return `binary:${remapPath(id.slice("binary:".length))}`;
          }
          return remapPath(id);
        };
        const remapEditorTab = (tab: EditorTab): EditorTab => {
          const path = remapPath(tab.entry.path);
          if (path === tab.entry.path) return tab;
          const relPath = path
            .slice(tab.workspacePath.replace(/\/+$/, "").length)
            .replace(/^\/+/, "");
          return {
            ...tab,
            id: path,
            entry: { ...tab.entry, path, relPath },
            document: { ...tab.document, path, relPath },
          };
        };
        transformTabs({
          mapDocTab: remapEditorTab,
          mapBinaryTab: (tab) => {
            const path = remapPath(tab.fileEntry.path);
            if (path === tab.fileEntry.path) return tab;
            const relPath = path
              .slice(tab.workspacePath.replace(/\/+$/, "").length)
              .replace(/^\/+/, "");
            return {
              ...tab,
              id: `binary:${path}`,
              fileEntry: { ...tab.fileEntry, path, relPath },
            };
          },
          mapTabId: remapId,
        });
      }

      if (!explorerWorkspacePath) return;
      void (async () => {
        await refreshWorkspaceFiles(explorerWorkspacePath);
        try {
          await rescanWorkspaceEntries(explorerWorkspacePath, scanOptions);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [
      closeTabsByIds,
      explorerWorkspacePath,
      refreshWorkspaceFiles,
      scanOptions,
    ],
  );

  const closeOtherTabs = useCallback(
    (tabId: string) => {
      const ordered = orderedTabsInState(getEditorTabsState());
      if (!ordered.some((tab) => tab.id === tabId)) return;
      closeTabsByIds(tabIdsToCloseOthers(ordered, tabId), {
        leftActiveTabId: tabId,
        rightActiveTabId: null,
        activeTabId: tabId,
        focusedEditorGroup: "left",
      });
      updateLayoutSettings({ editorSplitOpen: false });
    },
    [closeTabsByIds, updateLayoutSettings],
  );

  const closeTabsToRight = useCallback(
    (tabId: string) => {
      closeTabsByIds(tabIdsToCloseRight(orderedTabsInState(getEditorTabsState()), tabId));
    },
    [closeTabsByIds],
  );

  const closeSavedTabs = useCallback(() => {
    const summaries = orderedTabsInState(getEditorTabsState()).map((tab) => {
      if (isBinaryTab(tab)) return { id: tab.id, dirty: false };
      return {
        id: tab.id,
        dirty: tab.draftContent !== tab.document.content,
      };
    });
    closeTabsByIds(tabIdsToCloseSaved(summaries));
  }, [closeTabsByIds]);

  const copyTabName = useCallback(
    (tabId: string) => {
      const { tabs: docTabs, binaryTabs: binTabs } = getEditorTabsState();
      const docTab = docTabs.find((item) => item.id === tabId);
      if (docTab) {
        copyTextToClipboard(
          documentDisplayName(docTab.document, maruSettings.ui.documentLabelMode),
        );
        return;
      }
      const binaryTab = binTabs.find((item) => item.id === tabId);
      if (binaryTab) copyTextToClipboard(binaryTab.fileEntry.name);
    },
    [maruSettings.ui.documentLabelMode, copyTextToClipboard],
  );

  const copyTabPath = useCallback(
    (tabId: string) => {
      const { tabs: docTabs, binaryTabs: binTabs } = getEditorTabsState();
      const docTab = docTabs.find((item) => item.id === tabId);
      if (docTab) {
        copyTextToClipboard(docTab.document.path);
        return;
      }
      const binaryTab = binTabs.find((item) => item.id === tabId);
      if (binaryTab) copyTextToClipboard(binaryTab.fileEntry.path);
    },
    [copyTextToClipboard],
  );

  const copyTabRelativePath = useCallback(
    (tabId: string) => {
      const { tabs: docTabs, binaryTabs: binTabs } = getEditorTabsState();
      const docTab = docTabs.find((item) => item.id === tabId);
      if (docTab) {
        copyTextToClipboard(docTab.document.relPath);
        return;
      }
      const binaryTab = binTabs.find((item) => item.id === tabId);
      if (binaryTab) copyTextToClipboard(binaryTab.fileEntry.relPath);
    },
    [copyTextToClipboard],
  );

  const renameTabDocument = useCallback(
    async (tabId: string) => {
      const tab = getEditorTabsState().tabs.find((item) => item.id === tabId);
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
    ],
  );

  const moveTabDocument = useCallback(
    async (tabId: string) => {
      const tab = getEditorTabsState().tabs.find((item) => item.id === tabId);
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
    ],
  );

  const duplicateTabDocument = useCallback(
    async (tabId: string) => {
      const tab = getEditorTabsState().tabs.find((item) => item.id === tabId);
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
        insertDocTab(newTab, { activate: true, group: "left" });
        setExplorerVisibility(tab.visibility);
        setPendingSelectedPath(null);
        pushRecent(entry.path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      blockTabWrite,
      entryFromPayload,
      pushRecent,
      refreshAfterDocumentMutation,
    ],
  );

  const trashTabDocument = useCallback(
    async (tabId: string) => {
      const tab = getEditorTabsState().tabs.find((item) => item.id === tabId);
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
    [blockTabWrite, closeTab, refreshAfterDocumentMutation, t],
  );

  const revealTabInFinder = useCallback(
    (tabId: string) => {
      const { tabs: docTabs, binaryTabs: binTabs } = getEditorTabsState();
      const docTab = docTabs.find((item) => item.id === tabId);
      if (docTab) {
        revealTargetInFinder(docTab.document.path);
        return;
      }
      const binaryTab = binTabs.find((item) => item.id === tabId);
      if (binaryTab) revealTargetInFinder(binaryTab.fileEntry.path);
    },
    [revealTargetInFinder],
  );

  const revealPathInFiles = useCallback(
    (
      workspacePath: string,
      visibility: WorkspaceVisibility,
      targetPath: string,
    ) => {
      setPersistedAppMode("files");
      setExplorerVisibility(visibility);
      setWorkspaceFileFilter("all");
      setFileQueryByVisibility(visibility, "");
      setFilesPaneFilters(EMPTY_WORKSPACE_FILES_PANE_FILTERS);
      setSelectedFilePathsByWorkspace(workspacePath, [targetPath]);
      setPendingExplorerReveal({ pane: "files", targetPath });
      void refreshWorkspaceFiles(workspacePath);
    },
    [
      refreshWorkspaceFiles,
      setPersistedAppMode,
      setWorkspaceFileFilter,
    ],
  );

  const revealTabInExplorer = useCallback(
    (tabId: string, group: EditorGroupId) => {
      const { tabs: docTabs, binaryTabs: binTabs } = getEditorTabsState();
      const docTab = docTabs.find((item) => item.id === tabId) ?? null;
      const binaryTab = docTab ? null : binTabs.find((item) => item.id === tabId) ?? null;
      if (!docTab && !binaryTab) return;
      const visibility = docTab?.visibility ?? binaryTab!.visibility;
      const workspacePath = docTab?.workspacePath ?? binaryTab!.workspacePath;
      const relPath = docTab?.entry.relPath ?? binaryTab!.fileEntry.relPath;
      const targetPath = docTab?.document.path ?? binaryTab!.fileEntry.path;
      setExplorerVisibility(visibility);
      if (docTab) {
        setPersistedAppMode("pkm");
        if (!documentsPaneOpen) updateLayoutSettings({ documentsPaneOpen: true });
        setDocumentBrowserMode("tree");
        setExplorerQuery("");
        setExplorerDocumentFilter({ kind: "all" });
        const existing =
          getWorkspaceStoreState().collapsedTreeFoldersByVisibility[visibility] ?? [];
        setCollapsedTreeFoldersByVisibility(
          visibility,
          expandDocumentAncestors(existing, relPath),
        );
      } else {
        revealPathInFiles(workspacePath, visibility, targetPath);
      }
      selectTab(tabId, group);
      setPendingExplorerReveal({ pane: binaryTab ? "files" : "documents", targetPath });
    },
    [
      documentsPaneOpen,
      revealPathInFiles,
      selectTab,
      setDocumentBrowserMode,
      setExplorerQuery,
      setExplorerDocumentFilter,
      setPersistedAppMode,
      updateLayoutSettings,
    ],
  );

  const closeRightEditorPane = useCallback(() => {
    patchEditorIds({
      rightActiveTabId: null,
      focusedEditorGroup: "left",
      ...(leftResolvedTabId ? { activeTabId: leftResolvedTabId } : {}),
    });
    setFocusedWorkbenchSide("left");
    updateLayoutSettings({ editorSplitOpen: false });
  }, [leftResolvedTabId, updateLayoutSettings]);

  const closeActiveSurface = useCallback(() => {
    const terminalPanel = terminalPanelRef.current;
    if (terminalPanel?.hasFocus()) {
      terminalPanel.closeFocusedSurface();
      return;
    }
    if (visibleAppMode === "sites") {
      requestSiteViewCloseActive();
      return;
    }
    if (visibleAppMode !== "pkm") return;
    // A native Sites child webview cannot report focus into this DOM. Its
    // webview owns Cmd+W when the right side was explicitly focused or the
    // main webview lost focus; live left-side DOM focus still closes the doc.
    if (
      shouldCloseRightSites({
        rightWorkbenchMode,
        focusedWorkbenchSide,
        documentHasFocus: globalThis.document.hasFocus(),
      })
    ) {
      requestSiteViewCloseActive();
      return;
    }
    if (rightWorkbenchMode && focusedWorkbenchSide === "right") {
      setFocusedWorkbenchSide("left");
      patchEditorIds({
        focusedEditorGroup: "left",
        ...(leftResolvedTabId ? { activeTabId: leftResolvedTabId } : {}),
      });
      updateLayoutSettings({ editorSplitOpen: false });
      return;
    }
    if (focusedEditorGroup === "right" && rightResolvedTabId) {
      closeRightEditorPane();
      return;
    }
    if (leftResolvedTabId) closeTab(leftResolvedTabId);
  }, [
    visibleAppMode,
    closeRightEditorPane,
    closeTab,
    focusedEditorGroup,
    focusedWorkbenchSide,
    leftResolvedTabId,
    rightWorkbenchMode,
    rightResolvedTabId,
    updateLayoutSettings,
  ]);

  const closeAllCleanTabs = useCallback(() => {
    const dirtyTabs = orderedTabsInState(getEditorTabsState()).filter(
      (tab): tab is EditorTab =>
        !isBinaryTab(tab) && tab.draftContent !== tab.document.content,
    );
    const fallback = dirtyTabs[0]?.id ?? null;
    replaceAllDocTabs(dirtyTabs, {
      activeTabId: fallback,
      leftActiveTabId: fallback,
      rightActiveTabId: null,
      focusedEditorGroup: "left",
    });
    updateLayoutSettings({ editorSplitOpen: false });
    if (dirtyTabs.length > 0) {
      setError(t("editor.tabs.closeAll.dirtyKept", { count: dirtyTabs.length }));
    }
  }, [t, updateLayoutSettings]);

  const splitEditorRight = useCallback(() => {
    const state = getEditorTabsState();
    const { leftResolvedTabId: leftId, resolvedActiveTabId: activeId } = resolveEditorTabIds(
      state,
      editorSplitOpen,
    );
    const findTab = (id: string | null): AnyTab | null =>
      id
        ? state.tabs.find((tab) => tab.id === id) ??
          state.binaryTabs.find((tab) => tab.id === id) ??
          null
        : null;
    const target = findTab(activeId) ?? findTab(leftId) ?? orderedTabsInState(state)[0] ?? null;
    if (!target) return;
    setPersistedRightWorkbenchSurface("editor");
    patchEditorIds({
      rightActiveTabId: target.id,
      activeTabId: target.id,
      focusedEditorGroup: "right",
    });
    setFocusedWorkbenchSide("right");
    updateLayoutSettings({
      editorSplitOpen: true,
    });
  }, [
    editorSplitOpen,
    setPersistedRightWorkbenchSurface,
    updateLayoutSettings,
  ]);

  const openSourcePreviewSplit = useCallback(() => {
    const state = getEditorTabsState();
    const { leftResolvedTabId: leftId, resolvedActiveTabId: activeId } = resolveEditorTabIds(
      state,
      editorSplitOpen,
    );
    const findTab = (id: string | null): AnyTab | null =>
      id
        ? state.tabs.find((tab) => tab.id === id) ??
          state.binaryTabs.find((tab) => tab.id === id) ??
          null
        : null;
    const target = findTab(activeId) ?? findTab(leftId) ?? orderedTabsInState(state)[0] ?? null;
    if (!target || isBinaryTab(target)) return;
    const kind = target.document.fileKind.toLowerCase();
    if (kind !== "md" && kind !== "markdown") return;
    setPersistedRightWorkbenchSurface("editor");
    patchEditorIds({
      rightActiveTabId: target.id,
      leftActiveTabId: target.id,
      activeTabId: target.id,
      focusedEditorGroup: "left",
    });
    setFocusedWorkbenchSide("left");
    setEditorPaneViewModes({ left: "source", right: "preview" });
    updateSettings((current) => ({
      ...current,
      ui: {
        ...current.ui,
        editorViewMode: "source",
        editorPaneViewModes: { left: "source", right: "preview" },
      },
    }));
    updateLayoutSettings({ editorSplitOpen: true });
  }, [
    editorSplitOpen,
    setPersistedRightWorkbenchSurface,
    updateLayoutSettings,
    updateSettings,
  ]);

  const openGraphPanel = useCallback(
    (rawTarget?: GraphOpenTarget) => {
      // Reject non-target values (e.g. a MouseEvent when passed as an onClick
      // handler directly) so a plain toolbar click never rewrites graph.source.
      const target =
        rawTarget && typeof rawTarget.source === "string" && rawTarget.localTarget
          ? rawTarget
          : null;
      setGraphOpenTarget(target);
      setPersistedAppMode("pkm");
      updateLayoutSettings({
        terminalOpen: true,
        toolPanelSurface: "graph",
        terminalMaximized: false,
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

  // --- KG reference visualization (kg_refs Phase 4) -------------------------

  // Feature A trigger: map the document's references, then open the doc↔graph
  // split (graph in the tool panel) in reference-focus mode.
  const visualizeDocRefs = useCallback(
    (tab: EditorTab) => {
      const request = ++kgRefRequestRef.current;
      kgRefOwnerRef.current = "editor";
      const tabContext: KgEditorTabContext = {
        workspacePath: tab.workspacePath,
        docPath: tab.document.relPath,
      };
      const activeEditorAtRequest = kgActiveEditorRef.current;
      const isCurrentRequest = () => {
        const currentTab = kgEditorTabsRef.current.get(tab.id);
        const currentActiveEditor = kgActiveEditorRef.current;
        return (
          request === kgRefRequestRef.current &&
          kgRefOwnerRef.current === "editor" &&
          currentTab?.workspacePath === tabContext.workspacePath &&
          currentTab?.docPath === tabContext.docPath &&
          currentActiveEditor?.workspacePath === activeEditorAtRequest?.workspacePath &&
          currentActiveEditor?.docPath === activeEditorAtRequest?.docPath
        );
      };
      void kgDocumentRefs(tab.workspacePath, tab.document.relPath)
        .then((map) => {
          if (!isCurrentRequest()) return;
          setKgRefFocus({
            source: "editor",
            docPath: map.docPath,
            docRoot: tab.workspacePath,
            nodePaths: uniqueRefNodePaths(map.refs),
            steps: refStepsByParagraph(map.refs),
            nonce: Date.now(),
          });
          // The ownership/request checks above also guard the panel opener:
          // a late editor result must not resurrect the graph after drafts or
          // gap analysis became the active reference-focus owner.
          openGraphPanel();
        })
        .catch((err: unknown) => {
          if (isCurrentRequest()) {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
    },
    [openGraphPanel],
  );

  // Feature B toggle: per-document, session-local; the backend cache makes
  // repeat toggles cheap.
  const toggleKgHighlight = useCallback(
    (tab: EditorTab) => {
      if (kgHighlight?.docPath === tab.document.relPath) {
        setKgHighlight(null);
        return;
      }
      void kgDocumentRefs(tab.workspacePath, tab.document.relPath)
        .then((map) => setKgHighlight({ docPath: map.docPath, refs: map.refs }))
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : String(err)),
        );
    },
    [kgHighlight],
  );

  // Leaving the document exits both modes (both are per-document).
  const kgActiveDocPath = document?.relPath ?? null;
  useEffect(() => {
    if (kgHighlight && kgHighlight.docPath !== kgActiveDocPath) setKgHighlight(null);
    if (kgRefOwnerRef.current === "editor") {
      kgRefRequestRef.current += 1;
      kgRefOwnerRef.current = null;
    }
    if (
      kgRefFocus?.source === "editor" &&
      kgRefFocus.docPath !== kgActiveDocPath
    ) {
      setKgRefFocus(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocumentWorkspacePath, kgActiveDocPath]);

  const exitKgReferenceFocus = useCallback(() => {
    kgRefRequestRef.current += 1;
    kgRefOwnerRef.current = null;
    setKgRefFocus(null);
  }, []);
  const openDraftGraphFocus = useCallback(
    (request: DraftGraphFocusRequest, source: "drafts" | "gap") => {
      if (!primaryWorkspacePath || request.nodePaths.length === 0) return;
      kgRefRequestRef.current += 1;
      kgRefOwnerRef.current = source;
      setKgRefFocus({
        source,
        docPath: request.docPath,
        docRoot: primaryWorkspacePath,
        nodePaths: request.nodePaths,
        steps: [{ paragraph: 0, nodePaths: request.nodePaths }],
        nonce: Date.now(),
      });
      // Keep graph/workbench mutual exclusion and panel placement in the one
      // existing opener used by editor reference visualization.
      openGraphPanel();
    },
    [openGraphPanel, primaryWorkspacePath],
  );
  const openDraftsGraphFocus = useCallback(
    (request: DraftGraphFocusRequest) => openDraftGraphFocus(request, "drafts"),
    [openDraftGraphFocus],
  );
  const openGapGraphFocus = useCallback(
    (request: DraftGraphFocusRequest) => openDraftGraphFocus(request, "gap"),
    [openDraftGraphFocus],
  );

  const openGraphWorkspace = useCallback(() => {
    setPersistedAppMode("graph");
    if (layoutSettings.toolPanelSurface === "graph") {
      updateLayoutSettings({
        terminalOpen: false,
        toolPanelSurface: "terminal",
        terminalMaximized: false,
      });
    }
  }, [
    layoutSettings.toolPanelSurface,
    setPersistedAppMode,
    updateLayoutSettings,
  ]);

  const openPrimaryWorkbenchMode = useCallback(
    (mode: Exclude<AppMode, "pkm">) => {
      updateLayoutSettings({ editorSplitOpen: false });
      setFocusedWorkbenchSide("left");
      switch (mode) {
        case "inbox":
          openInboxAndFocus();
          break;
        case "comms":
          openComms();
          break;
        case "meetings":
          openMeetings();
          break;
        case "tasks":
          openTasks();
          break;
        case "sites":
          openSites();
          break;
        case "gap":
          openGapAnalysis();
          break;
        case "graph":
          openGraphWorkspace();
          break;
        default:
          setPersistedAppMode(mode);
      }
    },
    [
      openComms,
      openGapAnalysis,
      openGraphWorkspace,
      openInboxAndFocus,
      openMeetings,
      openSites,
      openTasks,
      setPersistedAppMode,
      updateLayoutSettings,
    ],
  );

  const openWorkbenchModeRight = useCallback(
    (mode: Exclude<AppMode, "pkm">) => {
      if (mode === "inbox") setInboxFocusTick((value) => value + 1);
      if (mode === "tasks") setTodayRoute("all");
      if (mode === "gap") setGapDraftId(null);
      if (mode === "graph" && layoutSettings.toolPanelSurface === "graph") {
        updateLayoutSettings({
          terminalOpen: false,
          terminalMaximized: false,
          toolPanelSurface: "terminal",
        });
      }
      setPersistedAppMode("pkm");
      setPersistedRightWorkbenchSurface(mode);
      setFocusedWorkbenchSide("right");
      updateLayoutSettings({ editorSplitOpen: true });
    },
    [
      layoutSettings.toolPanelSurface,
      setPersistedAppMode,
      setPersistedRightWorkbenchSurface,
      updateLayoutSettings,
    ],
  );

  const enqueueOpenedSiteUrls = useCallback((urls: unknown) => {
    const batch = buildSiteViewOpenRequests(urls, nextOpenedSiteUrlIdRef.current);
    nextOpenedSiteUrlIdRef.current = batch.nextId;
    if (batch.requests.length > 0) {
      setPendingOpenedSiteUrls((current) => [...current, ...batch.requests]);
    }
  }, []);

  const acknowledgeOpenedSiteUrls = useCallback((handledIds: readonly number[]) => {
    const handled = new Set(handledIds);
    setPendingOpenedSiteUrls((current) => current.filter((request) => !handled.has(request.id)));
  }, []);

  // The subscription installs its native listener before draining the cold
  // queue and returns synchronous cleanup, so effect teardown cannot consume
  // and discard a URL while an async listener promise is still resolving.
  useEffect(() => {
    if (booting) return;
    return subscribeSiteViewOpenRequests(enqueueOpenedSiteUrls);
  }, [booting, enqueueOpenedSiteUrls]);

  // Preserve the active document when possible: an OS-opened web URL uses the
  // right Sites workbench from Docs, and otherwise opens/keeps primary Sites.
  // Route once per arriving request (ids are monotonic, so the tail carries the
  // newest): a request Sites cannot fit yet — the tab cap — must not reopen the
  // workbench the user just closed on every render.
  useEffect(() => {
    const routeId = unroutedSiteViewOpenRequestId(
      pendingOpenedSiteUrls,
      routedOpenedSiteUrlIdRef.current,
    );
    if (routeId === null) return;
    routedOpenedSiteUrlIdRef.current = routeId;
    if (visibleAppMode === "pkm") {
      if (rightWorkbenchMode !== "sites") openWorkbenchModeRight("sites");
      return;
    }
    if (visibleAppMode !== "sites") openPrimaryWorkbenchMode("sites");
  }, [
    openPrimaryWorkbenchMode,
    openWorkbenchModeRight,
    pendingOpenedSiteUrls,
    rightWorkbenchMode,
    visibleAppMode,
  ]);

  const closeRightWorkbench = useCallback(() => {
    setFocusedWorkbenchSide("left");
    patchEditorIds({
      focusedEditorGroup: "left",
      ...(leftResolvedTabId ? { activeTabId: leftResolvedTabId } : {}),
    });
    updateLayoutSettings({ editorSplitOpen: false });
  }, [leftResolvedTabId, updateLayoutSettings]);

  const handleToolPanelSurfaceChange = useCallback(
    (toolPanelSurface: ToolPanelSurface) => {
      if (toolPanelSurface === "graph") setPersistedAppMode("pkm");
      updateLayoutSettings({ toolPanelSurface, terminalOpen: true }, { flush: true });
    },
    [setPersistedAppMode, updateLayoutSettings],
  );

  const handleTerminalThemeChange = useCallback(
    (theme: TerminalTheme) => {
      updateSettings((current) => ({
        ...current,
        terminal: { ...current.terminal, theme },
      }));
    },
    [updateSettings],
  );

  const handlePanelGraphThemeChange = useCallback(
    (theme: "dark" | "light" | "app") => {
      updateSettings((current) => ({
        ...current,
        graph: {
          ...current.graph,
          display: { ...current.graph.display, theme },
        },
      }));
    },
    [updateSettings],
  );

  const splitTerminalRight = useCallback(() => {
    updateLayoutSettings({
      terminalOpen: true,
      toolPanelSurface: "terminal",
      terminalSplitOpen: true,
    });
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
      if (layoutSettings.toolPanelSurface === "graph") {
        dockTerminal("right");
        return;
      }
      splitTerminalRight();
      return;
    }
    splitEditorRight();
  }, [
    dockTerminal,
    layoutSettings.toolPanelSurface,
    splitEditorRight,
    splitTerminalRight,
  ]);

  const selectTabByIndex = useCallback(
    (index: number) => {
      const tab = orderedTabsInState(getEditorTabsState())[index];
      if (tab) selectTab(tab.id);
    },
    [selectTab],
  );

  const handleCommitClick = useCallback(
    (status: GitStatus) => {
      if (blockWorkspaceWrite("modify")) return;
      if (!activeDocumentWorkspacePath) return;
      openCommitDialog(activeDocumentWorkspacePath, status);
    },
    [activeDocumentWorkspacePath, blockWorkspaceWrite],
  );

  const jumpToOutlineLine = useCallback((line: number, requestedGroup?: EditorGroupId) => {
    const targetGroup = requestedGroup ?? focusedEditorGroup;
    const jump = () => {
      const ta =
        targetGroup === "right"
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
    setPersistedEditorViewMode("source", targetGroup);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(jump);
    });
  }, [focusedEditorGroup, setPersistedEditorViewMode]);

  const openWorkspaceFileEntry = useCallback(
    async (entry: WorkspaceFileEntry, line?: number) => {
      if (!isOpenableDocumentFile(entry)) {
        if (explorerWorkspacePath) {
          revealPathInFiles(
            explorerWorkspacePath,
            explorerVisibility,
            entry.path,
          );
        }
        return;
      }
      const docEntry =
        entries.find(
          (candidate) =>
            candidate.path === entry.path || candidate.relPath === entry.relPath,
        ) ?? null;
      if (!docEntry) {
        setError(t("files.openUnavailable"));
        return;
      }
      setPersistedAppMode("pkm");
      const opened = await selectEntry(docEntry, "left");
      if (opened && line != null) {
        window.requestAnimationFrame(() =>
          jumpToOutlineLine(Math.max(0, line - 1), "left"),
        );
      }
    },
    [
      entries,
      explorerVisibility,
      explorerWorkspacePath,
      jumpToOutlineLine,
      revealPathInFiles,
      selectEntry,
      setPersistedAppMode,
      t,
    ],
  );

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
      focusedEditorGroup === "right"
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
  }, [outlineOpen, rightPaneTab, editorViewMode, focusedEditorGroup, document?.path]);

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
          openGraphWorkspace();
          break;
        case "open-graph-right":
          openGraphPanel();
          break;
        case "open-scratchpad":
        case "new-scratchpad-memo":
        case "review-scratchpad-temp": {
          setPersistedAppMode("pkm");
          if (!outlineOpen) updateLayoutSettings({ outlineOpen: true });
          setPersistedRightPaneTab("memo");
          const action =
            id === "new-scratchpad-memo"
              ? "new-memo"
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
        case "new-scratchpad-idea":
          setPersistedAppMode("drafts");
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent("maru:drafts:new-idea"));
          }, 0);
          break;
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
      openGraphPanel,
      openGraphWorkspace,
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
      "mod+k": () => {
        if (getAppOverlayStoreState().commandPaletteOpen) closeCommandPalette();
        else openCommandPalette();
      },
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
      const docTabs = getEditorTabsState().tabs;
      if (docTabs.length === 0) return;
      const currentIndex = Math.max(
        0,
        docTabs.findIndex((tab) => tab.id === resolvedActiveTabId),
      );
      const nextIndex = (currentIndex + delta + docTabs.length) % docTabs.length;
      selectTab(docTabs[nextIndex].id);
    },
    [resolvedActiveTabId, selectTab],
  );

  const openCommitDialogFromMenu = useCallback(async () => {
    if (!activeDocumentWorkspacePath) return;
    if (blockWorkspaceWrite("modify")) return;
    try {
      const status = await gitStatus(activeDocumentWorkspacePath);
      openCommitDialog(activeDocumentWorkspacePath, status);
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
          setPersistedAppMode("pkm");
          break;
        case "view.files":
          setPersistedAppMode("files");
          break;
        case "view.toggle_documents":
          if (visibleAppMode !== "pkm") setPersistedAppMode("pkm");
          updateLayoutSettings({ documentsPaneOpen: !documentsPaneOpen });
          break;
        case "view.toggle_right":
          updateLayoutSettings({ outlineOpen: !outlineOpen });
          break;
        case "view.command_palette":
          if (getAppOverlayStoreState().commandPaletteOpen) closeCommandPalette();
          else openCommandPalette();
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
      setPersistedAppMode,
      snapshotCurrent,
      splitTerminalRight,
      dockTerminal,
      switchActiveWorkspace,
      updateLayoutSettings,
      visibleAppMode,
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
    files: " files-mode",
    drafts: " drafts-mode",
    gap: " gap-mode",
    agents: " agents-mode",
  };
  const graphWorkspacePath =
    workspaceRegistry.activeByVisibility.private ?? privateWorkspaces[0]?.path ?? activeDocumentWorkspacePath;
  // The vault is usually a `vault/` submodule inside the workspace; only fall
  // back to the public-workspace-as-vault setup when there is no such folder.
  // The probe result is keyed by workspace so a switch A→B can never serve
  // A's vault while B's probe is still in flight.
  const [nestedVault, setNestedVault] = useState<{
    workspace: string;
    root: string | null;
  } | null>(null);
  useEffect(() => {
    if (!graphWorkspacePath) return;
    let cancelled = false;
    void vaultGraphRoot(graphWorkspacePath)
      .then((root) => {
        if (!cancelled) setNestedVault({ workspace: graphWorkspacePath, root });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [graphWorkspacePath]);
  const nestedVaultPath =
    nestedVault?.workspace === graphWorkspacePath ? nestedVault.root : null;
  const graphVaultPath =
    nestedVaultPath ??
    workspaceRegistry.activeByVisibility.public ??
    publicWorkspaces[0]?.path ??
    null;
  const graphDataPath =
    maruSettings.graph.source === "vault"
      ? graphVaultPath ?? activeDocumentWorkspacePath
      : graphWorkspacePath ?? activeDocumentWorkspacePath;
  const graphEntries = graphDataPath
    ? workspaceStates[graphDataPath]?.entries ?? NO_ENTRIES
    : activeDocumentEntries;
  const graphSurfaceVisible =
    visibleAppMode === "graph" || rightWorkbenchMode === "graph" || panelGraphOpen;
  const vaultWatchPath = graphSurfaceVisible ? graphDataPath : activeDocumentWorkspacePath;
  // Read the current state from the store: the first thing this effect does is
  // patch the workspace state, so depending on it would re-run the effect,
  // cancel the scan it just started, and then bail on its own `loading: true`
  // — the entries would never land for a path nothing else populates (e.g.
  // the vault submodule, which only the graph scans).
  useEffect(() => {
    if (!graphSurfaceVisible || !graphDataPath) return;
    const current = getWorkspaceStoreState().states[graphDataPath];
    if (current?.startupIoReady || current?.loading || current?.refreshing) return;
    // Land every result, cancelled or not: the writes are keyed by path, so a
    // late one is still correct for that key. Skipping them was the bug — any
    // re-run (settings load swaps the `scanOptions` array identity, or the
    // surface flips visible) cancelled the in-flight scan, and the guard above
    // then saw the `loading: true` this effect had just set and bailed
    // forever. `cancelled` now only suppresses a toast nobody asked for.
    const path = graphDataPath;
    let cancelled = false;
    updateWorkspaceState(path, { loading: true });
    void (async () => {
      try {
        const cached = await readVaultCache(path);
        if (cached) updateWorkspaceState(path, { entries: cached, loading: false, refreshing: true });
        const fresh = await rescanWorkspaceEntries(path, scanOptions);
        if (fresh) {
          updateWorkspaceState(path, { startupIoReady: true });
        } else {
          // A newer rescan or watcher delta superseded this scan and owns the
          // entries now; just don't leave this effect's loading flags stuck.
          updateWorkspaceState(path, { loading: false, refreshing: false });
        }
      } catch (err) {
        updateWorkspaceState(path, { loading: false, refreshing: false });
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [graphDataPath, graphSurfaceVisible, scanOptions]);
  // Watcher lifecycle + `vault://index-delta` incremental apply live in the
  // workspace store now (same enabled condition as the old effect).
  useVaultWatcherSync(
    vaultWatchPath,
    Boolean(graphSurfaceVisible && graphDataPath && vaultWatchPath),
    scanOptions,
  );
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
      visibleAppMode !== "files" &&
      outlineOpen
    ) {
      updateLayoutSettings({ outlineOpen: false });
    }
  }, [outlineOpen, visibleAppMode, updateLayoutSettings]);
  useEffect(() => {
    // Inbox selection only feeds the Shared Outbox queue while in Inbox mode.
    if (surfaceMode !== "inbox" && inboxShareablePaths.length > 0) {
      setInboxShareablePaths([]);
    }
  }, [surfaceMode, inboxShareablePaths.length]);
  const modeClass = modeClassByAppMode[visibleAppMode] ?? "";
  // In-DOM overlays that cover the content area; the native sites webview
  // cannot stack under DOM modals, so SitesPane hides it while any is open.
  // The approval dialog lives outside the overlay store, so it is OR-ed in.
  const sitesOverlayOpen = useSitesOverlayOpen(approvalGate.open);
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
  const reservedWorkbenchWidth = minimumWorkbenchWidth({
    visibleAppMode,
    rightWorkbenchMode,
    editorSplitOpen,
  });
  const shellStyle = useMemo(
    () =>
      ({
        ...themeVars,
        "--documents-col": documentsPaneOpen
          ? `${layoutSettings.documentsPaneWidth}px`
          : "0px",
        "--outline-col": outlineOpen ? `${layoutSettings.outlinePaneWidth}px` : "0px",
        // Keep one usable workbench column beside a right-docked terminal in
        // every mode. The stored preference stays untouched and is restored on
        // a wider window.
        "--terminal-col":
          layoutSettings.terminalDock === "right"
            ? layoutSettings.terminalOpen
              ? `min(${layoutSettings.terminalWidth}px, max(40px, calc(100vw - var(--activity-col) - ${reservedWorkbenchWidth}px)))`
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
      reservedWorkbenchWidth,
      themeVars,
    ],
  );
  const editorSplitStyle =
    editorSplitOpen && rightTab
      ? {
          gridTemplateColumns: `${layoutSettings.editorSplitRatio}fr 6px ${1 - layoutSettings.editorSplitRatio}fr`,
        }
      : undefined;
  const workbenchSplitStyle =
    rightWorkbenchOpen && rightWorkbenchMode
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

  const renderGraphSurface = useCallback(
    (placement: "full" | "panel") => (
      <LazyGraphView
        key={`${placement}:${maruSettings.graph.source}:${graphDataPath ?? "no-workspace"}`}
        workspacePath={graphDataPath}
        entries={graphEntries}
        focusTarget={graphOpenTarget}
        onFocusTargetChange={setGraphOpenTarget}
        onOpenEntry={(entry) => {
          // Panel opens must surface the editor too — the panel is visible in
          // every app mode, but the opened document only shows in pkm.
          setPersistedAppMode("pkm");
          void selectEntry(entry, "left");
        }}
        onCreateNote={handleWikilinkClick}
        graphSettings={maruSettings.graph}
        onGraphSettingsChange={(graph) =>
          updateSettings((current) => ({ ...current, graph }))
        }
        isFavorite={isFavorite}
        onToggleFavorite={toggleFavorite}
        referenceFocus={kgRefFocus}
        onExitReferenceFocus={exitKgReferenceFocus}
        onGraphChanged={() => {
          if (!graphDataPath) return;
          void rescanWorkspaceEntries(graphDataPath, scanOptions);
        }}
      />
    ),
    [
      maruSettings.graph,
      graphDataPath,
      graphEntries,
      graphOpenTarget,
      kgRefFocus,
      exitKgReferenceFocus,
      selectEntry,
      handleWikilinkClick,
      isFavorite,
      toggleFavorite,
      scanOptions,
      updateWorkspaceState,
      updateSettings,
      setPersistedAppMode,
    ],
  );
  // Stable element so TerminalPanel's memo() keeps working; null while the
  // full graph mode is visible so two Sigma instances never run at once.
  const panelGraphNode = useMemo(
    () =>
      visibleAppMode === "graph" || rightWorkbenchMode === "graph"
        ? null
        : renderGraphSurface("panel"),
    [renderGraphSurface, rightWorkbenchMode, visibleAppMode],
  );

  // ------------------------------------------------------------------
  // Stable props for the memoized panes (issue #201). Every non-primitive
  // prop the mode panes and the editor receive is hoisted into a useCallback
  // or useMemo keyed on its real inputs, so unrelated MainApp renders keep
  // prop identities and memo() can skip those panes. Bodies are unchanged
  // from the inline arrows they replace.
  // ------------------------------------------------------------------

  // Derived mission lists, keyed on the shared store snapshot.
  const inboxProcessingMissions = useMemo(
    () => inboxProcessMissions(processingMissions),
    [processingMissions],
  );
  const meetingsProcessingMissions = useMemo(
    () => activeMeetingsMissions(processingMissions),
    [processingMissions],
  );
  const tasksProcessingMissions = useMemo(
    () => activeTasksMissions(processingMissions),
    [processingMissions],
  );
  const trackedAgentMissions = useMemo(
    () => activeTrackedAgentMissions(processingMissions),
    [processingMissions],
  );

  // Shared by Inbox/Comms/Meetings/Today and the skill runs panel.
  const handleRevealPath = useCallback(
    (path: string) => {
      if (inboxWorkspacePath) void revealInFileManager(inboxWorkspacePath, path);
    },
    [inboxWorkspacePath],
  );
  const handleStopProcessingMission = useCallback(
    (id: string) => void stopProcessingMission(id),
    [stopProcessingMission],
  );
  const handleRefreshProcessed = useCallback(
    () => void refreshProcessedItems(),
    [refreshProcessedItems],
  );
  const handleSelectProcessedItem = useCallback(
    (item: InboxProcessedItem) => void selectProcessedItem(item),
    [selectProcessedItem],
  );

  // Inbox pane callbacks.
  const handleInboxRefresh = useCallback(() => {
    void refreshInbox();
    void refreshProcessedItems();
    void refreshProcessingMissions();
  }, [refreshInbox, refreshProcessedItems, refreshProcessingMissions]);
  const handleOpenInboxFolder = useCallback(() => {
    if (!inboxWorkspacePath) return;
    void openInFileManager(inboxWorkspacePath, inboxRootPath(inboxRuntimeConfig)).catch(
      (err) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [inboxWorkspacePath, inboxRuntimeConfig]);
  const handleOpenSourceFolder = useCallback(
    (key: string) => {
      if (!inboxWorkspacePath) return;
      void openInFileManager(inboxWorkspacePath, sourceFolderPath(inboxRuntimeConfig, key)).catch(
        (err) => setError(err instanceof Error ? err.message : String(err)),
      );
    },
    [inboxWorkspacePath, inboxRuntimeConfig],
  );
  const handleClassifyItem = useCallback((id: string) => void classifyItem(id), [classifyItem]);
  const handleProcessEntries = useCallback(
    (keys: string[], context?: string) => void processInboxKeys(keys, undefined, true, context),
    [processInboxKeys],
  );
  const handleStageInboxFiles = useCallback(
    (paths: string[]) => void stageInboxFiles(paths),
    [stageInboxFiles],
  );
  const handleTrashInboxTargets = useCallback(
    (targets: InboxTrashTarget[]) => void trashInboxTargets(targets),
    [trashInboxTargets],
  );
  const handleInboxProcessApplied = useCallback(() => {
    void refreshProcessedItems();
    void refreshInbox();
  }, [refreshProcessedItems, refreshInbox]);

  // Comms pane callbacks.
  const handleProcessCommsNow = useCallback(
    (channel: string) => void processCommsChannelNow(channel),
    [processCommsChannelNow],
  );
  const handleDeepProcessComms = useCallback(
    (channel: string) => void deepProcessCommsChannel(channel),
    [deepProcessCommsChannel],
  );
  const handleUnloadMigration = useCallback(
    (paths: string[]) => void unloadMigrationServices(paths),
    [unloadMigrationServices],
  );

  // Meetings pane callbacks.
  const handleMeetingsOpenSkillCompose = useCallback(
    (skill: SkillRecord | null, context: SkillContextItem[], prompt?: string) =>
      openSkillCompose(skill, context, prompt),
    [openSkillCompose],
  );
  const handleMeetingsViewConsumed = useCallback(() => setMeetingsRequestedView(null), []);

  // Today pane: the whole tasksProps bundle, keyed on its members.
  const handleTasksOpenSkillCompose = useCallback(
    (
      skill: SkillRecord | null,
      context: SkillContextItem[],
      prompt?: string,
      cwd?: string | null,
      onDispatched?: () => void | Promise<void>,
    ) => openSkillCompose(skill, context, prompt, cwd, onDispatched),
    [openSkillCompose],
  );
  const tasksProps = useMemo<TasksPaneProps>(
    () => ({
      workPath: inboxWorkspacePath,
      effectiveSettings: effectiveTasksSettings,
      labelMode: maruSettings.ui.documentLabelMode,
      skills,
      runtimeCommands: aiRuntimeCommands,
      permissionMode: maruSettings.ai.permissionMode,
      agents,
      ai: maruSettings.ai,
      processingMissions: tasksProcessingMissions,
      processingLogLines,
      onRefreshMissions: refreshProcessingMissions,
      onOpenSettings: openTasksSettings,
      onOpenSkillCompose: handleTasksOpenSkillCompose,
      onMissionStarted: handleMeetingsMissionStarted,
      onStopMission: handleStopProcessingMission,
      onConfirmApproval: approvalGate.confirmApproval,
      onRevealPath: handleRevealPath,
    }),
    [
      inboxWorkspacePath,
      effectiveTasksSettings,
      maruSettings.ui.documentLabelMode,
      skills,
      aiRuntimeCommands,
      maruSettings.ai,
      agents,
      tasksProcessingMissions,
      processingLogLines,
      refreshProcessingMissions,
      openTasksSettings,
      handleTasksOpenSkillCompose,
      handleMeetingsMissionStarted,
      handleStopProcessingMission,
      approvalGate.confirmApproval,
      handleRevealPath,
    ],
  );

  // EditorPane callbacks. renderEditorPane is a plain function (hook calls
  // are not allowed inside it), so the per-group closures it used to build
  // inline are hoisted here as explicit left/right variants; the render
  // sites select the matching variant on `group`.
  const leftDocTab = isBinaryTab(leftTab) ? null : (leftTab as EditorTab | null);
  const rightDocTab = isBinaryTab(rightTab) ? null : (rightTab as EditorTab | null);
  const leftHtmlKey = leftDocTab ? `left:${leftDocTab.id}` : null;
  const rightHtmlKey = rightDocTab ? `right:${rightDocTab.id}` : null;
  const rightEditorGroupTabs = useMemo(
    () =>
      rightTab
        ? editorTabSummaries.filter((summary) => summary.id === rightTab.id)
        : editorTabSummaries,
    [rightTab, editorTabSummaries],
  );
  const handleBinaryViewerError = useCallback((message: string) => setError(message), []);
  const leftBinaryBody = useMemo(
    () =>
      isBinaryTab(leftTab) ? (
        <BinaryViewerPane
          entry={leftTab.fileEntry}
          workspacePath={leftTab.workspacePath}
          classification={leftTab.classification}
          onError={handleBinaryViewerError}
        />
      ) : null,
    [leftTab, handleBinaryViewerError],
  );
  const rightBinaryBody = useMemo(
    () =>
      isBinaryTab(rightTab) ? (
        <BinaryViewerPane
          entry={rightTab.fileEntry}
          workspacePath={rightTab.workspacePath}
          classification={rightTab.classification}
          onError={handleBinaryViewerError}
        />
      ) : null,
    [rightTab, handleBinaryViewerError],
  );
  const handleLeftEditorChange = useCallback(
    (content: string) => {
      if (!leftResolvedTabId) return;
      activateEditorTab(leftResolvedTabId, "left");
      updateTabDraft(leftResolvedTabId, content);
    },
    [leftResolvedTabId],
  );
  const handleRightEditorChange = useCallback(
    (content: string) => {
      if (!rightResolvedTabId) return;
      activateEditorTab(rightResolvedTabId, "right");
      updateTabDraft(rightResolvedTabId, content);
    },
    [rightResolvedTabId],
  );
  const handleLeftSelectTab = useCallback(
    (nextTabId: string) => selectTab(nextTabId, "left"),
    [selectTab],
  );
  const handleRightSelectTab = useCallback(
    (nextTabId: string) => selectTab(nextTabId, "right"),
    [selectTab],
  );
  const handleLeftCloseTab = useCallback((nextTabId: string) => closeTab(nextTabId), [closeTab]);
  const handleRightCloseTab = useCallback(() => closeRightEditorPane(), [closeRightEditorPane]);
  const handleLeftOpenTabPreview = useCallback(
    (nextTabId: string) => {
      selectTab(nextTabId, "left");
      setPersistedEditorViewMode("preview", "left");
    },
    [selectTab, setPersistedEditorViewMode],
  );
  const handleRightOpenTabPreview = useCallback(
    (nextTabId: string) => {
      selectTab(nextTabId, "right");
      setPersistedEditorViewMode("preview", "right");
    },
    [selectTab, setPersistedEditorViewMode],
  );
  const handleLeftRevealTabInExplorer = useCallback(
    (nextTabId: string) => revealTabInExplorer(nextTabId, "left"),
    [revealTabInExplorer],
  );
  const handleRightRevealTabInExplorer = useCallback(
    (nextTabId: string) => revealTabInExplorer(nextTabId, "right"),
    [revealTabInExplorer],
  );
  const handleLeftSaveTab = useCallback(
    () => void saveTab(leftResolvedTabId),
    [leftResolvedTabId, saveTab],
  );
  const handleRightSaveTab = useCallback(
    () => void saveTab(rightResolvedTabId),
    [rightResolvedTabId, saveTab],
  );
  const handleLeftSnapshotTab = useCallback(
    () => void snapshotTab(leftResolvedTabId),
    [leftResolvedTabId, snapshotTab],
  );
  const handleRightSnapshotTab = useCallback(
    () => void snapshotTab(rightResolvedTabId),
    [rightResolvedTabId, snapshotTab],
  );
  const handleLeftFocusPane = useCallback(() => {
    setFocusedWorkbenchSide("left");
    if (leftResolvedTabId) activateEditorTab(leftResolvedTabId, "left");
  }, [leftResolvedTabId]);
  const handleRightFocusPane = useCallback(() => {
    setFocusedWorkbenchSide("right");
    if (rightResolvedTabId) activateEditorTab(rightResolvedTabId, "right");
  }, [rightResolvedTabId]);
  const handleLeftViewModeChange = useCallback(
    (mode: EditorViewMode) => setPersistedEditorViewMode(mode, "left"),
    [setPersistedEditorViewMode],
  );
  const handleRightViewModeChange = useCallback(
    (mode: EditorViewMode) => setPersistedEditorViewMode(mode, "right"),
    [setPersistedEditorViewMode],
  );
  const handleLeftVisualizeRefs = useCallback(() => {
    if (leftDocTab) visualizeDocRefs(leftDocTab);
  }, [leftDocTab, visualizeDocRefs]);
  const handleRightVisualizeRefs = useCallback(() => {
    if (rightDocTab) visualizeDocRefs(rightDocTab);
  }, [rightDocTab, visualizeDocRefs]);
  const handleLeftToggleKgHighlight = useCallback(() => {
    if (leftDocTab) toggleKgHighlight(leftDocTab);
  }, [leftDocTab, toggleKgHighlight]);
  const handleRightToggleKgHighlight = useCallback(() => {
    if (rightDocTab) toggleKgHighlight(rightDocTab);
  }, [rightDocTab, toggleKgHighlight]);
  const handleLeftHtmlViewModeChange = useCallback(
    (mode: HtmlViewMode) => {
      if (!leftDocTab || !leftHtmlKey) return;
      flushHtmlDraft(leftDocTab.id);
      setHtmlPaneModes((prev) => ({
        ...prev,
        [leftHtmlKey]: { ...prev[leftHtmlKey], mode },
      }));
    },
    [leftDocTab, leftHtmlKey, flushHtmlDraft],
  );
  const handleRightHtmlViewModeChange = useCallback(
    (mode: HtmlViewMode) => {
      if (!rightDocTab || !rightHtmlKey) return;
      flushHtmlDraft(rightDocTab.id);
      setHtmlPaneModes((prev) => ({
        ...prev,
        [rightHtmlKey]: { ...prev[rightHtmlKey], mode },
      }));
    },
    [rightDocTab, rightHtmlKey, flushHtmlDraft],
  );
  const handleLeftHtmlRiskAck = useCallback(
    (digest: string) => {
      if (!leftHtmlKey) return;
      setHtmlPaneModes((prev) => ({
        ...prev,
        [leftHtmlKey]: {
          ...prev[leftHtmlKey],
          mode: prev[leftHtmlKey]?.mode ?? "visual",
          riskAckDigest: digest,
        },
      }));
    },
    [leftHtmlKey],
  );
  const handleRightHtmlRiskAck = useCallback(
    (digest: string) => {
      if (!rightHtmlKey) return;
      setHtmlPaneModes((prev) => ({
        ...prev,
        [rightHtmlKey]: {
          ...prev[rightHtmlKey],
          mode: prev[rightHtmlKey]?.mode ?? "visual",
          riskAckDigest: digest,
        },
      }));
    },
    [rightHtmlKey],
  );
  const handleRenameTab = useCallback(
    (nextTabId: string) => void renameTabDocument(nextTabId),
    [renameTabDocument],
  );
  const handleMoveTab = useCallback(
    (nextTabId: string) => void moveTabDocument(nextTabId),
    [moveTabDocument],
  );
  const handleDuplicateTab = useCallback(
    (nextTabId: string) => void duplicateTabDocument(nextTabId),
    [duplicateTabDocument],
  );
  const handleDeleteTab = useCallback(
    (nextTabId: string) => void trashTabDocument(nextTabId),
    [trashTabDocument],
  );
  const handleKgRefNodeClick = useCallback(
    (nodePath: string) => {
      // Same handoff as NeighborhoodPane "그래프에서 보기", but into the
      // doc↔graph split (panel) so the document stays visible.
      openGraphPanel({
        source: activeDocumentWorkspacePath === graphVaultPath ? "vault" : "workspace",
        localTarget: { ownerWorkspacePath: null, relPath: nodePath },
      });
    },
    [activeDocumentWorkspacePath, graphVaultPath, openGraphPanel],
  );
  const handleToggleOutline = useCallback(
    () => updateLayoutSettings({ outlineOpen: !outlineOpen }),
    [outlineOpen, updateLayoutSettings],
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
    const docTab = isBinaryTab(tab) ? null : (tab as EditorTab | null);
    const binaryTab = isBinaryTab(tab) ? (tab as BinaryTab) : null;
    const isManagedVaultNote = Boolean(
      workspace?.writePolicy === "managed" &&
        docTab?.document.relPath.startsWith("notes/") &&
        docTab.document.relPath.toLowerCase().endsWith(".md"),
    );
    const htmlKey = docTab ? `${group}:${docTab.id}` : null;
    const htmlState = htmlKey ? htmlPaneModes[htmlKey] : undefined;
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
        tabs={group === "right" ? rightEditorGroupTabs : editorTabSummaries}
        activeTabId={tabId}
        bodyOverride={group === "right" ? rightBinaryBody : leftBinaryBody}
        entries={tab ? workspaceStates[tab.workspacePath]?.entries ?? entries : entries}
        onChange={group === "right" ? handleRightEditorChange : handleLeftEditorChange}
        onSelectTab={group === "right" ? handleRightSelectTab : handleLeftSelectTab}
        onCloseTab={group === "right" ? handleRightCloseTab : handleLeftCloseTab}
        onCloseOtherTabs={closeOtherTabs}
        onCloseTabsToRight={closeTabsToRight}
        onCloseSavedTabs={closeSavedTabs}
        onCloseAllTabs={closeAllCleanTabs}
        onCopyTabName={copyTabName}
        onCopyTabPath={copyTabPath}
        onCopyTabRelativePath={copyTabRelativePath}
        onRenameTab={handleRenameTab}
        onMoveTab={handleMoveTab}
        onDuplicateTab={handleDuplicateTab}
        onDeleteTab={handleDeleteTab}
        onOpenTabPreview={
          group === "right" ? handleRightOpenTabPreview : handleLeftOpenTabPreview
        }
        onRevealTabInFinder={revealTabInFinder}
        onRevealTabInExplorer={
          group === "right" ? handleRightRevealTabInExplorer : handleLeftRevealTabInExplorer
        }
        onSave={group === "right" ? handleRightSaveTab : handleLeftSaveTab}
        onSnapshot={group === "right" ? handleRightSnapshotTab : handleLeftSnapshotTab}
        onSplitRight={splitEditorRight}
        onOpenSourcePreview={docTab ? openSourcePreviewSplit : undefined}
        onOpenGraphRight={openGraphPanel}
        onVisualizeRefs={
          docTab && !isHtmlFileKind(docTab.document.fileKind)
            ? group === "right"
              ? handleRightVisualizeRefs
              : handleLeftVisualizeRefs
            : undefined
        }
        kgHighlightRefs={
          docTab && kgHighlight?.docPath === docTab.document.relPath
            ? kgHighlight.refs
            : null
        }
        onToggleKgHighlight={
          docTab && !isHtmlFileKind(docTab.document.fileKind)
            ? group === "right"
              ? handleRightToggleKgHighlight
              : handleLeftToggleKgHighlight
            : undefined
        }
        onKgRefNodeClick={handleKgRefNodeClick}
        onFocusPane={group === "right" ? handleRightFocusPane : handleLeftFocusPane}
        onToggleOutline={handleToggleOutline}
        onViewModeChange={
          group === "right" ? handleRightViewModeChange : handleLeftViewModeChange
        }
        onWikilinkClick={handleWikilinkClick}
        textareaRef={group === "right" ? rightEditorTextareaRef : editorTextareaRef}
        vaultPath={docTab?.workspacePath ?? null}
        htmlViewMode={htmlState?.mode ?? "visual"}
        onHtmlViewModeChange={
          group === "right" ? handleRightHtmlViewModeChange : handleLeftHtmlViewModeChange
        }
        htmlRiskAckDigest={htmlState?.riskAckDigest ?? null}
        onHtmlRiskAck={group === "right" ? handleRightHtmlRiskAck : handleLeftHtmlRiskAck}
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

  // Gate first paint on the active locale dictionary: the dicts are lazy
  // chunks now, and rendering before load would flash raw i18n keys.
  if (!localeValue.ready) return null;

  return (
    <LocaleContext.Provider value={localeValue}>
      <div className={shellClass} style={shellStyle} ref={appShellRef}>
        <header
          className="topbar"
          data-tauri-drag-region
          onPointerDown={handleTopbarPointerDown}
        >
          <div className="topbar-window-controls-guard" data-no-drag="true" aria-hidden="true" />
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
          <MissionBadge />

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
          <ActivityModeButton
            label={t("mode.pkm")}
            active={visibleAppMode === "pkm" && !rightWorkbenchOpen}
            icon={<FileText size={20} />}
            onOpenPrimary={() => {
              updateLayoutSettings({ editorSplitOpen: false });
              setPersistedAppMode("pkm");
            }}
          />
          {([
            ["files", FolderOpen],
            ["inbox", Inbox],
            ["comms", MessageSquare],
            ["meetings", UsersRound],
            ["tasks", ListTodo],
            ["drafts", PenLine],
            ["gap", Diff],
            ["agents", Bot],
            ["catalog", LayoutGrid],
            ["studio", Workflow],
            ["sites", Globe],
          ] as const).map(([mode, Icon]) => (
            <ActivityModeButton
              key={mode}
              label={t(`mode.${mode}`)}
              active={visibleAppMode === mode}
              secondaryActive={rightWorkbenchMode === mode}
              icon={<Icon size={20} strokeWidth={1.9} />}
              onOpenPrimary={() => openPrimaryWorkbenchMode(mode)}
              onOpenRight={() => openWorkbenchModeRight(mode)}
              openRightLabel={t("workbench.openRight", { name: t(`mode.${mode}`) })}
            />
          ))}
          {e2eFlowEnabled ? (
            <ActivityModeButton
              label={t("mode.e2e")}
              active={visibleAppMode === "e2e"}
              secondaryActive={rightWorkbenchMode === "e2e"}
              icon={<Route size={20} strokeWidth={1.9} />}
              onOpenPrimary={() => openPrimaryWorkbenchMode("e2e")}
              onOpenRight={() => openWorkbenchModeRight("e2e")}
              openRightLabel={t("workbench.openRight", { name: t("mode.e2e") })}
            />
          ) : null}
          {diagramEnabled ? (
            <ActivityModeButton
              label={t("mode.diagram")}
              active={visibleAppMode === "diagram"}
              secondaryActive={rightWorkbenchMode === "diagram"}
              icon={<Network size={20} strokeWidth={1.9} />}
              onOpenPrimary={() => openPrimaryWorkbenchMode("diagram")}
              onOpenRight={() => openWorkbenchModeRight("diagram")}
              openRightLabel={t("workbench.openRight", { name: t("mode.diagram") })}
            />
          ) : null}
          <ActivityModeButton
            label={t("mode.graph")}
            active={visibleAppMode === "graph"}
            secondaryActive={rightWorkbenchMode === "graph"}
            icon={<Waypoints size={20} strokeWidth={1.9} />}
            onOpenPrimary={() => openPrimaryWorkbenchMode("graph")}
            onOpenRight={() => openWorkbenchModeRight("graph")}
            openRightLabel={t("workbench.openRight", { name: t("mode.graph") })}
          />
          <button
            type="button"
            className="activity-button"
            onClick={openCommandPalette}
            title={t("sidebar.commandPalette")}
            aria-label={t("sidebar.commandPalette")}
          >
            <Command size={19} />
          </button>
          {visibleAppMode === "pkm" || visibleAppMode === "inbox" ? (
            <button
              type="button"
              className={outlineOpen ? "activity-button active" : "activity-button"}
              onClick={() => updateLayoutSettings({ outlineOpen: !outlineOpen })}
              title={outlineOpen ? t("layout.hideRightPane") : t("layout.showRightPane")}
              aria-label={outlineOpen ? t("layout.hideRightPane") : t("layout.showRightPane")}
            >
              {outlineOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
            </button>
          ) : null}
          {visibleAppMode === "pkm" ? (
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
          ) : null}
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

        <div
          className={
            rightWorkbenchOpen
              ? "app-workbench workbench-secondary-open"
              : editorSplitOpen
                ? "app-workbench editor-split-active"
                : "app-workbench"
          }
          style={workbenchSplitStyle}
          ref={rightWorkbenchOpen ? editorSplitShellRef : undefined}
        >
        <Suspense fallback={<div className="mode-loading" role="status">…</div>}>
        {rightWorkbenchMode ? renderEditorPane("left", leftTab, leftResolvedTabId) : null}
        {rightWorkbenchMode ? (
          <div
            className="workbench-split-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-valuemin={30}
            aria-valuemax={70}
            aria-valuenow={Math.round(layoutSettings.editorSplitRatio * 100)}
            onPointerDown={startEditorSplitResize}
          />
        ) : null}
        <div
          className={
            rightWorkbenchMode
              ? "workbench-secondary-surface"
              : "workbench-primary-surface"
          }
          onPointerDownCapture={() => {
            if (rightWorkbenchMode) setFocusedWorkbenchSide("right");
          }}
          onFocusCapture={() => {
            if (rightWorkbenchMode) setFocusedWorkbenchSide("right");
          }}
        >
        {rightWorkbenchMode ? (
          <header
            className="workbench-secondary-header"
            onPointerDown={() => setFocusedWorkbenchSide("right")}
          >
            <strong>{t(`mode.${rightWorkbenchMode}`)}</strong>
            <span className="workbench-secondary-spacer" />
            <button
              type="button"
              className="icon-button"
              onClick={() => openPrimaryWorkbenchMode(rightWorkbenchMode)}
              title={t("workbench.moveToMain")}
              aria-label={t("workbench.moveToMain")}
            >
              <PanelTopOpen size={13} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={closeRightWorkbench}
              title={t("workbench.closeRight")}
              aria-label={t("workbench.closeRight")}
            >
              <X size={13} />
            </button>
          </header>
        ) : null}
        {surfaceMode === "e2e" ? (
          <LazyE2EFlowPane
            workPath={inboxWorkspacePath}
            onRevealPath={(path) => {
              if (inboxWorkspacePath) void revealInFileManager(inboxWorkspacePath, path);
            }}
              />
        ) : surfaceMode === "diagram" ? (
          <LazyDiagramMode
            workPath={inboxWorkspacePath ?? settingsWorkPath}
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
        ) : surfaceMode === "graph" ? (
          renderGraphSurface("full")
        ) : surfaceMode === "sites" ? (
          <LazySitesPane
            overlayOpen={sitesOverlayOpen}
                onEmptyClose={rightWorkbenchMode === "sites" ? closeRightWorkbench : undefined}
            openedUrls={pendingOpenedSiteUrls}
            onOpenedUrlsHandled={acknowledgeOpenedSiteUrls}
          />
        ) : surfaceMode === "files" ? (
          <LazyFilesWorkbench
            onIgnore={(relPath) => void ignoreEntry(relPath)}
            entries={workspaceEntryNodes}
            selectedPaths={selectedFilePaths}
            query={fileQuery}
            loading={
              (booting ||
                explorerWorkspaceFilesState.loading ||
                shouldScanExplorerWorkspaceFiles) &&
              workspaceEntryNodes.length === 0
            }
            refreshing={explorerWorkspaceFilesState.refreshing}
            workspacePath={explorerWorkspacePath}
            workspaceVisibility={explorerVisibility}
            publicWorkspaceAvailable={publicWorkspaceAvailable}
            activeWorkspaceLabel={explorerWorkspaceCaption}
            filter={maruSettings.ui.workspaceFileFilter}
            sortKey={maruSettings.ui.filesSortKey}
            filesListAttributes={maruSettings.ui.filesListAttributes}
            paneFilters={filesPaneFilters}
            queuedSourcePaths={queuedSourcePaths}
            expandedFolders={collapsedFileFolders}
            treeOpen={layoutSettings.filesTreeOpen}
            treeWidth={layoutSettings.filesTreeWidth}
            previewOpen={layoutSettings.filesPreviewOpen}
            previewWidth={layoutSettings.filesPreviewWidth}
            favorites={maruSettings.ui.favorites}
            canCreate={
              explorerWorkspaceCaps.canCreate && explorerWorkspace?.writePolicy !== "managed"
            }
            canRenameMove={
              explorerWorkspaceCaps.canRenameMove && explorerWorkspace?.writePolicy !== "managed"
            }
            canDelete={
              explorerWorkspaceCaps.canDelete && explorerWorkspace?.writePolicy !== "managed"
            }
            openDocumentPaths={explorerOpenDocumentPaths}
            dirtyDocumentPaths={explorerDirtyDocumentPaths}
            pendingRevealTargetPath={
              pendingExplorerReveal?.pane === "files"
                ? pendingExplorerReveal.targetPath
                : null
            }
            onRevealHandled={() => setPendingExplorerReveal(null)}
            onWorkspaceVisibilityChange={(visibility) => {
              setExplorerVisibility(visibility);
              const nextPath = workspaceRegistry.activeByVisibility[visibility];
              if (nextPath && !workspaceStates[nextPath]?.entries.length) {
                void loadWorkspace(nextPath, visibility);
              }
            }}
            onAddPublicWorkspace={() => openAddWorkspaceDialog("public")}
            onQueryChange={setWorkspaceFileQuery}
            onFilterChange={setWorkspaceFileFilter}
            onSortKeyChange={setFilesSortKey}
            onFilesListAttributesChange={setFilesListAttributes}
            onPaneFiltersChange={setFilesPaneFilters}
            onExpandedFoldersChange={setCollapsedFileFolders}
            onSelectionChange={setWorkspaceFileSelection}
            onOpenDocument={(entry) => void openWorkspaceFileEntry(entry)}
            onQueuePaths={(paths) => void queueExternalFiles(paths)}
            onRevealInFinder={revealTargetInFinder}
            onRefresh={() => {
              if (explorerWorkspacePath) void refreshWorkspaceFiles(explorerWorkspacePath);
            }}
            onFilesystemMutated={handleFilesFilesystemMutated}
            onLayoutChange={updateLayoutSettings}
            onOpenFavorite={openFavorite}
            onRemoveFavorite={removeFavorite}
            onToggleFavorite={toggleFavorite}
            isFavoriteMissing={isFavoriteMissing}
            isFavorite={isFavorite}
            onOpenInBrowser={(targetPath) => {
              if (!explorerWorkspacePath) return;
              void binaryViewerOpenExternal(explorerWorkspacePath, targetPath).catch(
                (err: unknown) =>
                  setError(err instanceof Error ? err.message : String(err)),
              );
            }}
            onApplySkillToTarget={applySkillToFileTarget}
            onAttachToTerminal={attachPathToTerminal}
              />
        ) : surfaceMode === "studio" ? (
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
              />
        ) : surfaceMode === "catalog" ? (
          <LazyCatalogPane
            workspaceRoot={inboxWorkspacePath ?? settingsWorkPath}
            onReveal={(path) => {
              const root = inboxWorkspacePath ?? settingsWorkPath;
              if (root) void revealInFileManager(root, path);
            }}
          />
        ) : surfaceMode === "drafts" ? (
          <LazyDraftsPane
            workPath={primaryWorkspacePath}
            entries={primaryWorkspaceEntries}
            skills={skills}
            defaultRuntime={maruSettings.ai.defaultRuntime}
            agents={agents}
            ai={maruSettings.ai}
            taskIngestMinImportance={maruSettings.ai.taskIngestMinImportance}
            onTaskIngestMinImportanceChange={(value) =>
              updateSettings((current) => ({
                ...current,
                ai: { ...current.ai, taskIngestMinImportance: value },
              }))
            }
            onConfirmApproval={approvalGate.confirmApproval}
            onOpenAgents={() => setPersistedAppMode("agents")}
            onOpenGapAnalysis={openGapAnalysis}
            onOpenInGraph={openDraftsGraphFocus}
            onExitReferenceFocus={exitKgReferenceFocus}
          />
        ) : surfaceMode === "gap" ? (
          <LazyGapPane
            workPath={primaryWorkspacePath}
            entries={primaryWorkspaceEntries}
            initialDraftId={gapDraftId}
            onConsumeInitialDraftId={() => setGapDraftId(null)}
            onOpenInGraph={openGapGraphFocus}
            onExitReferenceFocus={exitKgReferenceFocus}
              />
        ) : surfaceMode === "agents" ? (
          <LazyAgentsPane
            workPath={inboxWorkspacePath}
            skills={skills}
            ai={maruSettings.ai}
            missions={processingMissions}
            logLines={processingLogLines}
            runtimeCommands={aiRuntimeCommands}
            tasksRoot={effectiveTasksSettings.root}
            onRefreshMissions={refreshProcessingMissions}
            onStopMission={stopProcessingMission}
            onMissionStarted={trackMissionQuietly}
            onConfirmApproval={approvalGate.confirmApproval}
            onAgentsChanged={refreshAgents}
              />
        ) : surfaceMode === "inbox" ? (
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
            processingMissions={inboxProcessingMissions}
            processingLogLines={processingLogLines}
            sourceFilter={inboxSourceFilter}
            onSourceFilter={setInboxSourceFilter}
            sourceFolderKeys={inboxSourceFolderKeys}
            fileDropTarget={inboxRuntimeConfig.file_drop}
            focusRequest={inboxFocusTick}
            actionBusy={inboxActionBusy}
            onRefresh={handleInboxRefresh}
            onOpenSettings={openInboxSettings}
            onOpenInboxFolder={handleOpenInboxFolder}
            onOpenSourceFolder={handleOpenSourceFolder}
            onClassify={handleClassifyItem}
            onDecide={decideInboxItem}
            onBulkAccept={bulkAcceptInboxKeys}
            onBulkReject={bulkRejectInboxKeys}
            onBulkMoveFiles={bulkMoveInboxFiles}
            onProcessEntries={handleProcessEntries}
            onStageFiles={handleStageInboxFiles}
            onProcessedStatusFilter={setProcessedStatusFilter}
            onProcessedQuery={setProcessedQuery}
            onRefreshProcessed={handleRefreshProcessed}
            onSelectProcessedItem={handleSelectProcessedItem}
            onRevealPath={handleRevealPath}
            onTrashItems={handleTrashInboxTargets}
            onStopProcessingMission={handleStopProcessingMission}
            workPath={inboxWorkspacePath}
            onConfirmApproval={approvalGate.confirmApproval}
            onProcessApplied={handleInboxProcessApplied}
            onShareSelectionChange={setInboxShareablePaths}
          />
        ) : surfaceMode === "comms" ? (
          <LazyCommsPane
            runtimeConfig={inboxRuntimeConfig}
            sourceRuns={sourceRuns}
            processedCounts={processedCounts}
            processedItems={processedItems}
            processedLoading={processedLoading}
            processedRefreshing={processedRefreshing}
            processedError={processedError}
            processedStatusFilter={processedStatusFilter}
            processedQuery={processedQuery}
            processedDetail={processedDetail}
            processingMissions={inboxProcessingMissions}
            processingLogLines={processingLogLines}
            sourceFilter={commsSourceFilter}
            actionBusy={inboxActionBusy}
            telegramPollingStatus={telegramPolling}
            authStatuses={commsAuthStatuses}
            kakaoRelayStatus={kakaoRelayStatus}
            workPath={inboxWorkspacePath}
            onConfirmApproval={approvalGate.confirmApproval}
            refreshing={commsRefreshing}
            migrationServices={migrationServices}
            migrationBusy={migrationBusy}
            onSourceFilter={setCommsSourceFilter}
            onProcessNow={handleProcessCommsNow}
            onRefresh={refreshActiveSurface}
            onProcessedStatusFilter={setProcessedStatusFilter}
            onProcessedQuery={setProcessedQuery}
            onRefreshProcessed={handleRefreshProcessed}
            onSelectProcessedItem={handleSelectProcessedItem}
            onStopProcessingMission={handleStopProcessingMission}
            onRevealPath={handleRevealPath}
            onGwsReauth={startGwsAuth}
            onMsoReauth={startMsoLogin}
            msoReauthDisabled={!inboxWorkspaceConfigReady}
            msoProcessDisabled={!inboxWorkspaceConfigReady}
            onStartTelegramPolling={startTelegramPollingFromSettings}
            onStopTelegramPolling={stopTelegramPollingFromSettings}
            onTelegramLogin={startTelegramLogin}
            onDeepProcess={handleDeepProcessComms}
            onOpenCommsSettings={openCommsSettings}
            onRefreshMigration={refreshMigrationServices}
            onUnloadMigration={handleUnloadMigration}
          />
        ) : surfaceMode === "meetings" ? (
          <LazyMeetingsPane
            workPath={inboxWorkspacePath}
            settings={maruSettings.meetings}
            effectiveSettings={effectiveMeetingsSettings}
            labelMode={maruSettings.ui.documentLabelMode}
            skills={skills}
            runtimeCommands={aiRuntimeCommands}
            agents={agents}
            ai={maruSettings.ai}
            permissionMode={maruSettings.ai.permissionMode}
            processingMissions={meetingsProcessingMissions}
            processingLogLines={processingLogLines}
            onRefreshMissions={refreshProcessingMissions}
            onOpenSettings={openMeetingsSettings}
            onOpenSkillCompose={handleMeetingsOpenSkillCompose}
            onMissionStarted={handleMeetingsMissionStarted}
            onStopMission={handleStopProcessingMission}
            onConfirmApproval={approvalGate.confirmApproval}
            onRevealPath={handleRevealPath}
                requestedView={meetingsRequestedView}
            onViewConsumed={handleMeetingsViewConsumed}
          />
        ) : surfaceMode === "tasks" ? (
          <LazyTodayPane
            route={todayRoute}
            onRouteChange={setTodayRoute}
            workPath={inboxWorkspacePath}
            effectiveSettings={effectiveTasksSettings}
            layout={layoutSettings}
            onLayoutChange={updateLayoutSettings}
            rolloverEpoch={todayRolloverEpoch}
            refreshRequestEpoch={todayRefreshEpoch}
            tasksProps={tasksProps}
          />
        ) : (
          <>
            {documentsPaneOpen ? (
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
                sortKey={maruSettings.ui.documentSortKey}
                documentLabelMode={maruSettings.ui.documentLabelMode}
                collapsedTreeFolders={collapsedTreeFolders}
                onQueryChange={setExplorerQuery}
                onBrowserModeChange={setDocumentBrowserMode}
                onSortKeyChange={setDocumentSortKey}
                onCollapsedTreeFoldersChange={setCollapsedTreeFolders}
                onSelect={selectEntry}
                onRevealInFinder={revealTargetInFinder}
                onRevealInFiles={(targetPath) => {
                  if (!explorerWorkspacePath) return;
                  revealPathInFiles(
                    explorerWorkspacePath,
                    explorerVisibility,
                    targetPath,
                  );
                }}
                onIgnore={(relPath) => void ignoreEntry(relPath)}
                onRefresh={() => void refreshCurrent()}
                refreshing={explorerWorkspaceState.refreshing}
                onClose={() => updateLayoutSettings({ documentsPaneOpen: false })}
                searchInputRef={searchInputRef}
                paneRef={documentsPaneRef}
                vaultPath={explorerWorkspacePath}
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
                editorSplitOpen && rightTab
                  ? "editor-split-shell split"
                  : "editor-split-shell"
              }
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

          </>
        )}
        </div>
        </Suspense>

        {outlineOpen && visibleAppMode !== "files" && !rightWorkbenchOpen ? (
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

        {outlineOpen && visibleAppMode !== "files" && !rightWorkbenchOpen ? (
          <OutlinePane
            document={document}
            draftContent={draftContent}
            entries={activeDocumentEntries}
            readOnly={!activeWorkspaceCanModify}
            workspacePath={activeDocumentWorkspacePath}
            scratchpadWorkPath={primaryWorkspacePath}
            scratchpadSortKey={maruSettings.ui.scratchpadSortKey}
            scratchpadListHeight={layoutSettings.scratchpadListHeight}
            onScratchpadSortKeyChange={setScratchpadSortKey}
            onScratchpadListHeightChange={(scratchpadListHeight) =>
              updateLayoutSettings({ scratchpadListHeight })
            }
            activeLine={activeOutlineLine}
            onJumpToLine={jumpToOutlineLine}
            onClose={() => updateLayoutSettings({ outlineOpen: false })}
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
            explorerWorkspacePath={explorerWorkspacePath}
            explorerExpandedFolders={collapsedFileFolders}
            onExplorerExpandedFoldersChange={setCollapsedFileFolders}
            explorerSelectedPath={selectedPath}
            explorerLoading={
              explorerWorkspaceFilesState.loading ||
              explorerWorkspaceFilesState.refreshing ||
              shouldScanExplorerWorkspaceFiles
            }
            explorerReady={explorerWorkspaceFilesState.scanStatus === "ready"}
            explorerRefreshing={explorerWorkspaceFilesState.refreshing}
            onExplorerRefresh={() => {
              if (explorerWorkspacePath) {
                void refreshWorkspaceFiles(explorerWorkspacePath);
              }
            }}
            onOpenWorkspaceFile={(entry, line) =>
              void openWorkspaceFileEntry(entry, line)
            }
            explorerIncludeDotFolders={maruSettings.scan.includeDotFolders}
            onIgnoreWorkspaceEntry={(relPath) => void ignoreEntry(relPath)}
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
                  missions={trackedAgentMissions}
                  logLines={processingLogLines}
                  runtimeCommands={aiRuntimeCommands}
                  permissionMode={maruSettings.ai.permissionMode}
                  onRefresh={refreshProcessingMissions}
                  onStopMission={handleStopProcessingMission}
                  onMissionStarted={handleMeetingsMissionStarted}
                  onConfirmApproval={approvalGate.confirmApproval}
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
                documentMarkdown={draftContent || document?.content || ""}
              />
            }
          />
        ) : null}
        </div>

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
          activeSurface={maruSettings.ui.layout.toolPanelSurface}
          graphNode={panelGraphNode}
          graphTheme={maruSettings.graph.display.theme}
          onOpenChange={handleTerminalOpenChange}
          onHeightChange={handleTerminalHeightChange}
          onDockChange={dockTerminal}
          onWidthChange={handleTerminalWidthChange}
          onSplitOpenChange={handleTerminalSplitOpenChange}
          onSplitRatioChange={handleTerminalSplitRatioChange}
          onMaximizedChange={handleTerminalMaximizedChange}
          onSurfaceChange={handleToolPanelSurfaceChange}
          onTerminalThemeChange={handleTerminalThemeChange}
          onGraphThemeChange={handlePanelGraphThemeChange}
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
                            : updateToast.kind === "skillsAvailable"
                              ? t("updates.skillsAvailable", { version: updateToast.version })
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
                            : updateToast.kind === "skillsAvailable"
                              ? t("updates.skillsAvailable", { version: updateToast.version })
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
              {updateToast.kind === "skillsAvailable" ? (
                <button
                  type="button"
                  className="button button-ghost button-sm"
                  onClick={() => {
                    dismissUpdateToast();
                    openSettings("skills");
                  }}
                >
                  {t("updates.skillsOpen")}
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
                  onClick={dismissUpdateToast}
                  aria-label={t("app.errorClose")}
                  title={t("app.errorClose")}
                >
                  <X size={14} />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <AgentUsageBar
          commandOverrides={terminalRuntimeCommands}
          onOpenSettings={openSettings}
          onOpenAgents={() => setPersistedAppMode("agents")}
          workspaceName={explorerWorkspace?.label ?? null}
          workspacePath={explorerWorkspacePath ?? null}
          workspaceFileCount={
            explorerWorkspaceFilesState.scanStatus === "ready" ? fileEntries.length : null
          }
          workspaceDocumentCount={entries.length}
        />

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
                  onClick={cancelDestructiveAction}
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
          open={newDocumentDialog !== null}
          workspaceRoot={activeDocumentWorkspacePath}
          initialTitle={newDocumentDialog?.seed?.title ?? ""}
          initialRelPath={newDocumentDialog?.seed?.relPath ?? null}
          initialDocType={newDocumentDialog?.seed?.docType ?? "reference"}
          initialOpenLibrary={newDocumentDialog?.seed?.openLibrary ?? false}
          entries={activeDocumentEntries}
          onOpenChange={(open) => {
            if (!open) closeNewDocumentDialog();
          }}
          onCreate={createNew}
        />
        <AddWorkspaceDialog
          open={addWorkspaceDialog !== null}
          defaultVisibility={addWorkspaceDialog?.defaultVisibility ?? "private"}
          onOpenChange={(open) => {
            if (!open) closeAddWorkspaceDialog();
          }}
          onAdd={handleAddWorkspace}
          onRegisterWorkspace={handleRegisterWorkspace}
        />
        {approvalGate.dialog}
        <ComposeDialog
          open={composeSeed !== null}
          skills={skills}
          seed={composeSeed}
          onClose={closeCompose}
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
        {settingsOverlay ? (
          <Suspense fallback={null}>
            <LazySettingsSurface
              workPath={settingsWorkPath}
              settings={maruSettings}
              onSettingsChange={(next) => updateSettings(next, { flush: true })}
              onInboxRuntimeConfigChange={setInboxRuntimeConfig}
            />
          </Suspense>
        ) : null}
        <CommitDialog
          open={commitDialog !== null}
          vaultPath={commitDialog?.path ?? null}
          status={commitDialog?.status ?? null}
          aiRuntime={commitMessageRuntime.runtime}
          aiEnabled={commitMessageRuntime.enabled}
          aiCommandOverride={commitMessageRuntime.commandOverride}
          onConfirmApproval={approvalGate.confirmApproval}
          onClose={closeCommitDialog}
          onCommitted={() => setGitRefreshTick((n) => n + 1)}
        />
      </div>
    </LocaleContext.Provider>
  );
}
