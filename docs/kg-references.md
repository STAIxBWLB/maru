# KG reference mapping and visualization

For one open document, `kg_document_refs` computes which vault notes it
references and where, and two visualization features consume that map: inline
highlights in the editor, and a reference-focus mode in the graph.

Backend: `src-tauri/src/kg_refs.rs`. Frontend: `src/lib/kgRefs.ts` (offset
conversion + span flattening), `src/components/KgRefHighlight.tsx` (editor
surfaces), `GraphView`/`GraphCanvas` `referenceFocus` (graph surface).

## Mapping service

`kg_document_refs(workPath, docPath) -> DocumentRefMap` reports two match
kinds:

- **wikilink** — every `[[target]]` in body and frontmatter, resolved to a
  vault note path. The resolver mirrors the frontend
  (`src/lib/wikilinkSuggestions.ts`): exact title → filename-no-ext → exact
  relPath → relPath-no-ext → slash-suffix fallback. Unresolved targets (ghost
  nodes) are skipped — the live graph already surfaces them from
  `VaultEntry.links`.
- **entity** — occurrences of other notes' titles (plus frontmatter
  `aliases`) as whole-phrase matches in the BODY only. Case-insensitive;
  pure-ASCII phrases additionally require non-word neighbors so "Rise" does
  not match inside "arises" (Korean phrases use plain substring). Titles
  shorter than 2 chars never entity-match; caps bound the output
  (20 spans/note, 200 spans total).

Each ref carries the vault-relative `nodePath` (matches `GraphNode.relPath`),
`nodeTitle`, `matchKind`, and its `spans`.

## On-demand constraint and cache

The mapping is expensive — one regex scan of the document per vault title —
so it runs **on demand only**, through explicit user actions (the two
features below). Nothing computes it during scan, watch, or open.

Results are cached on disk at
`<work>/.maru/kg-cache/<sha256(docRelPath)>.json`. A cached entry is valid iff:

1. the document content hash (sha256 of the raw bytes) matches, AND
2. the vault stamp matches — the sha256 of the vault scan cache file
   (`.maru/cache/workspace-index-v3.json`). `scan_vault` rewrites that file
   with fresh per-file fingerprints whenever the vault actually changed, and
   identical content hashes compare equal, so no-change rescans do NOT
   invalidate the KG cache.

Known gap: a vault edit that no `scan_vault` call has picked up yet (watcher
debounce window) leaves the stamp unchanged and the stale entry is served; the
next trigger after any scan refreshes it. Document edits are always caught
immediately via the content hash.

## Byte-offset semantics (for maintainers)

Backend spans are **UTF-8 byte offsets** into the raw document content (what
`read_document` returns), not JS char offsets. `paragraph` is the 0-based
index of the blank-line-separated block containing the span start, counted
over the whole raw document — the frontmatter block counts as paragraph 0.

`src/lib/kgRefs.ts` owns the conversion:

- `buildByteToCharTable` builds a byte-offset → UTF-16 code-unit index lookup
  in one pass; multibyte interior bytes map to their lead character, so any
  backend offset (always on a character boundary) converts exactly.
- `refMapToCharSpans` flattens per-node refs into one sorted, non-overlapping
  span list. Overlaps resolve deterministically: wikilink beats entity, then
  the longer span, then the earlier start.
- `mapSpansToRenderedText` re-locates source spans inside rendered preview
  text by searching candidate texts from a moving cursor (raw `[[...]]`, then
  alias, then target for wikilinks). Spans the renderer dropped (e.g.
  frontmatter) are skipped; one miss never desyncs the rest.

Never slice the document with backend offsets directly in JS — Korean text
makes byte and char indices diverge immediately.

## Feature A — editor highlights

A per-document, session-local toggle (`toggleKgHighlight` in `App.tsx`)
fetches the map and highlights every referenced title inline:

- **Source mode** — `KgSourceBackdrop`, a mirrored text layer behind the
  (backgroundless) textarea. The textarea itself is untouched: decorations
  are pure DOM, scroll-synced, and never modify the document.
- **Preview mode** — `applyKgPreviewHighlights` wraps rendered ranges in
  `<mark>` elements (and `clearKgPreviewHighlights` unwraps them).

Clicking a highlight routes through `onKgRefNodeClick`. Leaving the document
clears the mode. The disk cache makes repeat toggles cheap.

## Feature B — graph reference focus

`visualizeDocRefs` fetches the map, collects the unique referenced node
paths, and opens the doc↔graph split (graph in the tool panel) with a
`referenceFocus: { docPath, nodePaths, nonce }`. `GraphView` resolves paths to
node ids and `GraphCanvas` highlights exactly that neighborhood; the `nonce`
re-triggers the focus when the same document is re-visualized. The focus is
per-document and clears on navigation.
