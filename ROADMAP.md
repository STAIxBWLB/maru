# Maru Roadmap — Phase 3~8 (W1–W34+)

> **Mission** — Bring 사업단(business unit) + 대학본부조직(university headquarters) document operations into one Maru desktop workspace. The roadmap is a redefinition of Phase 3 and beyond into a **7-module** decomposition with weekly deliverables.
>
> **Status maru** — Updated through the desk-automation track on 2026-08-01. Phases 0–5 through W14, Diagram mode, Graph mode 8a/8b/8c, and the desk-automation side track (§9) are implemented. W15–W26 remain planned. See README's Status table for the canonical state column and CHANGELOG.md for release history; this file is the deeper "what's next + how to continue" reference.
>
> **Spec sources** — All design decisions trace back to `~/workspace/work/_meta/rules/{frontmatter-schema,document-lifecycle,hub-contract,evidence-policy}.md` (formerly `_sys/rules`, with `bu-lifecycle`→`document-lifecycle` and `hub-sync`→`hub-contract`). The work-repo-internal 26-week plan file it was mirrored from has since been consolidated; this file is the live Maru-side reference.

## 1. The 7-module decomposition

Each module is owned by Maru desktop. Hub backs them where shared catalog data is needed; spec details for the Hub side are in `dev/maru-hub/ROADMAP.md`.

| # | Module | Purpose | Surface | Owners |
|---|--------|---------|---------|--------|
| M1 | Operations Catalog | "What needs my attention right now" — deadlines, in-flight approvals, unlinked evidence, inbox pending | Activity-rail `LayoutGrid` mode → 3-column pane | ✅ shipped |
| M2 | Document Studio | 7-step authoring wizard (source → template → guideline → sections → HWP fields → export → package) replacing ad-hoc dialog | `Studio` mode | ✅ W12 shipped |
| M3 | Template / Form Filling | Unified template catalog (workspace + `_meta/templates` + project `_templates` + hwpx skill + Hub) with `.hwpx` placeholder fill + binary `.hwp → .hwpx` conversion | Studio Step 2 + 5 | 🚧 HWPX slot/fill shipped · `.hwp` conversion manual fallback |
| M4 | Export Pipeline | Markdown SSOT → docx / hwpx / pdf with sha256 manifest + converter dispatch + format-specific validators | `export_*` Tauri commands + palette | ✅ W8-W10 shipped · lightweight validators shipped · richer validators planned |
| M5 | Evidence Binder | Bind evidence (originals + extracted text + summary + verification) to doc sections / KPIs / submission checklist | Right pane Evidence tab | ✅ W14 implemented · W15 planned |
| M6 | Deck Studio | gpt-images-deck wizard with 14-style catalog, image-mode × production-mode matrix, job artifacts | New `Decks` mode (W17+) | 📋 planned |
| M7 | Hub Connector | Read shared context (templates / guidelines / glossary / evidence index / KPI status / **finalized documents**) + create submission gates + **finalize approved documents to Hub** (markdown body + rendered artifacts + evidence binaries) | Background + `Hub` commands | ✅ read shipped (W4) · Hub sync API shipped · ⏳ Maru sync caller · ⏳ finalize write (P6 W21) |

## 2. Week-by-week deliverables

Legend — ✅ shipped · 🚧 in progress · 📋 planned · ⏳ awaiting upstream

### Phase 3 — Unified Document Operations (W1–W6)

| W | Status | Deliverable | Critical files |
|---|--------|-------------|----------------|
| W1 | ✅ | Rule SSOTs (`frontmatter-schema`, `bu-lifecycle`, `hub-sync`, `evidence-policy`) + Rust `ops_catalog` + `hub_client` scaffolds + 4 BU seeds | `src-tauri/src/{ops_catalog,hub_client}/*` |
| W2 | ✅ | Hub catalog REST × 9 + Alembic 0001_core + 21-template seed + 12 pytest | `dev/maru-hub/src/maru_hub/api/routes/catalog.py` |
| W3 | ✅ | `ops_catalog::scan` real indexing (BU configs / inbox manifests / tasks / md frontmatter / evidence binaries) + Catalog mode UI | `src-tauri/src/ops_catalog/scan.rs` · `src/components/catalog/CatalogPane.tsx` |
| W4 | ✅ | notify fs watcher (debounced `catalog://refresh`) + Hub HTTP fetch (ETag + offline fallback) + drilldown dialog + Reveal-in-Finder + real-workspace gate (110 entries / 986 ms) | `src-tauri/src/ops_catalog/watcher.rs` · `src-tauri/src/hub_client/http.rs` |
| W5 | ✅ | `lib/hubLibrary.ts` typed fetchers + `NewDocumentDialog` Hub template/guideline pickers + 2 new palette commands | `src/lib/hubLibrary.ts` · `src/components/NewDocumentDialog.tsx` |
| W6 | ✅ | `WritingGuidelineSidebar` (right-pane BookOpen tab) parsing frontmatter `guideline_ids` + legacy provenance trailer | `src/components/catalog/WritingGuidelineSidebar.tsx` |

### Phase 4 — Document Edit Mode (W7–W12)

| W | Status | Deliverable | Critical files |
|---|--------|-------------|----------------|
| W7 | ✅ | `create_document` `CreateDocumentExtras` frontmatter prefill (template_id / template_slug / template_version / business_unit / program_id / guideline_ids) replacing W5 HTML trailer | `src-tauri/src/document.rs` · `src/lib/api.ts` |
| W8 | ✅ | M4 Export Pipeline scaffold — `export/{manifest,validate}.rs` + `export_plan / _manifest_load / _validate` + manifest.yaml schema with sha256 round-trip | `src-tauri/src/export/*` · `src/lib/export.ts` |
| W9 | ✅ | M4 transitions — `record_output_{pending,success,failure}` + `export_record_*` Tauri commands + `Validate last export bundle` palette + `summarizeValidation` | same module as W8 |
| W10 | ✅ | **Export bundle dispatch** — single "Export bundle" command drives `pending → ready/failed` from the manifest. Current implementation uses deterministic local converter commands (`pandoc`, `hwpx`, LibreOffice-backed PDF fallback) and records success/failure through the W9 manifest transitions. Missing converters, missing outputs, and source hash drift surface as partial failures instead of silent success. Background mission wrapping remains optional hardening. | `src-tauri/src/export/dispatch.rs` · `src/lib/export.ts` · `src/App.tsx` |
| W11 | ✅ | **Document Studio multi-step wizard (M2)** — new `Studio` activity-rail mode. 7 steps under `src/components/studio/StudioMode.tsx`: source picker, template picker (reuse `lib/hubLibrary`), guideline picker, section editor (Rich/Source modes), HWP field map placeholder state, export (wraps `export_plan` + dispatch), package (local body apply + version snapshot freeze). State persists at `<workspace>/.maru/studio/<doc-id>/state.json` via `src-tauri/src/studio/mod.rs`, and `studio_apply_body` preserves frontmatter bytes while replacing only the markdown body. | `src-tauri/src/studio/*` · `src/components/studio/*` · `src/App.tsx` activity-rail wiring |
| W12 | ✅ | **HWP field map (M3) + 개조식 inline lint (M2 Step 4)** — `hwpx slots` extracts `{{field}}` placeholders from bundled/workspace HWPX templates; `kordoc_lite` adds HWPX structure checks, Korean public-form label/inline-label detection, preserved XML fill for label-value fields, and docx/hwpx/pdf export structure checks. Step 4 runs debounced `gaejosik_lint`, underlines violations via CodeMirror decorations and BlockNote custom marks, and stores dismissals under workspace-state `composer.lintDismissals` with per-document Studio fallback. | `src-tauri/src/{template_fill,kordoc_lite}.rs` · `src-tauri/src/export/validate.rs` · `src-tauri/src/linter/gaejosik.rs` · `src/components/studio/*` |

### Phase 5 — Evidence Binder + Deck Studio (W13–W18)

| W | Module | Deliverable |
|---|--------|-------------|
| W13 | ✅ M5 | Right-pane Evidence Binder tab + `<workspace>/.maru/binder/<doc-id>.json` state. Auto-pulls inbox-processed attachments + `<binary>.evidence.yaml` sidecars under the active doc's BU, then uses `kordoc_lite` for local format detection and HWPX/form preview metadata. |
| W14 | ✅ M5 | Local Binder schema v2 with section / KPI / submission-checklist free-entry targets and live heading/task/HWP label suggestions. Full binary sha256 identity is computed on bind; mutations are revision-guarded and atomic. Structural validation, typed sidecar status, local verification, and submission selection remain distinct. No document frontmatter or Hub writes. |
| W15 | M5 | Hub `evidence_index` integration — sha256 lookup ("이미 검증됨" hint), `evidence_index.suggest_reuse` palette command, and metadata-only kordoc_lite detection fields. Maru still owns the binary; only sha256 + metadata flow to Hub. |
| W16 | M6 | Deck Studio mode + Plan step (Claude proposal → `slide_plan.json`) + 14-style catalog browser reading `dev/maru/skills/docs/slide-decks/*.md`. |
| W17 | M6 | Generate step matrix — `imageMode` radio (codex-native / provider / html-css) × `productionMode` checkboxes (image-folder / html-deck / pptx-from-images / pdf-export). Job artifact directory `projects/.../05-decks/<slug>/`. |
| W18 | M6 | Per-page regenerate, drag-and-drop reorder, manifest.yaml hashing of every emitted page + final PPTX / PDF. |

### Phase 6 — Approval workflow + Finalize to Hub (W19–W22)

| W | Module | Deliverable |
|---|--------|-------------|
| W19 | M7 + M2 | Maru Studio Step 7 emits `hub_submit_gate` (the existing W4 stub) with all safety pre-flights. `submission_gate_id` and `status: submitted` written back to the source markdown's frontmatter. |
| W20 | M7 | Hub polling for gate state changes; `frontmatter.status` auto-advances `submitted → received → approved/rejected` as Hub state matures. |
| W21 | M2 + M7 + M4 + M5 | Approval drawer in Maru — right pane shows `approval` block from frontmatter; per-step sign-off button posts to Hub `approval_routes/<id>/actions`. **Finalize step**: the moment a route transitions to `approved`, Maru auto-calls `POST /api/v1/documents/{id}/finalize` carrying the markdown body, every rendered artifact in the M4 manifest (docx/hwpx/pdf), and the binary bytes of every evidence file linked via `frontmatter.evidence_links`. On `201` response, frontmatter `status` flips to `archived-hub:<finalized_id>@v<N>` and future edits create a new local file that, when re-approved, will become version N+1 on Hub. |
| W22 | M2 + M7 | Status board mode (Kanban-style: draft / review / approval / archived) over the Catalog index, filtered by active BU. **New**: Hub Finalized tab inside `Catalog` mode — published version timeline + per-artifact download (via `GET /finalized-documents/{id}/artifacts/{format}`) + audit chain viewer. |

### Phase 7 — Certification & KPI bundle (W23–W26)

| W | Module | Deliverable |
|---|--------|-------------|
| W23 | M5 + Hub | Certification Vault mode reads Hub `certifications` + `certification_requirements`; checklists auto-bound to existing doc / evidence by document_type + business_unit. |
| W24 | M5 | `Cert: Bind evidence to item` + missing-requirement detection in Maru UI. |
| W25 | M5 | KPI Composer pulls Hub `kpi_snapshots` + generates a 개조식 narrative md with evidence references. |
| W26 | M5 + Hub | `certification.bundle.create` proposal → Maru downloads + presents the PDF bundle (cover + per-requirement section + KPI charts + evidence pages). The bundle is assembled by Hub directly from `finalized_documents` + `finalized_document_artifact` + `evidence_blobs` — **no Maru binary push is needed at bundle time** (everything was pushed at Phase 6 W21 finalize). Phase 3-7 verification gate. |

## 3. Verification matrix

| Surface | Required gate |
|---------|---------------|
| Rust | `cargo test --lib`; Binder changes also run the focused `evidence_binder` tests |
| Frontend | `pnpm test`, `pnpm typecheck`, and `pnpm lint:i18n` |
| Browser | `pnpm test:e2e`; Binder coverage exercises bind, targets, undo, local verification, submission selection, and unbind |
| Package | `pnpm build` plus the bundle-budget check included by that command |
| Milestone | `make verify`, the real-workspace catalog smoke, and the relevant live integration procedure |

## 4. Conventions to keep

1. **Frontmatter byte-identity** — every Maru write that mutates a YAML field must preserve unrelated fields, comments, ordering, and quoting. `src-tauri/src/frontmatter/ops.rs` is the only allowed code path.
2. **Skill dispatch is proposal-only** — every Hub-write MCP tool and every multi-step automation passes through the `proposal_queue` table (Hub) or the `approval.rs` gate (Maru). No silent destructive operations.
3. **Cache surfaces are disposable** — `<workspace>/.maru/cache/*`, `.maru/runs/*`, `.maru/queue/*`, `.maru/studio/*`, `.maru/certification/*` are gitignored runtime data; never write canonical state there.
4. **Hub holds bodies only for approved documents.** Drafts stay under `~/workspace/work/` (Maru = author SSOT). The Maru → Hub write path is two-stage: `POST /documents/sync` (metadata snapshot, planned M7 caller) for any draft and `POST /documents/{id}/finalize` (markdown body + rendered artifacts + linked evidence binaries, Phase 6 W21) after the approval route closes. W21 must add the matching `hub_client/safety.rs` pre-flight so finalize is the only Maru client path that may carry bodies/binaries, and only when the corresponding `submission_gate` state is `approved`.
5. **Private deployment is the product path.** Public/demo compatibility may remain in config and synthetic fixtures, but glossary scrubbing and real-name CI regex gates are not deployment logic.
6. **Korean filenames** — workspace path components stay in ASCII to avoid macOS NFD breakage. Templates handle Korean content; the file name doesn't.

## 5. Continuing work — concrete next steps

> **Note (2026-07-25):** git ran ahead of the linear W-plan. Phase 8 graph
> mode (8a/8b/8c) and the M0 rename shipped before the remaining Phase 5
> work. W14 is now implemented; W15 is the next backbone item.

### Immediate (W15 entry)

```
# branch: fresh feat/evidence-index-w15 off main
src-tauri/src/evidence_binder.rs         # expose full-sha lookup inputs
src-tauri/src/hub_client/*               # metadata-only evidence_index lookup
src/components/evidence/*                # verified/reuse hints
src/lib/evidenceBinder.ts                # Hub hint UI model
```

W10 follow-up hardening, if needed before Studio:
- Wrap converter runs in mission state when conversion duration becomes user-visible.
- Extend the W12 lightweight structure checks toward richer PDF font/embed checks if submission gates require it.
- Add an optional right-pane export progress surface; keep the palette command as the primary entrypoint.

### W12 shipped notes

- `template_get_fields` calls the bundled/user `hwpx` skill subprocess (`hwpx slots <template_path> --format json`) and normalizes slot keys for Studio field values.
- `template_get_fields` merges `hwpx slots` placeholders with `kordoc_lite` HWPX label/inline-label detection; field metadata includes source and confidence.
- `template_fill_hwpx` writes filled artifacts to `.maru/studio/filled/` by default, preserves form-label fills through `kordoc_lite`, and validates the result with both `hwpx validate` and lightweight structure checks.
- `gaejosik_lint` is deterministic and dismissal-aware; the UI uses a 350 ms debounce, CodeMirror decorations for source mode, and a BlockNote `gaejosikLint` mark for rich mode.

### W13 shipped notes

- `evidence_binder_read` and revision-guarded `evidence_binder_mutate` persist document-scoped state at `<workspace>/.maru/binder/<doc-id>.json`.
- Evidence candidates are seeded from processed inbox raw files and `<binary>.evidence.yaml` sidecars, with sidecar scanning scoped to the active document's BU root when available.
- Candidate metadata includes `kordoc_lite` format detection, lightweight structure checks, and HWPX field preview labels.

### W14 implemented notes

- Schema-v1 states migrate in memory and persist as v2 on the first mutation; old auto-derived verification is intentionally reset.
- Full binary sha256 is computed lazily on bind and becomes the stable binding identity. Candidate discovery does not hash all files.
- Section / KPI / submission-checklist targets stay in local Binder state. Suggestions come from the live draft's headings/tasks and HWP field labels.
- Structural checks, sidecar canonical status, local verification, and submission selection are separate states with guarded transitions.
- Maru-owned rename/move operations rekey path-derived document identities while preserving frontmatter-derived stable IDs.
- Binaries, document frontmatter, and Hub remain untouched. W15 may send only sha256 plus metadata.

## 6. Cross-cutting hand-off notes

- **Maru MCP sidecar** (`sidecars/maru-mcp/`, Phase 3+) lives outside this branch but is referenced by every M7 surface. Don't add new MCP tools without a matching `proposal_queue` row on the Hub side.
- **`workspace.config.yaml`** carries the `hub:` block (endpoint / token ref / scope / do_not_upload) and `bu_lifecycle:` block. New runtime knobs go there, not into `~/.maru/settings.json`.
- **Skill registry** lives at `~/.maru/skills/registry.json`; Maru reads via `skill_host::list_skills`. New built-in skills get embedded under `skills/` and materialized into `~/.maru/skills/_builtin/` at runtime.
- **Real-workspace verification** — every milestone repeats the W4 gate (`MARU_CATALOG_BENCH_WORKSPACE=~/workspace/work cargo test --lib -- --ignored catalog_real_workspace_smoke`) plus the live-Hub procedure in README §"Live-Hub verification".

## 6.5 Concept-map Diagram mode (side track, shipped)

Outside the M1–M7 backbone, a self-contained **Diagram** mode ships alongside Phase 5. It adapts the standalone 14k-line concept-map editor from `~/workspace/work/inbox/drop/kakao/concept-map-diagram.html` into a first-class Maru mode while fixing the source's tech debt (broken `localhost:5500` autosave, 14 `localStorage` namespaces, native `prompt/confirm/alert`, no a11y, no touch). A 2026-05-27 hardening pass closed the audit gaps: command-palette routing, workspace-keyed state, persisted `diagram.lastDocument`, Radix confirmations, selected-path export, lock/hide enforcement, filled ribbon tabs, and Diagram e2e coverage.

| Phase | State | Outcome |
|-------|-------|---------|
| 0 — Scaffold | ✅ | `MaruAppMode = "diagram"` + feature flag + Zustand-style store + i18n ko/en stubs + stub Rust commands. |
| 1 — Canvas + persistence | ✅ | Pointer-drag canvas, simple/text nodes, undo/redo with 500 ms coalesce, save/load to `<workspace>/diagrams/<name>.cmd.json` (v:7), saved-list aside, workspace-keyed unsaved store/session, and `diagram.lastDocument` restore. |
| 2 — Edges + 13 kinds + smart guides | ✅ | 4-port edge connect gesture, auto/straight routing, all 13 node kinds rendered as SVG, image picker, smart-guide snap (left/center/right + top/center/bottom), configurable snap size 1–200px. |
| 3 — Ribbon + panels + selection ops | ✅ | HWP-style 9-tab ribbon, filled Tools/Infographic/Arrow/Table tabs, Layers panel with drag-reorder + lock/hide + rename, per-selection Property panel, alignment / distribute / equalize ops, z-order ops, style copy/paste, color presets, Save-As Radix dialog, and locked-node protection for move/nudge/resize/delete/edit bulk paths. |
| 4 — Templates + export + version history | ✅ | 11 localized templates (PDCA cycle/grid, SWOT, fishbone, mind-map, org-chart, roadmap, kanban, keyword grid, process flow, blank), PNG/PNG-transparent/JPG/SVG/JSON/PDF/Mermaid export via selected-path Tauri save dialog, Radix confirmation dialogs for replace/restore, 5-min auto-snapshot ring (cap 20) under `.maru/diagrams/history/<docId>/`. |
| 5 — Polish + a11y + ergonomics | ✅ | Cmd+F / `/` find/replace, memos + status chips + progress bars, focus mode, dark-mode chrome (canvas stays light), keyboard nav (F2 rename, Arrow nudge, Cmd+A/D), special-chars picker, axe-ready focus rings + aria-labels, DOMPurify wrapper for future rich text. |
| 6 — Perf + interop | ✅ | Viewport culling (visibleSubset), edge-route Map cache (5k entries, position-keyed), Mermaid round-trip export/import, 1000-node bench fixture (`pnpm vitest bench src/lib/diagram/perf.bench.ts`). |
| 7 — Default-on | ✅ | Flag flips to opt-out. Hidden via `VITE_MARU_DIAGRAM=0`, `?maru-diagram=0`, or unchecking Settings → Preferences → "Diagram mode". Command palette opens Diagram when enabled; e2e covers flag visibility, ko/en labels, save/reload, templates, Mermaid, export dialog, filled tabs, and no `localhost:5500` / Google Fonts requests. |

File format: `.cmd.json` (v:7 envelope continues the source HTML's numbering past its broken `localhost:5500` boundary). Implementation lives under `src/lib/diagram/`, `src/components/diagram/`, and `src-tauri/src/diagram/mod.rs`. Detailed usage doc: `docs/diagram.md`.

## 6.6 Diagram Report Pattern Studio (side track, shipped)

The Report Pattern Studio track upgrades the Diagram mode from a freeform canvas to a report-figure authoring surface: typed report datasets, live pattern views, and a managed link into Markdown reports.

| Phase | State | Outcome |
|-------|-------|---------|
| 0 — v8 schema + migration | ✅ | `v:8` envelope with report datasets + pattern views; v7 documents migrate in memory on load; one-time v7 backup to `.maru/diagrams/backups/` before the first v8 save (`diagram_backup_document`, temp-file + rename). |
| 1 — Typed tables | ✅ | Table nodes bound to matrix datasets with cell-level editing (F2/Enter/Tab/arrows/Escape, merge/split, resize) and page frames. |
| 2 — Patterns + conversion | ✅ | Pattern registry (`report.*` ids), semantic conversion engine (same-family lossless / cross-family field-mapping preview / freeform non-convertible), workspace presets under `.maru/diagram-patterns/` (`diagram_pattern_save/list/delete`). |
| 3 — Codec registry | ✅ | Unified import/export with declared fidelity (lossless: maru-json, maru-svg with embedded canonical JSON; structural: csv/tsv/markdown-table/html-table/mermaid; visual: svg-image/png/jpg/pdf) + OS clipboard table codecs. |
| 4 — Insert/Update in report | ✅ | File-ribbon action renders SVG + 2x PNG to `attachments/diagrams/<docId>/<scope>-<hash8>.*` (`diagram_write_report_asset`, extension-whitelisted + atomic) and splices a managed `<!-- maru-diagram:v1 -->` block into the active Markdown document (recent-document chooser fallback) through the revision-checked `save_document` path; conflicts surface without retry, hash-named assets make re-renders idempotent. Pure splicer in `src/lib/diagram/reportLink.ts`, flow in `reportInsert.ts`. |

Managed-block semantics: blocks match on `source` + `scope` (`pattern:<viewId>` or `doc`), replace in place or append at end, preserve surrounding content byte-for-byte, skip malformed blocks with a warning, and are idempotent. Studio treats the block as a normal linked image — no inline Diagram editor, no export preprocessor, no auto refresh; DOCX/PDF converters are unchanged and HWPX output does not embed the linked image. Detailed usage doc: `docs/diagram.md`.

## 7. Glossary (Maru-internal)

- **BU** — Business Unit (사업단 or 대학본부조직). Identified by a slug like `koica-tiu` or `chu-ai-innovation`. Configured per directory via `.maru/bu-config.yaml`.
- **Bundle** — A directory of derived artifacts (`<source-stem>.exports/`) containing the manifest plus one file per requested format.
- **Manifest** — `manifest.yaml` next to the bundle. Maru SSOT for export state; the file is the only place sha256s of generated outputs live.
- **Provenance trailer (deprecated W5→W7)** — `<!-- maru:template ... -->` HTML comments. Replaced by proper frontmatter from Phase 4 W7 onward.
- **Studio** — The new Phase 4 W11+ multi-step authoring surface. Distinct from "Composer" view mode in the editor (W12+ work).
- **Finalize** — Phase 6 W21 action that pushes an approved document's markdown body + rendered artifacts (docx/hwpx/pdf) + linked evidence binaries to Hub via `POST /api/v1/documents/{id}/finalize`. After a successful finalize, the local markdown's frontmatter `status` flips to `archived-hub:<finalized_id>@v<N>`; subsequent edits create a new draft that, on re-approval, becomes version `N+1` on Hub.

## 8. Vault & Knowledge Graph (Phase 8) — ✅ 8a/8b/8c shipped

Spec 정본: work repo `_meta/migrations/2607-deep-restructure/specs/maru-vault-graph-spec.md` (DR-020). V4는 Sigma WebGL + Graphology MultiDirectedGraph, ForceAtlas2 worker, visibility reducer, layout cache v2, incremental workspace cache v3/watcher, source·scope·local-depth controls, analysis worker, revision-checked relationship review/apply로 강화됨. 쓰기는 `write_policy: "managed"` 스키마 가드 + 고유 스냅샷 + atomic replace를 유지하며 delete는 MCP 전용임. 문서: `docs/graph.md`.

### 8a — V1 read-only graph (W27–W29) ✅ (커밋 `cdf9ddb`, PR #61)

`"graph"` MaruAppMode, GraphModel 어댑터(`src/lib/graph/model.ts`)+vitest, `vault_graph_read`(edges/links 관용), Sigma WebGL GraphCanvas, Graphology ForceAtlas2 worker, 필터·검색·hover·클릭→노트 열기, NeighborhoodPane "그래프에서 보기" 버튼, 10k node/약 60k edge 합성 벤치. Playwright는 production DOM 대신 dev/E2E 전용 graph bridge를 사용함.

### 8b — V2 managed writes (W30–W32) ✅ (커밋 `96c7b44`, PR #62)

`write_policy: "managed"` + WorkspaceSwitcher 토글, `vault_guard.rs`(validate_managed_write + vault_validate_note), EditorPane 검증 스트립 + OutlinePane frontmatter 폼(description 카운터·type/domain select·topics 칩), 스냅샷-before-write, vault/CLAUDE.md 쓰기 규칙 개정 lockstep.

### 8c — V3 graph-driven (W33–W34+) ✅ (커밋 `1030354`, PR #63)

NewDocumentDialog 이웃 패널, 미해소 위키링크→CreateNoteDialog, 결정 체인 타임라인 레인(`decisionChains.ts`). (보류) Hub 그래프 메타 sync — Hub 소비자 생기기 전까지 범위 외.

V1은 쓰기 리스크 0으로 가치 출하, V2가 capability 모델을 바꾸고, V3는 V1+V2 프리미티브 위의 순수 프론트다. 세 단계 모두 출하되었으므로 Phase 8의 유일한 잔여 항목은 보류된 Hub 그래프 메타 sync이며, 이는 Hub 소비자가 생길 때까지 범위 외로 유지된다.

## 9. Desk automation (side track, shipped)

Outside the M1–M7 backbone, a track that turns incoming material into drafts a
person reviews. Its governing rule is that **nothing lands confirmed**: every
unattended stage may only produce pending artifacts, and each transition that
makes something real sits behind a gate that already existed (inbox routing's
`require_confirm_before_route`, the `drafts.promote` approval).

| Layer | Where | State |
|-------|-------|-------|
| Collection | work repo `_meta/scripts/daily_mail_digest.py`, launchd 03:30 | ✅ mail staged to `inbox/items/pending/` with bodies |
| Extraction | `inbox-process extract-tasks` (read-only) | ✅ |
| Drafting | `draft-writer write-drafts` → `$MARU_DRAFTS` (`scratchpad/drafts/` by default) | ✅ unreleased |
| Driver | work repo `_meta/scripts/desk_pipeline.sh`, launchd 04:30 | ✅ |
| Review | Ideation hub → promote | ✅ v0.4.33 |

Maru-side pieces, all shipped in v0.4.33 unless noted:

- **Ideation hub** (`src-tauri/src/drafts.rs`, `src/components/drafts/`) — one
  first-class unconfirmed concept for AI task drafts and ideation, promoted
  through an approval gate into a document or a task note. `drafts_list` adopts
  loose markdown in the collection, which is how the headless pipeline's output
  becomes visible without a new command. Doc: `docs/drafts.md`.
- **Scheduler** — recurring skill runs per workspace (`.maru/schedules.json`), a
  60s in-app ticker, catch-up on launch, `scheduler.add` approval.
- **Gap analysis** (`src-tauri/src/gap.rs`, `src/components/gap/`) — diffs the
  frozen promote baseline against the published document, classifies each hunk,
  and feeds a digest back into the next drafting run. Unreleased work made the log
  queryable (type + date filters, entry→draft selection) and recorded
  provenance (`baselineLines`, `draftKind`, `generatedBy`) so churn can be read
  against document size. Doc: `docs/gap-analysis.md`.
- **KG document references** (`src-tauri/src/kg_refs.rs`, `src/lib/kgRefs.ts`) —
  maps a document's wikilinks and entity mentions to graph nodes, highlights
  them in the editor, and animates them in the graph. Unreleased work walks the
  animation paragraph by paragraph, which is what the per-span paragraph index
  was computed for.

The Ideation hub now supports manual idea creation, revision-checked editing,
and the allowed lifecycle transitions. Voice intake remains future work: it
needs a transcriber the workspace does not have.
