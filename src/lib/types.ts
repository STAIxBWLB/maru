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

export interface InboxDropItem {
  id: string;
  path: string;
  relPath: string;
  title: string;
  source: string;
  sizeBytes: number;
  receivedAt: string | null;
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
