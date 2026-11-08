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
10 px tags; relationship/legend text is 12 px, frame titles 13 px and the document
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
