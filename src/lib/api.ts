import { invoke } from "@tauri-apps/api/core";
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
import { invokeE2EOverride } from "./e2eInvoke";
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
  InboxProcessedItem,
  InboxProcessedItemDetail,
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
  IdeationStage,
  TempCleanupCandidate,
  TempCleanupResult,
  TempCleanupSelection,
  ScratchpadMigrationResult,
  StoredFileOutcome,
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
  WorkspaceFileEntry,
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
  if (!isTauri()) return mockEntries(vaultPath);
  return invoke<VaultEntry[]>("scan_vault", { vaultPath, scanOptions: scanOptions ?? null });
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

/** Community-overlay JSON (`<workspace>/reports/vault-graph.json`, built by
 *  the weekly /vault-graph ritual). null = absent or unavailable — the graph
 *  mode degrades to the live layer. Corrupt file rejects with the reason. */
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

export async function scanInboxEntries(workPath: string, scanOptions?: ScanOptions): Promise<InboxEntry[]> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<InboxEntry[]>("scan_inbox_entries", {
      workPath,
      scanOptions: scanOptions ?? null,
    });
    if (override) return override;
    return [];
  }
  return invoke<InboxEntry[]>("scan_inbox_entries", { workPath, scanOptions: scanOptions ?? null });
}

export async function scanInboxProcessedItems(
  workPath: string,
  statuses?: InboxProcessedStatus[] | null,
  query?: string | null,
  limit = 100,
): Promise<InboxProcessedItem[]> {
  if (!isTauri()) return [];
  return invoke<InboxProcessedItem[]>("scan_inbox_processed_items", {
    workPath,
    statuses: statuses ?? null,
    query: query ?? null,
    limit,
  });
}

export async function readInboxProcessedItem(
  workPath: string,
  itemDir: string,
): Promise<InboxProcessedItemDetail> {
  if (!isTauri()) {
    throw new Error("Processed inbox item details require the Tauri shell.");
  }
  return invoke<InboxProcessedItemDetail>("read_inbox_processed_item", { workPath, itemDir });
}

export async function readInboxSourceRuns(workPath: string): Promise<InboxSourceRun[]> {
  if (!isTauri()) return [];
  return invoke<InboxSourceRun[]>("read_inbox_source_runs", { workPath });
}

export async function countInboxProcessedByChannel(
  workPath: string,
): Promise<Record<string, number>> {
  if (!isTauri()) return {};
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

export async function gitStatusFast(vaultPath: string): Promise<GitStatus> {
  if (!isTauri()) {
    return { isRepo: false, modified: 0, staged: 0, untracked: 0, untrackedKnown: false, clean: true, branch: null };
  }
  return invoke<GitStatus>("git_status_fast", { vaultPath });
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

export type AgentProvider = "claude" | "codex";

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
  if (!isTauri()) return [];
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

export async function terminalSpawn(
  sessionId: string,
  kind: TerminalKind,
  cwd: string | null = null,
  options: TerminalSpawnOptions = {},
): Promise<string> {
  if (!isTauri()) {
    throw new Error("Integrated terminal is only available inside the Tauri shell.");
  }
  return invoke<string>("terminal_spawn", {
    sessionId,
    kind,
    cwd,
    command: options.command ?? null,
    extraArgs: options.extraArgs ?? null,
    extraEnv: options.extraEnv ?? null,
    cols: options.cols ?? null,
    rows: options.rows ?? null,
  });
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
  if (!isTauri()) return [];
  return invoke<ScratchpadEntry[]>("scratchpad_list", { workPath });
}

export async function readScratchpadDocument(
  workPath: string,
  collection: ScratchpadCollection,
  relativePath: string,
): Promise<ScratchpadDocument> {
  if (!isTauri()) {
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
  return invoke<ScratchpadDocument>("scratchpad_create_idea", { workPath, title });
}

export async function transitionScratchpadIdea(
  workPath: string,
  relativePath: string,
  stage: IdeationStage,
  expectedRevision: string,
): Promise<ScratchpadDocument> {
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
