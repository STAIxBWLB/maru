import { frontmatterScalar } from "./document";
import type { DocumentPayload, VaultEntry } from "./types";
import {
  buildEntryIndex,
  resolveTargetIndexed,
  type EntryIndex,
} from "./wikilinkSuggestions";

export interface NeighborhoodTarget {
  /** Display title — falls back to the raw target if unresolved. */
  title: string;
  /** Workspace-relative path of the resolved entry, or "" when unresolved. */
  relPath: string;
  /** Resolved VaultEntry, or null when the target is missing in the vault. */
  entry: VaultEntry | null;
  /** Original wikilink target text (used for "create new" Phase 1B). */
  target: string;
}

export interface UpwardField {
  field: string;
  targets: NeighborhoodTarget[];
}

export interface Neighborhood {
  /** Frontmatter wikilink fields grouped by key (project, parent, related…). */
  upward: UpwardField[];
  /** All `[[…]]` mentions extracted from the body, deduplicated. */
  mentions: NeighborhoodTarget[];
  /** Same-`type` peer notes, mtime desc, capped. Same-project preferred. */
  peers: VaultEntry[];
}

const PEER_LIMIT = 12;
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

/** Walk a frontmatter value (string, list, nested map) collecting every
 *  `[[wikilink]]` target text it contains. Used so any frontmatter key with
 *  a wikilink — `project: [[X]]`, `related: [[A]] [[B]]`, custom keys — is
 *  surfaced in the upward section without hardcoding field names. */
function collectWikilinkTargets(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") {
    const out: string[] = [];
    const re = new RegExp(WIKILINK_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
      const inner = m[1];
      const pipeIdx = inner.indexOf("|");
      const target = (pipeIdx !== -1 ? inner.slice(0, pipeIdx) : inner).trim();
      if (target) out.push(target);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectWikilinkTargets);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(
      collectWikilinkTargets,
    );
  }
  return [];
}

function dedupePreserveOrder<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function toNeighborhoodTarget(
  index: EntryIndex,
  entries: VaultEntry[],
  target: string,
): NeighborhoodTarget {
  const resolved = resolveTargetIndexed(index, entries, target);
  return {
    title: resolved?.title ?? target,
    relPath: resolved?.relPath ?? "",
    entry: resolved,
    target,
  };
}

/** Compute the live neighborhood for the open document. Pure; runs on every
 *  draftContent change. For the small vaults Phase 1A targets (work/ ~4k
 *  notes) this is well under 10ms. If profiling shows it dominates, move to
 *  a Rust command keyed on document path + entries hash. */
export function buildNeighborhood(
  document: DocumentPayload,
  draftContent: string,
  entries: VaultEntry[],
  /** Pass a precomputed index when this is on a hot path (called per
   *  keystroke). Falls back to building one inline when omitted. */
  precomputedIndex?: EntryIndex,
): Neighborhood {
  const index = precomputedIndex ?? buildEntryIndex(entries);
  const meta = (document.meta ?? {}) as Record<string, unknown>;

  const upward: UpwardField[] = [];
  for (const [field, value] of Object.entries(meta)) {
    const targets = collectWikilinkTargets(value);
    if (targets.length === 0) continue;
    const unique = [...new Set(targets)];
    upward.push({
      field,
      targets: unique.map((t) => toNeighborhoodTarget(index, entries, t)),
    });
  }

  const body = draftContent.replace(FRONTMATTER_RE, "");
  const mentionTargets: string[] = [];
  const re = new RegExp(WIKILINK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const inner = m[1];
    const pipeIdx = inner.indexOf("|");
    const target = (pipeIdx !== -1 ? inner.slice(0, pipeIdx) : inner).trim();
    if (target) mentionTargets.push(target);
  }
  const mentions = dedupePreserveOrder(
    mentionTargets.map((t) => toNeighborhoodTarget(index, entries, t)),
    (item) => item.target,
  );

  const myType = frontmatterScalar(meta, "type");
  const myProject = frontmatterScalar(meta, "project");
  let peers: VaultEntry[] = [];
  if (myType) {
    peers = entries
      .filter(
        (entry) =>
          entry.path !== document.path &&
          frontmatterScalar(entry.frontmatter, "type") === myType,
      )
      .sort((a, b) => {
        const aSameProject =
          myProject != null &&
          frontmatterScalar(a.frontmatter, "project") === myProject;
        const bSameProject =
          myProject != null &&
          frontmatterScalar(b.frontmatter, "project") === myProject;
        if (aSameProject !== bSameProject) return aSameProject ? -1 : 1;
        return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
      })
      .slice(0, PEER_LIMIT);
  }

  return { upward, mentions, peers };
}
