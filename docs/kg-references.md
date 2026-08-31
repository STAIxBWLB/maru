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
2. the vault stamp matches: a sha256 over the *identity* of every note in the
   vault scan cache (`.maru/cache/workspace-index-v4.json`): rel path, title and
   aliases, which is exactly what wikilink resolution and entity matching key
   on. Bodies, fingerprints and timestamps are deliberately excluded, so editing
   an unrelated note cannot invalidate this document's map. Entries are sorted
   before hashing, so repeated no-change rescans stamp equal.

   The stamp used to be the sha256 of the whole scan-cache file, which meant any
   write anywhere in the workspace invalidated every document's map and made the
   expensive path the common one. `kg_document_refs` is also
   `#[tauri::command(async)]`, so a cache miss cannot block the UI thread.

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
`referenceFocus: { source: "editor", docPath, docRoot, nodePaths, steps, nonce }`. `GraphView` resolves
paths to node ids and `GraphCanvas` highlights exactly that neighborhood; the
`nonce` re-triggers the focus when the same document is re-visualized. The focus
is source-owned: editor focus still clears when the active editor document
changes, while Drafts and Gap can overlay their selected unconfirmed item
without being cleared by editor navigation. Drafts and Gap resolve
`originRefs`, `promotedTo`, and body wikilinks against the primary workspace
entries in the frontend; they never add scratchpad or draft files as graph
nodes. The Ideation detail shows up to eight resolved relationship chips,
sorted by graph degree, while the graph overlay receives every resolved node
path (the chip cap is only a compact projection). Both panes use the existing
graph-panel opener. Selection changes and the existing exit action clear
Drafts/Gap focus. In-flight editor focus requests are monotonic and source
owned, so a late response cannot replace a newer Drafts/Gap overlay or reopen
the graph. When nothing resolves, the bar says so instead of reporting "0
nodes highlighted".

`docRoot` carries the workspace the `nodePaths` are relative to, and it is load
bearing: graph nodes are rooted at the graph's own data path, which is
`<work>/vault` for `source: "vault"`. Comparing the two relative strings
resolved nothing at all on a nested-vault layout, so `resolveReferenceNodeIds`
(`src/lib/kgRefs.ts`) rebases both sides to absolute before matching.

### The converge animation

Referenced nodes gather toward the centroid of the referenced set and ease back
(`KG_REF_CONVERGE`, `KG_REF_ANIM_DURATION_MS`), honouring
`prefers-reduced-motion` by jumping to the rest state. Two constraints make this
work, and breaking either one renders nothing while still burning frames:

- The per-frame repaint must be
  `refresh({ partialGraph, skipIndexation: true })`. A bare `refresh()` takes
  sigma's full-refresh path, whose `process()` re-reads x/y from the graphology
  attributes and discards the reducer's animated coordinates. The animation
  moves nodes purely through the reducer; the graph data never changes.
- `partialGraph` must include the animated nodes' **incident edges**. Edge
  geometry is baked from the node cache at upload time, so a nodes-only partial
  refresh leaves the edges behind and tears the subgraph apart.

The animation waits for a ready renderer and consumes its trigger nonce only on
completion, so a run cut short by an FA2 restart is retried once the graph
settles. `e2e/kg-references.spec.ts` asserts the nodes actually move, reading
rendered display data through the graph bridge's `nodeScreenState`. Note that
`nodeViewportPoint` projects the graphology attributes and therefore cannot
observe a reducer-only move.
