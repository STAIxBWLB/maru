# Diagram mode

The `diagram` activity-rail mode (label 다이어그램 / Diagram) is a self-contained
concept-map editor, adapted from a standalone 14k-line HTML editor into a
first-class Maru mode (Phase 0–7, hardened 2026-05-27). It ships **default-on**;
opt out via Settings → Preferences → "Diagram mode", `VITE_MARU_DIAGRAM=0`, or
`?maru-diagram=0`. The **Report Pattern Studio** track (schema v8) adds typed
report datasets, pattern views, table editing, a codec registry, and managed
"Insert/Update in report" links into Markdown documents. Schema v9 (issue #433)
adds typed semantic datasets for Archify-based generation and editing of
architecture, workflow, sequence, dataflow and lifecycle diagrams.

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
validation). The retired gallery commands are no longer registered.
The command-isolation gate expects the registered command
count set in `Makefile` (`--expected-count`) with recorded evidence.

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
the canonical, editable meaning of a generated diagram, for any of the five
Archify engine types (architecture, workflow, sequence, dataflow, lifecycle).
`spec` is the Archify typed JSON (interchange/renderer input); canvas members
are a projection of the dataset, never a second semantic source. `idMap` is the reversible
Archify-safe-id → Maru-id mapping (Archify ids forbid `:` and leading digits;
Maru member ids like `ds:m0` do not), `engine` pins the `archify` engine
version the spec round-trips through, and `provenance` records the origin
(`generated` / `imported` / `gallery-copy`) with a source path when one
exists. Fields the pinned engine cannot represent are kept verbatim in
`preservedExtensions` and reported as fidelity diagnostics — never silently
stripped, never re-emitted as if the engine supported them.

Because canvas members are projections, the semantic spec stays the source
of truth: text edits write through to it, structural edits are spec edits,
and deleting members previews a spec cascade before one undoable commit
(see "Semantic editing"). Detach remains an explicit choice. v8→v9 is a
version bump only — v8 documents migrate in memory on load with no content
rewrites. Issue #433 P2 added sequence, dataflow and
lifecycle without a schema bump: every new datum rides an existing optional
slot (the dataset, node `meta`, edge `midOff`, the spec's optional relation
`id`). Builds 1.1.17 to 1.1.19 load and save P2 documents losslessly but show
containers as plain sections, refuse scoped apply on a dataset of an unknown
type, and do not write text through.

The per-type descriptor table, `validateSemanticContent`, `mintRelationIds`
and the projection live in `src/lib/diagram/semantic.ts`:

| Type | Entities | Relations (minted id prefix) | Containers | Not projected |
|---|---|---|---|---|
| architecture | `components` | `connections` (`conn`) | `boundaries` (by index) | `cards` |
| workflow | `nodes` | `edges` (`edge`) | `lanes`, `phases`, `groups` (by id) | `mainPath`, `semanticChecks`, `cards` |
| sequence | `participants` | `messages` (`msg`) | `segments`, `activations` (by index) | `cards` |
| dataflow | `nodes` | `flows` (`flow`) | `stages` (by index) | `cards` |
| lifecycle | `states` | `transitions` (`tr`) | `lanes` (by id) | `cards` |
| floorplan | `nodes` | `edges` (no ids; `<datasetId>-e<index>`) | nested from `parent` | node `details`, `paths`, `exclude`, `packages`, `hosts`, `tags`; `include`, `ignore`, `annotations`, `flows`, `tour` |

See "Floorplan" below for the sixth type, which is not an Archify type.

Every path that skips the engine (import, gallery copy, manual edits) runs
`validateSemanticContent`: the generated schema validator plus the reference
checks JSON Schema cannot express: dangling relation endpoints, lanes,
stages, boundary `wraps`, `mainPath`/`semanticChecks` and activation
participants, sequence self-messages, and duplicate ids. Ingest mints ids
for id-less relations (`diagram.archify.relationIdsAssigned`), so canvas
edges have stable ids; P1 documents keep their legacy `<datasetId>-e<index>`
edge ids until regenerated.

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

Generation offers the five types; a pasted `sequenceDiagram` or
`stateDiagram[-v2]` header selects sequence or lifecycle. The candidate's
relation ids are minted and `validateSemanticContent` runs before the engine
(an early fail), so the engine validates (and its receipt hashes) the
exact spec that is stored.

A selection on members of exactly one semantic dataset expands the scope to
that whole dataset (entities and containers, shown in the dialog before
Run), locks the type, sends the current spec (as untrusted data, omitted
with `diagram.generate.currentSpecOmitted` above 48 KiB) and reuses the
dataset id, so the result replaces the dataset in place. Members of several
datasets cannot run. Regenerating an existing dataset blocks on a locked
member only when it would change or be removed, moves grid members by their
slot delta (user offsets survive), removes only that dataset's relation
edges (freeform annotation edges survive), and adds containers when the
dataset already has them or the explicit regeneration contains workflow
phases/groups or sequence segments/activations. Plain reopening never
projects missing containers. The preview reports element, relation,
container and message-order changes.

Unavailability degrades honestly: a missing engine surfaces the typed
`ENGINE_UNAVAILABLE` diagnostic, an unreachable agent host surfaces the
failed-run state, and the Mermaid paste import path (`mermaidToDocDetailed`,
agent- and engine-free) keeps working for flowcharts, reporting skipped
constructs as localized diagnostics. A non-flowchart Mermaid header imports
nothing (`diagram.mermaid.unsupportedDiagramType`); sequence and state
diagrams add a hint to use generation instead, and the dialog's direct
apply is disabled.

## Semantic editing (issue #433 P2)

**Projection.** Entities become nodes (`meta.memberId =
<datasetId>:m<index>`; lifecycle `start`/`success`/`failure` are ovals,
`decision` a diamond). Workflow and lifecycle entities sit on a lane grid
(lane bands top-down, `col` columns), dataflow entities in stage columns
(ordered by `row`). Architecture projection honors explicit pos coordinates
and authored row/col cells using the pinned grid's origin and spacing;
index-based placement is a fallback only. Fresh-document auto-layout is used
only when no architecture member has authored placement.
Lanes, stages, boundaries, workflow phases/groups and sequence segments become
`section` containers; activations use simple transparent outlines so their
captions have no opaque header over message endpoints. Managed containers
are placed first in `nodes`, with id and `memberId` `<datasetId>:<role>:<key>` (Archify ids
forbid `:`, so they cannot collide) and `meta.semanticContainer` set. A
sequence is a participant row; each message is an `s→s` bracket edge whose
`midOff` depth encodes its order (by `y`, then array position), dashed for
`return`/`dashed` variants. Same-axis auto routes anchor the edge label on
the middle segment, so brackets carry their labels (identical to before
when `midOff` is 0). Lifelines come from the engine render. Workflow range
containers cover inclusive column ranges (groups within their lane). Phase headers sit above the lanes;
phase bodies are transparent and outer frames stay behind lanes and groups,
including after proposal additions. Sequence range coordinates are
interpolated onto the existing rank-based message brackets, with linear
extrapolation outside the message range. Equal-y messages use their mean rank.
Segment and activation bodies are transparent so the message edges painted
behind nodes remain visible. Activations follow the participant center and
show its label (updated with a participant rename in the same undo step);
their title is read-only because the schema has no activation label. Segment/activation keys
are positional, matching the pinned schema. Existing documents are not
reprojected on load; new documents and explicit proposals project containers.

**Text write-through.** `updateNode` / `updateEdge` (the chokepoint behind
inline editing, the property panel, layer rename and replace-all) write
text on a member through to its spec entry: title → `label`, body →
`sublabel` (empty deletes it), container title → `label`, edge label →
`label`. An empty required label (entities, containers, messages, flows) is
refused and the edit is dropped, like an edit on a locked node; an empty
optional label (connections, workflow edges, transitions) is deleted.

**Inspector.** The property panel shows a semantic inspector
(`SemanticProps`) for a single member: type, diagram, role, id, label and
lane/stage/boundary membership. Its editors (message order, lifecycle
state type, dataflow classification, lane and stage) are spec edits:
`planSemanticEdit` (`semanticEdit.ts`) validates the edited spec and routes
it through `buildProposalFromCandidate` and `prepareProposalApply` with a
touched filter, so each edit is one undo entry and canvas drift on
untouched members survives. Preview stays synchronous; applying a structural
edit runs the resulting spec through the pinned engine before committing.
An engine refusal, unavailable engine or document change during validation
leaves both the document and undo history untouched. Text write-through and
explicit detach remain local operations.

**Detach and delete.** "Detach to freeform..." drops the dataset and the
member markers after a confirm listing what is lost (types, order,
variants, classifications, notes, containers, not-projected and preserved
fields, provenance); the canvas stays and the detach is undoable. Deleting
semantic members (keyboard Delete or the Edit ribbon) previews a spec
cascade instead of detaching. The inspector also offers a Remove button.
Participant removal includes messages and activations; node/state removal
includes incident relations, wraps memberships, main-path/check references
and any group or boundary left empty. Container removals include their
contained entities when those entities require the lane or stage. Schema
minimum counts and locks can refuse the whole operation. The dialog lists
the direct and dependent changes before confirmation. Cancel or a document
change while the dialog is open leaves the document untouched. Multiple
selected semantic datasets, pattern detaches and freeform removals are
planned first and committed together in one undo snapshot. Selected freeform
objects and admitted annotation bridges are removed in the isolated plan
before semantic cascades; a bridge to an unselected external node still
refuses the edit. The confirmation lists freeform annotation edges lost
through the cascade as well as spec relationships.

**Structure controls (issue #527).** The inspector's Add form selects an
entity, relation or managed container collection and asks for typed labels,
endpoints, lane/stage, column/range or boundary members as appropriate.
Layout-less architecture specs use x/y position controls, defaulting to a
free slot to the right of existing components, rather than grid columns.
New IDs are minted without rewriting existing entity/relation IDs.
Index-keyed containers remap canvas IDs, annotation endpoints and selection
atomically with the spec edit. A surviving container keeps its own geometry
offset rather than inheriting the removed entry's canvas slot; lost
annotations belong to the removed entry and appear in the preview. Sequence
insert/remove deterministically re-space message y coordinates and remap
ranges with the nearest surviving anchor segment for interpolation and
extrapolation. Dataflow stage insertion/removal shifts numeric node-stage
memberships in the same transform; lane references remain ID-based. Boundary member checkboxes apply the entire wraps
set in one edit; phase/group and segment/activation ranges have explicit
Apply controls, with group lane and activation participant selectors.
Every structural command runs `validateSemanticContent`, proposal validation
and the existing `archify_validate_candidate` engine path before one
undoable commit. Keyboard/ribbon Delete and inspector Remove share the same
cascade/annotation preview and apply gate. Lifecycle's reserved main lane
cannot be removed. Architecture column inputs respect layout.cols; other
renderer limits, such as dataflow stage/canvas width, are enforced by the
engine with its diagnostic. New range checks refuse reversed ranges,
overlapping phases, empty groups and segments outside an authored canvas.
Preview remains synchronous; apply is asynchronous. Per-type fixtures also
run the pinned engine validator in the focused test suite. Browser tests
inject the generation host contract; production never bypasses engine admission.

## Floorplan (issue #535)

`floorplan` is the sixth `SemanticDiagramType`. Its dataset spec is the
upstream `floorplan/architecture@1` JSON verbatim (haydenschmitty/floorplan
0.6.3, `skills/floorplan/references/schema.md`), with `engine.name =
"floorplan"`. Schema constants, the validation floor and the nested layout
live in `src/lib/diagram/floorplan.ts`, interchange in `floorplanCodec.ts`.
`ARCHIFY_DIAGRAM_TYPES` lists the five engine types; Archify-only paths
(pre-check, pinned-engine validation, `archify-json`) never see floorplan.

**Projection.** A node with children is a `section` sized around its
children (rows of three, header band on top); a leaf is a member. Parents
paint before children. The `kind` maps to a node style token: `data` is a
cylinder, `external` a hexagon, everything else a plain box. Edges are drawn
between the nodes their endpoints name; a file-path endpoint is drawn on the
deepest node whose `paths` claim the file (`exclude` honored). The edge label
is `label`, else `kind`; `event`/`queue` edges are dashed. Every node is an
entity (`<datasetId>:m<index>`); there are no role containers. Canvas body
edits write to `summary`. Flows and the tour are kept, not drawn.

**Fidelity.** Every field, known or not, survives import, save and export
unchanged. Present not-projected fields report `diagram.semantic.notProjected`;
fields the upstream schema does not define (top level, node, edge) report
`diagram.floorplan.unknownField`. Edges keep the upstream shape: no ids are
minted.

**Validation and the apply gate (temporary exception).** There is no pinned
Floorplan engine yet. Until #536 adds it, `validateFloorplanSpec` is the whole
gate for import, generation and every structural apply
(`validateSemanticDraft` in `semanticApply.ts` skips the engine call for
floorplan only): required `project.name`, node `id`/`label`/`kind` with the
11 kinds, unique ids, parents that exist and do not cycle
(`diagram.semantic.parentCycle`), edge endpoints and kinds, flows with at
least two steps (`diagram.semantic.flowTooShort`) whose refs exist, and tour
refs. A ref is a node id or a file path: it contains `/`, or is dotted with a
first segment that is not a node id (`app.py`); `api.ghost` under an existing
`api` is dangling. Every problem names its field. The five Archify types keep
the pinned-engine gate unchanged. #536 removes this exception.

**Editing.** The inspector edits label (canvas title), summary, kind and
parent (a node cannot move under its own descendants), and an edge's kind;
the structure editor adds a node (kind, optional parent) or an edge. Removing
a node removes its descendants and every edge, flow step, tour stop and
annotation that names a removed node; a file-path ref counts as removed when
it resolved to a removed node and no surviving node claims it. A flow left
with fewer than two steps is removed whole. The cascade is listed before the
confirm and commits as one undo step through `planSemanticEdit`.

**Generation.** The Generate dialog offers Floorplan. The prompt carries the
schema summary and the selected source file paths, as for the other types;
the candidate gets `$schema` if missing and is refused on local validation
with the field named. Scanning a repository belongs to #536.

**Interchange.** `floorplan-json` imports `<name>.floorplan.json`, and a file
named exactly `architecture.json` whose `$schema` is
`floorplan/architecture@1` (the dialog reads the text before choosing the
codec). The Archify `architecture` type is told apart by `diagram_type` and
`<name>.architecture.json`, never by the bare name. Export emits the spec
verbatim; Mermaid does not apply.

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

## Architecture documents

The retired Architecture gallery is replaced by Diagram's Import dialog.
Repository documentation under `docs/architecture/` stays on disk; import
its typed JSON through `archify-json`. Existing copied documents retain
`provenance.origin = "gallery-copy"` and load/save without migration.

## Export / import

A codec registry (`src/lib/diagram/codecs.ts`) declares each format's import
capabilities and export fidelity up front:

- **lossless** — `maru-json` (canonical document) and `maru-svg` (SVG with the
  canonical JSON embedded as metadata; re-import restores the full document).
- **structural** — csv / tsv / markdown-table / html-table / mermaid /
  archify-json / floorplan-json: the data or topology survives, styling does not.
- **visual** — svg-image / png / png-transparent / jpg / pdf: a rendering only.

Exports run through the unified Import/Export dialog or the selected-path
Tauri save dialog; clipboard codecs copy/paste HTML tables, TSV, and Markdown
tables directly. Mermaid round-trips flowcharts (export + import); importing
another Mermaid diagram type is refused, and exporting a document with a
semantic dataset warns that its semantics are lost
(`diagram.mermaid.semanticLoss`). Archify JSON (`<name>.architecture.json`,
`.workflow.json`, `.sequence.json`, `.dataflow.json`, `.lifecycle.json`)
imports a projected canvas (members and containers) and exports the spec
verbatim. Floorplan JSON (`floorplan-json`, see "Floorplan") does the same
for `floorplan/architecture@1` maps.

### Verified static semantic export (T1)

The `archify-svg` and `archify-png` choices render one selected stored semantic
spec through the pinned bundled Archify engine. Architecture, workflow,
sequence, dataflow and lifecycle are supported. Canvas annotations, selection,
zoom and editor state are not renderer inputs. Missing engines and rejected
specs are errors; these choices never fall back to the canvas renderer.

The native worker validates and renders into private staging, checks the engine
HTML artifact, and returns bytes plus a versioned receipt. The frontend parses
that HTML without mounting it, requires exactly one SVG, inlines the supported
static CSS, and sanitizes SVG with DOMPurify. Scripts, event handlers, external
URLs and `foreignObject` are removed. Light/dark conversion is explicit; PNG
uses the existing SVG-to-Canvas rasterizer at pixel ratio 1. Interactive engine
HTML remains gated for T2 and is not an export choice here.

Export shows the spec hash, engine pin, final artifact hash and separate schema,
artifact, browser-conversion, visual-review and saved-byte-readback gates.
Conversion success does not mark visual review as passed. Only a native save
acknowledgement after byte comparison marks readback passed. The save bridge
atomically replaces the selected file under its existing lease, preserving the
previous file on a failed replacement. The final converted-file receipt is shown
for this operation; no sibling receipt is written next to that export copy.
When document context is supplied, the backend engine HTML and its own receipt
are retained in the Renders store below. SVG/PNG remain frontend-converted
export copies and are not stored there.

A changed document, workspace or closed dialog invalidates an in-flight render
before save. Once a native file copy has begun it completes atomically; the UI
keeps that operation busy until its acknowledgement. The native-only
`diagram-export` spec exercises real SVG/PNG conversion and saved-file hashes;
Chromium/jsdom checks alone do not prove WKWebView or a shipped release bundle.

## Workspace Renders

File > Renders lists disk artifacts from
`attachments/diagrams/<storeKey>/renders/<renderId>/`. Compatible lowercase ASCII
IDs retain their directory key; Unicode, uppercase, unsafe and reserved-prefix
IDs use a hash key to prevent traversal and case-insensitive collisions. Keys
also pass the shared portable-name rules, so Windows device names and trailing
dots are hashed rather than used as directories. The
receipt retains the original logical `docId`; list entries return the safe key
for prepare/delete and `originalDocId` for source matching. Each successful
history write creates a fresh UUID folder with `index.html` and `receipt.json`;
existing folders/files are never overwritten. The engine receipt
adds `docId`, historical `documentName`, `documentRevision`, `renderedAt` and
`diagramType` (display names are sanitized and capped at 256 UTF-8 bytes), plus the optional source `datasetId` for unambiguous re-rendering
in multi-dataset documents. Older receipts without it require a unique matching
source, or a new export with an explicit dataset choice. Its output hash belongs to the stored engine HTML, while a static
export's final SVG/PNG hash belongs to the converted copy. This is not HTML export
to a user-selected path; that remains behind #528 T2's platform gates.

The native commands scan receipts and join current `diagrams/*.cmd.json` files
by `docId`, using the current filename for Re-render. Removing or renaming a
source document does not delete its renders: a missing source is listed as
orphaned. When two saved diagrams share one ID, that group is marked ambiguous
with a bounded recovery diagnostic. Listing, verified viewing and deletion
remain available, while Re-render refuses to choose an arbitrary source until
one file receives a distinct ID. Copied render folders with valid receipts are listed; missing, malformed
or mismatched receipts/artifacts stay visible as unverified. Copied static
`index.svg`/`index.png` artifacts use image previews instead of HTML frames.

`diagram_prepare_render_view` rereads the receipt and artifact, compares their
SHA-256 values and grants exactly that file to the asset protocol. It never
grants the parent folder. Grants are exact-file additions to Tauri's app-session
asset scope, like the retired gallery; selecting another render does not revoke
an earlier verified file's grant. A mismatch names the affected file and asks for a
re-render. HTML uses the reviewed gallery sandbox flags
`allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox`,
without `allow-same-origin`, plus `referrerPolicy="no-referrer"`. Theme changes
recheck the artifact and remount with a `theme` query. The main-iframe guard
checks this viewer's source, exact sandbox and referrer policy.

Open in default app (the configured HTML handler, normally a browser) and Reveal
recheck the file first. Re-render reads the current
saved semantic spec rather than old render content. Legacy receipts without a
dataset ID match the prior diagram type first and require a unique source of
that type; a lone dataset of another type is refused. Confirmed Delete admits
and removes only the selected render folder through the workspace Delete guard;
source documents and other attachments remain. History is optional: if storage
fails after a valid engine render, export copies and report insertion still
succeed and show a cause/recovery warning that the render was not kept. An
action specifically requesting a stored re-render surfaces that warning as a
failed history action. Browser builds show the desktop
requirement and no invented render entries. The native `diagram-renders` spec
probes parent/IPC isolation, theme remount and a denied neighboring file; a
custom-protocol test build is not a shipped-release or manual visual check.

## Insert/Update in report

The File ribbon's "Insert/Update in report" action links the saved diagram
into a Markdown report:

1. Requires a saved, clean diagram (you are asked to save first otherwise).
2. Semantic datasets use the verified pinned-engine SVG/PNG path above and
   verify both receipts against their bytes before any write. Their asset names
   contain the full SHA-256 of the rendered pair; existing full-hash assets must
   contain identical bytes and are never replaced with different content.
   Non-semantic documents keep the model SVG/2x PNG path and the legacy
   `sha256(serializeDoc(doc) + renderOptions)` hash8 names. Both write through
   `diagram_write_report_asset` to
   `attachments/diagrams/<docId>/<fileScope>-<hash>.svg` / `.png`, where
   non-`[A-Za-z0-9._-]` runs in the scope become `-` for NTFS compatibility.
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
  diagnostics + agent-host-unavailable degradation, semantic import → edit →
  undo → save/reload, detach, delete guard, no `localhost:5500` / Google
  Fonts requests).

## Archify engine pin

The renderer is vendored under `sidecars/archify/`; `PIN.json` records the
upstream revision and SHA-256 manifest. Run `make check-archify-pin` to verify
integrity. To refresh, fetch an explicitly reviewed upstream tag, replace only
the vendored paths listed by the manifest, retain the MIT license and third-party
notices, and regenerate the manifest from those exact upstream bytes. Update
`ARCHIFY_ENGINE` in `src/lib/diagram/archifyCodec.ts` to the same version and
review the upstream diff before running the full verification gate. Never
refresh from a mutable installed skill directory.

## Engine

E0 (#544) is an independent architecture validation spike, not the product
apply/render engine. `maru-diagram-engine` and `tauri-plugin-maru-diagram` live
in the standalone `src-tauri/crates/` Cargo workspace. The core has no Tauri,
Maru app, Archify, Floorplan or Node dependency. The plugin accepts host hooks
for the selected workspace root and write authorization, and read-only
`DiagramSources` queries for document relations, workspace structure and vault
concepts. Only synthetic fixture sources are implemented in E0. Each snapshot
carries stable IDs, revisions and provenance; queries bound depth and node count.
The crates keep their own README, license notice and changelog for later
subtree extraction. E0 does not change licensing or publish either crate.

The app registers the plugin only under the existing default-off `native-e2e`
feature. A local-main-only capability permits its one validate command. The
native bridge measures actual Tauri IPC, core validation/hash and reply decoding
for 50 and 1,000 components. The browser spike loads the same core as
`wasm32-unknown-unknown` through wasm-bindgen; it does not install the Node
engine host override. This proves only this architecture slice can gate in
Chromium without Node. Product structural editing still uses the pinned
Archify gate, and the other five semantic types have not switched engines.

### E0 measurement and decision

**Decision: WebAssembly** for the planned frontend engine integration. The
hosted baseline at `a7139154` meets both AC1 limits: 130,258 bytes gzip (at most
400 KB) and 1,000-component warm p95 1.8 ms (below 50 ms). This selects the
transport; E0 does not switch product apply/render paths.

[Hosted CI run 42469991110](https://github.com/STAIxBWLB/maru/actions/runs/42469991110)
passed ci-ok, make verify (including both standalone SDK suites and subtree
extraction), Playwright, and the real-app macOS native suite. Measurements use
SDK subtree `b19f5140` before the N1-N5 follow-up; the final follow-up head still
requires its own green CI. The samples are not relabelled as measurements of
later code.

| Hosted baseline, 30 warm samples | 50 components | 1,000 components |
| --- | --- | --- |
| WASM / Chromium median | 0.3 ms | 1.2 ms |
| WASM / Chromium p95 | 0.5 ms | 1.8 ms |
| WASM / Chromium maximum | 0.7 ms | 4.3 ms |
| IPC / WKWebView median | 3 ms | 25 ms |
| IPC / WKWebView p95 | 15 ms | 46 ms |
| IPC / WKWebView maximum | 16 ms | 46 ms |

The hosted WASM build step took 30.92 s. Cold module load plus first validation
was 333 ms for Chromium/WASM and 58 ms for native IPC. These are different
platform/build scopes, not a speedup ratio. The earlier dgx02 reproduction
measured 130,326 bytes gzip, 1,000-component p95 2.6 ms, cold 436.6 ms and a
27.16 s build with warm registry/check artifacts. Raw samples, source identities,
job receipts and scope are retained in
[diagram-engine-e0.json](diagram-engine-e0.json). The dgx02 container had a
16-CPU quota, Cargo used two workers and Playwright one. Both fixtures adapt
the existing `perf.bench.ts` grid/chain populations to typed architecture JSON
with deterministic IDs and at most 12 columns; they do not measure that canvas
benchmark's geometry, rendering or viewport operations.

The harness records all 30 samples per size, cold initialization plus first
validation, source engine revision, fixture input bytes, and runner/build
scope. Use p95 of the warm 1,000-component samples for the latency gate.
`ENGINE_E0_BUILD`, `ENGINE_E0_WASM` and `ENGINE_E0_IPC` log records retain the
raw measurements. Native IPC uses the debug real app/WKWebView; WASM uses a
release core in Chromium, so these are separate absolute measurements, not a
cross-platform speedup claim. Build time includes tool compilation and bindgen
work on that runner and is not a promised clean-cache duration.

The payload receipt sums gzip-level-9 sizes of the actual optimized ES browser
library output (Vite retains ES-library whitespace). Vite library mode inlines
the generated web JS and WASM assets;
the facade includes both transport entry points. The browser loads that built
artifact. This measures an isolated deliverable, not the whole existing app
bundle; later product integration may emit separate binary assets. Cold load uses a
fresh browser context and includes module initialization and first validation.
The native cold sample includes lazy facade/fixture loading and the first IPC
round trip. Render, layout, UI application/undo and visual checks are outside
these validation timings. Warm calls use an already serialized spec string;
fixture construction and the initial spec JSON.stringify are outside that
window, while transport envelope serialization and result decoding remain in it.

### Receipt and source contracts

Public API version 1 returns `ok`, diagnostics with rule/path/cause/fix, and a
receipt with `engine: { id, version, revision }`, input hash and scoped gates.
The architecture slice labels its schema scope; artifact/browser/visual gates
remain not-run. Optional output/engine-output hashes, conversion, readback,
document identity/name/revision, renderedAt, diagramType and datasetId preserve
#528/#534 fields. The legacy parser accepts Archify `enginePin.name` (and
`engine.name`) and normalizes it to `engine.id`; it does not relabel an old
Archify validation as Maru validation. Product receipt migration is deferred.

Rust is the type source. `ts-rs` generates the checked-in engine declarations;
`node scripts/diagram-engine-e0.mjs types` fails CI on drift. Use its `--write`
option after changing Rust types. The host boundary check refuses app/outside
path dependencies and source inclusion, and refuses Tauri in the pure core.
CI dry-runs `git subtree split --prefix=src-tauri/crates`, extracts the result,
and runs each crate's tests there without the app or a Node engine host.
The local split dry run produced commit `61e16d8f` (SDK tree `b19f5140`);
its source-only archive passed core 5/5 and plugin 3/3 tests on dgx02 with Node
removed from PATH. The baseline SDK's typegen-enabled suite passed 6/6; the N4 receipt
follow-up passed 7/7 plus plugin 3/3 on dgx02.

The E0 baseline corpus had 31 sanitized cases: architecture 22, two
each for workflow, sequence, dataflow and lifecycle, plus one synthetic
Floorplan substitute. Rule groups are 12 existing fixtures, eight public specs,
four ID cases, two reference cases, four grid bounds cases and one privacy
substitute. The existing Floorplan fixture stays in Maru by the owner's
2026-11-08 decision: its content is the map published at
https://afam.staix.net/explore/map/ and its source repository is private (#547).
This E0 corpus keeps the synthetic substitute because its source contract
requires public repositories or synthetic fixtures. Archify's unsupported-type
response for the substitute is labelled as such, not a validity rejection. Existing app/native fixtures and synthetic rule cases retain
pinned Archify verdicts/diagnostics. The eight immutable public blobs had
PUBLIC visibility verified before intake. Private/unverified repository
candidates were excluded without copying their content. Local machine paths
and contact strings are scrubbed; relative public source evidence remains.
Repository-backed cases retain their original no-root/evidence verdicts.
Each also has a separate `validityOracle` report from a clone with only
`meta.repository` and component `sources` removed; all eight pass the pinned
Archify document-validity gate. That second verdict does not verify repository
evidence or change the preserved input. Additional intake-only redaction terms
come from newline-separated `MARU_E0_PRIVATE_TERMS`, never personal names
hardcoded in the source.
Only the explicitly labelled architecture slice expectations are asserted by
E0. Complete five-type differential parity, renderer constraints and screenshots
belong to later phases; this corpus is not a claim of achieved product parity.


### E1 document validity

E1 (#549) extends the pure engine to architecture, workflow, sequence, dataflow
and lifecycle. `validate_json` dispatches by the input `diagram_type`; native
plugin `validate` and WebAssembly `validate_diagram_json` call that same entry.
The E0 `validate_architecture_json` export remains a compatibility alias.
Architecture/sequence/dataflow admit schema version 1; workflow/lifecycle admit
1 and 2, matching the pinned schemas and existing generation output. The v2
readable-layout calculation is outside E1; authored fields are not prohibited
merely because their version is 2.

Each family owns typed input models and document rules. Shared metadata,
decorations and scalar contracts live in `common.rs`. Input defaults retain the
Rust-to-TS omission/null contract; compile fixtures cover all five families.
Those types describe deserialization structure, not a proof of valid content:
null, bad IDs, unknown fields, enum/range errors and graph contracts still need
runtime validation. Output diagnostics and receipts keep the API-v1 shape.
Diagnostic codes are `<type>/<constraint>` with JSON pointer paths, a cause and
a fix. Malformed/unsupported envelopes use `document/<constraint>`; `-v1` in a
rule identifier versions that diagnostic contract, independently of the input
schema version. Receipt schema gates name document validity; artifact, browser
and visual gates remain not-run. Product `semanticApply.ts`, generation and
rendering continue to use the pinned engine until E4.

The corpus contains 256 cases, including the 31 retained E0 records, 225
synthetic cases and the unsupported synthetic Floorplan record already among
the retained records. Eight recorded public immutable blobs retain their
input hashes and provenance; no new external intake was added. Original,
schema, non-geometry document (portable path/profile), and evidence-stripped
oracle layers remain separate. Machine-local
oracle staging paths are replaced with portable markers, and privacy checks
still run before the corpus is written.

| Family | Cases | Declared rules with negative generated coverage |
| --- | --- | --- |
| architecture | 73 | 31 |
| workflow | 55 | 34 |
| sequence | 43 | 21 |
| dataflow | 42 | 21 |
| lifecycle | 42 | 22 |

The remaining one case is Floorplan, outside E1. All 129 declared per-family
rules have a generated rejection with an equivalent namespaced engine code.
The differential test checks all 256 acceptance results and rejection mappings,
not just the E0 architecture subset. Diagnostic cause/fix/path/rule fields are
asserted nonempty. Positive seeds must first pass the actual pinned CLI;
unknown refusals cannot become automatic geometry waivers. A generated rule
hint must match an independently observed oracle cause, never merely an
unrelated rejection. The host oracle
cache is keyed by engine pin, type and full input, and is not SDK runtime code.

Shared rule classes cover shapes/known fields, versions/types, IDs/duplicates,
text/cardinality, scalar bounds/integers/enums, locale, portable output paths,
translations, brands, sources, guided views, legends and repository metadata.
Family-specific rules cover:

- Architecture: component/boundary/connection references, required position or
  complete grid inputs, unique declared cells, declared column limits, and
  laminar membership for the opt-in deployment-ownership profile. That profile
  also requires both boundary kinds, nonblank owners for nonexternal components,
  exactly one region per such component, private database membership, one shared
  region per private group, and labelled cross-boundary mechanisms. Authored
  positions override grid hints.
- Workflow: lane/end-point references, ordered and disjoint phase ranges,
  group ranges and membership, main-path nodes/edges/order, semantic-check
  references, allowed roots/terminals and required edges/reachable paths.
- Sequence: participant references and positive segment/activation ranges.
- Dataflow: stage references and flow end-points, with schema bounds on stages,
  dimensions and other authored scalar fields.
- Lifecycle: lane/state references and schema lane limits. A reserved lane name
  is a layout convention, handled below rather than added to E1.

The complete per-type rule/code/description table and generated-case inventory
are in `testdata/parity.json` and the host
`scripts/diagram-engine-e1-cases.mjs` generator. No Archify implementation code
or runtime dependency is imported into either SDK crate.

Intended differences are limited and named:

| Case | E1 result and reason |
| --- | --- |
| Dataflow unbounded authored row | Accepted: schema permits it; the pinned renderer's fixed row slots are an E2 geometry limitation. |
| Five dataflow stages on a narrow authored canvas | Accepted: stage count is schema-valid; computed canvas clearance is E2. |
| Lifecycle without the reserved `main` lane name | Accepted: IDs/references are valid; reserved-lane layout is explicitly E2. |
| Synthetic Floorplan input | Refused as unsupported: Floorplan is E5, with no E1 validity claim. |

Repository checkout/source evidence verification is excluded from the pure
validator comparison by an explicitly stored evidence-stripped input; its
original verdict remains available. Workflow/lifecycle v2 is compared directly
against the oracle, not listed as a difference. No label-fit, overlap, route,
legend-clearance or other computed geometry gate is claimed by E1.

The pre-W1 E1 remote Linux/Chromium measurements are recorded in
[diagram-engine-e1.json](diagram-engine-e1.json), separately from the E0
baseline. The actual ES library is 307,718 bytes gzip. Across 30 warm samples,
50 components measured median 0.4 / p95 0.8 ms; 1,000 components measured median
4.2 / p95 5.1 ms (maximum 6.9 ms). Cold initialization plus first validation was
476.4 ms; the build step took 6.77 s with warm registry/check/release caches (incremental). This is a
remote reproduction, not hosted CI build-time evidence. The source identity is
SDK tree `a5c859a1`, with raw samples and execution scope in the receipt.

The harness checks all five families plus workflow/lifecycle v2 without a Node
host override and refuses an invalid connection. Remote app checks, SDK
boundary/type drift and the full differential suite passed. Hosted Chromium
remains the final 400 KB gzip / 50 ms p95 gate; no final-head hosted result is
claimed from these remote tests.

The final SDK subtree split `f7858382` (tree `a5c859a1`) passed 28 core unit
and two differential tests plus three plugin tests from its source-only archive
with Node removed from PATH. This is separate from the browser's Node-free
validation proof and from the pending hosted final-head gate.


### E1 hosted baseline and object-shape follow-up

[Hosted run 42490489186](https://github.com/STAIxBWLB/maru/actions/runs/42490489186)
passed ci-ok, verify, browser and real-app native gates at `aae304cd` before
the object-shape follow-up. Its ES library measured 307,536 bytes gzip, a
37.81 s build step and 585.3 ms cold WASM initialization. Across 30 warm samples,
50 nodes measured median 0.7 / p95 1.2 ms; 1,000 nodes measured median 5.2 / p95
7.1 ms (maximum 10.6 ms). Those records are retained separately under
`hostedBaseline` in the E1 measurement receipt; they are not attributed to later
code.

The 307 KB hosted baseline already consumes about **77% of the 400 KB budget**.
E2 (#550 AC5) must plan the lazy-chunk split before adding geometry rather than
waiting for the combined payload to exceed the limit. Subsequent object-shape
inspection has its own payload/latency reproduction and a separate hosted gate.

The common decoder now verifies object positions from the decoded model's
serialized shape. Serde's positional struct arrays are refused with their JSON
path, an expected-object/found-array cause and a named-fields fix. Real Vec and
coordinate tuple arrays remain valid. The shape representation comes from the
same Rust model, avoiding another manually maintained per-field schema table.

Array-for-object regressions now cover each family at metadata, brand and
primary-item boundaries, plus shared source/card/view/repository/legend shapes
and type-specific layout/lane/stage/segment/activation/semantic-relation objects.
They retain schema refusals and cause mappings; no shape case is a geometry
waiver. The coordinate-tuple positive control remains accepted.

The W1 follow-up (SDK tree `14ee8f01`) has a separate remote reproduction in
`objectShapeFollowUp`: 324,182 bytes gzip, 1,000-node median 7.6 / p95 8.2 ms,
maximum 11.4 ms, and cold initialization 495.8 ms. Its incremental
build took 7.23 s. All limits passed in that remote container;
new-head hosted CI is still required. Serialization-based shape inspection adds
work but keeps this reproduction below the 400 KB / 50 ms limits.

The W1 source-only split `246b7c38` (tree `14ee8f01`) passed 29 core unit tests,
two differential tests over all 256 cases and three plugin tests with Node
removed from PATH. The app's default/native feature checks, boundary and type
drift checks also passed remotely; the final-head hosted gate remains pending.

### E2 staged geometry foundations

E2 is delivered in three stages: fixed-point/pin/font contracts and the lazy
payload boundary, five-type placement and routing, then geometry diagnostic
parity and the test-only canvas/performance proof. The first stage exposes real
text measurement, not a placeholder layout or a passed geometry receipt. The
production canvas and `semanticApply` continue using their existing paths.

Geometry coordinates are signed 32-bit integers in 1/64-pixel units, with
checked 64-bit intermediate arithmetic. Pixel inputs quantize once, rounding
halves away from zero. A pin set records its source spec SHA-256 for staleness reporting and targets
stable semantic member IDs; later placement gives pins precedence over authored
positions, then automatic placement. The planned test adapter takes explicitly
pinned current canvas x/y values and `meta.memberId`, rather than treating every
projected canvas position as a pin. An unrelated spec edit retains every pin
whose semantic member still exists, at the exact prior position. Source hash
changes produce a nonfatal notice; only missing members lose their pins, with
one diagnostic per dropped pin. `resolve_pins` takes the current placement
member identities rather than guessing membership from a hash. Generic request/font failures use
`document/...`; renderer-specific geometry refusals use the diagram-type namespace.

Text uses Noto Sans CJK KR Regular 400 and Bold 700, pinned to the upstream
[`f8d157532fbfaeda587e826d4cd5b21a49186f7c` source](https://github.com/notofonts/noto-cjk/tree/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/Korean),
under [SIL OFL 1.1](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE).
The SDK carries derived cmap, horizontal advance and ink-box tables plus font
hashes and the complete licence. Font parsing/download happens only in the
host-side generator; runtime never queries system fonts. Prefix advances use
integer scaling and ink boxes round outward. Uncovered visible scalars use the
pinned font's `.notdef` glyph (glyph ID 0),
are counted in `replacements` and produce a nonfatal coverage notice. No missing
character refuses layout. Unicode 17.0.0 default-ignorable scalars, including
variation selectors and joiners, have zero advance and no ink. E3 renders the
returned `.notdef` boxes for visible missing glyphs and skips ignored scalars,
without system fallback. E3 must render these same original-font glyph
IDs, weights and positions, with kerning, ligatures and localized substitutions
disabled; a system-font fallback would violate this contract.

The default `wasm` validation build excludes geometry and metric tables. A
separate `wasm-layout` build is referenced only by the dynamic `engineGeometry`
module. Payload receipts classify the actual emitted entry/static graph and
lazy metric/transport chunks separately, including Vite-inlined WASM bytes.
The validation entry is gated at 400,000 gzip bytes; lazy bytes are reported
separately, not hidden in the validation total. The browser probe verifies that
validation does not fetch the metric chunk before explicit text measurement.

The first cross-platform matrix hashes fixed arithmetic and both fonts' text
metrics for every parity-corpus record on Linux, macOS and Windows. It is a
foundation check, **not AC2's final whole-scene determinism proof**. Placement,
routes, legend/page boxes and pin preservation join that hash in the next stage.
S2 also runs the WASM build on at least one platform and compares its whole-corpus
geometry hashes with native output, covering the product runtime as well as the
three native targets.
The three E1 geometry divergences remain open until that implementation; no new
Archify validity agreement or 1,000-node layout latency is claimed here.

The initial S1 [remote reproduction](diagram-engine-e2.json), SDK tree `e9eac907`, measured
**324,126 B gzip** for validation (81% of the 400,000 B budget),
**1,043,487 B** for the separately lazy metric chunk and 122 B for optional
IPC transport. The two font tables occupy 1,948,208 raw bytes; original OTF
binaries are not bundled here. The incremental build step took 16.80 s with warm
registry/check/WASM caches, not a hosted CI timing. Chromium confirmed no metric
chunk request before explicit load, then measured both CJK-covered weights
without replacement glyphs. Validation cold initialization was 471.2 ms;
30 warm samples at 1,000 nodes measured median 7.3 / p95 8.1 ms (max 11.6 ms).
These are validation numbers, **not layout/routing latency**. Hosted payload,
latency and the three-OS foundation matrix remain pending at submission.

The later S1 pin-contract follow-up passed 47 core tests and two differential
tests. Its unrelated-field edit retains all existing pins, and each missing
member gets a separate nonfatal removal diagnostic. The source-bound benchmark
above predates this follow-up; new-head hosted CI remains the gate.

S3 will separately measure lazy geometry cold load (fetch plus WASM
instantiation) in Chromium beside the warm 1,000-node layout/routing p95. The
roughly 1.04 MB lazy metric payload is not part of validation's cold-load number.

The coverage/integrity follow-up (`coverageFollowUp` in the same receipt), SDK
tree `8143f641`, passed 50 core tests, two hash-probe tests and two differential
tests. The WASM browser probe passed emoji, check-symbol, variation-selector and
ZWJ examples at both font weights. Its remote validation entry measured
324,124 B gzip; lazy metrics measured 1,038,558 B. The 1,000-node validation
p95 was 8.7 ms. This remains a remote reproduction; hosted CI, whole-scene geometry
and lazy cold-load proof are separate gates.


### E2 five-type scene layout (S2)

The optional geometry feature now exposes `layout::layout_json`, accepting a
serialized `LayoutRequest`. It runs the existing E1 document gate first, then
uses the typed models for architecture grid/free placement, workflow and
lifecycle lane/column placement, sequence participant headers and authored
message times/ranges, and dataflow stage/row placement. The lazy TS facade is
`loadGeometryEngine().layout(request)`. Production `layout.ts`, `edgeRouting.ts`
and `semanticApply` remain on their existing paths; this is a test/SDK entry.

Coordinates remain signed integers in 1/64-pixel units. Explicit-ID entities,
lanes, groups and phases are pinnable: pins take precedence over authored
positions and automatic placement, and surviving authored-ID keys retain their
exact positions after unrelated edits. Lane/group/phase keys retain their role
namespace (for example `lane:main`). A frame pin holds that frame's own origin;
it is not an implicit compound/group drag of its children.

Architecture boundaries, dataflow stages, sequence segments and activations
are derived geometry, not independent pin targets. Their output IDs are a
role plus ordinal (`boundary:0`, `stage:0`, `segment:0`, `activation:0`), matching
the source array order. Placement ignores pins aimed at them. `resolve_pins`
drops each such pin using the existing per-pin diagnostic, with the cause
"this container's position derives from its members" and a next step to edit
or pin the members or timeline. Anonymous cards are likewise derived annotations;
`semantic.ts` does not project them as independently movable canvas members.
Their `card:<ordinal>` IDs are also not pin targets. No content-hash identity or
hidden source IDs are introduced. Adding/removing a member changes the derived
frame naturally, without a stale pin moving it independently of its contents.
Membership constraints and incompatible authored pins remain S3 geometry-gate
work.

Labels carry the pinned font identity, fixed-point font size, absolute glyph
origins and ink boxes, including nonfatal .notdef replacements and ignored
Unicode scalars. The S2 profile uses 13 px bold node labels, 11 px details and
10 px tags; relationship/legend text is 12 px, frame titles 13 px (Sequence
segment headings use 9 px on a separate rail above the time range), and the document
title 24 px. Multiline text, negative bearings, cards and legend overrides feed
measured bounds. Page bounds include nodes, ranges, labels, routes, cards and
legend extents. A passed S2 result does not claim the pinned renderer's full
label-fit, viewBox or legend-clearance rules; those refusals remain S3 work.

Routing uses deterministic port choices, obstacle visibility fast paths and an
independently implemented sparse A* over compressed obstacle-edge coordinates.
It never returns a diagonal or collision fallback. Once placement succeeds,
a route failure does not erase the scene: that edge remains in `routes` with
its ID and empty `points`, and a source edge-path diagnostic names the cause
and next step. Other routes continue independently. `ok` is false while an
error exists, but `geometry` remains present for inspection. Nonfatal font and
pin notices do not make the report fail. Input/placement failures, including
unrepresentable coordinates, can still return no geometry. S3 geometry-rule
diagnostics must likewise flag the existing geometry rather than clear it. Node and label rectangles are routing obstacles; derived cards are placed
below the completed relationship extents. Search/axis/waypoint budgets refuse
with a cause and next step. Explicit `via` points are retained; without them channel
hints constrain the route. `labelAt` is a center anchor and takes precedence over
relative offsets. Labels are allocated before final routing, so paths avoid the
complete label set. A diagonal `straight` preference still lowers to an
orthogonal obstacle-avoiding path in this stage. Variant, role and stroke width
remain in route output. Renderer-specific aesthetics/refusal parity are not
claimed by those basic safety checks.

The previous foundation matrix now hashes the canonical `{ok, geometry,
diagnostics}` result for every corpus case, including structured refusals.
Each case is laid out twice and must be identical. The v1 receipt and build
revision are excluded from this cross-runtime hash; successful receipts still
bind the actual input and geometry hash. Three hosted native builds and a real
Linux WASM build must produce byte-identical reports. The comparator requires
all four artifact identities and checks the corpus SHA, count, IDs/order and
hashes against the checked-in corpus. No case is silently skipped. This is a
determinism gate, not the S3 differential renderer-rule verdict.

S3 still adds the renderer-rule corpus cases and geometry refusal mappings,
resolves the three E1-labelled geometry differences, connects the test-only
canvas adapter, and records hosted 1,000-node layout/routing p95 plus lazy chunk
cold load. No SVG/PNG renderer or production apply/canvas switch is included.

The source-bound [S2 remote receipt](diagram-engine-e2-s2.json), SDK tree
`c399848c`, records 82 core tests, two document differential tests, geometry
clippy, default-feature compilation, boundary/type drift, and two Chromium
probes passing. The native and real WASM scene reports are byte-identical for
all 256 cases: 37 successful scenes and 219 structured refusals. The only
E1-accepted case additionally refused at this stage is an authored dataflow row
outside the fixed-point coordinate range. Those counts do not assert renderer
rule parity. Hosted Linux/macOS/Windows plus WASM agreement remains pending.
The validation graph measures 324,219 B gzip; separately lazy layout/metrics
measures 1,500,551 B. No 1,000-node layout p95 or lazy cold-load acceptance is
claimed by this functional proof; both remain S3 work.

The derived-frame pin-policy follow-up is recorded separately in that receipt,
SDK tree `2862495c`. It passed 84 core tests, two differential tests, geometry
clippy/type drift and both Chromium tests. The updated 256-case native/WASM
reports remain byte-identical. Validation remains 324,219 B gzip; the lazy
layout/metrics chunk is 1,482,982 B. These are remote checks; new-head hosted CI
and the remaining S3 gates are still pending.

The partial-scene contract is tested with an enclosed endpoint and a forced
small, per-call test-only A* budget. Both retain all nodes and a clear second
route, emit one unrouted edge and one error, and repeat deterministically.
The production search limits are unchanged. The browser probe also checks this
behavior through the actual WASM layout facade.

The partial-scene follow-up is separately anchored to SDK tree `5f8d81a9` in
that receipt. It passed 88 core tests, two differential tests, geometry clippy,
binding drift and both Chromium probes, including the actual-WASM partial scene.
All 256 native/WASM corpus reports remain byte-identical. Validation is
324,219 B gzip and the lazy layout/metrics chunk is 1,489,129 B. New-head hosted
checks and the S3 renderer/performance gates remain pending.


The routing-preset follow-up resolves workflow `outside-right`, `return-left`
and `up-channel` to their corresponding port families and explicit outer
channels; dataflow `vertical-channel` uses horizontal ports and a vertical
corridor. Authored channel coordinates override generated ones. A preset is
not silently treated as `auto`. Tests cover each family and an explicit channel
coordinate. Automatic vertical-segment labels are placed to a side of the
corridor, so final routing need not replace the channel just to avoid its label.
Workflow/lifecycle pin selection also precedes automatic yOffset conversion.

The determinism input now combines the 256 document-parity cases with three
checked-in, seeded synthetic stress scenes: 200 nodes and 48 relationships each
for architecture, workflow and dataflow. The generator has no host/random/time
input and is drift-checked. The same combined file is generated in all native,
WASM and compare jobs; its SHA/count/order are the comparison contract. These
are determinism stress fixtures, not additional renderer-oracle verdicts.
The unit proof checks that a production route succeeds where budget 0 reports
A* exhaustion for that same edge, while visible adjacent edges still complete.

Corpus tooling is gated by the explicit `geometry-corpus` test feature. Normal
`wasm-layout` links neither the corpus module nor its export. A guard checks
both JS and actual WASM exports for absence of `scene_corpus_hashes` after the
normal build. CI builds `wasm-layout,geometry-corpus` separately into a test-only
directory, leaving measured product bytes free of the corpus harness. Standalone
subtree tests enable that feature explicitly to retain test coverage.

The preset/dense-feature follow-up, SDK tree `97d4822b`, passed 97 core tests,
two differential tests, clippy/type drift and both Chromium probes. The combined
259-case native and separate test-WASM reports are byte-identical. Each dense
fixture retains all 200 nodes, proves a successful production A* detour and a
budget-0 failure for the same edge, and still routes adjacent clear edges.
The normal product export guard passed for JS and WASM. Validation measures
324,220 B gzip; normal lazy layout/metrics measures 1,434,912 B, excluding the
harness. These are remote checks; new-head hosted and S3 gates remain pending.

#### Visible text audit for the five typed families

Every authored scene-text field below reaches the shared measured label path,
which emits pinned glyphs, font size and ink bounds and supplies route obstacles.
Multiline combinations preserve the full content rather than shortening labels.
The regression tests inspect both label text and emitted glyph inputs.

| Family | Node text | Route text | Container text | Cards |
| --- | --- | --- | --- | --- |
| Architecture | `components[].label`, `.sublabel`, `.tag` | `connections[].label` | `boundaries[].label` | `cards[].title`, every `.items[]` string |
| Workflow | `nodes[].label`, `.sublabel`, `.tag` | `edges[].label` | `lanes[].label`, `phases[].label`, `groups[].label` | Same shared card path |
| Sequence | `participants[].label`, `.sublabel` | `messages[].label` and `.note`, combined as lines | `segments[].label`; activation bars have no separate authored caption | Same shared card path |
| Dataflow | `nodes[].label`, `.sublabel`, `.tag` | `flows[].label` and `.classification`, combined as lines | `stages[].label` | Same shared card path |
| Lifecycle | `states[].label`, `.sublabel`, `.tag`, `.step` | `transitions[].label` and `.note` | `lanes[].label` | Same shared card path |

Shared text on every family is `meta.title`, `meta.subtitle`, and the resolved
`meta.legend.entries[key].label` overrides. Default legend names are also
measured. The lifecycle detail combines sublabel/step and avoids duplicating
identical content; a sequence activation's participant reference points to the
already-labelled header. `tag` exists on the shared decoration model but is not
an E1-admitted sequence participant field, so it is not claimed as sequence copy.

Text exclusions are intentional: IDs, endpoint/member/lane references, types,
variants, roles, semantic checks and routing/layout controls are identifiers or
style/geometry inputs. `icon` selects a known vector mark; `brand` selects an
asset, not another authored caption. Source-reference paths, line ranges and
labels are provenance/interactive citation metadata. `meta.views` labels/notes
and locale/translation catalog strings belong to Viewer controls, not static
scene copy; they do not silently translate authored labels. Output filenames
and repository descriptors are not drawn. These fields remain in the original
spec for their owning renderer/Viewer paths.

#### Complete preset and route-identity contract

The preset resolver consumes the same accepted lists as document validation.
A table-driven audit covers every family/preset in both endpoint directions,
including authored channel-coordinate overrides. Named presets have concrete
port/channel intent, not an `auto` fall-through: horizontal/vertical orthogonal
midpoint corridors; outer right/left and upper/lower channels; dataflow's
vertical channel; and drop's source-relative inter-box gap. Workflow drop
carries its validated bias through checked Q16 interpolation; lifecycle drop
uses the midpoint. When no safe vertical gap exists, drop chooses an explicit
bottom detour. Explicit waypoints bypass unused generated channels. `auto`
remains automatic. A `straight` preference that needs bends to stay orthogonal
and obstacle-free gets a nonfatal preset-adjusted notice naming the preset and
its repair, rather than an undisclosed replacement.

| Families | Accepted preset | Generated corridor |
| --- | --- | --- |
| All four routed families | `auto`, `straight` | Automatic obstacle-safe path; `straight` discloses bends |
| Architecture | `orthogonal-h`, `orthogonal-v` | Midpoint X/Y between effective escaped ports |
| Workflow | `outside-right` | Right/right ports, X outside the whole scene |
| Workflow | `return-left` | Left/left ports, X left of both endpoints |
| Workflow, Lifecycle | `drop` | Facing vertical ports and source-relative clear Y gap; explicit bottom detour when spans overlap |
| Workflow, Dataflow, Lifecycle | `bottom-channel` | Bottom/bottom ports, Y below both endpoints |
| Workflow | `up-channel` | Top/top ports, Y above both endpoints |
| Dataflow, Lifecycle | `top-channel` | Top/top ports, Y above both endpoints |
| Dataflow | `vertical-channel` | Facing horizontal ports, X beyond the source escape toward the target |
| Lifecycle | `right-channel`, `left-channel` | Matching right/right or left/left ports, X beyond both endpoints |
| Sequence | None | Authored message timeline and lifeline ports, no route-preset input |

All authored route IDs are reserved before anonymous output IDs are allocated.
Generated names skip every reserved name, even an authored name later in the
source array. Internal failures and diagnostic paths use the source ordinal,
not a route display ID. An all-family blocked-plus-clear regression deliberately
collides an authored name with an anonymous edge's original fallback and checks
unique output IDs, the original source path and the unaffected clear route.
That regression enters through the typed scene builder: current E1 public ID
syntax already rejects colons, but the internal naming/routing contract must
remain safe independently. Public-input tests also cover distinct authored and
anonymous IDs. Architecture overrides use its admitted `via` coordinates;
`channelX`/`channelY` overrides are tested on the families that admit them.

The round-two route/text audit, SDK tree `4185e16a`, passed 117 core tests,
two document differential tests, clippy and binding drift in the remote Linux
container. All 259 native/test-WASM scene reports are byte-identical; both
Chromium probes passed without a retry. Normal product exports still omit
corpus tooling. Validation is 324,219 B gzip and the separate lazy geometry
chunk is 1,455,867 B. These are source-bound remote reproductions; the new-head
hosted matrix/native gates and S3 cold-load/layout budgets remain unverified.


#### E2 geometry diagnostics and the test canvas

S3 keeps document validity and geometry validity separate. The corpus retains
its original and evidence-stripped oracle verdicts and the E1 document
comparison. A second `geometryComparison` records the renderer verdict on that comparison input,
its equivalent geometry rules and whether placement must remain available.
The three E1 geometry deferrals are checked here rather than waived. The
synthetic unbounded-row probe now uses row 100 instead of a coordinate that
cannot fit the fixed-point representation; E1 still accepts it, while the E2
row-slot rule must reject it with a retained scene. Coordinate-overflow tests
remain separate input/placement failures.

Geometry rules operate after placement. A geometry or routing error sets
`ok=false` and supplies the source path, cause and repair while retaining the
scene, including every successfully routed edge. Input decoding, E1 validity
and coordinate overflow can still prevent placement. Font replacement and pin
notices remain nonfatal. No SVG or visual-review success is implied.

Route-quality findings distinguish the offending geometry's provenance.
Explicit `via` points, channel coordinates, label-position controls, endpoint
pins and authored side assertions can produce blocking refusals. A wholly
automatic route, label or port-placement defect is a nonfatal
`<family>/geometry-route-quality-notice`, with the underlying rule and repair
retained. Authorship is checked at the offending piece: an authored side fixes
endpoint direction but does not turn every middle corridor or an engine-chosen
coordinate along that side into user-authored geometry. A label pin constrains
the label, not the whole route. A mixed pair refuses at and names the authored
route. For workflow v2, a corridor witness ending at a first/last via junction
explicitly present on at least two distinct raw edges is an authored endpoint
piece and refuses on the owning edge; an internal via does not own an upstream
detour or a separate piece. Node, text, frame, source-budget and input errors remain blocking.
A routing failure with no path or an exhausted search budget still follows S2's
per-edge error contract; a successfully generated low-quality path is the
notice case. Unknown diagnostic codes do not acquire notice status. The engine keeps the
scene in both quality outcomes. Corpus notices are recorded per case/rule in
the same native/WASM determinism reports; no oracle-green document is waived
into an expected engine refusal.

The canvas adapter is an isolated test consumer, not the E4 product switch.
Only an explicit `meta.pinned === true` or `locked === true` flag becomes a pin;
moving an automatically projected node alone does not. `meta.memberId` selects
the source member through the dataset identity map. Explicit-ID lanes, phases
and groups are eligible; derived boundaries, stages, segments, activations and
cards are excluded. Pixel coordinates are checked and quantized to 1/64 px,
and the exact spec JSON is hashed for staleness reporting. The adapter neither
edits the diagram nor writes undo history. A separate test-library build sets
`VITE_ENGINE_GEOMETRY_TEST=1`; ordinary product builds remove its lazy import.
The browser probe paints an isolated SVG canvas from actual engine geometry
and checks pin retention across an unrelated source edit.

Payload and timing scopes remain explicit. The normal emitted library graph
is measured with the canvas test feature off and must contain no canvas bridge
chunk. Its validator entry and static imports count toward 400,000 B gzip;
geometry/metric tables stay in a separate lazy chunk. The test-enabled library
is emitted separately. Chromium cold-load timing starts a fresh Chromium process, disables HTTP caching, serves the exact
emitted artifact bytes without Vite rewriting, and includes the production lazy
module fetch/parse, bindings import and WASM
compile/instantiate, excluding the first layout's initialization. Warm layout
timing includes request serialization, validation, placement, routing and scene
JSON parsing. The 1,000-node case has 999 real relationships; missing or failed
routes invalidate the measurement. The 400 ms E2 budget is reported as
`budgetMet` for hosted-sample evaluation; the sub-200 ms E4 requirement stays
separately reported for a dedicated stable performance environment. The harness
uses retry 0 and records each sample as measured.


Renderer compatibility includes source-format budgets, not just the auto-grown
scene bounds: the fixed dataflow row slots and stage columns, lifecycle's main
lane, authored page limits, and declared/default label budgets remain explicit
rules. All text widths used by the new engine come from its pinned glyph
metrics. The oracle's automatic growth is recorded as a positive control, so
right/bottom growth is not confused with an authored-origin or reserved-region
failure. Node/label/frame diagnostics retain source collection ordinals even
when display route IDs were generated or reserved around authored names.


Routing caches only immutable placement obstacles and reuses a first-pass path
when no relationship label was added afterward. Dynamic labels invalidate that
path reuse. Cache-on/off regressions compare complete reports for labels,
failures, pins and more stroke widths than the cache admits. At most eight
clearance variants and 65,536 first-pass points are retained; other requests
use the original computation so width diversity cannot create an unbounded
obstacle-cache amplification. No route or assertion is omitted for speed.

#### S3 evidence and automatic-route notices

Remote reproduction at SDK tree `feb11af6`: 187 core tests, two document
differentials, two geometry differential/regression tests, the layered-boundary
differential and three metric-model/control tests passed. The gate/adjustment
coverage, logical-work ceiling and five pin-regression integration tests also
passed. Clippy, formatting, binding drift
and the SDK boundary check passed. All 623 combined native/test-WASM scene
reports are byte-identical,
including 311 AC1 parity inputs, 309 separate boundary inputs and three seeded
dense scenes. Every expected equivalent code must exist in the family rule
registry and be emitted, rather than accepting any one matching code. The three
former E1 geometry deferrals now agree with the renderer. The eight public
cases retain both original evidence-gate verdicts and explicitly stored
evidence-stripped renderer verdicts, as in E1; no oracle-green expectation is
replaced by an engine refusal.

All four Chromium/WASM probes passed without a retry. Local typecheck,
applicable ESLint and 16 focused tests passed. The test canvas remains isolated
from DiagramMode. Remote `make verify` passed: 2,999 TypeScript tests,
2,178 Rust tests (three ignored), fmt/clippy, frontend build and all 390
command-isolation checks. No local Cargo build/test or native suite was run.

| Remote Chromium reproduction | Result |
| --- | --- |
| Validation entry and static imports, gzip | 324,219 B |
| Separate lazy geometry/metrics chunk, gzip | 1,638,804 B |
| Exact emitted geometry HTTP response, identity bytes | 5,079,291 B |
| Fresh-process lazy fetch/parse/compile/instantiate | 259.6 ms |
| 1,000-node / 999-edge first layout | 385.9 ms |
| Same workload, 20 warm samples, median / p95 / max | 301.3 / 303.8 / 304.9 ms |
| Validation-only 1,000-node p95 | 8 ms |

Warm typical-size samples use 20 retained-node/edge iterations in the same
`ENGINE_E2_PERF` record: 50 nodes/49 edges p95 **4.1 ms**, 200 nodes/199 edges p95
**23.2 ms**. The performance group has retry 0, including on CI.

Owner decision 2026-11-09: **E2 budget 400 ms p95** for 1,000-node layout plus
routing in hosted Chromium. **Sub-200 ms is required in E4 (#552 AC6)** before
the canvas switches. The 200 ms comparison remains `targetMet:false`, labelled
"E4 requirement". The harness records `budgetMs:400` and `budgetMet` without
failing the browser suite on wall-clock timing; hosted samples evaluate the E2
budget. The hosted baseline [run 42538495856](https://github.com/STAIxBWLB/maru/actions/runs/42538495856)
at earlier head `8802a89f` recorded layout p95 362.5 ms, median 352.2 ms,
first 466.9 ms, cold 297.7 ms, lazy geometry 1,578,657 B gzip, validation 324,286 B
gzip and validation 1,000-node p95 about 9 ms. Later hosted run
[42552702466](https://github.com/STAIxBWLB/maru/actions/runs/42552702466) at head
`7b27f5c6` recorded layout p95 239.8 ms. Run
[42559386644](https://github.com/STAIxBWLB/maru/actions/runs/42559386644) at head
`ea2aa242` recorded p95 407.9 ms, median 389.8 ms and cold load 410 ms, above the
400 ms E2 budget. The sub-200 ms E4 target still needs a dedicated stable
performance environment and has not been established by these hosted samples.
These runs are measurements at their recorded heads, not current-head acceptance.

The previous source-bound reproduction measured
305.5 ms p95; the current reproduction is 303.8 ms. Every node, all
999 routed edges and every geometry check remain present. These source-bound
reproductions are separate from the hosted run records above.

The per-PR regression gate is deterministic logical work on the unchanged
`bench-1000.json` fixture: live A* expansions, route evaluations and constraint
predicate/pair evaluations. Each counter and their total have a checked-in
ceiling of the recorded baseline plus 25% in `testdata/work-budget.json`.
The three-OS native matrix enforces the ceiling; the fourth WASM receipt must
match all counters exactly. Counters are thread-local and compiled only for
tests or `geometry-corpus`, with no hooks in normal product builds. They do not
measure allocation, hash-table probes, font internals or elapsed time. Updating
a ceiling requires deliberate remeasurement with `geometry-work` and review.

Remaining model/admission investigations are tracked in [#560](https://github.com/STAIxBWLB/maru/issues/560),
a prerequisite for E4. The recorded model disagreements retain their individual
oracle results and require evidence-based classification before fixes.

Lifecycle v2 minimum-span checks reuse the shared source rectangles, including
width-aware column centers, populated-lane rows and pin overrides. Two
oracle-accepted regressions cover right-to-right cross-row transitions and a
widened first column with a right-to-left transition.

Cold loading uses a fresh Chromium process and an identity-encoded read-only
loopback server. Response byte counts must equal the exact emitted artifacts,
with no Vite rewriting. Browser startup and first layout are outside that
interval; the first layout is recorded separately.

Generated routing quality stays visible as notices. Authored or mixed
violations remain blocking and identify their source. All notice paths are
stored in the source-bound JSON receipt and native/WASM reports.

| Case | Automatic rule | Notices | Input accepted |
| --- | --- | --- | --- |
| `public-01` | `geometry-v1/ambiguous-corridor` | 2 | Yes |
| `public-01` | `geometry-v1/short-interior-segment` | 1 | Yes |
| `public-02` | `geometry-v1/ambiguous-corridor` | 3 | Yes |
| `public-05` | `geometry-v1/ambiguous-corridor` | 4 | Yes |
| `public-06` | `geometry-v1/ambiguous-corridor` | 7 | Yes |
| `public-06` | `geometry-v1/short-interior-segment` | 1 | Yes |

#### Layered boundary evidence

The exact layer passes in both directions: **208 cases, zero mismatches**.
It covers shared readable-area, page, margin, spacing, reserve and spread-width
quantities, plus source-format defaults and placement constants. Source checks
use 1/128px intermediates when half of an authored 1/64px dimension is needed;
output geometry remains 1/64px. Dataflow/lifecycle readable-area predicates and
sequence spread widths use shared source-budget helpers.

The separate model layer reports all 101 inputs without failing the build.
These synthetic inputs are not added to the strict 311-case AC1 corpus and do
not waive any of its verdicts. Counts preserve both directions; full differing
case IDs and diagnostic codes are in `boundaryEvidence.modelDifferences`.
The table is stamped to the measured source snapshot `f4dcf4fe`, after the
shared-via provenance change and its strict regression.

| Category | Cases | Agreements | Oracle accepts, engine refuses | Oracle refuses, engine accepts | Examples of differences |
| --- | --- | --- | --- | --- | --- |
| `artifact-route-rounding` | 2 | 1 | 0 | 1 | `e2-boundary-lifecycle-physical-corridor-7` |
| `readable-v2-implicit-placement` | 8 | 8 | 0 | 0 | No differing verdict |
| `readable-v2-placement` | 15 | 8 | 3 | 4 | `e2-boundary-workflow-v2-arrow-spacing-8`; `e2-boundary-workflow-v2-shared-trunk-23` |
| `text-capacity` | 76 | 49 | 24 | 3 | `e2-boundary-sequence-segment-title-above`; `e2-boundary-dataflow-primary-width-above` |

The 12 primary/detail role-fit cases now have per-case source formulas, widths,
font sizes, glyph-advance sums, and Noto widths scaled to the source minimum in
the ledger. Source estimates fit their budgets by 0px to 4.4px while Noto
exceeds the role budget by 13px to 75.059659px; each recorded Noto box
matches its glyph advances within 1/64px. Pinned Noto geometry is authoritative
for these text-fit
checks. The separate sequence segment-title case records a 430px legacy estimate
and a 673px Noto requirement against a 430px frame.

The measured `f4dcf4fe` audit preserves the original 41 model-difference cases
and 35 current mismatches in a 44-case union. Nine original cases now agree,
and three current-only cases record the Noto sequence brand rail, the paired
sequence automatic-label placement boundary, and the workflow shared-via
placement threshold. Across all 101 boundary inputs, 66 verdicts agree, 27 are
oracle-green/engine-refused, and 8 are oracle-red/engine-admitted. The
[per-case admission ledger](performance/diagram-engine-e2-admission-ledger.json)
records exact source inputs, original oracle results, current geometry and
diagnostics, numeric boundary evidence, source references, and dispositions.
These counts and per-case dispositions are stamped to `f4dcf4fe`. The prior
native/WASM run at that head covered 623 cases (216 accepted, 405 retained),
changed 34 scenes and 7 SVGs, and produced matching report hashes; its work
receipt is preserved in [diagram-engine-e2-s3.json](diagram-engine-e2-s3.json).
The final implementation run at `af582230`, including that regression and the
Linux test-workflow step, passed SDK fmt, clippy and all engine tests. Its
623-case native/WASM reports remain identical, with the same 34 changed whole-scene
hashes and 7 changed SVGs against approved S1. Whole-scene hashes include diagnostics;
a changed hash does not by itself imply moved coordinates. The exact changed IDs,
source commit and both explicitly named tree paths are in the
[final determinism receipt](performance/diagram-engine-e2-admission-determinism.json).
Logical work remains 3,355,500, below the 4,194,375 ceiling. Of 407 refusals, 405
retain geometry; the other two stop at hard validation before layout.
The dataflow authored-via cases `e2-boundary-dataflow-label-route-3` and
`e2-boundary-dataflow-label-route-5` and sequence case
`e2-boundary-sequence-family-label-route-above` now pass with retained
nonempty routes. Dataflow endpoint masking is scoped to the route's own
source/target nodes. The sequence's paired below-boundary case remains an
oracle-red/engine-admitted automatic-placement difference: E2 moves the Noto
label below its route to clear other message ports. The shared-trunk-25 source
is now refused because two raw edges explicitly share the first via junction
and the actual clipped route witness ends there. Its paired 23px case remains
oracle-green but is refused: the source port gives a 23px approach inside the
24px exception, while the E2 port shifts 2px and yields a 25px shared piece.
The lifecycle band-title
case is a measured-geometry model difference: the source composite `01 / Main`
mask overlaps `Go` by 0.015625px, while the retained Noto `Main` and `Go` boxes
are separate by 5.484375px. The geometry DTO has no composite source-title
record, and [the SVG regression](../src-tauri/crates/maru-diagram-engine/tests/lifecycle_band_title_svg.rs)
confirms the writer emits only geometry labels. The workflow shared-trunk rule
now treats a first/last via junction explicitly shared by distinct raw edges
as authored/fatal; the committed route regression covers this rule and its
same-geometry unshared control.

The model differences measure Noto text capacity against legacy text masks,
readable-v2 placement and implicit-port solver differences. Lifecycle's rounded
SVG-corner crossing is separately labelled `artifact-route-rounding`; the
geometry engine does not implement E3 SVG corner rounding. In particular,
**1 oracle-green authored-coordinate input still gets a route-blocked refusal**
on engine-placed geometry:
`e2-boundary-workflow-v2-route-lane-title-63`. It remains a refusal under the
provenance rule, not a downgraded notice. The two dataflow endpoint-via cases
and sequence case `e2-boundary-sequence-family-label-route-above` now pass with
their pinned source routes retained. The remaining migration risk stays
explicit for E4.

Automatic port candidates may move along an unpinned face, or choose another
face if no side was authored. Authored sides remain on that face, and via,
channel and timeline anchors never change. Search-budget exhaustion is final for
that edge, rather than restarting an exhausted search at another candidate port.
Automatic label positions search bounded checked normal offsets; explicit
label positions, offsets and segment selection remain constraints. The four
original architecture regressions retain all routes after default-size
alignment. A workflow phase's 16px decorative rail constrains the heading's
horizontal range, not Noto line height.

Source-bound samples, hashes, the full notice inventory and budget status are
recorded in [diagram-engine-e2-s3.json](diagram-engine-e2-s3.json). The
ordinary source-format budgets now use the pinned defaults: architecture grid origin
[40,80], cells 130x64 with 30x40 gaps, 120x60 components, and 30px boundary padding with a
20px lower rail; workflow v1 centers [88,220,300,430,500,625], lanes at x40/y52 with
width640, height104, 20px gaps and 92x52 nodes (tagged nodes use 68px height); dataflow
centers x=100+215 per stage and rows y=128+114 per row, with 112x58 nodes and 168px-wide
stage frames beginning at y46; lifecycle v1 uses phase centers [94,248,402,556,710],
event/outcome centers [402,556,710], band tops 126/278/450 and the format's state
dimensions; lifecycle v2 uses the documented 140x64 base state, 60px left margin, 64px
minimum column gap and 56px/184px row origin/pitch; sequence fixed headers are 86x60 at y72,
centered from x62 with 108px steps, and spread mode uses a shared column helper. These are
exact base format constants. Readable-v2 solver expansions, Noto text capacity and implicit
port placement remain model-difference boundaries rather than exact renderer-formula claims.
The generated lifecycle 7px corridor case is separately a rounded-artifact model difference:
final SVG corner rounding creates a crossing, so it is not counted as an isolated proof of
the exact 8px source corridor threshold.

The exported refusal audits below retain every renderer refusal site. Standard-audit rows preserve the source predicate and coverage note but do not provide a separate measured-boundary field; route-audit rows show a threshold only where the audit records one. Unreachable, invariant, delegated and aggregation-only rows do not claim a measured numeric boundary. Coverage notes are audit metadata, not oracle verdicts by themselves.

The strict AC1 comparison remains the original 309 parity cases. The separate 309 `boundaryCases` probe source thresholds around renderer predicates; they do not replace or expand the AC1 verdict corpus. A boundary hypothesis becomes evidence only after the pinned host oracle records the actual result.

##### Gate and adjustment audit

The 132 refusal rows below now explicitly record the profile/schema/version
condition and renderer adjustments performed before each check. Source-derived
metadata in `gateAdjustmentAudit` is drift-checked against the host generator.
Its 65 conditional/grouped rows link to 57 gate-off positive controls and three
positive adjustment controls. A complementary showcase page-clipping case
checks the active gate. All 60 positives must be accepted by both the actual
pinned oracle and engine; false/false is never a passing positive. All 45 declared
gate-on negative reference links are checked against actual oracle refusals.
Thirteen explicit exemptions identify unreachable, aggregate or preempted
branches rather than claiming an unmeasured switch.

Origin checks now follow the actual gates: architecture routes require showcase,
workflow origin assertions require schema 2, and lifecycle via arrays bypass
endpoint-side inference. Boundary origin checks remain unconditional even on
automatic pages: auto growth repairs right/bottom extents, not negative origins.

Profiled architecture boundaries expand before checks using Noto metrics with
the source 6 px minimum/9 px preferred title fonts, 4 px inset on each side, 10 px mask
padding, 30 px minimum mask width, 16 px minimum height and 2 px clearance. Rails are
ordered by base frame area and source ordinal, then stacked above earlier
titles/components before containment checks. Frame-top growth retains its lower
extent. Authored viewBox is kept; automatic viewBox includes the adjusted frames.
Fit and expansion both use the widest measured line for multiline text.

Sequence emits and wraps the catalog in emphasis, return, security, dashed,
default order after all/auto/hidden selection. The regression on a 480x735 page
with message.y=600 fits two catalog rows (required 724 px), whereas an alphabetic
reordering needs three (746 px). Actual oracle and engine adjustment controls
both accept the two-row case.

Label admission uses actual 2 px overlap tolerance, not route-search inflation.
Unprofiled architecture boundary titles and non-showcase lifecycle band titles
are not fatal label-admission obstacles; route search still avoids actual
node/text geometry. Three new controls were repaired to isolate their intended
gates: 20 ASCII i and 53 ASCII i preserve legacy text units without unrelated Noto
node/endpoint occlusion; 17 CJK scalars preserve 34 legacy units and exercise the
source's profile-dependent clipping mask. Positions are retained, and the
confirmed title-overlap witnesses stay unchanged.

##### Emitted geometry and page/position sources

Sequence legends now emit the catalog-order wrap itself: 8px Noto labels,
43px item allowance, 22px item gap and minimum 22px rows within source width
minus 80px. The checker uses the same ink/advance span and font. Tests assert
each entry's actual x/y, 22px row step, catalog order, font size and page coverage.
The wrapped bounds, including multiline row height, drive the diagnostic page.

The diagnostic page may grow to show all retained geometry. It is not an
admission budget. Architecture grid overflow is tested against the unchanged
authored viewBox, including row 1 ending at 244px on a 240px page. Workflow v1
checks resolved lane right+16 and legendY()+18; its omitted page retains the
fixed 720px width. Workflow v2 checks resolved node, route, label, frame and
legend extents against an authored page. An omitted v2 page allows right/bottom
growth, while negative origins still refuse. Dataflow, lifecycle-v1 and
sequence retain their format's fixed default width rather than borrowing
grown diagnostic width for clipping checks.

Twenty source-bound page/rhythm regressions retain actual oracle verdicts:
authored grid right/bottom limits, workflow v1 footer capacity, workflow v2
absolute route/label overflow, default-page label overflow, and separate
architecture source-stub/target-stub/interior lengths. Stubs require 8px;
interior segments require 16px. Via-only segments remain interior unless
physical endpoint ports are included or match placed route ends.

Editable-position checks consume placed bounds. Sequence distance, crowding and
header page limits use actual participant centers/rectangles; workflow direct
gap capacity uses placed node centers and dimensions. Pins can therefore
introduce or remove a violation without an ordinal reconstruction overriding
them. Four sequence and one workflow integration tests cover these cases.

Constraint labels are selected by producer namespace: `edge:<id>:label` for a
relation, `node:<id>:<role>` for node roles, and
`container:boundary:<ordinal>:label` for boundary titles. Regression tests cover
shared node/relation IDs with clear and overlapping edge labels, plus duplicate
boundary captions with distinct diagnostic paths.

##### Document and geometry refusal sites

| Renderer source | Refusal cause | Engine mapping | Predicate / threshold | Initial coverage note | Layer and reason | Profile/schema/version gate | Renderer adjustments before checking |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:197` | duplicate participant ids | `sequence/duplicate-id` | unique participant.id; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:200` | short readable timeline | `sequence/geometry-node-viewbox` | height -65 -142 >=120; no separate measured-boundary field | schema-unreachable; sequence schema requires height >=480; renderer threshold327 cannot be crossed by a document-valid input | exact: shared bounds, source constants or authored geometric predicate | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:206` | primary participant label fit | `sequence/geometry-label-fit` | textUnits(label)*6.8 <= headerWidth+6; no separate measured-boundary field | existing-synthetic; spread header width boundary generated using schema-valid25 W text | model-difference: Noto text extents replace legacy heuristic masks | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:209` | brand top rail | `sequence/geometry-label-fit` | brand mark and sigil fit participant header; no separate measured-boundary field | generated-boundary; e2-boundary-sequence-brand-rail-7/9; fixed86px header, model text-capacity | model-difference: Noto text extents replace legacy heuristic masks | participant has a resolved brand mark; controls: `gate-sequence-brand-absent` | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:216` | participant sublabel fit | `sequence/geometry-label-fit` | textUnits(sublabel)*6*.6 <= headerWidth-8; no separate measured-boundary field | existing-synthetic; spread sublabel width boundary generated using45 W text | model-difference: Noto text extents replace legacy heuristic masks | participant.sublabel is nonempty; controls: `gate-sequence-optional-detail-absent` | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:222` | unknown message source | `sequence/participant-reference` | message.from in participants; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:223` | unknown message target | `sequence/participant-reference` | message.to in participants; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:224` | nonnumeric message time | `sequence/shape` | typeof message.y is number; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:226` | message timeline bounds | `sequence/geometry-message-time` | 160 <= message.y <= authored height-83; no separate measured-boundary field | generated-boundary; lower bound160 is already schema-minimum; upper authored budget has 1/64px neighbours | exact: shared bounds, source constants or authored geometric predicate | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:230` | message endpoint span | `sequence/geometry-route-distance` | message endpoint distance >=60; no separate measured-boundary field | existing-synthetic; non-self fixed/spread pitch >=108; self relation is discrete14px case, not a continuous threshold | exact: shared bounds, source constants or authored geometric predicate | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:236` | edge through participant header | `sequence/geometry-route-clearance` | route avoids third-party opaque header; no separate measured-boundary field | shared-covered; e2-boundary-architecture-unrelated-node-clearance-1/3 proves shared2px predicate; sequence source y>=160 stays below all header bodies ending132 | exact: shared bounds, source constants or authored geometric predicate | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:246` | proper route crossing | `sequence/geometry-route-quality` | showcase disjoint endpoints do not cross; no separate measured-boundary field | renderer-invariant; sequence routes are horizontal so no proper perpendicular crossing; coincident overlaps handled corridor predicate | exact: shared bounds, source constants or authored geometric predicate | effective quality profile=showcase; proper crossing only; exemption: messagePath emits horizontal segments only; a proper interior X cannot be authored in the admitted sequence format; gate is retained, no fake positive proof | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:255` | ambiguous corridor | `sequence/geometry-route-quality` | showcase unrelated horizontal overlap is separated; no separate measured-boundary field | generated-boundary; e2-boundary-sequence-parallel-messages-180/212; source-family disjoint endpoints | exact: shared bounds, source constants or authored geometric predicate | effective quality profile=showcase; qualifying unrelated/shared endpoint policy; exemption: a same-row overlapping message corridor also violates unconditional row-spacing; no isolated accepted gate-off source exists for that witness | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:264` | segment border run | `sequence/geometry-route-quality` | no positive collinear overlap with trimmed frame side; no separate measured-boundary field | existing-synthetic; equality predicate is non-monotone: y==border is negative, both 1/64px neighbours positive; not represented as a false one-sided boundary | exact: shared bounds, source constants or authored geometric predicate | effective quality profile is present (standard or showcase); controls: `gate-sequence-border-profile-absent` | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:274` | route rhythm | `sequence/geometry-route-quality` | showcase micro segment8/interior16 floors; no separate measured-boundary field | renderer-invariant; one horizontal sequence segment has no interior turns; self span14 is above micro floor | exact: shared bounds, source constants or authored geometric predicate | effective quality profile=showcase; exemption: a valid sequence message is one horizontal segment spanning>=60px; no admitted micro/interior turn can trigger this call | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:298` | message row crowding | `sequence/geometry-message-spacing` | overlapping horizontal span requires deltaY >=28; no separate measured-boundary field | generated-boundary | exact: shared bounds, source constants or authored geometric predicate | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:311` | message label overlap | `sequence/geometry-label-overlap` | message label masks do not overlap at inset-2; no separate measured-boundary field | generated-boundary; e2-boundary-sequence-label-pair-*; tangent arrow spans isolate label-only overlap, model text-capacity | model-difference: Noto text extents replace legacy heuristic masks | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:315` | label near another route | `sequence/geometry-route-clearance` | showcase label-to-other-route clearance >=4; no separate measured-boundary field | generated-boundary; e2-boundary-sequence-family-label-route-below/above; actual4px oracle cause observed | exact: shared bounds, source constants or authored geometric predicate | effective quality profile=showcase; controls: `gate-sequence-label-route-standard` | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:325` | message label canvas containment | `sequence/geometry-label-viewbox` | showcase label overflow <=0.5px; no separate measured-boundary field | generated-boundary; e2-boundary-sequence-message-label-canvas-32/34; model text-capacity | model-difference: Noto text extents replace legacy heuristic masks | effective quality profile=showcase; controls: `gate-sequence-label-page-standard` | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:336` | reversed segment range | `sequence/range-order` | segment.to > segment.from; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:339` | segment canvas range | `sequence/geometry-segment-range` | from>=72 and to<=authored height-45; no separate measured-boundary field | generated-boundary | exact: shared bounds, source constants or authored geometric predicate | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:345` | segment title fit | `sequence/geometry-segment-label-fit` | label width +104 <= page width; no separate measured-boundary field | generated-boundary | model-difference: Noto text extents replace legacy heuristic masks | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:350` | unknown activation participant | `sequence/participant-reference` | activation.participant in participants; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:351` | reversed activation range | `sequence/range-order` | activation.to > activation.from; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:357` | participant columns exceed page | `sequence/geometry-participant-canvas-width` | last center +half header+40 <=width; no separate measured-boundary field | generated-boundary; fixed and spread modes both covered | exact: shared bounds, source constants or authored geometric predicate | always for each admitted member/reference | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:365` | implicit showcase legend hidden | `sequence/geometry-legend-clearance` | effective contentBottom +96 +22/additional row <=height (conservative growth hint uses98); no separate measured-boundary field | generated-boundary; legend-note/message/activation exact reserves; legend-wrap-label-width and legend-wrap-overrides model text-capacity; no unclaimed locale chrome proof | model-difference: Noto text extents replace legacy heuristic masks | source quality_profile=showcase AND meta.legend absent AND required legend exceeds page AND implicit legend cannot be measured; controls: `gate-sequence-late-standard`, `gate-sequence-late-hidden`, `gate-sequence-auto-height`, `adjust-sequence-legend-catalog-wrap` | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/sequence/render-sequence.mjs:369` | aggregate sequence refusal | `none` | any accumulated problem; no separate measured-boundary field | aggregation-only | exact: same source quantity/predicate; aggregation adds no independent threshold | aggregate previously collected failures; exemption: aggregation is not an independently switchable predicate | legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first; auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent; column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers; showcase enables the readable message label mask before label collision checks |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:122` | duplicate node ids | `dataflow/duplicate-id` | unique node.id; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:127` | unknown node stage | `dataflow/stage-reference` | stage in existing stage indices; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:130` | fixed row slots | `dataflow/fixed-row-slots` | row integer in0..4; no separate measured-boundary field | existing-synthetic; row5 rejection already recorded; row4/5 is a discrete integer boundary | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:133` | nonfinite placed coordinates | `dataflow/fixed-row-slots` | finite stage/row/width/height/offset projection; no separate measured-boundary field | mixed-admission; malformed scalar is E1-covered; schema-unbounded row5+ is fixed-row-slots; fixedpoint overflow is SDK coordinate refusal | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:137` | node horizontal page bounds | `dataflow/geometry-node-viewbox` | 24 <= node.left; node.right <=width-24; no separate measured-boundary field | generated-boundary; left margin covered; stage-frame width budget dominates a narrow authored-page right margin | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:140` | node vertical readable bounds | `dataflow/geometry-node-viewbox` | 104 <=node.y; node.bottom <=height-74; no separate measured-boundary field | generated-boundary | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:144` | primary node label fit | `dataflow/geometry-label-fit` | textUnits(label)*6.2 <=width+6; no separate measured-boundary field | generated-boundary | model-difference: Noto text extents replace legacy heuristic masks | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:147` | brand top rail | `dataflow/geometry-label-fit` | brand mark and sigil fit node width; no separate measured-boundary field | generated-boundary; e2-boundary-dataflow-brand-rail-71/73; both actual CLI verdicts observed, model text-capacity | model-difference: Noto text extents replace legacy heuristic masks | node has resolved brand mark; controls: `gate-dataflow-brand-absent` | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:158` | sublabel and tag fit | `dataflow/geometry-label-fit` | textUnits(value)*6*.6 <=width-8; no separate measured-boundary field | generated-boundary; separate sublabel/tag pairs | model-difference: Noto text extents replace legacy heuristic masks | sublabel/tag value is nonempty; controls: `gate-dataflow-optional-detail-absent` | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:169` | node collision gap | `dataflow/geometry-node-overlap` | separation >=10px; no separate measured-boundary field | generated-boundary | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:175` | unknown flow source | `dataflow/reference` | flow.from in nodes; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:176` | unknown flow target | `dataflow/reference` | flow.to in nodes; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:177` | missing flow data label | `dataflow/text` | nonempty flow.label; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:182` | flow endpoint span | `dataflow/geometry-route-distance` | Euclidean endpoint distance >=34; no separate measured-boundary field | generated-boundary | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:191` | authored diagonal via | `dataflow/geometry-route-quality` | each via segment dx<=.01 or dy<=.01; no separate measured-boundary field | generated-boundary; e2-boundary-dataflow-diagonal-via-0/1; source-aligned versus diagonal control | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:197` | endpoint side direction | `dataflow/geometry-route-quality` | first/last segment crosses selected border perpendicularly; no separate measured-boundary field | generated-boundary; e2-boundary-dataflow-endpoint-direction-0/1; physical source port at156,157 | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:207` | flow through third-party node | `dataflow/geometry-route-clearance` | segment avoids third-party node interior; no separate measured-boundary field | generated-boundary; e2-boundary-dataflow-third-node-gap-1/3; actual clean-flow/edge-through-node observed at gap1 | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:216` | proper crossing | `dataflow/geometry-route-quality` | showcase unrelated paths do not cross; no separate measured-boundary field | generated-boundary; e2-boundary-dataflow-physical-crossing--1/1; real four-node crossing observed at180,200 | exact: shared bounds, source constants or authored geometric predicate | effective quality profile=showcase; controls: `gate-dataflow-crossing-standard` | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:225` | ambiguous shared corridor | `dataflow/geometry-route-quality` | showcase unrelated paths do not share corridor; no separate measured-boundary field | generated-boundary; e2-boundary-dataflow-physical-corridor-7/9; 7px control actually accepted; 50px same fixture corridor actually refused | exact: shared bounds, source constants or authored geometric predicate | effective quality profile=showcase; controls: `gate-dataflow-corridor-standard` | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:234` | stage border run | `dataflow/geometry-route-quality` | no positive collinear overlap with trimmed stage side; no separate measured-boundary field | generated-boundary; e2-boundary-dataflow-stage-border-45/46/47; showcase exact46 top border with title X and x10 corridor actually refuses148px run; no fake header-bottom82 frame | exact: shared bounds, source constants or authored geometric predicate | effective quality profile is present; controls: `gate-dataflow-border-profile-absent` | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:244` | route rhythm | `dataflow/geometry-route-quality` | showcase micro8/interior16 floors; no separate measured-boundary field | shared-covered; e2-boundary-architecture-turn-7/9/15/17 shared rhythm floors plus existing e2-dataflow-geometry-route-quality-micro-segment actual family refusal | exact: shared bounds, source constants or authored geometric predicate | effective quality profile=showcase; controls: `gate-dataflow-rhythm-standard` | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:264` | label overlaps node | `dataflow/geometry-label-overlap` | label/node inset overlap forbidden; no separate measured-boundary field | generated-boundary; e2-boundary-dataflow-label-node-124/126; model text-capacity | model-difference: Noto text extents replace legacy heuristic masks | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:271` | label pairs overlap | `dataflow/geometry-label-overlap` | label pair inset-2 overlap forbidden; no separate measured-boundary field | generated-boundary | model-difference: Noto text extents replace legacy heuristic masks | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:275` | label route clearance | `dataflow/geometry-route-clearance` | showcase label/other-route distance >=4; no separate measured-boundary field | generated-boundary | exact: shared bounds, source constants or authored geometric predicate | effective quality profile=showcase; controls: `gate-dataflow-label-route-standard` | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:285` | label canvas overflow | `dataflow/geometry-label-viewbox` | showcase label overflow <=.5px; no separate measured-boundary field | generated-boundary; e2-boundary-dataflow-label-canvas-15/18; model text-capacity | model-difference: Noto text extents replace legacy heuristic masks | effective quality profile=showcase; controls: `gate-dataflow-label-page-standard` | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:295` | stages exceed page width | `dataflow/stage-canvas-width` | last stage center +84+24 <=width; no separate measured-boundary field | generated-boundary | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/dataflow/render-dataflow.mjs:299` | aggregate dataflow refusal | `none` | any accumulated problem; no separate measured-boundary field | aggregation-only | exact: same source quantity/predicate; aggregation adds no independent threshold | aggregate previously collected failures; exemption: aggregation only | resolve fixed stage centers100+215*stage and five row slots128+114*row before checking; source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:351` | duplicate state ids | `lifecycle/duplicate-id` | unique state.id; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references; bounds use schema-specific resolved metrics | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:357` | v1 fixed band page floor | `lifecycle/geometry-node-viewbox` | height -122 +4 >=448; no separate measured-boundary field | generated-boundary; v2 auto-row layout intentionally does not apply this floor | exact: shared bounds, source constants or authored geometric predicate | schema_version=1 (fixed band floor); controls: `gate-lifecycle-v2-no-fixed-floor` | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:361` | duplicate lane ids | `lifecycle/duplicate-id` | unique lane.id; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references; bounds use schema-specific resolved metrics | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:363` | reserved main lane absent | `lifecycle/reserved-main-lane` | main lane exists in v1/v2; no separate measured-boundary field | existing-synthetic; not E1: preserved from previous stage; discrete main/nonmain probe | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references; bounds use schema-specific resolved metrics | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:370` | unknown state lane | `lifecycle/lane-reference` | state.lane in lanes; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references; bounds use schema-specific resolved metrics | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:375` | v2 state column range | `lifecycle/range` | integer col in0..4; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | schema_version=2; declared col integer0..4; exemption: v1 column admission is no more permissive for any lane, so no source can violate v2's col0..4 predicate while valid in v1 | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:386` | v1 fixed band column capacity | `lifecycle/geometry-state-column` | phase col0..4; event/outcome col0..2; no separate measured-boundary field | existing-synthetic; v1 ordinary/terminal col3 rejects; v2 col3 accepted by its five-column grid | exact: shared bounds, source constants or authored geometric predicate | schema_version=1; fixed event/outcome bands admit only col0..2; controls: `gate-lifecycle-v2-ordinary-col3` | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:391` | nonfinite placed coordinates | `lifecycle/geometry-node-viewbox` | finite column/size/offset projection; no separate measured-boundary field | mixed-admission; wrong scalar shape is E1; invalid fixed-band columns above; huge valid coordinates hit SDK fixedpoint boundary | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references; bounds use schema-specific resolved metrics | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:395` | state horizontal page bounds | `lifecycle/geometry-node-viewbox` | v1 margin32;v2 margin28; no separate measured-boundary field | generated-boundary; v1 phase left and ordinary/outcome right margins; v2 authored right margin covered; v2 source-sized first left stays60 and cannot cross margin28 | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references; bounds use schema-specific resolved metrics | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:398` | state vertical lifecycle area | `lifecycle/geometry-node-viewbox` | v1 top64,bottomH-122;v2 top44,bottomH-extra-96; no separate measured-boundary field | generated-boundary; v1/v2 top and authored bottom reserves covered; auto-growth controls remain separate | exact: shared bounds, source constants or authored geometric predicate | schema-specific area after auto-height adjustment; authored page is not resized; controls: `gate-lifecycle-v2-auto-height` | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:402` | primary state label fit | `lifecycle/geometry-label-fit` | textUnits(label)*6.2 <=width+6; no separate measured-boundary field | generated-boundary; v1/v2 separate width pairs | model-difference: Noto text extents replace legacy heuristic masks | always for admitted members/references; bounds use schema-specific resolved metrics | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:405` | brand top rail | `lifecycle/geometry-label-fit` | brand mark and sigil fit state width; no separate measured-boundary field | generated-boundary; e2-boundary-lifecycle-brand-rail-71/73; shared brand predicate, model text-capacity | model-difference: Noto text extents replace legacy heuristic masks | state has resolved brand mark; controls: `gate-lifecycle-brand-absent` | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:416` | sublabel and tag fit | `lifecycle/geometry-label-fit` | v1 minimum6,v2 minimum7; width budget minus8; no separate measured-boundary field | generated-boundary; v1/v2 separate sublabel/tag pairs | model-difference: Noto text extents replace legacy heuristic masks | sublabel/tag nonempty; minimum6 for v1,7 for v2; controls: `gate-lifecycle-optional-detail-absent` | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:429` | state collision gap | `lifecycle/geometry-node-overlap` | state separation >=10px; no separate measured-boundary field | generated-boundary; v1/v2 same-column offset pairs | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references; bounds use schema-specific resolved metrics | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:435` | unknown transition source | `lifecycle/transition-endpoint` | transition.from in states; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references; bounds use schema-specific resolved metrics | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:436` | unknown transition target | `lifecycle/transition-endpoint` | transition.to in states; no separate measured-boundary field | E1-covered | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references; bounds use schema-specific resolved metrics | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:441` | transition endpoint span | `lifecycle/geometry-route-distance` | Euclidean endpoint distance >=32; no separate measured-boundary field | generated-boundary | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references; bounds use schema-specific resolved metrics | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:449` | endpoint side direction | `lifecycle/geometry-route-quality` | automatic route border crossing perpendicular; no separate measured-boundary field | generated-boundary; e2-boundary-lifecycle-endpoint-direction-0/1; straight preset avoids authored-via bypass; actual source-side refusal observed | exact: shared bounds, source constants or authored geometric predicate | transition.via is NOT an array (actual callback has no schema-version condition); controls: `gate-lifecycle-via-side-bypass` | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:460` | route through third-party state | `lifecycle/geometry-route-clearance` | segment avoids third-party state interior; no separate measured-boundary field | generated-boundary; e2-boundary-lifecycle-third-state-gap-1/3; three physical main-column states | exact: shared bounds, source constants or authored geometric predicate | always for admitted members/references; bounds use schema-specific resolved metrics | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:469` | proper crossing | `lifecycle/geometry-route-quality` | showcase disjoint routes do not cross unless planner halo resolves; no separate measured-boundary field | generated-boundary; e2-boundary-lifecycle-physical-crossing--1/1; actual authored-route crossing at180,200; planner halo exemption not claimed | exact: shared bounds, source constants or authored geometric predicate | effective quality profile=showcase; plannerRouted(left)&&plannerRouted(right) resolves the crossing with halo; exemption: planner halo sub-branch cannot be forced to retain an exact X from source; planner regenerates both paths; do not treat a clean auto seed as halo proof; controls: `gate-lifecycle-crossing-standard` | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:480` | ambiguous corridor | `lifecycle/geometry-route-quality` | showcase unrelated routes do not merge; no separate measured-boundary field | shared-covered; e2-boundary-architecture-corridor-7/9 exact shared8px predicate proof; lifecycle physical-corridor7/9 retained as MODEL artifact-route-rounding because final rounded SVG corner crossing preempts isolated source-corridor proof | model-difference: rounded SVG corners; logical8px threshold stays exact | effective quality profile=showcase; controls: `gate-lifecycle-corridor-standard` | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:492` | container border run | `lifecycle/geometry-route-quality` | frames=[]; no separate measured-boundary field | renderer-invariant; lifecycle bands are guides, not closed structural containers; no admitted source can trigger this call | exact: shared bounds, source constants or authored geometric predicate | effective profile present but frames is always empty; exemption: unreachable: lifecycle bands are open guides and this call supplies frames=[] | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:501` | route rhythm | `lifecycle/geometry-route-quality` | showcase micro8/interior16 floors; no separate measured-boundary field | shared-covered; e2-boundary-architecture-turn-7/9/15/17 shared rhythm floors plus existing e2-lifecycle-geometry-route-quality-micro-segment actual family refusal | exact: shared bounds, source constants or authored geometric predicate | effective quality profile=showcase; controls: `gate-lifecycle-rhythm-standard` | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:517` | transition label overlaps band title | `lifecycle/geometry-label-overlap` | showcase label rect misses the composed legacy band-title mask; no separate measured-boundary field | `e2-boundary-lifecycle-band-title-113.984375`: source `01 / Main` mask `[72,89,55.8,14]` overlaps `Go` by0.015625px; E2 `Main`/`Go` measured boxes are separate by5.484375px | measured-geometry model difference: E2 has no composed band-title text record, so do not add a source-composition predicate | source quality_profile=showcase; controls: `gate-lifecycle-title-standard` | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:523` | band-title refusal accumulation | `lifecycle/geometry-label-overlap` | aggregation-only; inherits line517 cause with no independent threshold | Same single band-title case and measured boxes as line517 | measured-geometry model difference; no separate composed text or source-coordinate check | source quality_profile=showcase; controls: `gate-lifecycle-title-standard` | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:530` | label overlaps state | `lifecycle/geometry-label-overlap` | label/state inset overlap forbidden; no separate measured-boundary field | generated-boundary; e2-boundary-lifecycle-label-node-122/124; model text-capacity | model-difference: Noto text extents replace legacy heuristic masks | always for admitted members/references; bounds use schema-specific resolved metrics | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:537` | label pairs overlap | `lifecycle/geometry-label-overlap` | label pair inset-2 overlap forbidden; no separate measured-boundary field | generated-boundary; e2-boundary-lifecycle-label-pair-412/416; model text-capacity | model-difference: Noto text extents replace legacy heuristic masks | always for admitted members/references; bounds use schema-specific resolved metrics | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:541` | label route clearance | `lifecycle/geometry-route-clearance` | showcase label/other-route distance >=4; no separate measured-boundary field | generated-boundary; e2-boundary-lifecycle-family-label-route-below/above; actual source4px oracle cause observed with displaced lower states | exact: shared bounds, source constants or authored geometric predicate | effective quality profile=showcase; controls: `gate-lifecycle-label-route-standard` | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:550` | label canvas overflow | `lifecycle/geometry-label-viewbox` | showcase label overflow <=.5px; no separate measured-boundary field | generated-boundary; e2-boundary-lifecycle-label-canvas-15/18; model text-capacity | model-difference: Noto text extents replace legacy heuristic masks | effective quality profile=showcase; controls: `gate-lifecycle-label-page-standard` | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |
| `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:559` | aggregate lifecycle refusal | `none` | any accumulated problem; no separate measured-boundary field | aggregation-only | exact: same source quantity/predicate; aggregation adds no independent threshold | aggregate previously collected failures; exemption: aggregation only | schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics; schema2 without authored viewBox grows to node bounds and resolved legend rows before checks; showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback |

##### Route, text and frame refusal sites

| Renderer source | Refusal cause | Engine mapping | Predicate / threshold | Initial coverage note | Layer and reason | Profile/schema/version gate | Renderer adjustments before checking |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `sidecars/archify/renderers/architecture/grid.mjs:33-59` | grid mode, position, nonnegative cell, column and uniqueness | `architecture/{enum,placement-input,range,grid-column,grid-cell}` | pos overrides grid hints; otherwise valid unique declared cell; no numeric threshold claimed | E1 architecture.rs and generated cases | exact: shared bounds, source constants or authored geometric predicate | layout.mode=grid; authored pos bypasses row/col/grid-cell checks; controls: `gate-architecture-pos-overrides-grid` | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:430-454` | identity, placement and finite positive size | `architecture/{duplicate-id,placement-input,shape,range}` | ids unique; free pos required; finite positive size; no numeric threshold claimed | E1: architecture.rs; generated E1 cases | exact: shared bounds, source constants or authored geometric predicate | always after source layout resolution | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:458` | component outside canvas | `architecture/geometry-node-viewbox` | node bounds contained in viewBox; threshold 0 | existing e2 primary viewBox/origin cases | exact: shared bounds, source constants or authored geometric predicate | always after source layout resolution | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:460-476` | primary/detail/tag/brand readability | `architecture/geometry-label-fit` | text minimum width <= available rail; no numeric threshold claimed | existing e2 primary/detail/tag; new brand-rail71/73 around48+5*8*.6=72px | model-difference: Noto text extents replace legacy heuristic masks | primary label always; brand/detail/tag branches require the corresponding nonempty source value; controls: `gate-architecture-brand-absent`, `gate-architecture-optional-detail-absent` | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:480-486` | component clearance | `architecture/geometry-node-overlap` | rectsOverlap(a,b,8); threshold 8 | new boundary: architecture-node-gap | exact: shared bounds, source constants or authored geometric predicate | always after source layout resolution | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:494` | unknown wrapped component | `architecture/reference` | wraps names existing components; no numeric threshold claimed | E1: architecture.rs reference | exact: shared bounds, source constants or authored geometric predicate | always after source layout resolution | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:500-519` | boundary title width/frame/page/node containment | `architecture/geometry-boundary-title-fit` | title fits frame/page and avoids components; no numeric threshold claimed | existing e2 boundary-title; individual title/frame intersections unisolated | model-difference: Noto text extents replace legacy heuristic masks | meta.quality_profile is present; controls: `gate-architecture-titles-profile-absent`, `adjust-architecture-title-expansion` | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:528-579` | boundary title pair and deployment frame containment | `architecture/geometry-boundary-overlap` | title pair disjoint; nested wraps agree with frames; no numeric threshold claimed | E1 ownership handles membership; geometry branches require frame-worker fixtures | model-difference: Noto text extents replace legacy heuristic masks | title pair check: quality_profile present; membership/frame nesting: engineering_profile=deployment-ownership; controls: `gate-architecture-titles-profile-absent`, `gate-architecture-nondeployment-scopes`, `adjust-architecture-title-stack` | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:585-617` | boundary canvas containment | `architecture/geometry-container-containment` | boundary contained in origin-zero page; threshold 0 | existing frame cases; no isolated route boundary | exact: shared bounds, source constants or authored geometric predicate | always after source layout resolution | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:622-623` | unknown relation endpoints | `architecture/reference` | from/to names component; no numeric threshold claimed | E1 reference cases | exact: shared bounds, source constants or authored geometric predicate | always after source layout resolution | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:626-635` | route outside canvas | `architecture/geometry-route-viewbox` | showcase all route points in page; threshold 0 | new boundary: architecture-route-origin | exact: shared bounds, source constants or authored geometric predicate | source quality_profile=showcase; controls: `gate-architecture-origin-standard` | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:638-651` | endpoint distance/self-loop port distance | `architecture/geometry-route-distance` | euclidean endpoint span >=24; threshold 24 | new boundary: architecture-port-span; self-loop existing positive case | exact: shared bounds, source constants or authored geometric predicate | always after source layout resolution | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:656-739` | shared route gates | `architecture/geometry-route-quality` | delegates endpoint/node/crossing/corridor/border/rhythm; no numeric threshold claimed | shared inventory below | exact: shared bounds, source constants or authored geometric predicate | endpoint/node gates always; crossing/corridor/rhythm showcase; border any effective profile; auto-only arrow selection; controls: `gate-architecture-crossing-standard`, `gate-architecture-corridor-standard`, `gate-architecture-rhythm-standard`, `gate-architecture-border-profile-absent` | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:739-747` | excessive route detour | `architecture/geometry-route-quality` | shortest legal orthogonal route ratio + excess + empty excursion; threshold {"ratio":2.5,"excessPx":200,"emptyPx":96} | oracle observed shortest408px; new actual-length1019/1021 ratio pair and excess199/201 pair | exact: shared bounds, source constants or authored geometric predicate | source quality_profile=showcase AND nonempty authored via; all detour thresholds conjunctive; controls: `gate-architecture-detour-standard` | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:750-764` | automatic short label gap | `architecture/geometry-label-overlap` | un-pinned label blocked and direct span <ceil(label.width+16); threshold 16 | new architecture automatic gap; exact text metric boundary intentionally not assumed | model-difference: Noto text extents replace legacy heuristic masks | showcase AND label unpinned AND automatic label blocked AND direct horizontal gap below measured minimum; exemption: not an independent acceptance gate: else-branch still refuses every blocked label; message specialization must not be counted as a gate-off acceptance proof | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:773-780` | label/component and boundary title overlap | `architecture/geometry-label-overlap` | rectsOverlap(label,node,-2); title overlap; threshold -2 | new label-node pair; boundary title pair remains frame-worker coverage | model-difference: Noto text extents replace legacy heuristic masks | label/component overlap always; boundary-title/label overlap only when quality_profile is present; controls: `gate-architecture-title-label-profile-absent` | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/architecture/render-architecture.mjs:785-805` | label route/page containment | `architecture/geometry-route-clearance` | delegates shared label gates; no numeric threshold claimed | shared inventory below | exact: shared bounds, source constants or authored geometric predicate | effective quality profile=showcase; controls: `gate-architecture-label-route-standard`, `gate-architecture-label-page-standard` | readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins; resolve authored pos ahead of grid row/col; declared node size is retained; automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown; title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:1941-2080` | v2 explicit pair pin conflicts | `workflow/geometry-route-quality` | label-route4; label-label -2; proper crossing; corridor8; threshold {"labelRoute":4,"labelOverlap":-2,"corridor":8} | new v2 pin boundary cases; actual final oracle diagnostics retained | model-difference: readable-v2 solver/implicit-port geometry; evaluate engine geometry | schema2; label-route requires labelAt or other authored route assertions; pair crossing/corridor additionally source showcase; controls: `gate-workflow-v1-pair-controls`, `gate-workflow-v2-corridor-standard` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2087-2106` | v2 preset/channel compatibility | `workflow/geometry-route-quality` | preset supports authored channel field; no numeric threshold claimed | new v2 incompatible preset case; engine support requires audit | model-difference: readable-v2 solver/implicit-port geometry; evaluate engine geometry | schema_version=2; named/source assertions apply before renderer repair; controls: `gate-workflow-v1-origin`, `gate-workflow-v1-preset-fields`, `gate-workflow-v1-via-rhythm` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2227-2273` | v2 origin pin containment | `workflow/geometry-route-viewbox` | labelAt/via/channel origin >=0; threshold 0 | new workflow-v2-origin pair | exact: shared bounds, source constants or authored geometric predicate | schema_version=2; named/source assertions apply before renderer repair; controls: `gate-workflow-v1-origin`, `gate-workflow-v1-preset-fields`, `gate-workflow-v1-via-rhythm` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2280-2300` | v2 finite and nonzero pinned segments | `workflow/geometry-route-quality` | finite coordinates; segment != zero; threshold 0 | finite E1 shape/range; new duplicate-via case | exact: shared bounds, source constants or authored geometric predicate | schema_version=2; named/source assertions apply before renderer repair; controls: `gate-workflow-v1-origin`, `gate-workflow-v1-preset-fields`, `gate-workflow-v1-via-rhythm` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2301-2337` | v2 orthogonal pin segments and min lengths | `workflow/geometry-route-quality` | axis aligned; direct>=28, endpoints>=8, interior>=16; threshold {"direct":28,"endpoint":8,"interior":16} | v2 anchors observed144,119 to288,119; turn15 rejects16px,17 accepted; endpoint9 accepted | exact: shared bounds, source constants or authored geometric predicate | schema_version=2; named/source assertions apply before renderer repair; controls: `gate-workflow-v1-origin`, `gate-workflow-v1-preset-fields`, `gate-workflow-v1-via-rhythm` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2338-2378` | v2 channel preservation and preset family | `workflow/geometry-route-quality` | via path contains authored channel; route fits preset family; no numeric threshold claimed | new channel-preservation/preset conflict; engine support requires audit | exact: shared bounds, source constants or authored geometric predicate | schema_version=2; named/source assertions apply before renderer repair; controls: `gate-workflow-v1-origin`, `gate-workflow-v1-preset-fields`, `gate-workflow-v1-via-rhythm` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2379-2412` | v2 endpoint orientation and unrelated-node clearance | `workflow/geometry-route-clearance` | honors sides; unrelated-node intersection; threshold 2 | new endpoint direction/node-clearance cases | exact: shared bounds, source constants or authored geometric predicate | schema_version=2; named/source assertions apply before renderer repair; controls: `gate-workflow-v1-origin`, `gate-workflow-v1-preset-fields`, `gate-workflow-v1-via-rhythm` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2413-2448` | v2 route legend/scene-label/frame clearance | `workflow/geometry-route-quality` | route avoids legend, title rails and frame border; threshold 0 | new source-via route legend189/191, title63/65 pairs based on observed baseline legend/header rectangles | exact: shared bounds, source constants or authored geometric predicate | schema_version=2; named/source assertions apply before renderer repair; controls: `gate-workflow-v1-origin`, `gate-workflow-v1-preset-fields`, `gate-workflow-v1-via-rhythm` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2450-2496` | v2 pinned label node/legend/title clearance | `workflow/geometry-label-overlap` | pinned label avoids measured obstacles; threshold {"node":-2,"legend":0,"title":0} | new pinned label legend bottom189/191 and lane-title bottom63/65 pairs | model-difference: Noto text extents replace legacy heuristic masks | schema_version=2; named/source assertions apply before renderer repair; controls: `gate-workflow-v1-origin`, `gate-workflow-v1-preset-fields`, `gate-workflow-v1-via-rhythm` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2503-2565` | schema, identity, references, column rules | `workflow/{shape,schema-version,diagram-type,text,id,duplicate-id,lane-reference,range}` | typed document and declared references; no numeric threshold claimed | E1 workflow.rs and generated cases | exact: shared bounds, source constants or authored geometric predicate | always; optional phases/groups/mainPath/card/detail branches require their source members; controls: `gate-workflow-optional-structures-absent` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2567-2597` | node finite/label/brand/lane bounds | `workflow/geometry-node-lane` | finite geometry; text fits; node within lane; no numeric threshold claimed | E1 finite/range; existing e2 fit/lane and new brand-rail71/73 | exact: shared bounds, source constants or authored geometric predicate | node coordinate/lane checks always; brand/detail/tag branches require their nonempty source value; controls: `gate-workflow-brand-absent`, `gate-workflow-optional-detail-absent` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2600-2643` | phase/group validity and title width | `workflow/{phase-range,phase-overlap,group-range,lane-reference,empty-group,geometry-phase-label-fit}` | declared ranges valid; title fits span; no numeric threshold claimed | E1 range/reference/membership; frame-worker title boundary | model-difference: Noto text extents replace legacy heuristic masks | always; optional phases/groups/mainPath/card/detail branches require their source members; controls: `gate-workflow-optional-structures-absent` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2645-2655` | same-lane node clearance | `workflow/geometry-node-overlap` | rectsOverlap(a,b,8); threshold 8 | existing same-lane-col; exact column/offset spacing needs layout-aware fixture | exact: shared bounds, source constants or authored geometric predicate | always; optional phases/groups/mainPath/card/detail branches require their source members; controls: `gate-workflow-optional-structures-absent` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2660-2668` | endpoints and direct span | `workflow/geometry-route-distance` | valid endpoints; direct span>=28; threshold 28 | E1 endpoints; new workflow-direct-span controls are oracle-measured | exact: shared bounds, source constants or authored geometric predicate | always; optional phases/groups/mainPath/card/detail branches require their source members; controls: `gate-workflow-optional-structures-absent` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2674-2759` | shared route gates | `workflow/geometry-route-quality` | endpoint/node/crossing/corridor/arrow/border/rhythm; no numeric threshold claimed | shared inventory below | exact: shared bounds, source constants or authored geometric predicate | endpoint/node always; crossing/corridor/rhythm source showcase; border source profile present; arrowheads schema2 with showcase refusal/standard warning; controls: `gate-workflow-rhythm-standard`, `gate-workflow-border-profile-absent`, `gate-workflow-v1-no-v2-arrows`, `gate-workflow-v2-arrows-standard` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2760-2779` | mainPath node/link/order | `workflow/{main-path-node,main-path-edge,main-path-order}` | all path steps linked and forward; no numeric threshold claimed | E1 workflow.rs; existing generated rejection cases | exact: shared bounds, source constants or authored geometric predicate | always; optional phases/groups/mainPath/card/detail branches require their source members; controls: `gate-workflow-optional-structures-absent` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2782-2799` | label node/pair overlap | `workflow/geometry-label-overlap` | rectsOverlap(label,node-or-label,-2); threshold -2 | new common label-node and label-pair | model-difference: Noto text extents replace legacy heuristic masks | always; optional phases/groups/mainPath/card/detail branches require their source members; controls: `gate-workflow-optional-structures-absent` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2801-2829` | label-route and v1 page/legend containment | `workflow/geometry-route-clearance; workflow/geometry-viewbox-capacity` | label-route4; lane right+16; legendY+18<=page; threshold {"route":4,"lane":16,"legend":18} | shared label-route; existing e2 page/legend cases | exact: shared bounds, source constants or authored geometric predicate | label-route source showcase; fixed lane/legend page checks schema1; shared label page containment schema1 AND source showcase; controls: `gate-workflow-label-route-standard`, `gate-workflow-label-page-standard`, `gate-workflow-v2-auto-height` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:2840-3056` | v2 pre-routing shape/reference/overlap errors | `workflow/{duplicate-id,edge-endpoint,lane-reference,range,geometry-node-overlap}` | source-valid nodes and identities before solve; threshold 8 | E1 for structure; node-overlap existing E2 case | exact: shared bounds, source constants or authored geometric predicate | schema_version=2; readable solver may adjust layout before emitting source/preset/capacity/budget error; controls: `gate-workflow-v1-origin`, `gate-workflow-v1-preset-fields`, `gate-workflow-v1-via-rhythm` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/workflow-compiler.mjs:3803,3878,4258,4606,4639,4836` | v2 feasibility, preset conflict, capacity, bounded solver | `workflow/geometry-route-quality; workflow/geometry-viewbox-capacity` | feasible sides/pins/ranks/lanes/page; finite planning budget; threshold {"direct":28,"stub":8,"turn":16,"laneGap":32} | new preset/channel cases; solver exhaustion is algorithm-dependent, not a source numeric boundary | model-difference: readable-v2 solver/implicit-port geometry; evaluate engine geometry | schema_version=2; readable solver may adjust layout before emitting source/preset/capacity/budget error; controls: `gate-workflow-v1-origin`, `gate-workflow-v1-preset-fields`, `gate-workflow-v1-via-rhythm` | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/workflow/render-workflow.mjs:24-26` | compiled error propagation | `workflow/geometry-route-quality` | compiled.ok false => throw original diagnostics; no numeric threshold claimed | wrapper has no independent geometry predicates | exact: same source quantity/predicate; aggregation adds no independent threshold | compiled.ok is false; exemption: error propagation only; compiler audit supplies the actual gates | schema1 resolves legacy fixed columns/lanes before checks; schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry; schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged |
| `sidecars/archify/renderers/shared/geometry.mjs:388-455` | endpoint-side-direction | `*/geometry-route-quality` | first/final nonzero segment honors declared/inferred side; threshold 0 | new endpoint-orientation plus raw diagonal controls | exact: shared bounds, source constants or authored geometric predicate | always except renderer shouldCheckRelation callback (lifecycle via-array bypass); controls: `gate-lifecycle-via-side-bypass` | No independent adjustment; consume resolved geometry from caller |
| `sidecars/archify/renderers/shared/geometry.mjs:463-522` | edge-through-node | `*/geometry-route-clearance` | unrelated opaque obstacle intersects segment with2px clearance; threshold 2 | new unrelated-node-clearance | exact: shared bounds, source constants or authored geometric predicate | valid referenced endpoints; unrelated opaque obstacles only; source/target exempt; exemption: applicability guard, not a profile/version refusal; exempt source/target is covered by normal endpoint routes | renderer selects opaque obstacles; sequence excludes lifelines, activations and segments |
| `sidecars/archify/renderers/shared/geometry.mjs:607-693` | proper-crossing | `*/geometry-route-quality` | strict interior segment intersection; shared ends/profile exceptions; threshold 0 | new proper-crossing raw pin case; touching control | exact: shared bounds, source constants or authored geometric predicate | effective showcase refuses; standard warning only when caller enables warnInStandard; crossingResolved callback may exempt automatic halo routes; exemption: halo callback requires observing actual planner geometry, not an arbitrary synthetic crossing override; controls: `gate-architecture-crossing-standard`, `gate-dataflow-crossing-standard`, `gate-lifecycle-crossing-standard` | No independent adjustment; consume resolved geometry from caller |
| `sidecars/archify/renderers/shared/geometry.mjs:706-855` | ambiguous-corridor | `*/geometry-route-quality` | collinear overlap >=8; v2 same-style terminal trunk <=24 exempt; threshold {"minimum":8,"trunkMaximum":24} | new corridor7/9 pairs; `workflow-v2-shared-trunk-25` has two raw edges ending the same first via at [169,119] and now refuses on that authored piece | exact shared bounds; v2 first/last via witness ownership is fatal only when distinct raw edges explicitly share that endpoint and the clipped witness ends there; other pieces remain piece-local | showcase refusal; standard only warning for v2 short-trunk mode; shared-endpoint policies and <=24px same-style terminal-trunk exception; controls: `gate-architecture-corridor-standard`, `gate-workflow-v2-corridor-standard` | No independent adjustment; consume resolved geometry from caller |
| `sidecars/archify/renderers/shared/geometry.mjs:788-815` | arrowhead-collision | `*/geometry-route-quality` | same destination/axis/direction, tip distance <3.5*(widthA+widthB); threshold "3.5*(widthA+widthB)" | observed v2 tips288,119 /288,126; widths6/7 and8/7 test marker sums6/8 around7px; C-generated notice policy explicit | exact: shared bounds, source constants or authored geometric predicate | caller selects architecture auto unlabeled-position routes or workflow schema2; standard workflow is warning, showcase refusal; controls: `gate-workflow-v1-no-v2-arrows`, `gate-workflow-v2-arrows-standard` | No independent adjustment; consume resolved geometry from caller |
| `sidecars/archify/renderers/shared/geometry.mjs:876-953` | container-border-run | `*/geometry-route-quality` | positive overlap beyond epsilon on corner-trimmed frame side; threshold 0.0001 | existing seq segment-border; new sequence border-neighbor pair | exact: shared bounds, source constants or authored geometric predicate | effective profile is present; controls: `gate-architecture-border-profile-absent`, `gate-sequence-border-profile-absent`, `gate-dataflow-border-profile-absent` | No independent adjustment; consume resolved geometry from caller |
| `sidecars/archify/renderers/shared/geometry.mjs:1028-1104` | micro/short interior segment | `*/geometry-route-quality` | nonzero segment length <8; interior length <16; threshold {"micro":8,"interior":16} | new 7/9 and15/17 source-via pairs | exact: shared bounds, source constants or authored geometric predicate | effective quality profile=showcase; controls: `gate-architecture-rhythm-standard`, `gate-workflow-rhythm-standard`, `gate-dataflow-rhythm-standard`, `gate-lifecycle-rhythm-standard` | No independent adjustment; consume resolved geometry from caller |
| `sidecars/archify/renderers/shared/geometry.mjs:1108-1153` | label-route-clearance | `*/geometry-route-clearance` | other-route distance <4 (own relation exempt); threshold 4 | new authored label-route3/5 pairs | model-difference: Noto text extents replace legacy heuristic masks | effective quality profile=showcase; controls: `gate-architecture-label-route-standard`, `gate-sequence-label-route-standard`, `gate-dataflow-label-route-standard`, `gate-lifecycle-label-route-standard` | No independent adjustment; consume resolved geometry from caller |
| `sidecars/archify/renderers/shared/geometry.mjs:1179-1259` | label-canvas-containment | `*/geometry-label-viewbox` | label rect overflow >0.5; threshold 0.5 | new label-origin -0.5/+1.5 controls; actual rect extent oracle measured | model-difference: Noto text extents replace legacy heuristic masks | effective quality profile=showcase; readable-v2 uses its separate grow/explicit-origin path; controls: `gate-architecture-label-page-standard`, `gate-sequence-label-page-standard`, `gate-dataflow-label-page-standard`, `gate-lifecycle-label-page-standard` | architecture auto canvas grows around labels; other authored page budgets remain fixed |
| `sidecars/archify/renderers/shared/route-quality.mjs:10-18,494-615` | excessive-route-detour | `*/geometry-route-quality` | ratio>=2.5 AND excess>=200 AND empty>=96; <=80 obstacles; shared outer corridor exemption32; threshold {"ratio":2.5,"excess":200,"empty":96,"obstacles":80,"shared":32} | ratio, excess and serpentine empty95/97 pairs; shared outer-corridor32 exemption requires a separate multi-route witness | exact: shared bounds, source constants or authored geometric predicate | source profile=showcase AND via nonempty; <=80 obstacles; ratio/excess/empty conjunction; related shared outer corridor>=32px exempt; controls: `gate-architecture-detour-standard` | compute shortest obstacle-clearing reference and content bounds after layout |

The clear-margin controls add ten cases, two per family. A dedicated test requires
both actual oracle and engine verdicts to agree on short OK labels with ample
space and 80-character W labels with narrow space; near-threshold differences
remain reported. For the same 20 W string, the stated legacy dataflow primary
heuristic is 124 px, while pinned Noto bold 13 px measures 237.90625 px advance;
at the engine minimum 8 px its measured text width is 146.403846 px (before node padding).
These explanatory numbers are not a legacy capacity predicate in the engine.

The original pre-alignment v2 seed illustrated oracle source port [144,119]
versus engine [216,168]. The current embedded two-node col 0/1 measurement records
actual source [140,119] and target [168,119], with the complete input and node boxes
in the JSON receipt. It does not assert that historical implicit ports match the
new source, or add an oracle-compatible placement solver. Geometry rules use
the engine's own positions. An authored destination side owns an incoming-arrow
face collision; the same side does not invent a collision when the actual tips
are far enough apart.

## Render

### E3 S1 contract

`render-svg` writes deterministic SVG from an E2 `GeometryDocument`, theme,
source title/description and a coordinate-free `SemanticContext`. The context
reads only family/version and per-id node type/lane or frame variant. It never
reads source positions, rows, columns, message times or viewBox coordinates.
`SvgOptions::from_spec` prepares it natively; the isolated WASM request takes
`geometry`, `options` and the matching `specJson` snapshot. The writer does not
place nodes, move glyphs, reroute edges or change geometry admission rules.

A refused layout still renders its retained geometry. SVG `ok:true` means its
artifact matches that scene, not that the input passed layout admission. PNG,
output receipts, the offline viewer and the product switch are separate stages.
No new Tauri command is registered; command isolation stays at 390.

Array order, attribute order and source-id encoding are stable. Coordinates are
exact terminating decimals of signed 1/64px units, with no timestamps, random
ids, locale formatting or unordered traversal. SVG ids namespace and hex-encode
the E2 UTF-8 source ids; node, container, route and `edge:{id}:label` identities
cannot collide with each other or root metadata. Anonymous identities have a
separate ordinal namespace. Route groups retain supplied role/variant tags.

### Semantic projection

Meaning-bearing elements are distinct from styling. Per-kind component fill and
stroke tokens live once in `render/theme.rs`, for light and dark themes; nodes
and corresponding legend swatches use the same token. An opaque node mask keeps
underlaid rails and routes from showing through the translucent kind fill.
Lifecycle kinds alias the component tokens using the pinned type-class mapping.
Component types, route variants and frame kinds retain their distinct semantic
color and pattern mappings in the Maru light/dark theme. Shadow, gradient, icon,
brand-mark, card decoration and interaction behavior remain viewer styling; card
text remains in the retained text geometry. Decorative card dots/icons/brands
remain out of scope under #543.

E3 derives semantic primitives from retained E2 geometry and semantics; it does
not run a second placement model. Sequence lifelines start at participant-box
bottom centres. Their end uses the page footer reserve, clamps above the measured
legend title by 22px when present, stops 22px above a card, and still reaches the
last message, activation or segment. These are explicit layout adaptations for
E2's retained boxes. Existing E2 container boxes supply lanes, exception lanes,
groups, phases, dataflow stages, sequence segments and activation bars. These
retained frames provide standalone grouping geometry; lifecycle v1, for example,
uses the lane records to classify bands even though the pinned SVG draws bands
and states instead of lane rectangles. The workflow phase span follows its
retained phase box centerline. Edge dash meaning is preserved: return 3,5;
security 5,5; dashed 4,4.

Lifecycle initial markers, final double borders, V1 rail and populated band
dividers are rendered separately. The V1 rail comes from the producer's retained
`lifecycleRail` endpoints: (154,157) to (`phaseXs[maxCol]+38`,157). It can point
left for column 0 but must remain nonzero, including a singleton main phase.
V1 band dividers use x=72 through page width minus 72, at y=112, 264 or 436 for
the populated phase, event or outcome band. V2 has no V1 rail/dividers. Two additive,
optional API-v1 node fields preserve semantics that cannot be recovered from
pin-adjusted positions: `finalState` and `phaseOrder`. The lifecycle producer
computes final classification and authored phase ordinal while the source order
is available; SVG never rereads grid coordinates. Old geometry still decodes;
lifecycle rendering asks for a fresh matching layout if these semantics are
missing. Node/route coordinates and glyph positions are unchanged. Lifecycle
scene hashes deliberately change for these fields and the derived final legend.

When lifecycle legend output is nonempty and a final state exists, the producer
appends a derived `final` entry. It does not add `final` to the authorable input
vocabulary. Entries now reserve their leading swatch slot, gap and measured text;
row placement changes deliberately with the corrected footprint.
Symbols precede their labels in explicit E2 leading swatch boxes. The producer
stores separate swatch and text bounds; route samples use their 34px reference
width, and the node/start/final symbols use their family dimensions. E2 measures
label text with the pinned Noto metrics instead of reusing Archify's 0.62-em text
estimate. Legend rows use x=40, 22px inter-item gaps and a minimum 22px row pitch
(long multiline text grows its row) for all families;
sequence legend labels retain E2 sizes of 8px (other families 12px) and weight
400, rather than the renderer's 10px/500 presentation. Headers use pinned 700
rather than 650. E2 has only the reviewed 400/700 metric tables; these font-model
choices are explicit intended changes, not writer fallbacks. Hidden and empty legends have no entries or swatches.

### Per-family semantic coverage

| Family | Pinned semantic element | S1 disposition |
| --- | --- | --- |
| All | Title/subtitle, node/edge/frame text, notes, tags, classifications and optional cards supplied by E2 | Rendered at the supplied boxes, baselines, sizes and glyph positions |
| Architecture | Component rectangles and opaque masks; directed connections and variant patterns; region/security boundary frames; legend | Rendered, including per-kind node/swatch tokens and distinct boundary patterns |
| Workflow | Component nodes; lane and exception-lane frames; phase headers/span lines; group/security-group frames; directed edges, role/variant tags and legend | Rendered from E2 boxes and per-id semantic variants |
| Workflow | Distinct decision/terminal shapes | Not applicable: accepted `WorkflowNode.type` is COMPONENT_TYPES and has no shape vocabulary; pinned `renderNode` is rect rx6. No topology inference or schema expansion |
| Sequence | Participant headers/masks, lifelines, activation bars, segment frames/captions, messages, return/security/dashed styles and legend samples | Rendered. Lifelines start at placed box bottoms; their end respects timeline content, cards, page footer and measured legend-title clearance |
| Dataflow | Component nodes/masks; stage frames; flow paths, line styles, classifications and legend | Rendered; database node and swatch share the same kind token |
| Lifecycle | State rectangles/masks/type tokens; initial dot/stem/head; final double border; lane frames and labels; V1 band dividers and implied rail; transitions and legend | Rendered. Final classification and phase order remain authored semantics under pins |
| Lifecycle V2 | V1 implied rail/dividers | Not applicable, matching the pinned renderer; supplied lane captions remain visible in E2's horizontal glyph layout rather than legacy vertical text |
| Legend | Present/all/hidden selection, labels and semantic symbols, including derived lifecycle final | Rendered from E2's explicit leading swatch and text boxes; wrapping and row footprint use E2's measured label geometry |
| Styling/viewer | Shadows, gradients, brands/icons, animation/focus badges and interaction chrome | Intended change/out of scope under #543; semantic component tokens, shapes/frames, paths, markers, labels and source identities remain |

### Accessibility and font policy

The root is `role="img"` with source-derived `<title>`, `<desc>` and
`aria-labelledby`. Node groups name their text, semantic kind and final status;
containers and directed edges have roles/labels. Label groups retain original
text in `aria-label`, including line separators and unsupported scalars. All
untrusted XML text/attributes are escaped; illegal XML controls are diagnosed.
Source strings never become element names, CSS rules or external URLs.

Mapped scalars use `Noto Sans CJK KR, sans-serif`, weights 400/700, with shaping,
kerning and ligatures disabled and `text-rendering="geometricPrecision"`. Every
scalar has its E2 origin, so the browser cannot invent wrapping or spacing.
S1 does not embed original font binaries or a per-document subset: a subsetter
would add another binary-processing dependency and size surface before S2's
rasterization measurement. Stack-only SVG bytes are deterministic; physical
text fidelity requires the pinned font. Fallback pixels are not claimed to
match E2 metrics. The separate renderer/parser never enters the validation
artifact or its 400,000 B gzip budget.

Unsupported nonignorables draw the actual pinned font glyph-zero outline, never
the original scalar through platform fallback. Default-ignorables paint nothing.
`render/notdef.json` retains source hashes and units-per-em; Linux-only
`diagram-engine-e3-fonts.mjs` and `export-notdef` derive/check it from the same
immutable OTFs as E2. OFL and roxmltree MIT notices are retained and indexed in
`THIRD_PARTY_NOTICES.md`.

The screenshot harness verifies both original OTF hashes and font loading, then
checks browser-parsed selection frames, glyph origins, font size/weight and
scalar advances within 1/64px. Browser `getBBox()` is separately recorded:
[SVG 2 §8.10](https://www.w3.org/TR/SVG2/coords.html#BoundingBoxes) defines text
bounds using full glyph cells, not E2's line/advance-plus-ink frames. Their
measured difference is not used to widen a shared-quantity threshold or create
a new geometry admission rule. Captures prove the intended font was loaded;
they are not native-app proof or byte/pixel comparison with Archify.

### Artifact and determinism gates

Optional roxmltree 0.21.1 independently reparses the artifact. The gate checks
root metadata, namespace, unique identities, counts/ownership/hierarchy per kind,
rectangles, actual route points/width, font/text/glyph data, actual glyph-zero
paths, node/swatch kind-token mapping, and every semantic primitive's geometry,
paint, pattern and complete root paint order (page, frames, underlays, activations,
routes, masks/nodes, legend, overlays and labels). Node masks must precede their
bodies. CSS/reference checks apply only to paint or URL attributes; literal
`@import` or `url(...)` captions remain text. Numeric comparisons allow at most 1/64px and
reject nonfinite values. XML declarations, processing instructions (including
external stylesheets), comments, DTDs, CDATA, unexpected text, scripts, foreign
paint, external references,
unrecognized transforms and unexpected attributes fail with a cause and fix.
The request/artifact limit is 16 MiB. The checker computes route fallback and
primitive expectations independently of the writer. Degenerate projection
fixtures cover a singleton participant with no messages, an empty legend, one
stage, a single main lifecycle state, and tiny final boxes. Cardinalities below
E1 minimums remain refused; those projection tests reduce a DTO at the writer
seam instead of expanding input admission. Transparent label/legend-entry rectangles
are selection frames, not substitutes for the positioned glyph checks.

The four-report `diagram-determinism` workflow retains E2 geometry/refusal hashes
and work ceilings and adds light/dark SVG SHA-256, byte count and artifact gates
for all retained scenes, including `ok:false` layouts. No-geometry records
explicitly carry `svg:null`; the comparator verifies that this agrees with the
retention flag. Native Linux/macOS/Windows and actual WASM must match all fields.
The isolated test facade owns the `wasm-render` artifact; normal JS/WASM exports
exclude SVG/corpus tooling and there is no product export/canvas switch.

### Pinned visual and semantic references

Constants were read as references; no renderer code is imported/copied into the
SDK. E2 geometry and semantic primitives are authoritative. The gate compares
derived SVG primitive kind, owner, shape, paint, stroke, dash, arrow and layer to
an independent reference derivation from the same retained DTO. `gate.rs` also
checks emitted node/frame radii, markers, labels and glyphs. The table records
defaults and derived values so their family/version conditions and source basis
remain reviewable.

| Quantity/meaning | Reference value or rule | Pinned source |
| --- | --- | --- |
| Component type fill/stroke, light/dark | Seven semantic token pairs; lifecycle aliases retain the same mapping | `sidecars/archify/assets/template.html:175-209,218-250`; `sidecars/archify/renderers/lifecycle/render-lifecycle.mjs:175-183` |
| Route stroke default | Explicit E2 width wins; missing width: architecture 1.5px, workflow/sequence/dataflow 1.4px, lifecycle 1.1px; emphasis 1.8px except lifecycle v1 2px and v2 1.6px | E3 writer `render/svg.rs`; independent primitive reference `render/primitive_gate.rs`; Archify architecture `render-architecture.mjs:858`; workflow `workflow-compiler.mjs:4721`; sequence `render-sequence.mjs:447`; dataflow `render-dataflow.mjs:457`; lifecycle `render-lifecycle.mjs:825` |
| Route and frame dash defaults | Route return 3,5; security 5,5; dashed 4,4. Frames: region 8,4; security/exception 4,4; lane/group/stage/segment 6,6; otherwise solid | E3 `render/primitives.rs`; Archify `assets/template.html:4151-4154,4695-4697`; sequence `render-sequence.mjs:24-29,447-448`; workflow `workflow-compiler.mjs:4658-4663` |
| Workflow phase span | Midline of retained phase bounds, x from frame left to right; 1.1px, variant dash/accent | E3 `render/primitives.rs`; Archify `workflow/workflow-compiler.mjs:4666-4672`; artifact gate `render/primitive_gate.rs` |
| Sequence lifeline | Participant center x; starts at box bottom; 0.8px dash3,7; end is page bottom minus65, clamped to measured legend title minus22 and card top minus22, but not above last message/activation/segment | E3 `render/primitives.rs`; Archify `sequence/render-sequence.mjs:92-94,398-406`; artifact gate `render/primitive_gate.rs` |
| Lifecycle initial marker | Dot radius4.5; 1.4px stem, from dot edge to 6px before tip; head extends 7px left and 3.5px above/below tip | E3 `render/primitives.rs`; Archify `lifecycle/render-lifecycle.mjs:850-865`; artifact gate `render/primitive_gate.rs` |
| Lifecycle final border | Final-state box inset is min(3px, quarter of smaller dimension), radius4, stroke1; tiny boxes retain the clamped/possibly zero-size inset as an invalid-but-preserved geometry case | E3 `render/primitives.rs`; Archify `lifecycle/render-lifecycle.mjs:789-790`; artifact gate `render/primitive_gate.rs` |
| Lifecycle v1 bands | Populated bands only; x=72 through page width minus72; y=112 phase, 264 event, 436 outcome; 0.8px dash3,8 | E3 `render/primitives.rs`; Archify `lifecycle/render-lifecycle.mjs:745-756`; artifact gate `render/primitive_gate.rs` |
| Lifecycle v1 rail | Producer DTO endpoints: (154,157) to (`phaseXs[maxCol]+38`,157); arrow, 2.2px; may point left in column0 but endpoints must differ. V2 omits rail and bands | E3 producer `layout/lifecycle.rs`; E3 primitive `render/primitives.rs`; Archify `lifecycle/render-lifecycle.mjs:884-893`; artifact gate `render/primitive_gate.rs` |
| Legend catalog and empty/hidden behavior | Family catalog order; hidden clears entries; final appended only for nonempty lifecycle legend with a final state; empty legend has no bounds/title/swatches | E2 `layout/mod.rs`; Archify sequence catalog `sequence/render-sequence.mjs:24-40`; lifecycle `render-lifecycle.mjs:297-311`; footprint empty case `shared/legend.mjs:75-76` |
| Legend footprint and text | Start x=40 for every family; item and row gaps 22px; route swatch width34/gap9, lifecycle start26 slot/24px drawn width, final16, ordinary node14/gap8; labels measured with Noto metrics. Sequence font8px; other families12px. This intentionally replaces the sidecar's 0.62-em text estimate while preserving the footprint composition | E2 `layout/mod.rs`; Archify `shared/legend.mjs:7-10,55-100`; artifact gate `render/primitive_gate.rs` |
| Legend header | Producer retains the title baseline 20px above the first entry baseline; header has its own Noto 12px/700 label box, entry selection frame excludes it. Default caption Legend, locale ko uses 범례 | Archify `shared/legend.mjs:130-150,194-212`; producer `layout/mod.rs`, independent label/glyph gate |
| Legend symbol bounds | Symbols use explicit leading `swatch_bounds`; each entry must also retain `text_bounds`. Architecture swatch16x10/radius2.5 starts at text baseline minus9; ordinary/start/final paint bounds14x9 (start24x9) begin at baseline minus8; ordinary radius2; route samples sit at baseline minus3 | E2 `layout/mod.rs`; E3 `render/primitives.rs`; Archify architecture `render-architecture.mjs:930`; workflow `workflow-compiler.mjs:4749`; dataflow `render-dataflow.mjs:500-502`; lifecycle `render-lifecycle.mjs:850-865`; artifact gate `render/primitive_gate.rs` |
| Legend placement and insufficient space | Swatch precedes text; a too-small supplied footprint is rejected. Empty/hidden legend contributes no swatches | E3 `render/primitives.rs`; E3 `render/primitive_gate.rs`; Archify `shared/legend.mjs:75-76,117-129,145-154` |
| Container radii and strokes | region12; lane/segment/stage10; group9; security-group/exception-lane8; phase4 backing mask with no stroke; activation3; unknown kind6; ordinary frame stroke1 | E3 `render/svg.rs`; Archify workflow `workflow-compiler.mjs:4658-4685,4670-4672`; sequence `render-sequence.mjs:391,410`; dataflow `render-dataflow.mjs:417` |
| Node rectangles | lifecycle radius7; other families radius6; 1.5px stroke; masks are opaque and have no stroke | E3 `render/svg.rs`; Archify architecture `render-architecture.mjs:898-901`; lifecycle `render-lifecycle.mjs:801-804`; artifact gate `render/gate.rs` |
| Legend frame/content bounds | No visible enclosing legend frame. E2 retains legacy `legend.bounds` for layout budgeting and an optional invisible `contentBounds` over title, entries, swatches and text, inflated by8px for paint/arrowhead clearance | E2 `layout/mod.rs`; Archify `shared/legend.mjs:194-216`; E3 `render/svg.rs`; legend gate `render/legend_gate.rs` |
| Arrow marker | 10x7, ref(9,3.5), triangle (0,0),(10,3.5),(0,7); units follow stroke width | E3 `render/svg.rs`; Archify `shared/utils.mjs:14-25`; artifact gate `render/gate.rs` |
| Route width and glyph0 scale | Route supplied width is retained; absent width uses the family/version defaults above. Replaced glyph outline scale is font size divided by pinned units-per-em | E3 `render/svg.rs`; artifact gates `render/gate.rs`, `render/primitive_gate.rs` |
| Labels and glyphs | E2 font identity, weight, size, positions and input scalars are emitted directly. Route primary lines use effective variant color, route details use muted color, workflow/architecture frame captions use frame accents, and node tags use node-kind tokens; other labels use weight-based text/muted defaults | E3 `render/label_paint.rs`; Archify architecture `render-architecture.mjs:872-901`, workflow `workflow-compiler.mjs:4660-4686,4704-4715,4727-4735`, sequence `render-sequence.mjs:434-450`, dataflow `render-dataflow.mjs:436-450,461-471`, lifecycle `render-lifecycle.mjs:774-804,836-847`; artifact gate `render/gate.rs` |
| Accessibility fallbacks | Missing node label text falls back to target id; missing semantic caption kind falls back to `node`; these values affect aria labels only. Required semantic records fail context validation | E3 `render/primitives.rs`; `render/mod.rs`; `render/primitives.rs` |
| Empty sequence content fallback | No route/frame timeline extent uses 0; final lifeline end is still clamped to at least each participant bottom. No nodes means no lifeline primitives | E3 `render/primitives.rs`; independent artifact expectation `render/primitive_gate.rs` |
| SVG metadata defaults | Absent title/description use `Diagram` / `Diagram geometry`; these are accessible metadata, not geometry. SVG string-write `unwrap` calls are infallible `String` writes; semantic `expect` calls rely on the context gate | E3 `render/mod.rs`; `render/svg.rs`; `render/primitives.rs` |
| Complete paint ordering | Background before frames, semantic underlays before activation bars/routes/nodes, masks before node bodies, legend/overlays before label glyphs; semantic primitives retain relative ordering too | Writer projection contract; independent artifact gate `render/primitive_gate.rs::check_paint_order`, mutation tests `tests/svg_paint_order.rs`; source sequence lifelines/activations `sequence/render-sequence.mjs:398-410` |
| Artifact gate empty/default handling | Missing route points parse as empty and fail expected point checks; missing text nodes count as empty; absent expected primitive counts are zero. These are checker defaults, not output defaults | E3 `render/gate.rs`; `render/primitive_gate.rs` |

### Effective values and fallback audit

The rules below cover every accepted renderer fallback over `variant`, `type`,
`kind`, style and width. `||`/`??` defensive paths for malformed input are not
accepted semantic fallbacks: family schemas reject those values, and E3 either
fails closed or applies the documented output-safe fallback. Source coordinate
layout remains outside the SVG writer; it consumes E2 boxes, routes, labels,
swatches and retained semantics.

| Effective value or fallback chain | Family and branch | Pinned source and E3 rule | Gate/disposition |
| --- | --- | --- | --- |
| Arrow class: authored variant or `default`, then class-map `default` if key is unknown | Architecture connections; workflow phase/edge; sequence message; dataflow flow; lifecycle transition | Archify map `shared/geometry.mjs:1784-1789`; call sites architecture `render-architecture.mjs:856`, workflow `workflow-compiler.mjs:4669,4719`, sequence `render-sequence.mjs:446`, dataflow `render-dataflow.mjs:455`, lifecycle `render-lifecycle.mjs:811-828`. Missing route variant yields default in E3; lifecycle E2 routes retain the effective value from the producer. | Valid variants are schema-limited (`common.rs:17`, `sequence.rs:19`). Missing-variant is an accepted default branch; unknown-variant is invalid source and fails E1 enum validation. `tests/svg_fallback_admission.rs` covers all-family rejection and accepted default/variant branches. |
| Lifecycle effective transition variant: explicit variant wins; otherwise only v2 forward main-lane edge -> emphasis; remaining v1/v2 edges -> default | Lifecycle v1/v2 | Archify inference applies only in v2 (`lifecycle/render-lifecycle.mjs:811-819`); E2 producer `layout/lifecycle.rs`; E3 raw authored override retained at `render/semantics.rs`. E2 retains `phaseOrder` for main states in both versions, but does not infer v1 route emphasis. | E3 independent reference derives from raw override + lane/order (`render/gate.rs`). `tests/svg_effective_lifecycle.rs` covers explicit/implicit, pin/no-pin, v1/v2 and tamper rejection. |
| Route stroke/marker color: emphasis token; security token; dashed/database token; otherwise default arrow token | All five families; sequence `return` uses default arrow color/marker plus return dash | Archify classes `shared/geometry.mjs:1784-1808`, CSS `assets/template.html:4150-4160`; E3 `render/svg.rs`. Emphasis is 1.8px except lifecycle v1 2px/v2 1.6px; ordinary architecture 1.5px, workflow/sequence/dataflow 1.4px, lifecycle 1.1px. | `render/gate.rs` independently checks route marker/color/dash/width. `tests/svg_semantic_styles.rs` covers accepted security/dashed route and phase paint in both themes; invalid variants are rejected as above. |
| Route width: explicit positive width, else family/version/variant default | Architecture, workflow, sequence, dataflow, lifecycle | Archify architecture `render-architecture.mjs:858`; workflow `workflow-compiler.mjs:4721`; sequence `render-sequence.mjs:447`; dataflow `render-dataflow.mjs:457`; lifecycle `render-lifecycle.mjs:825`. E3 `render/svg.rs` applies the same defaults to retained geometry. | Independent width expectation `render/gate.rs`. Zero-width is schema-invalid (relationship width minimum0.5 in `common.schema.json:59`); test zero only at malformed-input seam if needed. |
| Node kind paint: `componentFill[type]`/`componentText[type]`, else external/muted | Architecture, workflow, sequence participants, dataflow; ordinary/fallback lifecycle state type maps to neutral/external | Archify architecture `render-architecture.mjs:882-883`; workflow `workflow-compiler.mjs:4690-4691`; sequence `render-sequence.mjs:376`; dataflow `render-dataflow.mjs:422-423`; lifecycle `render-lifecycle.mjs:175-195,760-761`. E3 theme aliases lifecycle kinds to the same component token pairs (`render/theme.rs`). | Accepted component/state enums are restricted to mapped kinds (`common.rs:8-17`; sequence `sequence.rs:10-19`; lifecycle `lifecycle.rs:9-11`). `tests/svg_fallback_admission.rs` rejects unknown types across all five families; E3 also rejects unknown theme kinds in `render/primitives.rs`. External/neutral fallback is malformed-input defense, not accepted-output parity. |
| Legend swatch kind: mapped component/state token, else external | Architecture, workflow, lifecycle; dataflow database uses its component token | Archify architecture `render-architecture.mjs:930`, workflow `workflow-compiler.mjs:4749`, lifecycle `render-lifecycle.mjs:865`; E3 uses the same theme mapping and explicit leading `swatch_bounds` (`render/primitives.rs`). | Legend kind is validated before paint; unsupported-kind fallback is invalid-input only. `render/primitive_gate.rs` checks primitive identity, kind paint and bounds. |
| Sequence activation kind: known explicit activation type, else known participant type, else external | Sequence activation bar and its mask/body | Archify `sequence/render-sequence.mjs:421-427`; E3 `activation_kind` uses the same ordered fallback (`render/svg.rs`) and paints mask before kind body (`:435-457`). | Explicit type and absent-type/participant fallback are accepted branches (`tests/svg_activation_kinds.rs`). Invalid activation values are direct-context seam cases only (`:103-139`). Missing semantic activation record fails closed (`render/gate.rs`). |
| Structural frame kind/variant paint | Architecture region/security-group; workflow lane, exception-lane, group/security-group, phase; sequence segment; dataflow stage; lifecycle retained lanes/cards | Archify architecture `render-architecture.mjs:841-844`; workflow `workflow-compiler.mjs:4657-4686`; sequence `render-sequence.mjs:409-417`; dataflow `render-dataflow.mjs:414-418`; lifecycle v1 bands and state output `render-lifecycle.mjs:736-756,896-926`. E3 frame style resolves region/security/exception/security-group explicitly, then ordinary lane treatment for other retained grouping frames (`render/theme.rs`); frame dash is independently derived in `render/primitives.rs`. | Frame paint/dash checks in `render/gate.rs`. Workflow phase uses source `c-mask` fill with no stroke behind the variant-colored span (`workflow-compiler.mjs:4666-4672`); E3 paints the retained phase box as that mask treatment. Lifecycle lane/card/group rectangles are deliberate standalone grouping adaptations. Unknown-frame lane fallback is a malformed-DTO seam (`tests/svg_semantic_styles.rs`); accepted frame kinds are enumerated. |
| Route-label color: primary label lines follow effective route variant; secondary lines/notes use muted; default and sequence return retain default/muted colors | Architecture, workflow, sequence, dataflow, lifecycle | Archify architecture `render-architecture.mjs:872-878`; workflow `workflow-compiler.mjs:4727-4735`; sequence `render-sequence.mjs:434-441`; dataflow `render-dataflow.mjs:461-471`; lifecycle `render-lifecycle.mjs:836-847`. E3 retains effective route override, route identity and primary line count in `render/semantics.rs`; independent color mapping lives in `render/label_paint.rs`. | `render/gate.rs` compares glyph colors against the independent label paint derivation. Existing fixture coverage: `tests/svg_label_accents.rs`. Label color does not alter E2 glyph positions or font metrics. |
| Frame-caption color: semantic exception/security/emphasis/dashed accent, otherwise muted | Workflow lane/phase/group captions; architecture region/security boundary captions | Archify workflow `workflow-compiler.mjs:4660-4672,4682-4686`; architecture boundary labels `render-architecture.mjs:841-844`. E3 label paint derives by frame identity and variant in `render/label_paint.rs`. | Checked per glyph through `render/gate.rs`; variant/default label branches are exercised in `tests/svg_label_accents.rs`. |
| Node-tag color: node/state kind text token | Architecture, workflow, dataflow, lifecycle; sequence has no node tag field | Archify architecture `render-architecture.mjs:890-892`; workflow `workflow-compiler.mjs:4704-4705`; dataflow `render-dataflow.mjs:436-437`; lifecycle `render-lifecycle.mjs:774-775`. E3 maps label id `node:{id}:tag` back to its semantic kind in `render/label_paint.rs` and its independent reference paint path. | Artifact gate compares per-glyph colors. Existing kind-token label fixture: `tests/svg_label_identity.rs`; this is an accent token, while tag text/geometry remain E2-supplied. |
| Lifecycle node dimensions/offsets: explicit positive width/height, else v1 lane-specific dimensions or v2 140x64; missing/falsy offset -> 0 in reference | Lifecycle v1/v2 | Archify `lifecycle/render-lifecycle.mjs:91-98,206-227`; E2 resolves missing values before emitting boxes (`layout/lifecycle.rs`). | Accepted schema minima width48/height36 (`lifecycle.schema.json:182-189`), so zero/falsy dimension fallback is invalid-input defense only. E3 writer consumes retained node bounds. |
| Caption fallback: semantic label, then target id; missing semantic kind -> `node` | Accessibility group label only; no visual glyph/text change | E3 `render/primitives.rs`; `render/mod.rs`. Required source semantic nodes/types are otherwise rejected (`render/primitives.rs`). | `render/gate.rs` independently reconstructs node captions. Missing label/kind fallback is accessibility-only; required metadata mismatch fails. |
| Legend kind/label: present/all/hidden selection; per-key label override, else key; derived lifecycle `final` only when visible entries exist and a final state exists | All families | E2 catalog resolution and label fallback `layout/mod.rs`; Archify family catalogs, e.g. sequence `render-sequence.mjs:24-40`, lifecycle `render-lifecycle.mjs:291-311`, and empty footprint `shared/legend.mjs:75-76`. | E2 retains explicit leading `swatch_bounds`, `text_bounds`, `title_y`, `content_bounds`; writer rejects missing per-entry bounds. Hidden/empty means no visible swatches. `legend.bounds` stays in the old layout budget; `content_bounds` is invisible paint coverage only. |
| Node/route widths, text boxes and layout sizes | Explicit source value, else family default where accepted; width-style fallbacks above | Archify workflow node width `workflow-compiler.mjs:942`; dataflow node width `render-dataflow.mjs:95`; lifecycle dimensions `render-lifecycle.mjs:212-227`; sequence message label width `render-sequence.mjs:430-440`. | Layout resolves accepted defaults before E3. `||` treating zero as absent is not an accepted-input branch where schemas require positive dimensions (`lifecycle.schema.json:182-189`; `common.schema.json:59`). Explicit route widths >=0.5 are covered by `tests/svg_route_widths.rs`; no zero-width acceptance is claimed. |

### Rendered elements and deliberate omissions

| Element | Current projection and reference | Disposition |
| --- | --- | --- |
| `legend.bounds` and `content_bounds` | No SVG rectangle is emitted for either. The legacy bounds continue to budget the existing page; `content_bounds` encloses title, entries, text and swatch paint with an 8px reserve (`layout/mod.rs`; `svg.rs:333-345`). | `content_bounds` is invisible geometry for artifact containment. Do not restore the visible rounded legend frame. |
| `label-bounds` and `legend-entry-box` | Transparent, no-stroke rectangles retain E2 selection geometry (`svg.rs:535-549,565-573`). | Invisible accessibility/selection metadata; expected by the SVG artifact gate. |
| `node-mask` and `activation-mask` | Opaque masks precede the kind-painted node/activation body (`svg.rs:435-457,515-534`). | Required visual behavior; source node and activation masks are retained. |
| Lifecycle lane, card and other retained grouping frames | E2-supplied containers remain read-only geometry; the SVG projects them as standalone frames even where the sidecar presents a band, external card, or grouping outside the SVG. | Intentional standalone grouping adaptation; no source-coordinate lookup or repositioning in the writer. The lifecycle v1 source band still has no lane rectangle (`render-lifecycle.mjs:736-756,896-926`). |
| Background | E3 emits a solid theme page rect (`svg.rs:384-387`); each family renderer uses its background grid (`architecture/render-architecture.mjs:948-954`; workflow `workflow-compiler.mjs:4761-4780`; sequence `render-sequence.mjs:487-492`; dataflow `render-dataflow.mjs:511-516`; lifecycle `render-lifecycle.mjs:902-907`). | Intentional standalone theme background instead of the sidecar grid. |
| Cards and decorative marks | Retained card text remains in the text geometry. Card dots, icons, brands, sigils, shadows, animation and interaction chrome are not painted by E3. | Decorative omissions remain out of scope under #543; do not claim card decoration fidelity. |
| Unsupported glyphs | E3 draws a `.notdef` outline generated from the pinned font (`svg.rs:591-608`) rather than asking the platform fallback font. | Intentional deterministic unsupported-scalar behavior; glyph size uses pinned font units-per-em. |
| Lifecycle v1/v2 band and rail | E3 renders v1 populated bands and producer-supplied rail; v2 omits both. | Matches the pinned version behavior; E2 lane containers remain separately available for standalone grouping. |

### Reviewed geometry limitation

The ten captures retain E2 geometry. Workflow/dataflow subtitle frames overlap
lane/stage captions before SVG serialization; [#561](https://github.com/STAIxBWLB/maru/issues/561)
tracks the source placement gap as an E4 blocker. S1 does not hide labels or add
coordinate overrides, as agreed. #560's label-capacity role correction remains
out of scope. The captures are reviewed projections, not acceptance of these
source layouts for the product switch. Source-bound verification and screenshot
hashes are recorded with the PR; hosted agreement and native results remain
separate from a remote Linux reproduction.
