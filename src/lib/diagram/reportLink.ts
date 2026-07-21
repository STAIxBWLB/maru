/**
 * Managed Markdown blocks for "Insert/Update in report" (Report Pattern
 * Studio Phase 4).
 *
 * A managed block links a Markdown report to a rendered diagram asset:
 *
 * ```md
 * <!-- maru-diagram:v1 {"source":"diagrams/example.cmd.json","scope":"pattern:<id>","asset":"attachments/diagrams/<doc-id>/<scope>-<hash>.svg","fallback":"attachments/diagrams/<doc-id>/<scope>-<hash>.png","renderHash":"sha256:<hash>"} -->
 * ![Caption](attachments/diagrams/<doc-id>/<scope>-<hash>.svg)
 * ```
 *
 * Everything outside the block is user content and is preserved byte-for-byte
 * across splices — the same contract as the Today journal splice
 * (`splice_journal` in `src-tauri/src/today_store.rs`). The block is replaced
 * in place when a block with the same `source` AND `scope` already exists;
 * otherwise it is appended at the end of the document.
 */

export const MANAGED_BLOCK_MARKER = "<!-- maru-diagram:v1";

export interface ManagedBlockAttrs {
  /** Workspace-relative path of the source diagram (`diagrams/<name>.cmd.json`). */
  source: string;
  /** `pattern:<viewId>` for a single pattern view, `doc` for the whole canvas. */
  scope: string;
  /** Workspace-relative path of the primary (SVG) asset. */
  asset: string;
  /** Workspace-relative path of the PNG fallback asset. */
  fallback?: string;
  /** `sha256:<hex>` of the canonical serialized doc + render options. */
  renderHash?: string;
}

export interface ManagedBlockMatch {
  /** Char offset of the first character of the comment line. */
  start: number;
  /** Char offset just past the last character of the block (the image line
   *  when present, otherwise the comment line). Never includes the trailing
   *  newline, so surrounding bytes survive a splice untouched. */
  end: number;
  attrs: ManagedBlockAttrs;
}

export interface BuildManagedBlockArgs {
  source: string;
  scope: string;
  assetPath: string;
  fallbackPath?: string;
  renderHash?: string;
  caption: string;
}

/** Escape a caption so it cannot break the Markdown image syntax. */
function escapeCaption(caption: string): string {
  return caption.replace(/\r?\n/g, " ").replace(/[[\]]/g, "");
}

export function buildManagedBlock(args: BuildManagedBlockArgs): string {
  const attrs: ManagedBlockAttrs = {
    source: args.source,
    scope: args.scope,
    asset: args.assetPath,
    ...(args.fallbackPath !== undefined ? { fallback: args.fallbackPath } : {}),
    ...(args.renderHash !== undefined ? { renderHash: args.renderHash } : {}),
  };
  // `>` only occurs inside JSON string values (a diagram named "x --> y" would
  // otherwise terminate the HTML comment mid-JSON); > survives JSON.parse.
  const json = JSON.stringify(attrs).replace(/>/g, "\\u003e");
  const comment = `${MANAGED_BLOCK_MARKER} ${json} -->`;
  const image = `![${escapeCaption(args.caption)}](${args.assetPath})`;
  return `${comment}\n${image}`;
}

const COMMENT_RE = /<!-- maru-diagram:v1 (\{[^\n]*?) -->/g;
const IMAGE_RE = /^!\[[^\]]*\]\(\S+\)[ \t]*$/;

function isAttrs(value: unknown): value is ManagedBlockAttrs {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.source === "string" &&
    typeof record.scope === "string" &&
    typeof record.asset === "string"
  );
}

/**
 * Find every `maru-diagram:v1` comment block plus its following image line.
 * Malformed JSON attributes are skipped with a warning (the block is left
 * alone — Maru never rewrites what it cannot parse). The image line may
 * follow on the next line; blank lines between comment and image are
 * tolerated and left outside the block range.
 */
export function parseManagedBlocks(markdown: string): ManagedBlockMatch[] {
  const out: ManagedBlockMatch[] = [];
  COMMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMMENT_RE.exec(markdown)) !== null) {
    const start = match.index;
    const commentEnd = start + match[0].length;
    let attrs: ManagedBlockAttrs;
    try {
      const parsed: unknown = JSON.parse(match[1] ?? "");
      if (!isAttrs(parsed)) throw new Error("missing required keys");
      attrs = parsed;
    } catch (err) {
      console.warn("maru-diagram: skipping malformed managed block", err);
      continue;
    }
    let end = commentEnd;
    // Tolerantly attach the image line: it may follow on the next line, with
    // blank lines in between (which stay outside the managed range).
    let cursor = commentEnd;
    while (cursor < markdown.length) {
      const lineEnd = markdown.indexOf("\n", cursor);
      const stop = lineEnd === -1 ? markdown.length : lineEnd;
      const line = markdown.slice(cursor, stop);
      if (line.trim().length === 0) {
        if (lineEnd === -1) break;
        cursor = lineEnd + 1;
        continue;
      }
      if (IMAGE_RE.test(line)) end = stop;
      break;
    }
    out.push({ start, end, attrs });
  }
  return out;
}

/** Does the document already link this diagram + scope? */
export function findManagedBlock(
  markdown: string,
  match: { source: string; scope: string },
): ManagedBlockMatch | null {
  return (
    parseManagedBlocks(markdown).find(
      (block) =>
        block.attrs.source === match.source && block.attrs.scope === match.scope,
    ) ?? null
  );
}

export interface SpliceResult {
  content: string;
  mode: "inserted" | "updated";
}

function appendBlock(markdown: string, block: string): string {
  if (markdown.trim().length === 0) return `${block}\n`;
  let base = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  if (!base.endsWith("\n\n")) base += "\n";
  return `${base}${block}\n`;
}

/**
 * Replace the block whose attrs share `match.source` AND `match.scope`, or
 * append the block at the end of the document when none exists. Content
 * outside the block is preserved byte-for-byte. Idempotent: splicing the
 * same block twice is a no-op on the second pass.
 */
export function spliceManagedBlock(
  markdown: string,
  block: string,
  match: { source: string; scope: string },
): SpliceResult {
  const existing = findManagedBlock(markdown, match);
  if (existing) {
    return {
      content: markdown.slice(0, existing.start) + block + markdown.slice(existing.end),
      mode: "updated",
    };
  }
  return { content: appendBlock(markdown, block), mode: "inserted" };
}
