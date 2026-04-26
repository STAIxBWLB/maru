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
