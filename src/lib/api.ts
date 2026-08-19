import { Channel, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  MOCK_VAULT_PATH,
  mockCreateDocument,
  mockCreateVersion,
  mockDuplicateDocument,
  mockEntries,
  mockInboxDropItems,
  mockMeetingGuides,
  mockMeetingMetadata,
  mockMeetingNoteRows,
  mockTaskMetadata,
  mockTaskNoteRows,
  mockMoveDocument,
  mockSetActiveWorkspaceRoot,
  mockTrashDocument,
  mockVaultGraphFile,
  mockWorkspaceFiles,
  mockWorkspaceRegistry,
  readMockDocument,
} from "./fixtures";
import { getViewerCategory, type ViewerCategory } from "./binaryViewer";
import { denseMockEntries } from "./graph/fixtures";
import { invokeE2EOverride } from "./e2eInvoke";
import type {
  KakaoEnqueueResult,
  KakaoRelayEnvelope,
  KakaoRelayStatus,
  KakaoSendResult,
  KakaoStageResult,
} from "./kakaoRelay";
import type {
  CreatedDocument,
  DeletedDocument,
  DocumentPayload,
  FileQueueApplyItem,
  FileQueueApplyOutcome,
  FileQueueSourceInfo,
  FileStoreOperation,
  GitFileChange,
  GitSyncCommitPushResult,
  GitSyncPullResult,
  GitSyncScanResult,
  GitStatus,
  GmailMessage,
  GmailDecisionOutcome,
  GmailDecisionRequest,
  ProviderAuthStatus,
  OutlookMessage,
  OutlookDecisionOutcome,
  OutlookDecisionRequest,
  ProjectPickerEntry,
  StageOutcome,
  TelegramMessage,
  TelegramFetchOptions,
  TelegramMonitorConfigSave,
  TelegramMonitorConfigView,
  TelegramPollingStatus,
  TelegramDecisionOutcome,
  ApprovalDecision,
  ApprovalRequest,
  InboxAcceptRequest,
  InboxApplyDecision,
  InboxClassification,
  InboxDecisionOutcome,
  InboxDropItem,
  InboxDropStageOutcome,
  InboxEntry,
  InboxIntakeMode,
  InboxProcessedItem,
  InboxProcessedItemDetail,
  InboxProcessedSnapshot,
  InboxProcessedStatus,
  InboxSourceRun,
  InboxDropStageRequest,
  InboxRuntimeConfig,
  InboxSettings,
  InboxTrashOutcome,
  InboxTrashTarget,
  MissionLogTail,
  MissionRecord,
  MeetingGuides,
  MeetingMetadata,
  MeetingNoteRow,
  MeetingsLogLineRecord,
  MemoDocument,
  MemoFormat,
  ScratchpadCollection,
  ScratchpadDocument,
  ScratchpadEntry,
  DraftDocument,
  DraftEntry,
  DraftImportance,
  DraftKind,
  DraftPromoteTarget,
  DraftStatus,
  GapLogEntry,
  GapReport,
  GapReportSummary,
  DocumentRefMap,
  SchedulerSchedule,
  SchedulerScheduleInput,
  ScratchpadSource,
  IdeationStage,
  TempCleanupCandidate,
  TempCleanupResult,
  TempCleanupSelection,
  ScratchpadMigrationResult,
  StoredFileOutcome,
  ContentSearchOptions,
  ContentSearchResult,
  CreateTaskDraft,
  TaskBucket,
  TaskDetailsPatch,
  TaskMetadata,
  TaskNoteRow,
  TaskSchedulePatch,
  TaskStatus,
  TasksLogLineRecord,
  ScanOptions,
  VaultEntry,
  WorkspaceEntriesSnapshot,
  WorkspaceEntryNode,
  WorkspaceFileEntry,
  WorkspaceMutationOutcome,
  WorkspaceRegistry,
  WorkspaceRootEntry,
  WorkspaceVisibility,
  VersionSnapshot,
} from "./types";
import type { TerminalKind } from "./terminal";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

export const DEFAULT_INBOX_SETTINGS: InboxSettings = {
  inboxRoot: "inbox/downloads",
  sources: ["outlook", "sharepoint", "gmail", "kakao", "telegram", "downloads"],
  gwsPath: null,
};

export const DEFAULT_INBOX_RUNTIME_CONFIG: InboxRuntimeConfig = {
  root: "inbox",
  schema_version: 1,
  paths: {
    drop: "drop",
    items: "items",
    pending: "items/pending",
    done: "items/done",
    failed: "items/failed",
    duplicate: "items/duplicate",
    state: "_state",
    receipts: "_state/index.jsonl",
  },
  naming: {
    item_id_template: "{date}-{channel}-{slug}",
    raw_dir: "raw",
    manifest_file: "manifest.yaml",
    extracted_file: "extracted.md",
    summary_file: "summary.md",
    route_file: "route.md",
  },
  file_drop: {
    channel: "incoming",
    drop_path: "drop/incoming",
    operation: "copy",
  },
  gmail: {
    enabled: true,
    scan_window_days: 14,
    max_results: 20,
    auto_refresh_ttl_seconds: 300,
    unread_only: true,
    query: "",
    gws_path: null,
  },
  dedupe: { default: "sha256" },
  channels: {
    incoming: { provider: "local", kind: "file", drop_paths: ["drop/incoming"], dedupe: "sha256" },
    arc: { provider: "local", kind: "file", drop_paths: ["drop/arc"], dedupe: "sha256" },
    atlas: { provider: "local", kind: "file", drop_paths: ["drop/atlas"], dedupe: "sha256" },
    chrome: { provider: "local", kind: "file", drop_paths: ["drop/chrome"], dedupe: "sha256" },
    flow: { provider: "local", kind: "file", drop_paths: ["drop/flow"], dedupe: "sha256" },
    safari: { provider: "local", kind: "file", drop_paths: ["drop/safari"], dedupe: "sha256" },
    others: { provider: "local", kind: "file", drop_paths: ["drop/others"], dedupe: "sha256" },
    transcripts: { provider: "local", kind: "transcript", drop_paths: ["drop/transcripts"], dedupe: "sha256" },
    mso: {
      provider: "mso",
      skill: "io-mso",
      kind: "bundle",
      drop_paths: ["drop/mso"],
      source_kinds: { mail: "message", sharepoint: "document", onedrive: "document" },
      dedupe: "provider-native",
    },
    gws: {
      provider: "gws",
      skill: "io-gws",
      kind: "bundle",
      drop_paths: ["drop/gws"],
      source_kinds: { mail: "message", drive: "document", gdrive: "document" },
      dedupe: "provider-native",
    },
    telegram: {
      provider: "telegram",
      skill: "io-telegram",
      kind: "bundle",
      drop_paths: ["drop/telegram"],
      source_kinds: { messages: "message", files: "attachment" },
      dedupe: "provider-native",
    },
    kakao: {
      provider: "kakao",
      skill: "io-kakao",
      kind: "bundle",
      drop_paths: ["drop/kakao"],
      source_kinds: { messages: "message", files: "attachment", exports: "data" },
      dedupe: "sha256",
    },
  },
  processing: {
    require_confirm_before_route: true,
    summary_schema: "inbox-summary/v1",
  },
  hooks: {},
};

export async function getSampleWorkspacePath(): Promise<string> {
  if (!isTauri()) return MOCK_VAULT_PATH;
  return invoke<string>("sample_workspace_path");
}

export async function chooseVaultDirectory(title: string): Promise<string | null> {
  if (!isTauri()) return MOCK_VAULT_PATH;
  const selected = await open({
    directory: true,
    multiple: false,
    title,
  });
  return typeof selected === "string" ? selected : null;
}

export async function chooseWorkspaceDirectory(title: string): Promise<string | null> {
  return chooseVaultDirectory(title);
}

export async function chooseFiles(title: string): Promise<string[]> {
  if (!isTauri()) return [];
  const selected = await open({
    directory: false,
    multiple: true,
    title,
  });
  if (Array.isArray(selected)) return selected.filter((item): item is string => typeof item === "string");
  return typeof selected === "string" ? [selected] : [];
}

export async function chooseDirectories(title: string): Promise<string[]> {
  if (!isTauri()) return [];
  const selected = await open({
    directory: true,
    multiple: true,
    title,
  });
  if (Array.isArray(selected)) return selected.filter((item): item is string => typeof item === "string");
  return typeof selected === "string" ? [selected] : [];
}

export async function chooseSaveFile(
  title: string,
  defaultPath?: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await save({
    title,
    defaultPath,
  });
  return typeof selected === "string" ? selected : null;
}

export async function scanVault(vaultPath: string, scanOptions?: ScanOptions): Promise<VaultEntry[]> {
  if (!isTauri()) {
    // e2e opt-in: exercise the dense-graph path in web mode without a backend.
    try {
      if (
        typeof localStorage !== "undefined" &&
        localStorage.getItem("maru:e2e:graph-dense") === "1"
      ) {
        return denseMockEntries(vaultPath);
      }
    } catch {
      /* ignore */
    }
    return mockEntries(vaultPath);
  }
  return invoke<VaultEntry[]>("scan_vault", { vaultPath, scanOptions: scanOptions ?? null });
}

/** Delta-targeted scan: only the touched rel paths (from the vault watcher).
 *  Missing/excluded paths come back absent — the caller treats absence as
 *  removal when merging the delta into the workspace entries. */
export async function scanVaultPaths(
  vaultPath: string,
  relPaths: readonly string[],
  scanOptions?: ScanOptions,
): Promise<VaultEntry[]> {
  if (!isTauri()) {
    // Web/e2e mode has no real watcher; mirror the mock scan, filtered down
    // to the touched rel paths.
    const touched = new Set(relPaths);
    const all = await scanVault(vaultPath, scanOptions);
    return all.filter((entry) => touched.has(entry.relPath));
  }
  return invoke<VaultEntry[]>("scan_vault_paths", {
    vaultPath,
    relPaths,
    scanOptions: scanOptions ?? null,
  });
}

export async function startVaultWatcher(workspacePath: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("start_vault_watcher", { workspacePath });
}

export async function stopVaultWatcher(): Promise<void> {
  if (!isTauri()) return;
  await invoke("stop_vault_watcher");
}

export async function scanWorkspaceFiles(
  vaultPath: string,
  scanOptions?: ScanOptions,
): Promise<WorkspaceFileEntry[]> {
  if (!isTauri()) return mockWorkspaceFiles(vaultPath);
  return invoke<WorkspaceFileEntry[]>("scan_workspace_files", { vaultPath, scanOptions: scanOptions ?? null });
}

export async function scanWorkspaceEntries(
  vaultPath: string,
  scanOptions?: ScanOptions,
): Promise<WorkspaceEntriesSnapshot> {
  if (!isTauri()) {
    const entries: WorkspaceEntryNode[] = mockWorkspaceFiles(vaultPath).map((entry) => ({
      kind: "file",
      targetKind: null,
      parentRelPath: entry.relPath.split("/").slice(0, -1).join("/"),
      ...entry,
    }));
    const directories = new Map<string, WorkspaceEntryNode>();
    for (const entry of entries) {
      const parts = entry.parentRelPath.split("/").filter(Boolean);
      for (let index = 0; index < parts.length; index += 1) {
        const relPath = parts.slice(0, index + 1).join("/");
        if (directories.has(relPath)) continue;
        directories.set(relPath, {
          kind: "directory",
          targetKind: null,
          path: `${vaultPath.replace(/\/$/, "")}/${relPath}`,
          relPath,
          parentRelPath: parts.slice(0, index).join("/"),
          name: parts[index],
          extension: null,
          fileKind: "directory",
          sizeBytes: 0,
          updatedAt: null,
          gitTracked: false,
          binary: false,
        });
      }
    }
    return {
      revision: `mock:${entries.length}`,
      entries: [...directories.values(), ...entries].sort((a, b) =>
        a.relPath.localeCompare(b.relPath),
      ),
    };
  }
  return invoke<WorkspaceEntriesSnapshot>("scan_workspace_entries", {
    vaultPath,
    scanOptions: scanOptions ?? null,
  });
}

export async function scanMeetingNotes(
  workPath: string,
  root?: string | null,
): Promise<MeetingNoteRow[]> {
  if (!isTauri()) return mockMeetingNoteRows(workPath);
  return invoke<MeetingNoteRow[]>("scan_meeting_notes", { workPath, root: root ?? null });
}

export async function readMeetingMetadata(
  workPath: string,
  relPath: string,
): Promise<MeetingMetadata> {
  if (!isTauri()) return mockMeetingMetadata(relPath);
  return invoke<MeetingMetadata>("read_meeting_metadata", { workPath, relPath });
}

export async function readMeetingGuides(workPath: string): Promise<MeetingGuides> {
  if (!isTauri()) return mockMeetingGuides();
  return invoke<MeetingGuides>("read_meeting_guides", { workPath });
}

export async function appendMeetingsLog(workPath: string, line: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("append_meetings_log", { workPath, line });
}

export async function readMeetingsLog(
  workPath: string,
  options?: { limit?: number | null; eventFilter?: string[] | null },
): Promise<MeetingsLogLineRecord[]> {
  if (!isTauri()) return [];
  return invoke<MeetingsLogLineRecord[]>("read_meetings_log", {
    workPath,
    limit: options?.limit ?? null,
    eventFilter: options?.eventFilter ?? null,
  });
}

export async function searchCalendarNotes(
  workPath: string,
  roots: string[],
  query: string,
): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("search_calendar_notes", { workPath, roots, query });
}

export async function searchWorkspaceContents(
  workspacePath: string,
  query: string,
  options?: ContentSearchOptions,
): Promise<ContentSearchResult> {
  if (!isTauri()) {
    return { files: [], fileCount: 0, totalMatches: 0, truncated: false };
  }
  return invoke<ContentSearchResult>("search_workspace_contents", {
    workspacePath,
    query,
    options: options ?? null,
  });
}

export async function scanTaskNotes(
  workPath: string,
  root?: string | null,
): Promise<TaskNoteRow[]> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<TaskNoteRow[]>("scan_task_notes", {
      workPath,
      root: root ?? null,
    });
    if (override) return override;
    return mockTaskNoteRows(workPath);
  }
  return invoke<TaskNoteRow[]>("scan_task_notes", { workPath, root: root ?? null });
}

export async function readTaskMetadata(
  workPath: string,
  relPath: string,
): Promise<TaskMetadata> {
  if (!isTauri()) return mockTaskMetadata(relPath);
  return invoke<TaskMetadata>("read_task_metadata", { workPath, relPath });
}

export async function createTaskNote(
  workPath: string,
  draft: CreateTaskDraft,
  root?: string | null,
): Promise<TaskNoteRow> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<TaskNoteRow>("create_task_note", {
      workPath,
      draft,
      root: root ?? null,
    });
    if (override) return override;
    return mockTaskNoteRows(workPath)[0];
  }
  return invoke<TaskNoteRow>("create_task_note", { workPath, draft, root: root ?? null });
}

export async function updateTaskStatus(
  workPath: string,
  relPath: string,
  status: TaskStatus,
  root?: string | null,
): Promise<TaskNoteRow> {
  if (!isTauri()) return mockTaskNoteRows(workPath)[0];
  return invoke<TaskNoteRow>("update_task_status", {
    workPath,
    relPath,
    status,
    root: root ?? null,
  });
}

export async function updateTaskScheduleFields(
  workPath: string,
  relPath: string,
  fields: TaskSchedulePatch,
): Promise<TaskNoteRow> {
  if (!isTauri()) return mockTaskNoteRows(workPath)[0];
  return invoke<TaskNoteRow>("update_task_schedule_fields", { workPath, relPath, fields });
}

export async function updateTaskDetails(
  workPath: string,
  relPath: string,
  fields: TaskDetailsPatch,
  root?: string | null,
): Promise<TaskNoteRow> {
  if (!isTauri()) return mockTaskNoteRows(workPath)[0];
  return invoke<TaskNoteRow>("update_task_details", {
    workPath,
    relPath,
    fields,
    root: root ?? null,
  });
}

export async function moveTaskNote(
  workPath: string,
  relPath: string,
  targetBucket: TaskBucket,
  root?: string | null,
): Promise<TaskNoteRow> {
  if (!isTauri()) return mockTaskNoteRows(workPath)[0];
  return invoke<TaskNoteRow>("move_task_note", {
    workPath,
    relPath,
    targetBucket,
    root: root ?? null,
  });
}

export async function appendTasksLog(workPath: string, line: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("append_tasks_log", { workPath, line });
}

export async function readTasksLog(
  workPath: string,
  options?: { limit?: number | null; eventFilter?: string[] | null },
): Promise<TasksLogLineRecord[]> {
  if (!isTauri()) return [];
  return invoke<TasksLogLineRecord[]>("read_tasks_log", {
    workPath,
    limit: options?.limit ?? null,
    eventFilter: options?.eventFilter ?? null,
  });
}

export async function readVaultCache(vaultPath: string): Promise<VaultEntry[] | null> {
  if (!isTauri()) return mockEntries(vaultPath);
  return invoke<VaultEntry[] | null>("read_vault_cache", { vaultPath });
}

export interface VaultSchemaIssue {
  field: string;
  code: string;
  message: string;
}

export interface VaultSchemaReport {
  valid: boolean;
  issues: VaultSchemaIssue[];
}

/** Stateless frontmatter schema check for managed-vault notes (V2 contract:
 *  description ≤200 · type 8종 · domain 6종 · topics wikilink 배열). Paths
 *  outside notes/**\/*.md always report valid. */
export async function vaultValidateNote(
  content: string,
  relPath: string,
): Promise<VaultSchemaReport> {
  if (!isTauri()) return { valid: true, issues: [] };
  return invoke<VaultSchemaReport>("vault_validate_note", { content, relPath });
}

/** Community-overlay JSON (`<vault>/reports/vault-graph.json`, built by the
 *  weekly /vault-graph ritual; the vault is the workspace root or a `vault/`
 *  submodule inside it). null = absent or unavailable — the graph mode degrades
 *  to the live layer. Corrupt file rejects with the reason. */
export async function vaultGraphRead(
  vaultPath: string,
  source: "vault" | "workspace" | "all" = "vault",
): Promise<import("./graph/model").VaultGraphFile | null> {
  if (!isTauri()) {
    // e2e opt-in: exercise the enriched path in web mode without a backend.
    try {
      if (
        typeof localStorage !== "undefined" &&
        localStorage.getItem("maru:e2e:graph-overlay") === "1"
      ) {
        return mockVaultGraphFile();
      }
    } catch {
      /* ignore */
    }
    return null;
  }
  return invoke<import("./graph/model").VaultGraphFile | null>("vault_graph_read", {
    vaultPath,
    source,
  });
}

/** `<workspace>/vault` when the vault is a submodule inside the workspace, else
 *  null (the workspace is its own vault). Drives the Vault graph source. */
export async function vaultGraphRoot(workspace: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("vault_graph_root", { workspace });
}

export interface GraphLayoutCache {
  version: number;
  positions: Record<string, [number, number]>;
  pinnedIds?: string[];
}

const GRAPH_LAYOUT_FALLBACK_KEY = "maru:graph-layout";

/** Read the disposable graph-layout warm-start cache. Non-Tauri (browser dev /
 *  e2e) falls back to localStorage; any read failure degrades to null. */
export async function vaultGraphLayoutRead(
  workspace: string,
): Promise<GraphLayoutCache | null> {
  if (!isTauri()) {
    try {
      const raw = localStorage.getItem(`${GRAPH_LAYOUT_FALLBACK_KEY}:${workspace}`);
      return raw ? (JSON.parse(raw) as GraphLayoutCache) : null;
    } catch {
      return null;
    }
  }
  try {
    return await invoke<GraphLayoutCache | null>("vault_graph_layout_read", { workspace });
  } catch {
    return null;
  }
}

export async function vaultGraphLayoutSave(
  workspace: string,
  cache: GraphLayoutCache,
): Promise<void> {
  if (!isTauri()) {
    try {
      localStorage.setItem(`${GRAPH_LAYOUT_FALLBACK_KEY}:${workspace}`, JSON.stringify(cache));
    } catch {
      /* best-effort cache; ignore quota errors */
    }
    return;
  }
  try {
    await invoke("vault_graph_layout_save", { workspace, cache });
  } catch {
    /* disposable cache — never surface a write failure */
  }
}

export interface GraphLinkRequest {
  sourceWorkspace: string;
  sourceDocument: string;
  targetWorkspace: string;
  targetDocument: string;
  relation: string;
  reciprocal: boolean;
}

export interface GraphLinkPatchPreview {
  workspace: string;
  document: string;
  field: string;
  wikilink: string;
  expectedRevision: string;
  beforeValues: string[];
  afterValues: string[];
  changed: boolean;
}

export interface GraphLinkProposal {
  request: GraphLinkRequest;
  patches: GraphLinkPatchPreview[];
  changed: boolean;
}

export async function graphLinkPreview(request: GraphLinkRequest): Promise<GraphLinkProposal> {
  if (!isTauri()) {
    return {
      request,
      changed: true,
      patches: [{
        workspace: request.sourceWorkspace,
        document: request.sourceDocument,
        field: request.relation,
        wikilink: `[[${request.targetDocument.replace(/\.(md|markdown|mdx)$/i, "")}]]`,
        expectedRevision: "browser-preview",
        beforeValues: [],
        afterValues: [`[[${request.targetDocument.replace(/\.(md|markdown|mdx)$/i, "")}]]`],
        changed: true,
      }],
    };
  }
  return invoke<GraphLinkProposal>("graph_link_preview", { request });
}

export async function graphLinkApply(proposal: GraphLinkProposal): Promise<{ documents: DocumentPayload[] }> {
  if (!isTauri()) return { documents: [] };
  return invoke<{ documents: DocumentPayload[] }>("graph_link_apply", { proposal });
}

export async function scanInboxDrop(vaultPath: string, scanOptions?: ScanOptions): Promise<InboxDropItem[]> {
  if (!isTauri()) return mockInboxDropItems();
  return invoke<InboxDropItem[]>("scan_inbox_drop", { vaultPath, scanOptions: scanOptions ?? null });
}

export async function scanInboxEntries(
  workPath: string,
  scanOptions?: ScanOptions,
  intakeMode?: InboxIntakeMode | "all",
): Promise<InboxEntry[]> {
  const args = {
    workPath,
    scanOptions: scanOptions ?? null,
    intakeMode: intakeMode ?? null,
  };
  if (!isTauri()) {
    const override = await invokeE2EOverride<InboxEntry[]>("scan_inbox_entries", args);
    if (override) return override;
    return [];
  }
  return invoke<InboxEntry[]>("scan_inbox_entries", args);
}

export interface InboxProcessedQuery {
  workPath: string;
  channel: string | null;
  statuses: InboxProcessedStatus[];
  query: string | null;
  limit: number;
}

export async function scanInboxProcessedItems({
  workPath,
  channel,
  statuses,
  query,
  limit,
}: InboxProcessedQuery): Promise<InboxProcessedItem[]> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<InboxProcessedItem[]>(
      "scan_inbox_processed_items",
      { workPath, channel, statuses, query, limit },
    );
    if (override) return override;
    return [];
  }
  return invoke<InboxProcessedItem[]>("scan_inbox_processed_items", {
    workPath,
    channel,
    statuses,
    query,
    limit,
  });
}

export async function scanInboxProcessedSnapshot({
  workPath,
  channel,
  statuses,
  query,
  limit,
}: InboxProcessedQuery): Promise<InboxProcessedSnapshot> {
  const args = { workPath, channel, statuses, query, limit };
  if (!isTauri()) {
    const override = await invokeE2EOverride<InboxProcessedSnapshot>(
      "scan_inbox_processed_snapshot",
      args,
    );
    if (override) return override;
    return { items: [], counts: {} };
  }
  return invoke<InboxProcessedSnapshot>("scan_inbox_processed_snapshot", args);
}

export async function readInboxProcessedItem(
  workPath: string,
  itemDir: string,
): Promise<InboxProcessedItemDetail> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<InboxProcessedItemDetail>(
      "read_inbox_processed_item",
      { workPath, itemDir },
    );
    if (override) return override;
    throw new Error("Processed inbox item details require the Tauri shell.");
  }
  return invoke<InboxProcessedItemDetail>("read_inbox_processed_item", { workPath, itemDir });
}

export async function readInboxSourceRuns(workPath: string): Promise<InboxSourceRun[]> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<InboxSourceRun[]>("read_inbox_source_runs", {
      workPath,
    });
    if (override) return override;
    return [];
  }
  return invoke<InboxSourceRun[]>("read_inbox_source_runs", { workPath });
}

export async function countInboxProcessedByChannel(
  workPath: string,
): Promise<Record<string, number>> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<Record<string, number>>(
      "count_inbox_processed_by_channel",
      { workPath },
    );
    if (override) return override;
    return {};
  }
  return invoke<Record<string, number>>("count_inbox_processed_by_channel", { workPath });
}

export async function trashInboxItems(
  workPath: string,
  targets: InboxTrashTarget[],
  approvalId: string,
): Promise<InboxTrashOutcome[]> {
  if (!isTauri()) {
    return targets.map((target) => ({
      id: target.id,
      kind: target.kind,
      originalPath: target.path,
      ok: true,
      error: null,
    }));
  }
  return invoke<InboxTrashOutcome[]>("trash_inbox_items", { workPath, targets, approvalId });
}

export async function stageInboxDropFiles(
  workPath: string,
  request: InboxDropStageRequest,
): Promise<InboxDropStageOutcome[]> {
  if (!isTauri()) {
    return request.sourcePaths.map((sourcePath) => ({
      id: sourcePath,
      sourcePath,
      targetPath: `${workPath}/inbox/${request.dropPath ?? "drop/incoming"}/${sourcePath.split("/").pop() ?? "file"}`,
      fileName: sourcePath.split("/").pop() ?? "file",
      channel: request.channel ?? "incoming",
      dropPath: request.dropPath ?? "drop/incoming",
      ok: true,
      error: null,
    }));
  }
  return invoke<InboxDropStageOutcome[]>("stage_inbox_drop_files", {
    workPath,
    channel: request.channel ?? null,
    dropPath: request.dropPath ?? null,
    sourcePaths: request.sourcePaths,
  });
}

export async function readInboxRuntimeConfig(workPath: string): Promise<InboxRuntimeConfig> {
  if (!isTauri()) return DEFAULT_INBOX_RUNTIME_CONFIG;
  return invoke<InboxRuntimeConfig>("read_inbox_runtime_config", { workPath });
}

export async function saveInboxRuntimeConfig(
  workPath: string,
  config: InboxRuntimeConfig,
): Promise<InboxRuntimeConfig> {
  if (!isTauri()) return config;
  return invoke<InboxRuntimeConfig>("save_inbox_runtime_config", { workPath, config });
}

export async function prepareApproval(input: {
  kind: string;
  summary: string;
  target?: string | null;
  payloadPreview?: string | null;
}): Promise<ApprovalRequest> {
  if (!isTauri()) {
    return {
      id: `mock-approval-${Date.now()}`,
      kind: input.kind,
      summary: input.summary,
      target: input.target ?? null,
      payloadPreview: input.payloadPreview ?? null,
      autoApproved: false,
    };
  }
  return invoke<ApprovalRequest>("prepare_approval", {
    kind: input.kind,
    summary: input.summary,
    target: input.target ?? null,
    payloadPreview: input.payloadPreview ?? null,
  });
}

export async function recordApproval(
  id: string,
  decision: ApprovalDecision,
  rememberKind = false,
): Promise<ApprovalRequest> {
  if (!isTauri()) {
    return {
      id,
      kind: "mock",
      summary: "",
      target: null,
      payloadPreview: null,
      autoApproved: false,
    };
  }
  return invoke<ApprovalRequest>("record_approval", { id, decision, rememberKind });
}

export async function acceptInboxItem(
  vaultPath: string,
  id: string,
  targetFolder: string,
  approvalId: string,
): Promise<InboxDecisionOutcome> {
  if (!isTauri()) {
    return {
      id,
      decision: "accepted",
      sourcePath: id,
      targetPath: `${targetFolder}/${id.split("/").pop() ?? "file"}`,
      fileName: id.split("/").pop() ?? "file",
      ok: true,
      error: null,
    };
  }
  return invoke<InboxDecisionOutcome>("accept_inbox_item", {
    vaultPath,
    id,
    targetFolder,
    approvalId,
  });
}

export async function acceptInboxItems(
  vaultPath: string,
  items: InboxAcceptRequest[],
  approvalId: string,
): Promise<InboxDecisionOutcome[]> {
  if (!isTauri()) {
    return items.map((item) => ({
      id: item.id,
      decision: "accepted",
      sourcePath: item.id,
      targetPath: `${item.targetFolder ?? "."}/${item.id.split("/").pop() ?? "file"}`,
      fileName: item.id.split("/").pop() ?? "file",
      ok: true,
      error: null,
    }));
  }
  return invoke<InboxDecisionOutcome[]>("accept_inbox_items", { vaultPath, items, approvalId });
}

export async function applyInboxDecisions(
  workPath: string,
  decisions: InboxApplyDecision[],
  approvalId: string,
): Promise<InboxDecisionOutcome[]> {
  if (!isTauri()) {
    return decisions.map((decision) => {
      const name = decision.itemDir.split("/").pop() ?? "item";
      const accepted = decision.decision === "accept";
      return {
        id: decision.itemDir,
        decision: accepted ? "accepted" : "rejected",
        sourcePath: decision.itemDir,
        targetPath: accepted ? `inbox/items/done/${name}` : `rejected/${name}`,
        fileName: name,
        ok: true,
        error: null,
      };
    });
  }
  return invoke<InboxDecisionOutcome[]>("apply_inbox_decisions", { workPath, decisions, approvalId });
}

export async function rejectInboxItem(
  vaultPath: string,
  id: string,
  approvalId: string,
): Promise<InboxDecisionOutcome> {
  if (!isTauri()) {
    return {
      id,
      decision: "rejected",
      sourcePath: id,
      targetPath: `inbox/rejected/${id.split("/").pop() ?? "file"}`,
      fileName: id.split("/").pop() ?? "file",
      ok: true,
      error: null,
    };
  }
  return invoke<InboxDecisionOutcome>("reject_inbox_item", { vaultPath, id, approvalId });
}

export async function rejectInboxItems(
  vaultPath: string,
  ids: string[],
  approvalId: string,
): Promise<InboxDecisionOutcome[]> {
  if (!isTauri()) {
    return ids.map((id) => ({
      id,
      decision: "rejected",
      sourcePath: id,
      targetPath: `inbox/rejected/${id.split("/").pop() ?? "file"}`,
      fileName: id.split("/").pop() ?? "file",
      ok: true,
      error: null,
    }));
  }
  return invoke<InboxDecisionOutcome[]>("reject_inbox_items", { vaultPath, ids, approvalId });
}

export async function readDocument(
  vaultPath: string,
  documentPath: string,
): Promise<DocumentPayload> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<DocumentPayload>("read_document", {
      vaultPath,
      documentPath,
    });
    if (override) return override;
    return readMockDocument(documentPath);
  }
  return invoke<DocumentPayload>("read_document", { vaultPath, documentPath });
}

export async function saveDocument(
  vaultPath: string,
  documentPath: string,
  content: string,
  expectedRevision?: string | null,
): Promise<DocumentPayload> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<DocumentPayload>("save_document", {
      vaultPath,
      documentPath,
      content,
      expectedRevision: expectedRevision ?? null,
    });
    if (override) return override;
    const doc = readMockDocument(documentPath);
    doc.content = content;
    doc.body = content.replace(/^---[\s\S]*?---\n/, "");
    return doc;
  }
  return invoke<DocumentPayload>("save_document", {
    vaultPath,
    documentPath,
    content,
    expectedRevision: expectedRevision ?? null,
  });
}

/** Patch a single frontmatter field while preserving order + comments of
 *  every other key. Pass `value: null` to delete. */
export async function updateFrontmatterField(
  vaultPath: string,
  documentPath: string,
  key: string,
  value: string | string[] | number | boolean | null,
  expectedRevision?: string | null,
): Promise<DocumentPayload> {
  if (!isTauri()) {
    const doc = readMockDocument(documentPath);
    return doc;
  }
  return invoke<DocumentPayload>("update_frontmatter_field", {
    vaultPath,
    documentPath,
    key,
    value,
    expectedRevision: expectedRevision ?? null,
  });
}

/**
 * Optional Hub-driven frontmatter prefill values.
 *
 * Mirrors `document::CreateDocumentExtras` on the Rust side. Maru sends
 * these via `create_document` so the new file's frontmatter carries a
 * proper `template_id` / `template_slug` / `template_version` /
 * `business_unit` / `program_id` / `guideline_ids` block alongside the
 * standard `type` → `status` → `created_at` → `updated_at` → `id` fields.
 * (Phase 4 W7 replaces the W5 HTML-comment provenance trailer.)
 */
export interface CreateDocumentExtras {
  templateId?: string;
  templateSlug?: string;
  templateVersion?: number;
  guidelineIds?: string[];
  businessUnit?: string;
  programId?: string;
}

export async function createDocument(
  vaultPath: string,
  title: string,
  docType: string,
  body: string,
  targetRelPath?: string | null,
  extras?: CreateDocumentExtras,
): Promise<CreatedDocument> {
  if (!isTauri()) return mockCreateDocument(title, docType, body);
  return invoke<CreatedDocument>("create_document", {
    vaultPath,
    title,
    docType,
    body,
    targetRelPath: targetRelPath ?? null,
    extras: extras ?? null,
  });
}

export async function createVersion(
  vaultPath: string,
  documentPath: string,
  title: string,
  content: string,
  summary: string,
): Promise<VersionSnapshot> {
  if (!isTauri()) return mockCreateVersion(title);
  return invoke<VersionSnapshot>("create_version", {
    vaultPath,
    documentPath,
    title,
    content,
    summary,
  });
}

export async function moveDocument(
  vaultPath: string,
  documentPath: string,
  targetRelPath: string,
): Promise<DocumentPayload> {
  if (!isTauri()) return mockMoveDocument(documentPath, targetRelPath);
  return invoke<DocumentPayload>("move_document", {
    vaultPath,
    documentPath,
    targetRelPath,
  });
}

export async function duplicateDocument(
  vaultPath: string,
  documentPath: string,
): Promise<DocumentPayload> {
  if (!isTauri()) return mockDuplicateDocument(documentPath);
  return invoke<DocumentPayload>("duplicate_document", { vaultPath, documentPath });
}

export async function trashDocument(
  vaultPath: string,
  documentPath: string,
): Promise<DeletedDocument> {
  if (!isTauri()) return mockTrashDocument(documentPath);
  return invoke<DeletedDocument>("trash_document", { vaultPath, documentPath });
}

// === Workspace registry ===

export async function listWorkspaceRoots(): Promise<WorkspaceRegistry> {
  if (!isTauri()) return mockWorkspaceRegistry();
  return invoke<WorkspaceRegistry>("list_workspace_roots");
}

export async function addWorkspaceRoot(
  entry: WorkspaceRootEntry,
): Promise<WorkspaceRegistry> {
  if (!isTauri()) return mockWorkspaceRegistry();
  return invoke<WorkspaceRegistry>("add_workspace_root", { entry });
}

export async function removeWorkspaceRoot(path: string): Promise<WorkspaceRegistry> {
  if (!isTauri()) return mockWorkspaceRegistry();
  return invoke<WorkspaceRegistry>("remove_workspace_root", { path });
}

export async function setActiveWorkspaceRoot(
  path: string,
  visibility: WorkspaceVisibility,
): Promise<WorkspaceRegistry> {
  if (!isTauri()) return mockSetActiveWorkspaceRoot(path, visibility);
  return invoke<WorkspaceRegistry>("set_active_workspace_root", { path, visibility });
}

export async function refreshWorkspaceCapabilities(path: string): Promise<WorkspaceRegistry> {
  if (!isTauri()) return mockWorkspaceRegistry();
  return invoke<WorkspaceRegistry>("refresh_workspace_capabilities", { path });
}

// === Git ===

export async function gitStatus(vaultPath: string): Promise<GitStatus> {
  if (!isTauri()) {
    return { isRepo: false, modified: 0, staged: 0, untracked: 0, untrackedKnown: true, clean: true, branch: null };
  }
  return invoke<GitStatus>("git_status", { vaultPath });
}

export async function gitCommit(
  vaultPath: string,
  message: string,
  paths?: string[],
): Promise<GitStatus> {
  if (!isTauri()) {
    return { isRepo: false, modified: 0, staged: 0, untracked: 0, untrackedKnown: true, clean: true, branch: null };
  }
  return invoke<GitStatus>("git_commit", { vaultPath, message, paths: paths ?? null });
}

export async function gitGenerateCommitMessage(
  vaultPath: string,
  paths: string[],
  runtime: AgentProvider,
  commandOverride?: string | null,
): Promise<string> {
  if (!isTauri()) return "chore(workspace): update selected changes";
  return invoke<string>("git_generate_commit_message", {
    vaultPath,
    paths,
    runtime,
    commandOverride: commandOverride ?? null,
  });
}

export async function gitSyncScan(
  vaultPath: string,
  includeExcluded = false,
): Promise<GitSyncScanResult> {
  if (!isTauri()) {
    return { syncRoot: vaultPath, confirmBeforeCommit: true, repos: [], excluded: [] };
  }
  return invoke<GitSyncScanResult>("git_sync_scan", {
    vaultPath,
    includeExcluded,
  });
}

export async function gitSyncPullRebase(repoPath: string): Promise<GitSyncPullResult> {
  if (!isTauri()) {
    return { repoPath, stashed: false, stdout: "", stderr: "" };
  }
  return invoke<GitSyncPullResult>("git_sync_pull_rebase", { repoPath });
}

export async function gitSyncCommitPush(params: {
  repoPath: string;
  message: string;
  paths?: string[] | null;
  approvalId: string;
}): Promise<GitSyncCommitPushResult> {
  if (!isTauri()) {
    return {
      repoPath: params.repoPath,
      committed: true,
      pushed: true,
      commitStdout: "",
      pushStdout: "",
    };
  }
  return invoke<GitSyncCommitPushResult>("git_sync_commit_push", {
    repoPath: params.repoPath,
    message: params.message,
    paths: params.paths ?? null,
    approvalId: params.approvalId,
  });
}

export async function gitChanges(vaultPath: string): Promise<GitFileChange[]> {
  if (!isTauri()) return [];
  return invoke<GitFileChange[]>("git_changes", { vaultPath });
}

export async function gitDiff(vaultPath: string, filePath: string): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("git_diff", { vaultPath, filePath });
}

export async function revealInFileManager(
  vaultPath: string,
  targetPath: string,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Reveal in file manager requires the Tauri app.");
  }
  await invoke("reveal_in_file_manager", { vaultPath, targetPath });
}

export async function openInFileManager(
  vaultPath: string,
  targetPath: string,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Open in file manager requires the Tauri app.");
  }
  await invoke("open_in_file_manager", { vaultPath, targetPath });
}

export async function applyFileQueue(
  vaultPath: string,
  items: FileQueueApplyItem[],
): Promise<FileQueueApplyOutcome[]> {
  if (!isTauri()) {
    return items.map((item) => {
      const fileName = item.sourcePath.split("/").pop() ?? "file";
      return {
        id: item.id,
        sourcePath: item.sourcePath,
        targetPath: `${item.targetDir.replace(/\/$/, "")}/${fileName}`,
        fileName,
        operation: item.operation,
      };
    });
  }
  return invoke<FileQueueApplyOutcome[]>("apply_file_queue", { vaultPath, items });
}

export async function createWorkspaceDirectory(
  vaultPath: string,
  parentPath: string,
  name: string,
): Promise<WorkspaceMutationOutcome> {
  if (!isTauri()) {
    const targetPath = `${parentPath.replace(/\/$/, "")}/${name}`;
    return {
      sourcePath: null,
      targetPath,
      name,
      status: "done",
      error: null,
    };
  }
  return invoke<WorkspaceMutationOutcome>("create_workspace_directory", {
    vaultPath,
    parentPath,
    name,
  });
}

export async function renameWorkspaceEntry(
  vaultPath: string,
  sourcePath: string,
  newName: string,
): Promise<WorkspaceMutationOutcome> {
  if (!isTauri()) {
    const parent = sourcePath.split("/").slice(0, -1).join("/");
    return {
      sourcePath,
      targetPath: `${parent}/${newName}`,
      name: newName,
      status: "done",
      error: null,
    };
  }
  return invoke<WorkspaceMutationOutcome>("rename_workspace_entry", {
    vaultPath,
    sourcePath,
    newName,
  });
}

export async function duplicateWorkspaceEntries(
  vaultPath: string,
  sourcePaths: string[],
): Promise<WorkspaceMutationOutcome[]> {
  if (!isTauri()) {
    return sourcePaths.map((sourcePath) => {
      const name = sourcePath.split("/").pop() ?? "item";
      return {
        sourcePath,
        targetPath: `${sourcePath}-copy`,
        name: `${name}-copy`,
        status: "done" as const,
        error: null,
      };
    });
  }
  return invoke<WorkspaceMutationOutcome[]>("duplicate_workspace_entries", {
    vaultPath,
    sourcePaths,
  });
}

export async function pasteWorkspaceEntries(
  vaultPath: string,
  sourcePaths: string[],
  targetDir: string,
  operation: FileStoreOperation,
): Promise<WorkspaceMutationOutcome[]> {
  if (!isTauri()) {
    return sourcePaths.map((sourcePath) => {
      const name = sourcePath.split("/").pop() ?? "item";
      return {
        sourcePath,
        targetPath: `${targetDir.replace(/\/$/, "")}/${name}`,
        name,
        status: "done" as const,
        error: null,
      };
    });
  }
  return invoke<WorkspaceMutationOutcome[]>("paste_workspace_entries", {
    vaultPath,
    sourcePaths,
    targetDir,
    operation,
  });
}

export async function trashWorkspaceEntries(
  vaultPath: string,
  targetPaths: string[],
): Promise<WorkspaceMutationOutcome[]> {
  if (!isTauri()) {
    return targetPaths.map((sourcePath) => ({
      sourcePath,
      targetPath: null,
      name: sourcePath.split("/").pop() ?? "item",
      status: "done" as const,
      error: null,
    }));
  }
  return invoke<WorkspaceMutationOutcome[]>("trash_workspace_entries", {
    vaultPath,
    targetPaths,
  });
}

export async function describeFileQueueSources(paths: string[]): Promise<FileQueueSourceInfo[]> {
  if (!isTauri()) {
    return paths.map((path) => {
      const fileName = path.split("/").pop() ?? path;
      return {
        path,
        sourceRelPath: fileName,
        fileName,
        sourceKind: "file",
      };
    });
  }
  return invoke<FileQueueSourceInfo[]>("describe_file_queue_sources", { paths });
}

// === Phase 2 inbox watcher / AI bridge / classifier ===

export async function startInboxWatcher(vaultPath: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("start_inbox_watcher", { vaultPath });
}

export async function stopInboxWatcher(): Promise<void> {
  if (!isTauri()) return;
  await invoke("stop_inbox_watcher");
}

/** Build the prompt maru sends to Claude for one inbox item. Pure
 *  Rust side — keeps the prompt template under version control instead
 *  of in TS. */
export async function buildInboxClassificationPrompt(item: InboxDropItem): Promise<string> {
  if (!isTauri()) {
    return `[mock] classify ${item.relPath} (${item.source})`;
  }
  return invoke<string>("build_inbox_classification_prompt", { item });
}

/** Parse Claude's classifier reply. Tolerant of fences + surrounding
 *  prose; collapses unknown categories to `noise`. */
export async function parseInboxClassification(raw: string): Promise<InboxClassification> {
  if (!isTauri()) {
    // Browser dev fallback only — the Rust `parse_inbox_classification`
    // command is the SSOT for classification semantics; this mock exists so
    // the browser dev shell can exercise the UI without a real subprocess
    // and must never drift into production logic.
    return mockClassification(raw);
  }
  return invoke<InboxClassification>("parse_inbox_classification", { raw });
}

/** Spawn the Claude CLI for a one-shot prompt. Returns the invocation
 *  id; caller subscribes to the `ai://output` and `ai://done` events
 *  with that id to accumulate output. */
export async function startClaudeCliInvocation(
  prompt: string,
  cwd: string | null = null,
  extraArgs: string[] | null = null,
  extraEnv: Record<string, string> | null = null,
): Promise<string> {
  if (!isTauri()) {
    throw new Error("Claude CLI invocation is only available inside the Tauri shell.");
  }
  return invoke<string>("start_claude_cli_invocation", { prompt, cwd, extraArgs, extraEnv });
}

export type AgentProvider = "claude" | "codex" | "kimi" | "kiro";

export const AGENT_PROVIDERS: readonly AgentProvider[] = ["claude", "codex", "kimi", "kiro"];
export type AgentCommandOverrides = Partial<Record<AgentProvider, string | null>>;

export type AgentAuthStatus =
  | "authenticated"
  | "unauthenticated"
  | "unknown"
  | "cli_missing";

export interface AgentAccountStatus {
  id: AgentProvider;
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  authStatus: AgentAuthStatus;
  loginMethod: string | null;
  provider: string | null;
  organization: string | null;
  email: string | null;
  message: string | null;
}

export type AgentUsageState =
  | "ok"
  | "unsupported"
  | "unavailable"
  | "cli_missing"
  | "unauthenticated";

export interface AgentUsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface AgentUsageStatus {
  id: string;
  state: AgentUsageState;
  windows: AgentUsageWindow[];
  updatedAt: string;
  message: string | null;
}

/** Per-agent account/authentication status. `commandOverrides` maps agent id
 *  to an absolute binary path that bypasses PATH-based resolution. */
export async function agentsAccountStatus(
  commandOverrides?: AgentCommandOverrides,
): Promise<AgentAccountStatus[]> {
  if (!isTauri()) return mockAgentsAccountStatus();
  return invoke<AgentAccountStatus[]>("agents_account_status", {
    commandOverrides: populatedAgentCommandOverrides(commandOverrides),
  });
}

/** Per-agent quota/usage windows. Cached backend-side; pass `force` only for
 *  a user-initiated refresh. */
export async function agentsUsageStatus(
  commandOverrides?: AgentCommandOverrides,
  force?: boolean,
): Promise<AgentUsageStatus[]> {
  if (!isTauri()) return mockAgentsUsageStatus();
  return invoke<AgentUsageStatus[]>("agents_usage_status", {
    commandOverrides: populatedAgentCommandOverrides(commandOverrides),
    force,
  });
}

function populatedAgentCommandOverrides(
  commandOverrides?: AgentCommandOverrides,
): Record<string, string> | undefined {
  if (!commandOverrides) return undefined;
  const populated = Object.fromEntries(
    AGENT_PROVIDERS.flatMap((id) => {
      const value = commandOverrides[id]?.trim();
      return value ? [[id, value]] : [];
    }),
  );
  return Object.keys(populated).length > 0 ? populated : undefined;
}

function mockAgentsAccountStatus(): AgentAccountStatus[] {
  return [
    {
      id: "claude",
      installed: true,
      binaryPath: "/usr/local/bin/claude",
      version: "2.1.220",
      authStatus: "authenticated",
      loginMethod: "OAuth",
      provider: "Anthropic",
      organization: "jeju.ai",
      email: "hello@jeju.ai",
      message: null,
    },
    {
      id: "codex",
      installed: true,
      binaryPath: "/usr/local/bin/codex",
      version: "0.145.0",
      authStatus: "authenticated",
      loginMethod: "ChatGPT",
      provider: "OpenAI",
      organization: null,
      email: "yj.lee@chu.ac.kr",
      message: null,
    },
    {
      id: "kimi",
      installed: true,
      binaryPath: "/usr/local/bin/kimi",
      version: "0.29.2",
      authStatus: "authenticated",
      loginMethod: "OAuth",
      provider: "Moonshot AI",
      organization: null,
      email: "hello@jeju.ai",
      message: null,
    },
    {
      id: "kiro",
      installed: true,
      binaryPath: "/usr/local/bin/kiro-cli",
      version: "2.15.1",
      authStatus: "unauthenticated",
      loginMethod: null,
      provider: null,
      organization: null,
      email: null,
      message: "Not logged in.",
    },
  ];
}

function mockAgentsUsageStatus(): AgentUsageStatus[] {
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  return [
    {
      id: "claude",
      state: "ok",
      windows: [
        { label: "Session", usedPercent: 19, resetsAt: iso(48 * 60_000) },
        { label: "Weekly", usedPercent: 89, resetsAt: iso((2 * 24 + 20) * 3_600_000) },
      ],
      updatedAt: new Date(now).toISOString(),
      message: null,
    },
    {
      id: "codex",
      state: "ok",
      windows: [{ label: "Session", usedPercent: 5, resetsAt: iso(3 * 3_600_000) }],
      updatedAt: new Date(now).toISOString(),
      message: null,
    },
    {
      id: "kimi",
      state: "unsupported",
      windows: [],
      updatedAt: new Date(now).toISOString(),
      message: "No usage source for this agent.",
    },
    {
      id: "kiro",
      state: "unsupported",
      windows: [],
      updatedAt: new Date(now).toISOString(),
      message: "No usage source for this agent.",
    },
  ];
}

/** Provider-agnostic one-shot CLI invocation (claude/codex). Returns the
 *  invocation id; caller subscribes to `ai://output` / `ai://done` / `ai://error`
 *  with that id. Codex is driven via its stdin-piped `exec` form by the backend. */
export async function startAgentCliInvocation(
  provider: AgentProvider,
  prompt: string,
  cwd: string | null = null,
  extraArgs: string[] | null = null,
  extraEnv: Record<string, string> | null = null,
  commandOverride: string | null = null,
  permissionMode: string | null = null,
): Promise<string> {
  if (!isTauri()) {
    // The browser dev shell has no ai:// event bus, so an e2e override's return
    // value stands in for the whole invocation (see sendAgentChatTurn).
    const override = await invokeE2EOverride<string>("start_agent_cli_invocation", {
      provider,
      prompt,
      cwd,
      extraArgs,
      extraEnv,
      commandOverride,
      permissionMode,
    });
    if (override) return override;
    throw new Error("Agent CLI invocation is only available inside the Tauri shell.");
  }
  return invoke<string>("start_agent_cli_invocation", {
    provider,
    prompt,
    cwd,
    extraArgs,
    extraEnv,
    commandOverride,
    permissionMode,
  });
}

export async function listAiMissions(): Promise<MissionRecord[]> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<MissionRecord[]>("list_ai_missions", {});
    if (override) return override;
    return [];
  }
  return invoke<MissionRecord[]>("list_ai_missions");
}

export async function readAiMissionLog(
  invocationId: string,
  maxLines = 160,
): Promise<MissionLogTail> {
  if (!isTauri()) return { invocationId, lines: [] };
  return invoke<MissionLogTail>("read_ai_mission_log", { invocationId, maxLines });
}

export async function stopAiMission(invocationId: string): Promise<MissionRecord> {
  if (!isTauri()) {
    throw new Error("Mission stop is only available inside the Tauri shell.");
  }
  return invoke<MissionRecord>("stop_ai_mission", { invocationId });
}

// === Integrated terminal ===

export function terminalAvailable(): boolean {
  return isTauri();
}

export interface TerminalSpawnOptions {
  command?: string | null;
  extraArgs?: string[] | null;
  extraEnv?: Record<string, string> | null;
  cols?: number | null;
  rows?: number | null;
}

export type TerminalColor =
  | { kind: "named"; name: string }
  | { kind: "indexed"; index: number }
  | { kind: "rgb"; r: number; g: number; b: number };

export interface TerminalCell {
  ch: string;
  width: number;
  fg: TerminalColor;
  bg: TerminalColor;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface TerminalCursor {
  row: number;
  col: number;
  visible: boolean;
}

export interface TerminalMouseFlags {
  click: boolean;
  motion: boolean;
  drag: boolean;
  sgr: boolean;
}

export interface TerminalFrame {
  sessionId: string;
  cols: number;
  rows: number;
  cursor: TerminalCursor;
  /** Full grid when `dirtyRows` is null/absent; otherwise only the changed
   *  rows, aligned 1:1 to `dirtyRows`, to be patched into the retained grid. */
  lines: TerminalCell[][];
  scrollbackLen: number;
  title?: string | null;
  dirtyRows?: number[] | null;
  displayOffset: number;
  mouse: TerminalMouseFlags;
  altScreen: boolean;
  /** Canonical backend selection projected into visible rows. */
  selectionSpans?: TerminalSelectionSpan[];
  /** Soft-wrap flag aligned with `lines` (and `dirtyRows` for patches). */
  wrappedRows?: boolean[];
}

export interface TerminalSelectionSpan {
  row: number;
  start: number;
  end: number;
}

export interface TerminalCellStyle {
  fg: TerminalColor;
  bg: TerminalColor;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export type TerminalWireCell = [text: string, width: number, styleIndex: number];

export interface TerminalWireFrame {
  sessionId: string;
  cols: number;
  rows: number;
  cursor: TerminalCursor;
  palette: TerminalCellStyle[];
  lines: TerminalWireCell[][];
  scrollbackLen: number;
  title?: string | null;
  dirtyRows?: number[] | null;
  displayOffset: number;
  mouse: TerminalMouseFlags;
  altScreen: boolean;
  selectionSpans: TerminalSelectionSpan[];
  wrappedRows: boolean[];
}

export function decodeTerminalWireFrame(frame: TerminalWireFrame): TerminalFrame {
  const fallback: TerminalCellStyle = {
    fg: { kind: "named", name: "Foreground" },
    bg: { kind: "named", name: "Background" },
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
  };
  return {
    sessionId: frame.sessionId,
    cols: frame.cols,
    rows: frame.rows,
    cursor: frame.cursor,
    lines: frame.lines.map((line) =>
      line.map(([ch, width, styleIndex]) => {
        const style = frame.palette[styleIndex] ?? fallback;
        return { ch, width, ...style };
      }),
    ),
    scrollbackLen: frame.scrollbackLen,
    title: frame.title,
    dirtyRows: frame.dirtyRows,
    displayOffset: frame.displayOffset,
    mouse: frame.mouse,
    altScreen: frame.altScreen,
    selectionSpans: frame.selectionSpans,
    wrappedRows: frame.wrappedRows,
  };
}

export type TerminalStreamMessage =
  | {
      kind: "frame";
      sessionId: string;
      generation: string;
      seq: number;
      prevSeq: number;
      frame: TerminalWireFrame;
    }
  | {
      kind: "exit";
      sessionId: string;
      generation: string;
      seq: number;
      exitCode: number | null;
    }
  | {
      kind: "fault";
      sessionId: string;
      generation: string;
      seq: number;
      message: string;
    };

export interface TerminalSpawnHandle {
  generation: string;
  channel: Channel<TerminalStreamMessage>;
}

export type TerminalSearchDirection = "next" | "previous";

export interface TerminalSearchMatch {
  row: number;
  col: number;
  length: number;
}

export interface TerminalSearchResult {
  sessionId: string;
  query: string;
  found: boolean;
  row: number | null;
  col: number | null;
  length: number;
  displayOffset: number;
}

export type TerminalMouseAction = "press" | "release" | "move";

export type TerminalInputCommand =
  | { type: "text"; text: string }
  | { type: "paste"; text: string }
  | { type: "lineBreak" }
  | {
      type: "key";
      key: string;
      code?: string | null;
      shiftKey?: boolean;
      altKey?: boolean;
      ctrlKey?: boolean;
      metaKey?: boolean;
    }
  | {
      type: "mouse";
      button: number;
      col: number;
      row: number;
      action: TerminalMouseAction;
      shiftKey?: boolean;
      altKey?: boolean;
      ctrlKey?: boolean;
    }
  | {
      type: "wheel";
      up: boolean;
      col: number;
      row: number;
      shiftKey?: boolean;
      altKey?: boolean;
      ctrlKey?: boolean;
    };

export type TerminalSelectionKind = "simple" | "semantic" | "lines";

export type TerminalSelectionCommand =
  | {
      type: "start";
      row: number;
      col: number;
      side: "left" | "right";
      kind: TerminalSelectionKind;
    }
  | {
      type: "update";
      row: number;
      col: number;
      side: "left" | "right";
      scrollDelta?: number;
    }
  | { type: "finish"; includeAll?: boolean }
  | { type: "clear" }
  | { type: "selectAll" };

export async function terminalSpawn(
  sessionId: string,
  kind: TerminalKind,
  cwd: string | null = null,
  options: TerminalSpawnOptions = {},
  onEvent?: (message: TerminalStreamMessage) => void,
): Promise<TerminalSpawnHandle> {
  if (!isTauri()) {
    throw new Error("Integrated terminal is only available inside the Tauri shell.");
  }
  const channel = new Channel<TerminalStreamMessage>((message) => onEvent?.(message));
  const generation = await invoke<string>("terminal_spawn", {
    sessionId,
    kind,
    cwd,
    command: options.command ?? null,
    extraArgs: options.extraArgs ?? null,
    extraEnv: options.extraEnv ?? null,
    cols: options.cols ?? null,
    rows: options.rows ?? null,
    onEvent: channel,
  });
  return { generation, channel };
}

export async function terminalWrite(sessionId: string, data: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_write", { sessionId, data });
}

export async function terminalInput(
  sessionId: string,
  command: TerminalInputCommand,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_input", { sessionId, command });
}

export async function terminalInputBatch(
  sessionId: string,
  generation: string,
  clientSeq: number,
  commands: TerminalInputCommand[],
): Promise<void> {
  if (!isTauri() || commands.length === 0) return;
  await invoke("terminal_input_batch", { sessionId, generation, clientSeq, commands });
}

export async function terminalAck(
  sessionId: string,
  generation: string,
  seq: number,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_ack", { sessionId, generation, seq });
}

export async function terminalRequestFull(
  sessionId: string,
  generation: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_request_full", { sessionId, generation });
}

export async function terminalSetVisibility(
  sessionId: string,
  generation: string,
  visible: boolean,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_set_visibility", { sessionId, generation, visible });
}

export async function terminalSelection(
  sessionId: string,
  generation: string,
  command: TerminalSelectionCommand,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_selection", { sessionId, generation, command });
}

export async function terminalCopySelection(
  sessionId: string,
  generation: string,
): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("terminal_copy_selection", { sessionId, generation });
}

export async function terminalResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_resize", { sessionId, cols, rows });
}

/** Scroll the viewport through scrollback by `delta` lines (positive = toward
 *  history). The backend emits a fresh frame reflecting the scrolled view. */
export async function terminalScroll(sessionId: string, delta: number): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_scroll", { sessionId, delta });
}

/** Clear the visible screen and scrollback (Cmd+K). No-op while the
 *  alternate screen is active; the backend emits a fresh cleared frame. */
export async function terminalClear(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_clear", { sessionId });
}

export async function terminalText(sessionId: string): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("terminal_text", { sessionId });
}

export async function terminalSearch(
  sessionId: string,
  query: string,
  direction: TerminalSearchDirection = "next",
  caseSensitive = false,
): Promise<TerminalSearchResult> {
  if (!isTauri()) {
    return {
      sessionId,
      query,
      found: false,
      row: null,
      col: null,
      length: 0,
      displayOffset: 0,
    };
  }
  return invoke<TerminalSearchResult>("terminal_search", {
    sessionId,
    query,
    direction,
    caseSensitive,
  });
}

export async function terminalKill(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_kill", { sessionId });
}

export interface TerminalHooksStatus {
  scope: string;
  claudePath: string;
  claudeInstalled: boolean;
  kimiPath: string;
  kimiInstalled: boolean;
  codexHint: string;
}

export async function terminalHooksStatus(
  workPath: string | null,
  scope: "project" | "global",
): Promise<TerminalHooksStatus> {
  return invoke<TerminalHooksStatus>("terminal_hooks_status", { workPath, scope });
}

export async function terminalHooksInstall(
  workPath: string | null,
  scope: "project" | "global",
): Promise<TerminalHooksStatus> {
  return invoke<TerminalHooksStatus>("terminal_hooks_install", { workPath, scope });
}

export async function terminalHooksUninstall(
  workPath: string | null,
  scope: "project" | "global",
): Promise<TerminalHooksStatus> {
  return invoke<TerminalHooksStatus>("terminal_hooks_uninstall", { workPath, scope });
}

export async function writeAgentContextHint(
  workPath: string,
  targets: string[],
): Promise<string[]> {
  return invoke<string[]>("write_agent_context_hint", { workPath, targets });
}

export async function removeAgentContextHint(
  workPath: string,
  targets: string[],
): Promise<string[]> {
  return invoke<string[]>("remove_agent_context_hint", { workPath, targets });
}

/** Pull unread Gmail messages via the user's existing `gws` Google
 *  Workspace CLI. Returns id / from / subject / date — maru never
 *  fetches the message body, just the envelope, matching the Phase 2
 *  triage surface. Empty `query` falls back to gws's default
 *  `is:unread`. */
export async function fetchGmailUnread(
  maxOrVaultPath: number | string | null = null,
  queryOrMax: string | number | null = null,
  maybeQuery: string | null = null,
): Promise<GmailMessage[]> {
  if (!isTauri()) {
    return mockGmailUnread();
  }
  const vaultPath = typeof maxOrVaultPath === "string" ? maxOrVaultPath : null;
  const max = typeof maxOrVaultPath === "number" ? maxOrVaultPath : typeof queryOrMax === "number" ? queryOrMax : null;
  const query = typeof queryOrMax === "string" ? queryOrMax : maybeQuery;
  return invoke<GmailMessage[]>("fetch_gmail_unread", { vaultPath, max, query });
}

export async function stageGmailItems(
  workPath: string,
  messages: GmailMessage[],
  approvalId: string,
): Promise<StageOutcome[]> {
  if (!isTauri()) {
    return messages.map((message) => ({
      messageId: message.id,
      channel: "gws",
      provider: "gws",
      targetPath: `${workPath}/inbox/drop/gws/${message.id}.json`,
      ok: true,
      error: null,
    }));
  }
  return invoke<StageOutcome[]>("stage_gmail_items", { workPath, messages, approvalId });
}

export async function checkGwsAuth(vaultPath: string | null): Promise<ProviderAuthStatus> {
  if (!isTauri()) return mockAuthStatus("gws");
  return invoke<ProviderAuthStatus>("check_gws_auth", { vaultPath });
}

export async function decideGmailItem(
  vaultPath: string | null,
  messageId: string,
  decision: "accepted" | "rejected",
  approvalId: string,
): Promise<GmailDecisionOutcome> {
  if (!isTauri()) {
    return {
      messageId,
      decision,
      labelName: decision === "accepted" ? "maru-accepted" : "maru-rejected",
      archived: decision === "accepted",
      ok: true,
      error: null,
    };
  }
  return invoke<GmailDecisionOutcome>("decide_gmail_item", {
    vaultPath,
    messageId,
    decision,
    approvalId,
  });
}

export async function decideGmailItems(
  vaultPath: string | null,
  items: GmailDecisionRequest[],
  approvalId: string,
): Promise<GmailDecisionOutcome[]> {
  if (!isTauri()) {
    return items.map((item) => ({
      messageId: item.messageId,
      decision: item.decision,
      labelName: item.decision === "accepted" ? "maru-accepted" : "maru-rejected",
      archived: item.decision === "accepted",
      ok: true,
      error: null,
    }));
  }
  return invoke<GmailDecisionOutcome[]>("decide_gmail_items", {
    vaultPath,
    items,
    approvalId,
  });
}

export async function fetchOutlookUnread(
  workPath: string | null,
  max?: number | null,
  m365Path?: string | null,
): Promise<OutlookMessage[]> {
  if (!isTauri()) return mockOutlookUnread();
  return invoke<OutlookMessage[]>("fetch_outlook_unread", {
    workPath,
    max: max ?? null,
    m365Path: m365Path ?? null,
  });
}

export async function stageOutlookItems(
  workPath: string,
  messages: OutlookMessage[],
  approvalId: string,
): Promise<StageOutcome[]> {
  if (!isTauri()) {
    return messages.map((message) => ({
      messageId: message.id,
      channel: "mso",
      provider: "mso",
      targetPath: `${workPath}/inbox/drop/mso/${message.id}.json`,
      ok: true,
      error: null,
    }));
  }
  return invoke<StageOutcome[]>("stage_outlook_items", { workPath, messages, approvalId });
}

export async function checkMsoAuth(
  workPath: string | null,
  m365Path?: string | null,
): Promise<ProviderAuthStatus> {
  if (!isTauri()) return mockAuthStatus("mso");
  return invoke<ProviderAuthStatus>("check_mso_auth", {
    workPath,
    m365Path: m365Path ?? null,
  });
}

export async function decideOutlookItem(
  workPath: string | null,
  messageId: string,
  decision: OutlookDecisionRequest["decision"],
  approvalId?: string | null,
  m365Path?: string | null,
): Promise<OutlookDecisionOutcome> {
  if (!isTauri()) {
    return {
      messageId,
      decision,
      categoryName: decision === "accepted" ? "maru-accepted" : "maru-rejected",
      archived: false,
      ok: true,
      error: null,
    };
  }
  return invoke<OutlookDecisionOutcome>("decide_outlook_item", {
    workPath,
    messageId,
    decision,
    approvalId: approvalId ?? null,
    m365Path: m365Path ?? null,
  });
}

export async function decideOutlookItems(
  workPath: string | null,
  items: OutlookDecisionRequest[],
  approvalId?: string | null,
  m365Path?: string | null,
): Promise<OutlookDecisionOutcome[]> {
  if (!isTauri()) {
    return items.map((item) => ({
      messageId: item.messageId,
      decision: item.decision,
      categoryName: item.decision === "accepted" ? "maru-accepted" : "maru-rejected",
      archived: false,
      ok: true,
      error: null,
    }));
  }
  return invoke<OutlookDecisionOutcome[]>("decide_outlook_items", {
    workPath,
    items,
    approvalId: approvalId ?? null,
    m365Path: m365Path ?? null,
  });
}

export async function fetchTelegramRecent(
  options: TelegramFetchOptions,
): Promise<TelegramMessage[]> {
  if (!isTauri()) return mockTelegramRecent();
  return invoke<TelegramMessage[]>("fetch_telegram_recent", { options });
}

export async function stageTelegramItems(
  workPath: string,
  messages: TelegramMessage[],
  approvalId: string,
): Promise<StageOutcome[]> {
  if (!isTauri()) {
    return messages.map((message) => ({
      messageId: message.id,
      channel: "telegram",
      provider: "telegram",
      targetPath: `${workPath}/inbox/drop/telegram/${message.id}.json`,
      ok: true,
      error: null,
    }));
  }
  return invoke<StageOutcome[]>("stage_telegram_items", { workPath, messages, approvalId });
}

export async function checkTelegramAuth(
  options: TelegramFetchOptions,
): Promise<ProviderAuthStatus> {
  if (!isTauri()) return mockAuthStatus("telegram");
  return invoke<ProviderAuthStatus>("check_telegram_auth", { options });
}

export async function readTelegramMonitorConfig(
  workPath: string | null,
  monitorConfigPath?: string | null,
): Promise<TelegramMonitorConfigView> {
  if (!isTauri()) return mockTelegramMonitorConfig(workPath, monitorConfigPath);
  return invoke<TelegramMonitorConfigView>("read_telegram_monitor_config", {
    workPath,
    monitorConfigPath: monitorConfigPath ?? null,
  });
}

export async function saveTelegramMonitorConfig(
  workPath: string | null,
  monitorConfigPath: string | null,
  config: TelegramMonitorConfigSave,
): Promise<TelegramMonitorConfigView> {
  if (!isTauri()) return mockTelegramMonitorConfigFromSave(workPath, monitorConfigPath, config);
  return invoke<TelegramMonitorConfigView>("save_telegram_monitor_config", {
    workPath,
    monitorConfigPath,
    config,
  });
}

export async function acceptTelegramItem(
  workPath: string,
  message: TelegramMessage,
  approvalId?: string | null,
): Promise<TelegramDecisionOutcome> {
  if (!isTauri()) {
    return {
      messageId: message.id,
      decision: "accepted",
      targetPath: `${workPath}/inbox/drop/telegram/${message.id}.json`,
      ok: true,
      error: null,
    };
  }
  return invoke<TelegramDecisionOutcome>("accept_telegram_item", {
    workPath,
    message,
    approvalId: approvalId ?? null,
  });
}

export async function rejectTelegramItem(
  messageId: string,
  approvalId?: string | null,
): Promise<TelegramDecisionOutcome> {
  if (!isTauri()) {
    return { messageId, decision: "rejected", targetPath: null, ok: true, error: null };
  }
  return invoke<TelegramDecisionOutcome>("reject_telegram_item", {
    messageId,
    approvalId: approvalId ?? null,
  });
}

export async function startTelegramPolling(
  options: TelegramFetchOptions,
  intervalSeconds?: number | null,
): Promise<TelegramPollingStatus> {
  if (!isTauri()) {
    return {
      running: true,
      intervalSeconds: intervalSeconds ?? 60,
      lastStartedAt: new Date().toISOString(),
      lastFetchedAt: null,
      lastMessageCount: 0,
      lastError: null,
    };
  }
  return invoke<TelegramPollingStatus>("start_telegram_polling", {
    options,
    intervalSeconds: intervalSeconds ?? null,
  });
}

export async function stopTelegramPolling(): Promise<TelegramPollingStatus> {
  if (!isTauri()) {
    return {
      running: false,
      intervalSeconds: 60,
      lastStartedAt: null,
      lastFetchedAt: null,
      lastMessageCount: 0,
      lastError: null,
    };
  }
  return invoke<TelegramPollingStatus>("stop_telegram_polling");
}

export async function telegramPollingStatus(): Promise<TelegramPollingStatus> {
  if (!isTauri()) return stopTelegramPolling();
  return invoke<TelegramPollingStatus>("telegram_polling_status");
}

export async function readKakaoRelayStatus(workPath: string): Promise<KakaoRelayStatus> {
  if (!isTauri()) return mockKakaoRelayStatus();
  return invoke<KakaoRelayStatus>("read_kakao_relay_status", { workPath });
}

export async function readKakaoRelayMessages(
  workPath: string,
  roomSlug: string,
  limit: number,
): Promise<KakaoRelayEnvelope[]> {
  if (!isTauri()) return mockKakaoRelayMessages(roomSlug, limit);
  return invoke<KakaoRelayEnvelope[]>("read_kakao_relay_messages", {
    workPath,
    roomSlug,
    limit,
  });
}

export async function stageKakaoRelayNew(
  workPath: string,
  dryRun: boolean,
  approvalId?: string | null,
): Promise<KakaoStageResult> {
  if (!isTauri()) return mockKakaoStageResult();
  return invoke<KakaoStageResult>("stage_kakao_relay_new", {
    workPath,
    dryRun,
    approvalId: approvalId ?? null,
  });
}

export async function enqueueKakaoSend(
  workPath: string,
  chat: string,
  text: string,
  attachmentPath: string | null,
  approvalId: string,
): Promise<KakaoEnqueueResult> {
  if (!isTauri()) {
    return {
      id: "00000000-0000-4000-8000-000000000001",
      path: `${workPath}/kakao-relay/outbox/00000000-0000-4000-8000-000000000001.json`,
    };
  }
  return invoke<KakaoEnqueueResult>("enqueue_kakao_send", {
    workPath,
    chat,
    text,
    attachmentPath,
    approvalId,
  });
}

export async function readKakaoSendResults(
  workPath: string,
  ids: string[],
): Promise<KakaoSendResult[]> {
  if (!isTauri()) {
    return ids.map((id) => ({ id, status: "queued", ok: null, error: null }));
  }
  return invoke<KakaoSendResult[]>("read_kakao_send_results", { workPath, ids });
}

export interface LegacyLaunchdService {
  label: string;
  plistPath: string;
  loaded: boolean;
}

export async function detectLegacyTelegramLaunchd(): Promise<LegacyLaunchdService[]> {
  if (!isTauri()) return [];
  return invoke<LegacyLaunchdService[]>("detect_legacy_telegram_launchd");
}

export async function unloadLegacyTelegramLaunchd(
  plistPath: string,
): Promise<LegacyLaunchdService> {
  if (!isTauri()) return { label: "telegram-monitor", plistPath, loaded: false };
  return invoke<LegacyLaunchdService>("unload_legacy_telegram_launchd", { plistPath });
}

// === Scheduled jobs (launchd) ===

export interface JobSchedule {
  hour: number;
  minute: number;
  recoveryIntervalSeconds: number;
  runAtLoad: boolean;
}

export interface JobStatus {
  id: string;
  title: string;
  description: string;
  installed: boolean;
  loaded: boolean;
  enabled: boolean;
  plistPath: string;
  label: string;
  schedule: JobSchedule;
  lastExitCode: number | null;
  lastRunAt: string | null;
}

export interface JobLogsTail {
  stdout: string;
  stderr: string;
}

function mockJobStatus(workPath: string): JobStatus {
  return {
    id: "mail-digest",
    title: "Daily Mail Digest",
    description: "",
    installed: false,
    loaded: false,
    enabled: false,
    plistPath: `${workPath}/.maru/jobs.json`,
    label: "com.maru.job.mail-digest.00000000",
    schedule: { hour: 3, minute: 30, recoveryIntervalSeconds: 900, runAtLoad: false },
    lastExitCode: null,
    lastRunAt: null,
  };
}

export async function jobsList(workPath: string): Promise<JobStatus[]> {
  if (!isTauri()) return [mockJobStatus(workPath)];
  return invoke<JobStatus[]>("jobs_list", { workPath });
}

export async function jobsInstall(workPath: string, jobId: string): Promise<JobStatus> {
  if (!isTauri()) return { ...mockJobStatus(workPath), id: jobId, installed: true };
  return invoke<JobStatus>("jobs_install", { workPath, jobId });
}

export async function jobsUninstall(workPath: string, jobId: string): Promise<JobStatus> {
  if (!isTauri()) return { ...mockJobStatus(workPath), id: jobId };
  return invoke<JobStatus>("jobs_uninstall", { workPath, jobId });
}

export async function jobsStart(workPath: string, jobId: string): Promise<JobStatus> {
  if (!isTauri()) return { ...mockJobStatus(workPath), id: jobId, enabled: true };
  return invoke<JobStatus>("jobs_start", { workPath, jobId });
}

export async function jobsStop(workPath: string, jobId: string): Promise<JobStatus> {
  if (!isTauri()) return { ...mockJobStatus(workPath), id: jobId };
  return invoke<JobStatus>("jobs_stop", { workPath, jobId });
}

export async function jobsRunNow(workPath: string, jobId: string): Promise<JobStatus> {
  if (!isTauri()) return { ...mockJobStatus(workPath), id: jobId };
  return invoke<JobStatus>("jobs_run_now", { workPath, jobId });
}

export async function jobsReadLog(workPath: string, jobId: string): Promise<JobLogsTail> {
  if (!isTauri()) return { stdout: "", stderr: "" };
  return invoke<JobLogsTail>("jobs_read_log", { workPath, jobId });
}

// === dot workspace sync (global dot configuration) ===

export interface DotCliStatus {
  available: boolean;
  path: string | null;
  version: string | null;
  compatible: boolean;
  minimumVersion: string;
  message: string | null;
}

export interface DotSyncJobStatus {
  id: string;
  action: string;
  label: string;
  intervalSeconds: number;
  mode: string;
  state: string;
  lastRunAt: string | null;
}

export interface DotSyncProfileStatus {
  schemaVersion: number;
  kind: "mirror" | "peer-profile";
  profile: string;
  configured: boolean;
  workspacePath: string;
  storeDir: string;
  target: { kind: string; spec: string; host?: string; path: string };
  localExists: boolean;
  targetExists: boolean;
  paused: boolean;
  lockHeld: boolean;
  owner?: string;
  canPush: boolean;
  machineNames: string[];
  filterMode: string;
  allowCount: number;
  submoduleCount: number;
  propagation: { create: boolean; update: boolean; delete: boolean };
  maxDelete: number;
  rsyncVersion?: string;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastIntakeAt: string | null;
  conflictCount: number;
  logPath: string;
  includePath: string;
  excludePath: string;
  ignorePath: string;
  allowPath: string;
  jobs: DotSyncJobStatus[];
}

export interface DotPeerStatus {
  schemaVersion: number;
  kind: "peer";
  profile: DotSyncProfileStatus;
  job: DotSyncJobStatus;
  lastExitCode: number | null;
  runCount: number | null;
  homePathsPath: string;
}

export interface DotSyncOverview {
  cli: DotCliStatus;
  mirror: DotSyncProfileStatus | null;
  peer: DotPeerStatus | null;
}

export type DotSyncMode = "clean" | "force";
export type DotSyncActionRequest =
  | {
      type: "configureMirror";
      target: string;
      owner: string;
      filterMode: "include" | "exclude";
      create: boolean;
      update: boolean;
      delete: boolean;
      maxDelete: number;
      pushIntervalSeconds: number;
      pullIntervalSeconds: number;
      pushMode: DotSyncMode;
      pullMode: DotSyncMode;
    }
  | { type: "pauseMirror" | "resumeMirror" | "disablePeer" | "peerDoctor" | "peerDiff" | "readPeerHomePaths" | "installCli" | "updateCli" }
  | { type: "runMirror"; direction: "push" | "pull"; mode: DotSyncMode; dryRun: boolean }
  | {
      type: "configurePeer";
      host: string;
      remotePath: string;
      intervalSeconds: number;
      allowPatterns: string;
      homePaths: string;
      acknowledgeSecrets: boolean;
    }
  | { type: "runPeer"; dryRun: boolean }
  | {
      type: "saveFilter";
      profile: "sync" | "peer";
      kind: "include" | "exclude" | "ignore" | "allow";
      content: string;
      acknowledgeSecrets: boolean;
    }
  | { type: "readFilter"; profile: "sync" | "peer"; kind: "include" | "exclude" | "ignore" | "allow" }
  | { type: "savePeerHomePaths"; content: string }
  | { type: "readLog"; profile: "sync" | "peer" };

export interface DotSyncActionResult {
  stdout: string;
  stderr: string;
  overview: DotSyncOverview;
}

export const EMPTY_DOT_SYNC_OVERVIEW: DotSyncOverview = {
  cli: {
    available: false,
    path: null,
    version: null,
    compatible: false,
    minimumVersion: "2.63.0",
    message: null,
  },
  mirror: null,
  peer: null,
};

export async function dotSyncOverview(): Promise<DotSyncOverview> {
  if (!isTauri()) return EMPTY_DOT_SYNC_OVERVIEW;
  return invoke<DotSyncOverview>("dot_sync_overview");
}

export async function dotSyncRun(request: DotSyncActionRequest): Promise<DotSyncActionResult> {
  if (!isTauri()) return { stdout: "", stderr: "", overview: EMPTY_DOT_SYNC_OVERVIEW };
  return invoke<DotSyncActionResult>("dot_sync_run", { request });
}

export async function readInboxSettings(vaultPath: string): Promise<InboxSettings> {
  if (!isTauri()) return { ...DEFAULT_INBOX_SETTINGS };
  return invoke<InboxSettings>("read_inbox_settings", { vaultPath });
}

export async function saveInboxSettings(
  vaultPath: string,
  settings: InboxSettings,
): Promise<InboxSettings> {
  if (!isTauri()) return settings;
  return invoke<InboxSettings>("save_inbox_settings", { vaultPath, settings });
}

// === Right pane file shelf / memos ===

export async function storeShelfFiles(
  vaultPath: string,
  sources: string[],
  operation: FileStoreOperation,
): Promise<StoredFileOutcome[]> {
  if (!isTauri()) {
    return sources.map((sourcePath) => ({
      sourcePath,
      targetPath: `${vaultPath}/.maru/stash/files/${sourcePath.split("/").pop() ?? "file"}`,
      fileName: sourcePath.split("/").pop() ?? "file",
      operation,
    }));
  }
  return invoke<StoredFileOutcome[]>("store_shelf_files", { vaultPath, sources, operation });
}

export async function storeShelfFilesAs(
  sources: string[],
  targetDir: string,
  operation: FileStoreOperation,
): Promise<StoredFileOutcome[]> {
  if (!isTauri()) {
    return sources.map((sourcePath) => ({
      sourcePath,
      targetPath: `${targetDir}/${sourcePath.split("/").pop() ?? "file"}`,
      fileName: sourcePath.split("/").pop() ?? "file",
      operation,
    }));
  }
  return invoke<StoredFileOutcome[]>("store_shelf_files_as", {
    sources,
    targetDir,
    operation,
  });
}

export async function saveMemoAs(
  vaultPath: string,
  targetPath: string,
  content: string,
): Promise<MemoDocument> {
  if (!isTauri()) {
    return {
      name: targetPath.split("/").pop() ?? "memo.md",
      path: targetPath,
      format: targetPath.endsWith(".txt") ? "plain" : "markdown",
      updatedAt: null,
      sizeBytes: content.length,
      preview: content.trim().slice(0, 160),
      content,
    };
  }
  return invoke<MemoDocument>("save_memo_as", { vaultPath, targetPath, content });
}

export async function listScratchpad(workPath: string): Promise<ScratchpadEntry[]> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<ScratchpadEntry[]>("scratchpad_list", { workPath });
    if (override) return override;
    return [];
  }
  return invoke<ScratchpadEntry[]>("scratchpad_list", { workPath });
}

export async function readScratchpadDocument(
  workPath: string,
  collection: ScratchpadCollection,
  relativePath: string,
): Promise<ScratchpadDocument> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<ScratchpadDocument>("scratchpad_read", {
      workPath,
      collection,
      relativePath,
    });
    if (override) return override;
    const name = relativePath.split("/").pop() ?? "scratchpad.md";
    return {
      collection,
      relativePath,
      name,
      source: collection === "memos" ? "maru" : "manual",
      ideationStage: collection === "ideation" ? "seed" : null,
      format: name.toLowerCase().endsWith(".txt") ? "plain" : "markdown",
      updatedAt: null,
      sizeBytes: 0,
      preview: "",
      revision: "browser-preview",
      stale: false,
      editable: true,
      content: "",
    };
  }
  return invoke<ScratchpadDocument>("scratchpad_read", {
    workPath,
    collection,
    relativePath,
  });
}

export async function saveScratchpadDocument(
  workPath: string,
  collection: ScratchpadCollection,
  relativePath: string,
  format: MemoFormat,
  content: string,
  expectedRevision?: string | null,
  force = false,
): Promise<ScratchpadDocument> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<ScratchpadDocument>("scratchpad_save", {
      workPath,
      collection,
      relativePath,
      format,
      content,
      expectedRevision: expectedRevision ?? null,
      force,
    });
    if (override) return override;
    const name = relativePath.split("/").pop() ?? `scratchpad.${format === "plain" ? "txt" : "md"}`;
    return {
      collection,
      relativePath,
      name,
      source: collection === "memos" ? "maru" : "manual",
      ideationStage: collection === "ideation" ? "seed" : null,
      format,
      updatedAt: new Date().toISOString(),
      sizeBytes: new TextEncoder().encode(content).byteLength,
      preview: content.trim().slice(0, 160),
      revision: `browser-${Date.now()}`,
      stale: false,
      editable: true,
      content,
    };
  }
  return invoke<ScratchpadDocument>("scratchpad_save", {
    workPath,
    collection,
    relativePath,
    format,
    content,
    expectedRevision: expectedRevision ?? null,
    force,
  });
}

export async function renameScratchpadDocument(
  workPath: string,
  collection: ScratchpadCollection,
  relativePath: string,
  newRelativePath: string,
  expectedRevision: string,
): Promise<ScratchpadDocument> {
  return invoke<ScratchpadDocument>("scratchpad_rename", {
    workPath,
    collection,
    relativePath,
    newRelativePath,
    expectedRevision,
  });
}

export async function trashScratchpadDocument(
  workPath: string,
  collection: ScratchpadCollection,
  relativePath: string,
  expectedRevision: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("scratchpad_trash", { workPath, collection, relativePath, expectedRevision });
}

export async function createScratchpadIdea(
  workPath: string,
  title: string,
): Promise<ScratchpadDocument> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<ScratchpadDocument>("scratchpad_create_idea", {
      workPath,
      title,
    });
    if (override) return override;
  }
  return invoke<ScratchpadDocument>("scratchpad_create_idea", { workPath, title });
}

export async function transitionScratchpadIdea(
  workPath: string,
  relativePath: string,
  stage: IdeationStage,
  expectedRevision: string,
): Promise<ScratchpadDocument> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<ScratchpadDocument>("scratchpad_transition_idea", {
      workPath,
      relativePath,
      stage,
      expectedRevision,
    });
    if (override) return override;
  }
  return invoke<ScratchpadDocument>("scratchpad_transition_idea", {
    workPath,
    relativePath,
    stage,
    expectedRevision,
  });
}

export async function planScratchpadTempCleanup(
  workPath: string,
): Promise<TempCleanupCandidate[]> {
  if (!isTauri()) return [];
  return invoke<TempCleanupCandidate[]>("scratchpad_cleanup_plan", { workPath });
}

export async function applyScratchpadTempCleanup(
  workPath: string,
  selections: TempCleanupSelection[],
): Promise<TempCleanupResult> {
  if (!isTauri()) return { trashed: [], skipped: [] };
  return invoke<TempCleanupResult>("scratchpad_cleanup_apply", { workPath, selections });
}

export async function migrateLegacyMemos(
  workPath: string,
): Promise<ScratchpadMigrationResult> {
  if (!isTauri()) return { migrated: [], skipped: [] };
  return invoke<ScratchpadMigrationResult>("scratchpad_migrate_legacy_memos", { workPath });
}

export async function startScratchpadWatcher(workPath: string): Promise<number> {
  if (!isTauri()) return 0;
  return invoke<number>("start_scratchpad_watcher", { workPath });
}

export async function stopScratchpadWatcher(): Promise<void> {
  if (!isTauri()) return;
  await invoke("stop_scratchpad_watcher");
}

// === Drafts ===

export async function listDrafts(workPath: string): Promise<DraftEntry[]> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<DraftEntry[]>("drafts_list", { workPath });
    if (override) return override;
    return [];
  }
  return invoke<DraftEntry[]>("drafts_list", { workPath });
}

export async function getDraftsPromoteDefaultDir(workPath: string): Promise<string> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<string>("drafts_promote_default_dir", { workPath });
    if (override) return override;
    throw new Error("drafts_promote_default_dir_unavailable");
  }
  return invoke<string>("drafts_promote_default_dir", { workPath });
}

export async function readDraft(workPath: string, id: string): Promise<DraftDocument> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<DraftDocument>("drafts_read", { workPath, id });
    if (override) return override;
    throw new Error("drafts_not_found");
  }
  return invoke<DraftDocument>("drafts_read", { workPath, id });
}

export async function saveDraft(
  workPath: string,
  id: string,
  body: string,
  expectedUpdatedAt: string,
): Promise<DraftDocument> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<DraftDocument>("drafts_save", {
      workPath,
      id,
      body,
      expectedUpdatedAt,
    });
    if (override) return override;
    throw new Error("drafts_not_found");
  }
  return invoke<DraftDocument>("drafts_save", { workPath, id, body, expectedUpdatedAt });
}

export async function createDraft(params: {
  workPath: string;
  kind: DraftKind;
  title: string;
  source: ScratchpadSource;
  originRefs?: string[];
  importance?: DraftImportance | null;
  confidence?: number | null;
  body: string;
}): Promise<DraftEntry> {
  const args = {
    workPath: params.workPath,
    kind: params.kind,
    title: params.title,
    source: params.source,
    originRefs: params.originRefs ?? null,
    importance: params.importance ?? null,
    confidence: params.confidence ?? null,
    body: params.body,
  };
  if (!isTauri()) {
    const override = await invokeE2EOverride<DraftEntry>("drafts_create", args);
    if (override) return override;
    throw new Error("drafts_create_unavailable");
  }
  return invoke<DraftEntry>("drafts_create", args);
}

export async function setDraftStatus(
  workPath: string,
  id: string,
  status: DraftStatus,
): Promise<DraftEntry> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<DraftEntry>("drafts_set_status", {
      workPath,
      id,
      status,
    });
    if (override) return override;
    throw new Error("drafts_not_found");
  }
  return invoke<DraftEntry>("drafts_set_status", { workPath, id, status });
}

export async function discardDraft(workPath: string, id: string): Promise<DraftEntry> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<DraftEntry>("drafts_discard", { workPath, id });
    if (override) return override;
    throw new Error("drafts_not_found");
  }
  return invoke<DraftEntry>("drafts_discard", { workPath, id });
}

export async function promoteDraft(params: {
  workPath: string;
  id: string;
  target: DraftPromoteTarget;
  targetPath?: string | null;
  approvalId: string;
}): Promise<DraftEntry> {
  const args = {
    workPath: params.workPath,
    id: params.id,
    target: params.target,
    targetPath: params.targetPath ?? null,
    approvalId: params.approvalId,
  };
  if (!isTauri()) {
    const override = await invokeE2EOverride<DraftEntry>("drafts_promote", args);
    if (override) return override;
    throw new Error("drafts_not_found");
  }
  return invoke<DraftEntry>("drafts_promote", args);
}

export async function draftsRelinkPromoted(params: {
  workPath: string;
  id: string;
  targetPath: string;
}): Promise<DraftEntry> {
  const args = {
    workPath: params.workPath,
    id: params.id,
    targetPath: params.targetPath,
  };
  if (!isTauri()) {
    const override = await invokeE2EOverride<DraftEntry>("drafts_relink_promoted", args);
    if (override) return override;
    throw new Error("drafts_relink_not_found");
  }
  return invoke<DraftEntry>("drafts_relink_promoted", args);
}

// === Gap analysis ===

export async function gapAnalyze(workPath: string, draftId: string): Promise<GapReport> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<GapReport>("gap_analyze", { workPath, draftId });
    if (override) return override;
    throw new Error("gap_analyze_unavailable");
  }
  return invoke<GapReport>("gap_analyze", { workPath, draftId });
}

/** Explicit log append — call only after an analysis has been viewed/confirmed. */
export async function gapAppendLog(workPath: string, draftId: string): Promise<GapLogEntry> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<GapLogEntry>("gap_append_log", { workPath, draftId });
    if (override) return override;
    throw new Error("gap_append_log_unavailable");
  }
  return invoke<GapLogEntry>("gap_append_log", { workPath, draftId });
}

export async function gapLogList(workPath: string, limit?: number): Promise<GapLogEntry[]> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<GapLogEntry[]>("gap_log_list", {
      workPath,
      limit: limit ?? null,
    });
    if (override) return override;
    return [];
  }
  return invoke<GapLogEntry[]>("gap_log_list", { workPath, limit: limit ?? null });
}

export async function gapReportsList(workPath: string): Promise<GapReportSummary[]> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<GapReportSummary[]>("gap_reports_list", { workPath });
    if (override) return override;
    return [];
  }
  return invoke<GapReportSummary[]>("gap_reports_list", { workPath });
}

// === Knowledge-graph reference mapping ===

/** On-demand, cache-aware document→note reference mapping. Expensive on a
 *  miss (one regex pass per vault title), cheap on a cache hit. */
export async function kgDocumentRefs(workPath: string, docPath: string): Promise<DocumentRefMap> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<DocumentRefMap>("kg_document_refs", {
      workPath,
      docPath,
    });
    if (override) return override;
    throw new Error("kg_document_refs_unavailable");
  }
  return invoke<DocumentRefMap>("kg_document_refs", { workPath, docPath });
}

/** Drop kg-ref cache entries: one document when docPath is given, all when
 *  omitted. Returns the number of entries removed. */
export async function kgRefsClear(workPath: string, docPath?: string): Promise<number> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<number>("kg_refs_clear", {
      workPath,
      docPath: docPath ?? null,
    });
    if (override !== null) return override;
    return 0;
  }
  return invoke<number>("kg_refs_clear", { workPath, docPath: docPath ?? null });
}

// === Scheduler ===

export async function listSchedules(workPath: string): Promise<SchedulerSchedule[]> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<SchedulerSchedule[]>("scheduler_list", { workPath });
    if (override) return override;
    return [];
  }
  return invoke<SchedulerSchedule[]>("scheduler_list", { workPath });
}

export async function addSchedule(
  workPath: string,
  schedule: SchedulerScheduleInput,
  approvalId: string,
): Promise<SchedulerSchedule> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<SchedulerSchedule>("scheduler_add", {
      workPath,
      schedule,
      approvalId,
    });
    if (override) return override;
    throw new Error("scheduler_add_unavailable");
  }
  return invoke<SchedulerSchedule>("scheduler_add", { workPath, schedule, approvalId });
}

export async function removeSchedule(workPath: string, id: string): Promise<void> {
  if (!isTauri()) {
    await invokeE2EOverride<void>("scheduler_remove", { workPath, id });
    return;
  }
  await invoke("scheduler_remove", { workPath, id });
}

export async function setScheduleEnabled(
  workPath: string,
  id: string,
  enabled: boolean,
): Promise<SchedulerSchedule> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<SchedulerSchedule>("scheduler_set_enabled", {
      workPath,
      id,
      enabled,
    });
    if (override) return override;
    throw new Error("scheduler_not_found");
  }
  return invoke<SchedulerSchedule>("scheduler_set_enabled", { workPath, id, enabled });
}

export async function runScheduleNow(workPath: string, id: string): Promise<string> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<string>("scheduler_run_now", { workPath, id });
    if (override) return override;
    throw new Error("scheduler_not_found");
  }
  return invoke<string>("scheduler_run_now", { workPath, id });
}

function mockGmailUnread(): GmailMessage[] {
  return [
    {
      id: "mock-1",
      from: "boss <boss@example.com>",
      subject: "[mock] Q2 운영회의 일정 조율",
      date: "Tue, 28 Apr 2026 09:00:00 +0900",
    },
    {
      id: "mock-2",
      from: "no-reply@plaud.ai",
      subject: "[mock] Plaud-AutoFlow 회의 요약",
      date: "Tue, 28 Apr 2026 00:29:08 +0000",
    },
  ];
}

function mockOutlookUnread(): OutlookMessage[] {
  return [
    {
      id: "outlook-1",
      from: "Operations <ops@example.com>",
      subject: "Project update",
      date: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      bodyPreview: "Please review the latest update.",
      webLink: null,
      categories: [],
      isRead: false,
    },
  ];
}

const MOCK_KAKAO_ROOM_NAME = "코이카우즈백사업단";
const MOCK_KAKAO_ROOM_SLUG = "koica-uzbek";

function mockKakaoStageResult(): KakaoStageResult {
  return {
    stagedMessages: 2,
    stagedMedia: 0,
    skipped: 0,
    errors: [],
    perRoom: { [MOCK_KAKAO_ROOM_SLUG]: { staged: 2, skipped: 0 } },
  };
}

function mockKakaoRelayStatus(): KakaoRelayStatus {
  return {
    configured: true,
    root: "/mock/Dropbox/maru-kakao-relay",
    state: "running",
    heartbeat: new Date(Date.now() - 45 * 1000).toISOString(),
    heartbeatAgeSeconds: 45,
    stale: false,
    lastError: null,
    rooms: [
      {
        name: MOCK_KAKAO_ROOM_NAME,
        slug: MOCK_KAKAO_ROOM_SLUG,
        managed: true,
        sendAllowed: true,
        priority: 1,
        messageDays: 7,
      },
    ],
  };
}

function mockKakaoRelayMessages(roomSlug: string, limit: number): KakaoRelayEnvelope[] {
  if (roomSlug !== MOCK_KAKAO_ROOM_SLUG) return [];
  const base = Date.now();
  const envelopes: KakaoRelayEnvelope[] = [
    {
      schema: "kakao-msg/v1",
      provider: "kakao",
      kind: "message",
      message: {
        id: "kakao-1",
        chat: MOCK_KAKAO_ROOM_NAME,
        room_slug: MOCK_KAKAO_ROOM_SLUG,
        sender: "김철수",
        is_me: false,
        text: "이번 주 일정 공유드립니다.",
        sent_at: new Date(base - 10 * 60 * 1000).toISOString(),
        captured_at: new Date(base - 9 * 60 * 1000).toISOString(),
        engine: "mock",
        attachments: [],
      },
    },
    {
      schema: "kakao-msg/v1",
      provider: "kakao",
      kind: "message",
      message: {
        id: "kakao-2",
        chat: MOCK_KAKAO_ROOM_NAME,
        room_slug: MOCK_KAKAO_ROOM_SLUG,
        sender: "나",
        is_me: true,
        text: "확인했습니다. 회의록은 내일까지 정리할게요.",
        sent_at: new Date(base - 5 * 60 * 1000).toISOString(),
        captured_at: new Date(base - 4 * 60 * 1000).toISOString(),
        engine: "mock",
        attachments: [],
      },
    },
  ];
  return envelopes.slice(0, Math.max(0, limit));
}

function mockTelegramRecent(): TelegramMessage[] {
  return [
    {
      id: "telegram-1",
      chatId: "ops",
      chatTitle: "Ops",
      sender: "Lee",
      text: "확인할 메시지입니다.",
      date: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      permalink: null,
    },
  ];
}

function mockAuthStatus(provider: string): ProviderAuthStatus {
  return {
    provider,
    state: "ok",
    detail: null,
    cliPath:
      provider === "mso"
        ? "/opt/homebrew/bin/m365"
        : provider === "gws"
          ? "/opt/homebrew/bin/gws"
          : "$HOME/.maru/env/.venv/bin/python",
    account: provider === "telegram" ? null : "mock@example.com",
  };
}

function mockTelegramMonitorConfig(
  workPath: string | null,
  monitorConfigPath?: string | null,
): TelegramMonitorConfigView {
  return {
    path:
      monitorConfigPath ??
      `${workPath ?? MOCK_VAULT_PATH}/.maru/secrets/services/telegram-monitor.config.yaml`,
    exists: false,
    warnings: [],
    telegram: {
      apiId: null,
      apiHash: null,
      hasApiHash: false,
      phone: null,
      selfId: null,
    },
    polling: { interval_seconds: 60 },
    chats: [],
    notification: {
      telegram: {
        botToken: null,
        hasBotToken: false,
        chatId: null,
      },
    },
  };
}

function mockTelegramMonitorConfigFromSave(
  workPath: string | null,
  monitorConfigPath: string | null,
  config: TelegramMonitorConfigSave,
): TelegramMonitorConfigView {
  return {
    ...mockTelegramMonitorConfig(workPath, monitorConfigPath),
    exists: true,
    telegram: {
      apiId: config.telegram.apiId,
      apiHash: config.telegram.apiHash ? "****mock" : null,
      hasApiHash: Boolean(config.telegram.apiHash),
      phone: config.telegram.phone,
      selfId: config.telegram.selfId,
    },
    polling: config.polling,
    chats: config.chats,
    notification: {
      telegram: {
        botToken: config.notification.telegram.botToken ? "****mock" : null,
        hasBotToken: Boolean(config.notification.telegram.botToken),
        chatId: config.notification.telegram.chatId,
      },
    },
  };
}

function mockClassification(raw: string): InboxClassification {
  const lower = raw.toLowerCase();
  if (lower.includes("meeting") || lower.includes("회의")) {
    return {
      category: "meeting",
      summary: "회의 관련 파일로 추정됩니다.",
      suggestedFolder: "meetings",
      extractedDate: null,
    };
  }
  if (lower.includes("task") || lower.includes("todo") || lower.includes("할일")) {
    return {
      category: "task",
      summary: "처리할 작업 항목이 포함됐을 수 있습니다.",
      suggestedFolder: null,
      extractedDate: null,
    };
  }
  if (lower.includes("budget") || lower.includes("kpi") || lower.endsWith(".pdf")) {
    return {
      category: "reference",
      summary: "참고자료 또는 행정 첨부로 추정됩니다.",
      suggestedFolder: "references",
      extractedDate: null,
    };
  }
  return {
    category: "noise",
    summary: "분류기 모의 응답.",
    suggestedFolder: null,
    extractedDate: null,
  };
}

export interface BinaryViewerClassification {
  category: ViewerCategory;
  mime: string | null;
  extension: string | null;
  sizeBytes: number;
  detectedFormat: string;
}

export interface BinaryViewerTextPreview {
  content: string;
  truncated: boolean;
  encoding: string;
  byteCount: number;
  shownBytes: number;
}

export interface BinaryViewerArchiveEntry {
  name: string;
  size: number;
  compressedSize: number;
  isDir: boolean;
}

export interface BinaryViewerArchivePreview {
  entries: BinaryViewerArchiveEntry[];
  totalEntries: number;
  truncated: boolean;
}

export interface BinaryViewerHwpxPreview {
  html: string;
  sections: number;
  warnings: string[];
}

export async function binaryViewerClassify(
  vaultPath: string,
  targetPath: string,
): Promise<BinaryViewerClassification> {
  if (!isTauri()) {
    return mockBinaryViewerClassify(vaultPath, targetPath);
  }
  return invoke<BinaryViewerClassification>("binary_viewer_classify", {
    vaultPath,
    targetPath,
  });
}

export async function binaryViewerPrepareAsset(
  vaultPath: string,
  targetPath: string,
): Promise<string> {
  if (!isTauri()) {
    return targetPath;
  }
  return invoke<string>("binary_viewer_prepare_asset", {
    vaultPath,
    targetPath,
  });
}

export interface PrepareHtmlEditorAssetsResult {
  documentDirectory: string;
}

export async function prepareHtmlEditorAssets(
  vaultPath: string,
  documentPath: string,
): Promise<PrepareHtmlEditorAssetsResult> {
  if (!isTauri()) {
    // Browser-mock mode (vitest/jsdom, e2e mocks): no asset protocol exists, so
    // report no directory — the runtime document then keeps URLs untouched.
    return { documentDirectory: "" };
  }
  return invoke<PrepareHtmlEditorAssetsResult>("prepare_html_editor_assets", {
    vaultPath,
    documentPath,
  });
}

export async function binaryViewerReadText(
  vaultPath: string,
  targetPath: string,
  maxBytes?: number,
): Promise<BinaryViewerTextPreview> {
  if (!isTauri()) {
    throw new Error("binaryViewerReadText requires the Tauri app.");
  }
  return invoke<BinaryViewerTextPreview>("binary_viewer_read_text", {
    vaultPath,
    targetPath,
    maxBytes: maxBytes ?? null,
  });
}

export async function binaryViewerReadArchive(
  vaultPath: string,
  targetPath: string,
): Promise<BinaryViewerArchivePreview> {
  if (!isTauri()) {
    throw new Error("binaryViewerReadArchive requires the Tauri app.");
  }
  return invoke<BinaryViewerArchivePreview>("binary_viewer_read_archive", {
    vaultPath,
    targetPath,
  });
}

export async function binaryViewerExtractHwpx(
  vaultPath: string,
  targetPath: string,
): Promise<BinaryViewerHwpxPreview> {
  if (!isTauri()) {
    throw new Error("binaryViewerExtractHwpx requires the Tauri app.");
  }
  return invoke<BinaryViewerHwpxPreview>("binary_viewer_extract_hwpx", {
    vaultPath,
    targetPath,
  });
}

export async function binaryViewerOpenExternal(
  vaultPath: string,
  targetPath: string,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("binaryViewerOpenExternal requires the Tauri app.");
  }
  await invoke("binary_viewer_open_external", { vaultPath, targetPath });
}

export async function binaryViewerPreviewExternal(
  vaultPath: string,
  targetPath: string,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("binaryViewerPreviewExternal requires the Tauri app.");
  }
  await invoke("binary_viewer_preview_external", { vaultPath, targetPath });
}

function mockBinaryViewerClassify(
  vaultPath: string,
  targetPath: string,
): BinaryViewerClassification {
  const entry =
    mockWorkspaceFiles(vaultPath).find(
      (item) => item.path === targetPath || item.relPath === targetPath,
    ) ?? null;
  const extension =
    entry?.extension ??
    targetPath
      .split("/")
      .pop()
      ?.split(".")
      .pop()
      ?.toLowerCase() ??
    null;
  const category = entry ? getViewerCategory(entry) : "unsupported";
  return {
    category,
    mime: null,
    extension,
    sizeBytes: entry?.sizeBytes ?? 0,
    detectedFormat: category === "unsupported" ? "unknown" : category,
  };
}
