export interface VaultEntry {
  path: string;
  relPath: string;
  title: string;
  /** Raw YAML frontmatter as parsed from disk. Phase 0 surfaces all keys
   *  unmodified; Phase 1 will derive typed lenses (type, project, etc.)
   *  from this map without baking them into the Rust struct. */
  frontmatter: Record<string, unknown>;
  updatedAt: string | null;
  wordCount: number;
  snippet: string;
  fileKind: string;
  versionCount: number;
  /** Raw `[[wikilink]]` targets in this note's body + frontmatter, produced by
   *  the Rust scan. Used to compute backlinks. Optional — absent on older
   *  caches and in test fixtures. */
  links?: string[];
}

export interface DocumentPayload {
  path: string;
  relPath: string;
  title: string;
  content: string;
  body: string;
  meta: Record<string, unknown>;
  fileKind: string;
}

export interface VersionSnapshot {
  path: string;
  relPath: string;
  title: string;
  createdAt: string;
}

export interface CreatedDocument {
  path: string;
  relPath: string;
  title: string;
}

export interface DeletedDocument {
  originalPath: string;
  originalRelPath: string;
  trashPath: string;
  trashRelPath: string;
}

export type WorkspaceVisibility = "private" | "public";
export type WorkspaceProvider =
  | "local"
  | "googleDrive"
  | "oneDrive"
  | "sharePoint"
  | "nextcloud"
  | "obsidian"
  | "unknown";
export type WorkspaceExternalWriter =
  | "gdrive"
  | "onedrive"
  | "sharepoint"
  | "nextcloud"
  | "mcp-obsidian";
export type WorkspaceWritePolicy = "direct" | "delegated" | "readOnly";
export type ProviderPermissionSource = "manual" | "filesystem" | "api" | "unknown";

export interface WorkspaceCapabilities {
  canRead: boolean;
  canCreate: boolean;
  canModify: boolean;
  canDelete: boolean;
  canRenameMove: boolean;
  canShare: boolean;
  canManageMembers: boolean;
}

export interface ProviderPermissionSummary {
  role: string | null;
  source: ProviderPermissionSource;
  checkedAt: string | null;
  capabilities: WorkspaceCapabilities;
  warning?: string | null;
}

export interface WorkspaceRootEntry {
  label: string;
  path: string;
  visibility: WorkspaceVisibility;
  provider: WorkspaceProvider;
  providerId?: string | null;
  externalWriter?: WorkspaceExternalWriter | null;
  writePolicy: WorkspaceWritePolicy;
  permissionSummary?: ProviderPermissionSummary | null;
}

export interface WorkspaceRegistry {
  workspaces: WorkspaceRootEntry[];
  activeByVisibility: Record<WorkspaceVisibility, string | null>;
  hiddenDefaults: string[];
}

export interface AppError {
  message: string;
}

/** Git working-tree status of the active workspace. Returned by the Rust
 *  `git_status` command via shelling out to the user's git binary. */
export interface GitStatus {
  isRepo: boolean;
  modified: number;
  staged: number;
  untracked: number;
  /** False when badge polling intentionally skipped untracked enumeration. */
  untrackedKnown: boolean;
  clean: boolean;
  branch: string | null;
}

/** Per-file working-tree change. Returned by `git_changes`, capped at
 *  ~200 rows server-side. Renames surface the new path only. */
export interface GitFileChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  untracked: boolean;
}

export interface GitSyncExcludedPath {
  path: string;
  reason: string;
}

export interface GitSyncRepo {
  path: string;
  relPath: string;
  branch: string | null;
  status: string;
  changes: number;
  paths: string[];
  clean: boolean;
  excluded: boolean;
  exclusionReason: string | null;
  isRoot: boolean;
  depth: number;
}

export interface GitSyncScanResult {
  syncRoot: string;
  confirmBeforeCommit: boolean;
  repos: GitSyncRepo[];
  excluded: GitSyncExcludedPath[];
}

export interface GitSyncPullResult {
  repoPath: string;
  stashed: boolean;
  stdout: string;
  stderr: string;
}

export interface GitSyncCommitPushResult {
  repoPath: string;
  committed: boolean;
  pushed: boolean;
  commitStdout: string;
  pushStdout: string;
}

export interface InboxDropItem {
  id: string;
  path: string;
  relPath: string;
  title: string;
  source: string;
  sizeBytes: number;
  receivedAt: string | null;
}

export interface InboxPathConfig {
  drop: string;
  items: string;
  pending: string;
  done: string;
  failed: string;
  duplicate: string;
  state: string;
  receipts: string;
}

export interface InboxNamingConfig {
  item_id_template: string;
  raw_dir: string;
  manifest_file: string;
  extracted_file: string;
  summary_file: string;
  route_file: string;
}

export interface InboxFileDropConfig {
  channel: string;
  drop_path: string;
  operation: "copy";
}

export interface InboxGmailConfig {
  enabled: boolean;
  scan_window_days: number;
  max_results: number;
  auto_refresh_ttl_seconds: number;
  unread_only: boolean;
  query: string;
  gws_path: string | null;
}

export interface OutlookMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
  bodyPreview: string;
  webLink: string | null;
  categories: string[];
  isRead: boolean;
}

export interface OutlookDecisionRequest {
  messageId: string;
  decision: Extract<InboxDecisionValue, "accepted" | "rejected">;
}

export interface OutlookDecisionOutcome {
  messageId: string;
  decision: Extract<InboxDecisionValue, "accepted" | "rejected">;
  categoryName: string;
  archived: boolean;
  ok: boolean;
  error: string | null;
}

export interface TelegramMessage {
  id: string;
  chatId: string;
  chatTitle: string;
  sender: string;
  text: string;
  date: string;
  permalink: string | null;
}

export interface TelegramPollingStatus {
  running: boolean;
  intervalSeconds: number;
  lastStartedAt: string | null;
  lastFetchedAt: string | null;
  lastMessageCount: number;
  lastError: string | null;
}

export interface TelegramFetchOptions {
  workPath?: string | null;
  max?: number | null;
  pythonPath?: string | null;
  scriptPath?: string | null;
  sessionFile?: string | null;
  monitorConfigPath?: string | null;
  legacyAutoDrop?: boolean | null;
}

export interface TelegramDecisionOutcome {
  messageId: string;
  decision: Extract<InboxDecisionValue, "accepted" | "rejected">;
  targetPath: string | null;
  ok: boolean;
  error: string | null;
}

export interface InboxChannelConfig {
  provider: string;
  skill?: string | null;
  kind: string;
  drop_paths: string[];
  source_kinds?: Record<string, string>;
  dedupe: string;
  [extra: string]: unknown;
}

export interface InboxRuntimeConfig {
  root: string;
  schema_version?: number | null;
  paths: InboxPathConfig;
  naming: InboxNamingConfig;
  file_drop: InboxFileDropConfig;
  gmail: InboxGmailConfig;
  dedupe?: Record<string, unknown>;
  channels: Record<string, InboxChannelConfig>;
  processing?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface InboxEntry {
  id: string;
  kind: "dropFile" | "pendingItem";
  path: string;
  relPath: string;
  title: string;
  channel: string;
  sourceKind: string | null;
  dropPath: string | null;
  configuredRoot: string;
  itemId: string | null;
  status: string | null;
  manifestPath: string | null;
  summaryPath: string | null;
  routePath: string | null;
  sizeBytes: number;
  receivedAt: string | null;
}

export type InboxProcessedStatus = "done" | "failed" | "duplicate";

export interface InboxProcessedItem {
  id: string;
  status: InboxProcessedStatus | string;
  channel: string;
  provider: string | null;
  kind: string | null;
  receivedAt: string | null;
  itemDir: string;
  manifestPath: string;
  summaryPath: string | null;
  routePath: string | null;
  extractedPath: string | null;
  title: string;
  description: string | null;
  project: string | null;
  classification: string | null;
  routeStatus: string | null;
  summaryPreview: string;
  rawFileCount: number;
  updatedAt: string | null;
  error: string | null;
}

export interface InboxProcessedRawFile {
  path: string;
  relPath: string;
  sizeBytes: number;
}

export interface InboxProcessedItemDetail {
  item: InboxProcessedItem;
  manifestText: string;
  summaryText: string | null;
  routeText: string | null;
  extractedText: string | null;
  extractedTruncated: boolean;
  rawFiles: InboxProcessedRawFile[];
}

/** Latest digest summary for a source channel (from `_state/digests/*.md`). */
export interface InboxSourceDigest {
  generatedAt: string | null;
  itemsTotal: number | null;
  itemsHigh: number | null;
  itemsMed: number | null;
  itemsLow: number | null;
  threads: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  note: string | null;
}

/** Per-source processing run state (from `_state/sync-cursors.jsonl` + digests). */
export interface InboxSourceRun {
  channel: string;
  provider: string | null;
  account: string | null;
  lastRunAt: string | null;
  lastRunKind: string | null;
  lastInternalDateIso: string | null;
  itemsFetched: number | null;
  itemsNew: number | null;
  digest: InboxSourceDigest | null;
}

export interface InboxAcceptRequest {
  id: string;
  targetFolder?: string | null;
}

/** One confirmed routing decision for the inbox batch review flow. Mirrors
 *  `InboxApplyDecision` in `src-tauri/src/inbox.rs`. `itemDir` is the pending
 *  item directory (workspace-relative or absolute inside the inbox). */
export interface InboxApplyDecision {
  itemDir: string;
  /** "accept" promotes the item (filing raw originals into `destination` then
   *  moving the item dir to `done/`); "reject" moves it to `rejected/`. */
  decision: "accept" | "reject";
  /** Workspace-relative project folder for raw originals (accept only). */
  destination?: string | null;
  classification?: string | null;
  project?: string | null;
}

export interface InboxDecisionOutcome {
  id: string;
  decision: InboxDecisionValue;
  sourcePath: string;
  targetPath: string | null;
  fileName: string | null;
  ok: boolean;
  error: string | null;
}

export type InboxDecisionValue = "pending" | "accepted" | "rejected";

export type InboxTrashKind = "dropFile" | "pendingItem" | "processedItem";

export interface InboxTrashTarget {
  id: string;
  kind: InboxTrashKind;
  path: string;
}

export interface InboxTrashOutcome {
  id: string;
  kind: InboxTrashKind;
  originalPath: string;
  ok: boolean;
  error: string | null;
}

export interface ScanOptions {
  includeDotFolders: string[];
}

export interface InboxDropStageOutcome {
  id: string;
  sourcePath: string;
  targetPath: string | null;
  fileName: string | null;
  channel: string;
  dropPath: string;
  ok: boolean;
  error: string | null;
}

export interface InboxDropStageRequest {
  channel?: string | null;
  dropPath?: string | null;
  sourcePaths: string[];
}

/** Live filesystem event from the Rust `notify` watcher. Payload of the
 *  `inbox://file_event` Tauri event; mirrors `InboxFileEvent` in
 *  `src-tauri/src/inbox_watcher.rs`. */
export interface InboxFileEvent {
  vaultPath: string;
  absPath: string;
  relPath: string;
  source: string;
  /** "added" | "modified" | "removed". */
  kind: string;
}

/** Classifier output. Mirrors `Classification` in
 *  `src-tauri/src/inbox_classifier.rs`. */
export interface InboxClassification {
  /** "task" | "reference" | "meeting" | "admin" | "noise". */
  category: string;
  summary: string;
  suggestedFolder: string | null;
  extractedDate: string | null;
}

/** Gmail message envelope from `gws gmail +triage --format json`. */
export interface GmailMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
}

export interface GmailDecisionRequest {
  messageId: string;
  decision: Extract<InboxDecisionValue, "accepted" | "rejected">;
}

export interface GmailDecisionOutcome {
  messageId: string;
  decision: Extract<InboxDecisionValue, "accepted" | "rejected">;
  labelName: string;
  archived: boolean;
  ok: boolean;
  error: string | null;
}

export interface ApprovalRequest {
  id: string;
  kind: string;
  summary: string;
  target: string | null;
  payloadPreview: string | null;
  autoApproved: boolean;
}

export type ApprovalDecision = "pending" | "approved" | "rejected";

export type MissionStatus = "running" | "idle" | "done" | "failed" | "stopped";

export interface InboxProcessMissionMetadata {
  origin: "inboxProcess";
  /** First/primary channel (kept for back-compat with `inboxProcessChannel`). */
  channel: string;
  /** All distinct channels covered by a bundled review-flow run. */
  channels?: string[];
  /** When true, Anchor renders the meetings/tasks-style review + confirm flow. */
  reviewFlow?: boolean;
  inputPaths: string[];
  workspacePath?: string | null;
  skillName?: string | null;
  runtime?: string | null;
  permissionMode?: string | null;
  sourceKind?: string | null;
  parentRunId?: string | null;
}

export interface SkillMissionMetadata {
  origin?: string | null;
  skillName?: string | null;
  runtime?: string | null;
  permissionMode?: string | null;
  workspacePath?: string | null;
  inputPaths?: string[];
  sourceKind?: string | null;
  parentRunId?: string | null;
}

export type MissionMetadata = InboxProcessMissionMetadata | SkillMissionMetadata | Record<string, unknown>;

export interface MissionRecord {
  id: string;
  kind: string;
  startedAt: string;
  lastOutputAt: string;
  status: MissionStatus;
  exitCode: number | null;
  outputLogPath: string | null;
  metadata?: MissionMetadata | null;
}

export interface MissionLogTail {
  invocationId: string;
  lines: string[];
}

export interface MeetingNoteRow {
  path: string;
  relPath: string;
  fileName: string;
  sizeBytes: number;
  updatedAt: string | null;
  frontmatter: Record<string, unknown>;
}

export interface MeetingMetadata {
  relPath: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  attendees: string[];
  date: string | null;
  preview: string;
  lineCount: number;
  charCount: number;
}

export interface MeetingGuides {
  quickStart: string | null;
  glossary: string | null;
  people: string | null;
  tagStandards: string | null;
  notesGuidelines: string | null;
}

export interface MeetingsLogLineRecord {
  raw: string;
  ts: string | null;
  event: string;
  runId: string | null;
  status: string | null;
  skill: string | null;
  target: string | null;
  payload: Record<string, unknown> | null;
  legacy: boolean;
}

export type TaskBucket = "active" | "backlog" | "archive" | "calendar";
export type TaskStatus = "active" | "in-progress" | "done" | "cancelled" | "backlog";

export interface TaskNoteRow {
  path: string;
  relPath: string;
  fileName: string;
  bucket: TaskBucket;
  sizeBytes: number;
  updatedAt: string | null;
  frontmatter: Record<string, unknown>;
}

export interface TaskMetadata {
  relPath: string;
  frontmatter: Record<string, unknown>;
  preview: string;
  lineCount: number;
  charCount: number;
  tags: string[];
}

export interface CreateTaskDraft {
  slug: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  bucket: TaskBucket;
}

export interface TaskSchedulePatch {
  project?: string | null;
  priority?: string | null;
  due?: string | null;
  calendarStart?: string | null;
  calendarEnd?: string | null;
  estimateMinutes?: number | null;
}

export interface TasksLogLineRecord {
  raw: string;
  ts: string | null;
  event: string;
  runId: string | null;
  status: string | null;
  skill: string | null;
  target: string | null;
  payload: Record<string, unknown> | null;
  legacy: boolean;
}

/** Per-workspace inbox configuration persisted at `<workspace>/.anchor/inbox.json`. */
export interface InboxSettings {
  /** Workspace-relative path to the inbox root directory. */
  inboxRoot: string;
  /** Source folder names that should be classified. Empty means no filter. */
  sources: string[];
  /** Optional absolute path to the `gws` CLI binary. */
  gwsPath: string | null;
}

export type FileStoreOperation = "copy" | "move";
export type FileQueueSourceKind = "file" | "directory";

export interface FileQueueSourceInfo {
  path: string;
  sourceRelPath: string;
  fileName: string;
  sourceKind: FileQueueSourceKind;
}

export interface StoredFileOutcome {
  sourcePath: string;
  targetPath: string;
  fileName: string;
  operation: FileStoreOperation;
}

export interface WorkspaceFileEntry {
  path: string;
  relPath: string;
  name: string;
  extension: string | null;
  fileKind: string;
  sizeBytes: number;
  updatedAt: string | null;
  gitTracked: boolean;
  binary: boolean;
}

export interface FileQueueApplyItem {
  id: string;
  sourcePath: string;
  sourceKind: FileQueueSourceKind;
  targetDir: string;
  operation: FileStoreOperation;
}

export interface FileQueueApplyOutcome {
  id: string;
  sourcePath: string;
  targetPath: string;
  fileName: string;
  operation: FileStoreOperation;
}

export type FileQueueStatus = "queued" | "done" | "error";

export interface FileQueueItem extends FileQueueApplyItem {
  sourceRelPath: string;
  fileName: string;
  status: FileQueueStatus;
  targetPath?: string | null;
  message?: string | null;
}

export type MemoFormat = "plain" | "markdown";

export interface MemoEntry {
  name: string;
  path: string;
  format: MemoFormat;
  updatedAt: string | null;
  sizeBytes: number;
  preview: string;
}

export interface MemoDocument extends MemoEntry {
  content: string;
}

// === Workspace pairing + .anchor/ system mode ===

export interface WorkspaceOwner {
  name?: string | null;
  affiliation?: string | null;
  roles?: string[];
  emails?: Record<string, string>;
  github?: string | null;
}

export interface WorkspacePaths {
  primary?: string | null;
  vault?: string | null;
  mirror?: string | null;
  "private"?: string | string[] | null;
  "public"?: string | string[] | WorkspacePublicPathSpec | WorkspacePublicPathSpec[] | null;
}

export interface WorkspacePublicPathSpec {
  label?: string | null;
  path: string;
  provider?: WorkspaceProvider | null;
  providerId?: string | null;
  externalWriter?: WorkspaceExternalWriter | null;
  writePolicy?: WorkspaceWritePolicy | null;
  role?: string | null;
}

export interface WorkspaceConfig {
  version: number;
  owner?: WorkspaceOwner | null;
  paths: WorkspacePaths;
  ssot?: Record<string, string>;
  skills?: Record<string, unknown>;
  io?: Record<string, unknown>;
  inbox?: Record<string, unknown>;
  /** Unmodelled keys in workspace.config.yaml are surfaced here. */
  [extra: string]: unknown;
}

export interface WorkspaceDetect {
  workPath: string;
  configPath: string;
  config: WorkspaceConfig;
  resolvedPrivatePath: string | null;
  resolvedPrivateExists: boolean;
  resolvedPublicPath: string | null;
  resolvedPublicExists: boolean;
  publicWorkspaces?: Array<{
    label: string;
    path: string;
    exists: boolean;
    provider: WorkspaceProvider;
    providerId?: string | null;
    externalWriter?: WorkspaceExternalWriter | null;
    writePolicy: WorkspaceWritePolicy;
    role?: string | null;
  }>;
}

export interface WorkspaceSummary {
  root: string;
  privateLabel: string | null;
  privatePath: string | null;
  publicLabel: string | null;
  publicPath: string | null;
}

export interface RegisterWorkspaceOutcome {
  workspaceRegistry: WorkspaceRegistry;
  privateWorkspacePath: string;
  publicWorkspacePath: string | null;
}

export interface AnchorWorkspaceMeta {
  version: number;
  workPath: string;
  pairedVaultPath: string | null;
  ownerName: string | null;
  locale: string | null;
  /** "pkm" | "inbox" | "system" */
  lastActiveMode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnchorWorkspaceMetaPatch {
  /** v1 semantics: pass a string to set the field. Omitting (or
   *  passing `null`/`undefined`) leaves the existing value unchanged.
   *  Clearing a field is not yet supported through this patch. */
  pairedVaultPath?: string | null;
  ownerName?: string | null;
  locale?: string | null;
  lastActiveMode?: string | null;
}

export interface RuleEntry {
  name: string;
  title: string;
  enabled: boolean;
  scope: string | null;
  origin: string | null;
  updatedAt: string | null;
}

export interface RuleDocument {
  name: string;
  relPath: string;
  content: string;
  title: string;
  enabled: boolean;
}

export interface TemplateEntry {
  name: string;
  title: string;
  docType: string | null;
  origin: string | null;
  updatedAt: string | null;
}

export interface ImportItem {
  category: "rule" | "template" | "mcp" | "projects" | "skills";
  originAbs: string;
  originRel: string;
  targetRel: string;
  /** "new" | "update" | "unchanged" */
  status: string;
  originSha256: string;
  label: string;
}

export interface ImportPlan {
  workPath: string;
  sysPresent: boolean;
  rules: ImportItem[];
  templates: ImportItem[];
  mcp: ImportItem | null;
  projects: ImportItem | null;
  skills: ImportItem | null;
}

export interface ImportReceipt {
  applied: ImportItem[];
  skipped: ImportItem[];
}
