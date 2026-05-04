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

/** Anchor multi-vault registry. external_writer === "mcp-obsidian"
 *  signals that anchor reads but defers writes to an Obsidian instance
 *  (write delegation lands in Phase 2). */
export interface VaultRegistryEntry {
  label: string;
  path: string;
  externalWriter?: string | null;
}

export interface VaultList {
  vaults: VaultRegistryEntry[];
  activeVault: string | null;
  hiddenDefaults: string[];
}

export interface AppError {
  message: string;
}

/** Git working-tree status of the active vault. Returned by the Rust
 *  `git_status` command via shelling out to the user's git binary. */
export interface GitStatus {
  isRepo: boolean;
  modified: number;
  staged: number;
  untracked: number;
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

/** Per-vault inbox configuration persisted at `<vault>/.anchor/inbox.json`.
 *  Read on vault activation and applied to scan / watcher / Gmail commands. */
export interface InboxSettings {
  /** Vault-relative path to the inbox root directory. */
  inboxRoot: string;
  /** Source folder names that should be classified. Empty list means
   *  "accept everything", but the UI treats it as "no filter active". */
  sources: string[];
  /** Optional absolute path to the `gws` CLI binary. */
  gwsPath: string | null;
}
