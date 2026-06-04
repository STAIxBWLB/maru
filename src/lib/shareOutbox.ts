// Pure helpers + shared types for the Shared Outbox right-pane tab. The
// `share_outbox` block in workspace.config.yaml is the SSOT; the backend owns
// reading/validating it. These helpers build the de-duped share queue and
// classify which sources are shareable.

/** Result of `read_share_outbox_config` (serde camelCase). */
export interface ShareOutboxAuthor {
  key: string;
  suffix: string | null;
  nameRef: string | null;
  isDefault: boolean;
}

export interface ShareOutboxConfig {
  present: boolean;
  root: string | null;
  rootResolved: string | null;
  rootExists: boolean;
  insideWorkspace: boolean;
  hasRequiredConfig: boolean;
  missingKeys: string[];
  timezone: string | null;
  defaultAuthor: string | null;
  authors: ShareOutboxAuthor[];
}

/** Result of `ensure_share_outbox_root`. */
export interface ShareOutboxEnsureResult {
  rootResolved: string;
  created: boolean;
}

/** One entry of `scan_share_outbox().items`. */
export interface ShareOutboxRecentItem {
  output: string;
  name: string;
  title: string;
  author: string;
  timestamp: string;
  exists: boolean;
}

/** Result of `scan_share_outbox`. */
export interface ShareOutboxScan {
  rootResolved: string | null;
  rootExists: boolean;
  indexExists: boolean;
  items: ShareOutboxRecentItem[];
  totalReceipts: number;
  skippedLines: number;
}

/** One source passed to `prepare_share_outbox_files`. */
export interface ShareOutboxSource {
  path: string;
  title?: string | null;
}

/** Per-file outcome of `prepare_share_outbox_files`. */
export interface ShareOutboxResult {
  source: string;
  ok: boolean;
  dryRun: boolean;
  output: string | null;
  error: string | null;
}

export type ShareQueueSource = "document" | "files" | "inbox" | "manual";

export interface ShareQueueItem {
  /** Absolute path. */
  path: string;
  /** Display label (document title or basename). */
  label: string;
  source: ShareQueueSource;
  shareable: boolean;
  /** i18n key resolved by the caller; only set when `!shareable`. */
  disabledReason?: string;
}

export interface BuildShareQueueInput {
  activeDocument: { path: string; title: string; dirty: boolean } | null;
  selectedFileEntries: Array<{ path: string; name?: string }>;
  inboxShareablePaths: string[];
  manualPaths: string[];
}

/** Last path segment, ignoring trailing separators. */
export function basenameOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** A trailing separator marks a directory, which is never shareable. */
export function isDirectoryPath(path: string): boolean {
  return /[/\\]$/.test(path.trim());
}

/**
 * Build the ordered, de-duped share queue. Source priority (lowest wins on
 * duplicate paths): document < files < inbox < manual. A dirty active document
 * is non-shareable ("save first"); directory paths are non-shareable.
 */
export function buildShareQueue(input: BuildShareQueueInput): ShareQueueItem[] {
  const items: ShareQueueItem[] = [];
  const seen = new Set<string>();

  const push = (item: ShareQueueItem) => {
    if (seen.has(item.path)) return;
    seen.add(item.path);
    items.push(item);
  };

  const pushFileLike = (path: string, source: ShareQueueSource) => {
    const isDir = isDirectoryPath(path);
    push({
      path,
      label: basenameOf(path),
      source,
      shareable: !isDir,
      disabledReason: isDir ? "shareOutbox.reason.directory" : undefined,
    });
  };

  if (input.activeDocument) {
    const doc = input.activeDocument;
    push({
      path: doc.path,
      label: doc.title || basenameOf(doc.path),
      source: "document",
      shareable: !doc.dirty,
      disabledReason: doc.dirty ? "shareOutbox.reason.saveFirst" : undefined,
    });
  }
  for (const entry of input.selectedFileEntries) {
    pushFileLike(entry.path, "files");
  }
  for (const path of input.inboxShareablePaths) {
    pushFileLike(path, "inbox");
  }
  for (const path of input.manualPaths) {
    pushFileLike(path, "manual");
  }
  return items;
}

/**
 * Whether an inbox row maps to a concrete shareable file. `file` rows (raw drop
 * files) and `dropFile` entries point at real files; `pendingItem` entries
 * point at an item directory (manifest), so they are not directly shareable.
 */
export function isInboxRowShareable(args: {
  kind: "entry" | "file";
  entryKind?: "dropFile" | "pendingItem";
}): boolean {
  if (args.kind === "file") return true;
  return args.entryKind === "dropFile";
}
