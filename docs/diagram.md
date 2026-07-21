# Diagram mode

The `diagram` activity-rail mode (label 다이어그램 / Diagram) is a self-contained
concept-map editor, adapted from a standalone 14k-line HTML editor into a
first-class Maru mode (Phase 0–7, hardened 2026-05-27). It ships **default-on**;
opt out via Settings → Preferences → "Diagram mode", `VITE_MARU_DIAGRAM=0`, or
`?maru-diagram=0`. The **Report Pattern Studio** track (schema v8) adds typed
report datasets, pattern views, table editing, a codec registry, and managed
"Insert/Update in report" links into Markdown documents.

## Documents

Diagrams live at `<workspace>/diagrams/<name>.cmd.json` — a `v:8` envelope
(report datasets + pattern views; the version numbering continues the source
HTML's past its broken `localhost:5500` autosave boundary). The last-opened
document is restored from `diagram.lastDocument`; unsaved state is
workspace-keyed.

**v8 migration.** Legacy `v:7` documents migrate in memory on load. The first
v8 save over a migrated document triggers a one-time backup to
`<workspace>/.maru/diagrams/backups/<name>-v7-<ts>.cmd.json` (temp-file +
rename, so a crash cannot leave a truncated backup). A backup failure warns
but never blocks the save, and is not retried within the session.

Storage paths:

- `diagrams/<name>.cmd.json` — diagram documents.
- `.maru/diagram-patterns/<name>.pattern.json` — workspace pattern presets.
- `.maru/diagrams/history/<docId>/` — auto-snapshot ring (cap 20).
- `.maru/diagrams/backups/` — one-time v7 backups.
- `attachments/diagrams/<docId>/` — rendered report assets (SVG/PNG), the
  only write target outside the diagram stores.

Backend commands (`src-tauri/src/diagram/mod.rs`): `diagram_save_document`,
`diagram_load_document`, `diagram_list_documents`, `diagram_delete_document`,
`diagram_export_blob` / `diagram_export_blob_to_path`, snapshot commands
`diagram_save_snapshot` / `diagram_list_snapshots` / `diagram_restore_snapshot`,
`diagram_backup_document` (one-time v7 backup), pattern presets
`diagram_pattern_save` / `diagram_pattern_list` / `diagram_pattern_delete`,
and `diagram_write_report_asset` (report assets; extension-whitelisted to
svg/png/json, traversal-safe, atomic, write-guard checked).

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
- `src-tauri/src/diagram/mod.rs` — persistence, export, snapshots, v7 backup,
  pattern presets, report assets.
- e2e: `e2e/diagram.spec.ts` (flag visibility, ko/en labels, save/reload,
  templates, Mermaid, export dialog, no `localhost:5500` / Google Fonts requests).
