# Diagram mode

The `diagram` activity-rail mode (label 다이어그램 / Diagram) is a self-contained
concept-map editor, adapted from a standalone 14k-line HTML editor into a
first-class Maru mode (Phase 0–7, hardened 2026-05-27). It ships **default-on**;
opt out via Settings → Preferences → "Diagram mode", `VITE_MARU_DIAGRAM=0`, or
`?maru-diagram=0`. The **Report Pattern Studio** track (schema v8) adds typed
report datasets, pattern views, table editing, a codec registry, and managed
"Insert/Update in report" links into Markdown documents. Schema v9 (issue #433)
adds typed semantic datasets for Archify-based generation and editing.

## Documents

Diagrams live at `<workspace>/diagrams/<name>.cmd.json` — a `v:9` envelope
(report datasets + pattern views + typed semantic datasets; the version
numbering continues the source HTML's past its broken `localhost:5500`
autosave boundary). The last-opened document is restored from
`diagram.lastDocument`; unsaved state is workspace-keyed.

**Legacy migration.** `v:7`/`v:8` documents migrate in memory on load (v8→v9
is a version bump only). The first save at the current schema over a migrated
document triggers a one-time backup to
`<workspace>/.maru/diagrams/backups/<name>-v<source>-<ts>.cmd.json` (temp-file +
rename, so a crash cannot leave a truncated backup). A backup failure **aborts
the save** — overwriting the only legacy copy without a backup would be
unrecoverable — and the next save attempt retries the backup. Save-As to a
different name leaves the legacy file untouched, so no backup runs.

Storage paths:

- `diagrams/<name>.cmd.json` — diagram documents.
- `.maru/diagram-patterns/<name>.pattern.json` — workspace pattern presets.
- `.maru/diagrams/history/<docId>/` — auto-snapshot ring (cap 20).
- `.maru/diagrams/backups/` — one-time legacy-schema backups.
- `attachments/diagrams/<docId>/` — rendered report assets (SVG/PNG), the
  only write target outside the diagram stores.

Backend commands (`src-tauri/src/diagram/mod.rs`): `diagram_save_document`,
`diagram_load_document`, `diagram_list_documents`, `diagram_delete_document`,
`diagram_export_blob` / `diagram_export_blob_to_path`, snapshot commands
`diagram_save_snapshot` / `diagram_list_snapshots` / `diagram_restore_snapshot`,
`diagram_backup_document` (one-time legacy backup), pattern presets
`diagram_pattern_save` / `diagram_pattern_list` / `diagram_pattern_delete`,
and `diagram_write_report_asset` (report assets; extension-whitelisted to
svg/png/json, traversal-safe, atomic, write-guard checked). Generation adds
`archify_validate_candidate` (`src-tauri/src/archify.rs`, pinned-engine
validation) and the architecture gallery adds
`architecture_read_sibling_spec` (`src-tauri/src/architecture.rs`, guarded
sibling read). The command-isolation gate now expects **387** registered
commands with recorded evidence (`Makefile` `--expected-count 387`).

## Canvas & nodes

- 13 node kinds: simple, text, numbered, section, titled-box, split-box, diamond,
  oval, hexagon, cylinder, callout, table, image — all rendered as SVG.
- 4-port edges (auto / straight routing) with arrowheads and labels.
- Smart-guide snap (left/center/right + top/center/bottom), configurable snap
  size 1–200 px.
- Selection ops: align / distribute / equalize, z-order, style copy/paste,
  color presets, lock/hide enforcement across move/nudge/resize/delete/edit.
- Memos, status chips, progress bars, focus mode, find/replace (⌘F or `/`).

## Ribbon

HWP-style 9-tab ribbon with filled Tools / Infographic / Arrow / Table tabs, a
drag-reorder Layers panel (lock/hide/rename), and a per-selection Property panel.

## Templates

11 localized templates: PDCA cycle, PDCA grid, SWOT, fishbone, mind-map,
org-chart, roadmap, kanban, keyword grid, process flow, blank.

## Report Pattern Studio

v8 documents carry typed **report datasets** (matrix, and record-based kinds)
plus **pattern views** — live projections of a dataset through a report
pattern (tables, timelines, scorecards, trees, flows, networks, …; ids like
`report.timeline`, `report.kpi-scorecard`). The pattern gallery inserts a
pattern as a new document or at the pointer, converts a selected view to
another pattern, and saves/applies workspace presets.

**Pattern editing & conversion fidelity.** Conversions classify as:

- `same-family` — the target pattern projects the same dataset kind; one
  command regenerates the view's members losslessly (no dialog).
- `cross-family` — records are extracted from the source dataset and remapped
  through a field-mapping preview dialog; unmapped fields surface as warnings.
- `freeform` — legacy templates and hand-built content are non-convertible;
  deleting a strict subset of a view's generated members asks to detach them
  first.

**Table editing.** Table nodes bind a matrix dataset; cell-level editing is
keyboard-first: F2 (or a printable character) opens the cell editor, Enter
commits and moves down, Tab / Shift+Tab move right/left, Escape closes,
arrows move the cell focus, Delete clears the range, and the Table ribbon tab
merges/splits cells and adds/removes rows/columns. Pasting from the OS
clipboard understands HTML tables, TSV, and Markdown tables.

## Typed semantic datasets (schema v9)

v9 adds the `semanticSpec` dataset kind (`src/lib/diagram/reportTypes.ts`):
the canonical, editable meaning of a generated diagram. `spec` is the Archify
typed JSON (interchange/renderer input); canvas members are a projection of
the dataset, never a second semantic source. `idMap` is the reversible
Archify-safe-id → Maru-id mapping (Archify ids forbid `:` and leading digits;
Maru member ids like `ds:m0` do not), `engine` pins the `archify` engine
version the spec round-trips through, and `provenance` records the origin
(`generated` / `imported` / `gallery-copy`) with a source path when one
exists. Fields the pinned engine cannot represent are kept verbatim in
`preservedExtensions` and reported as fidelity diagnostics — never silently
stripped, never re-emitted as if the engine supported them.

Because canvas members are projections, freeform edits to a managed member
require detaching it first (the same detach contract as report pattern
views); the semantic spec stays the source of truth. v8→v9 is a version bump
only — v8 documents migrate in memory on load with no content rewrites.

## Generation and safe editing (issue #433)

The File ribbon's 다이어그램 생성 action (`GenerateDiagramDialog`; pipeline
in `src/lib/diagram/generation.ts` + `proposal.ts`) runs: requirements →
agent produces a bounded candidate (`semanticSpec` dataset) → strict
validation through the pinned engine (`archify_validate_candidate`) → preview
with candidate summary, categorized diff, engine receipt and diagnostics →
explicit apply → conditional save. Nothing mutates the document before the
apply click; blocking diagnostics (a locked-node target, a silently removed
boundary edge) disable apply, and the offending ops are dropped from the
proposal so the op list alone can never mutate out-of-scope or locked
members.

Scoped edits (an active selection at open time) may modify or remove only
scoped node ids; additions of brand-new ids are allowed. Boundary edges
(exactly one endpoint in scope) may be updated but never removed silently —
a kept one is reported, a removed one blocks. Edges fully outside the scope
and locked nodes are never touched. `prepareProposalApply` re-checks the
base memory revision (stale → re-preview), validates the would-be result,
and returns a single transformer wrapped in exactly one `withSnapshot` undo
entry.

Saves are conditional on `expected_revision` (the `diagramRevision` of the
loaded/last-saved body): a file that changed on disk since the load rejects
with a `document_conflict` IpcError and is left untouched. UI apply success
is therefore not a durable save — canvas state and the on-disk document are
separate commitments, and a conflict surfaces as a notice, never an
automatic retry.

Unavailability degrades honestly: a missing engine surfaces the typed
`ENGINE_UNAVAILABLE` diagnostic, an unreachable agent host surfaces the
failed-run state, and the Mermaid paste import path (`mermaidToDocDetailed`,
agent- and engine-free) keeps working, reporting skipped constructs as
localized diagnostics.

## Archify engine pin

The validation/render engine is the vendored, hash-pinned copy at
`sidecars/archify/` — never the user-installed skill at
`~/.agents/skills/archify`, which is user-mutable. `sidecars/archify/PIN.json`
carries `version`, `repository`, a 40-hex `revision` (plus `revisionRef`),
`pinnedAt`, `license: MIT` with `licenseHolders`, the vendoring `excludes`,
and a `fileHashes` SHA-256 manifest of every vendored file. `make verify`
runs `check-archify-pin` (`scripts/check-archify-pin.mjs`), which fails the
build when the tree drifts from the manifest, when LICENSE or
THIRD_PARTY_NOTICES.md go missing, or when the pin metadata is incomplete.

Refresh after a deliberate engine update: re-vendor the files, regenerate
the manifest from the repo root —

```bash
node -e 'const{createHash}=require("node:crypto"),{readdirSync,readFileSync,statSync}=require("node:fs"),{join,relative,sep}=require("node:path");const root="sidecars/archify";const walk=(d)=>readdirSync(d).sort().flatMap((e)=>{const p=join(d,e);return statSync(p).isDirectory()?walk(p):[p]});const out={};for(const f of walk(root)){const rel=relative(root,f).split(sep).join("/");if(rel!=="PIN.json")out[rel]=createHash("sha256").update(readFileSync(f)).digest("hex")}console.log(JSON.stringify(out,null,2))'
```

— write the result into `PIN.json.fileHashes`, bump `version` / `revision` /
`pinnedAt`, review the diff, and keep the MIT notices (LICENSE,
THIRD_PARTY_NOTICES.md) intact.

## Architecture gallery handoff

The Architecture gallery's "Diagram으로 복사해 편집" action copies a
blueprint's `<slug>.architecture.json` spec into Diagram mode as a NEW
workspace diagram. The read goes through `architecture_read_sibling_spec`,
a guarded sibling read: the spec must live in the same submodule as the
viewer (own containment check with `..`/symlink resolution, symlinks
escaping the submodule root refused), under a 1 MiB size cap, and it must
parse against the Archify schema — a missing or unsupported spec simply
leaves the action unavailable. The copy lands as a `semanticSpec` dataset
with `provenance.origin = "gallery-copy"` and the workspace-relative source
path, gets projected and laid out, and is saved under a never-overwriting
name; the source repo's files and the gallery's per-file asset-protocol
grants are untouched.

## Export / import

A codec registry (`src/lib/diagram/codecs.ts`) declares each format's import
capabilities and export fidelity up front:

- **lossless** — `maru-json` (canonical document) and `maru-svg` (SVG with the
  canonical JSON embedded as metadata; re-import restores the full document).
- **structural** — csv / tsv / markdown-table / html-table / mermaid: the data
  or topology survives, styling does not.
- **visual** — svg-image / png / png-transparent / jpg / pdf: a rendering only.

Exports run through the unified Import/Export dialog or the selected-path
Tauri save dialog; clipboard codecs copy/paste HTML tables, TSV, and Markdown
tables directly. Mermaid round-trips (export + import).

## Insert/Update in report

The File ribbon's "Insert/Update in report" action links the saved diagram
into a Markdown report:

1. Requires a saved, clean diagram (you are asked to save first otherwise).
2. Renders a standalone SVG and a 2x PNG from the document model, computes
   `renderHash = sha256(serializeDoc(doc) + renderOptions)`, and writes both
   to `attachments/diagrams/<docId>/<fileScope>-<hash8>.svg` / `.png` via
   `diagram_write_report_asset`, where `fileScope` is the scope with
   non-`[A-Za-z0-9._-]` runs replaced by `-` (the raw scope contains `:`,
   which NTFS treats as an alternate-data-stream separator). Hash-named files
   make re-renders idempotent (same content → same name → atomic overwrite).
3. The scope is `pattern:<viewId>` when exactly one pattern view is selected,
   otherwise `doc`. A pattern scope renders only that view's member
   nodes/edges (the asset shows the selected view, not the whole canvas);
   block attrs keep the raw scope. The label flips to "Update in report" when
   the active document already links this diagram + scope (checked lazily
   when the File tab opens).
4. The target is the active editor document when it is Markdown; otherwise a
   recent-document chooser opens. The document is read fresh, the managed
   block is spliced, and it is saved through the revision-checked
   `save_document` path. A `document_conflict` surfaces a notice and is never
   retried automatically; a write denial surfaces the error. On any failure
   after the asset write, the hash-named assets remain (harmless) and the
   document — including any previous block pointing at the previous asset —
   is untouched.

Managed block contract (`src/lib/diagram/reportLink.ts`):

```md
<!-- maru-diagram:v1 {"source":"diagrams/example.cmd.json","scope":"pattern:<id>","asset":"attachments/diagrams/<doc-id>/<scope>-<hash>.svg","fallback":"attachments/diagrams/<doc-id>/<scope>-<hash>.png","renderHash":"sha256:<hash>"} -->
![Caption](attachments/diagrams/<doc-id>/<scope>-<hash>.svg)
```

Blocks are matched on `source` + `scope`: a match replaces the block in place;
no match appends at the end of the document. Content outside the block is
preserved byte-for-byte, malformed blocks are skipped with a warning, and
splicing is idempotent.

**Studio limitations.** Studio and the export converters treat the managed
block as a normal linked image: there is no inline Diagram editor in Studio,
no export preprocessor, and no automatic refresh of linked assets. DOCX/PDF
converters are unchanged, and HWPX output does NOT embed the linked image.

## Version history

A 5-minute auto-snapshot ring (cap 20 per document) under
`<workspace>/.maru/diagrams/history/<docId>/`, with Radix confirmation dialogs
for replace/restore.

## Performance

Viewport culling (`visibleSubset`) + a position-keyed edge-route Map cache
(5k entries) keep 1000-node diagrams smooth. Bench:
`pnpm vitest bench src/lib/diagram/perf.bench.ts`.

## Code layout

- `src/lib/diagram/` — pure modules (actions, alignment, codecs, convert,
  edgeRouting, export, geometry, history, mermaid, nodeKinds, patterns,
  patternStudio, persistence, presets, reportLink, reportInsert, reportTypes,
  richText, shortcuts, smartGuides, state, tableActions, tableEditing,
  tableKeys, templates, versionHistory, viewportCulling, …) each with a
  colocated `*.test.ts`.
- `src/components/diagram/` — `DiagramMode`, store context, `canvas/`, `modals/`,
  `panels/`, `ribbon/`.
- `src-tauri/src/diagram/mod.rs` — persistence, export, snapshots, legacy backup,
  pattern presets, report assets.
- e2e: `e2e/diagram.spec.ts` (flag visibility, ko/en labels, save/reload,
  templates, Mermaid, export dialog, generation dialog + Mermaid paste
  diagnostics + agent-host-unavailable degradation, no `localhost:5500` /
  Google Fonts requests).
