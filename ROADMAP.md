# Anchor Roadmap — Phase 3~7 (26 weeks)

> **Mission** — Bring 사업단(business unit) + 대학본부조직(university headquarters) document operations into one Anchor desktop workspace. The roadmap is a redefinition of Phase 3 and beyond into a **7-module** decomposition with weekly deliverables.
>
> **Status anchor** — Updated through Phase 4 W12 (HWP field map + 개조식 inline lint). See README's Status table for the canonical state column; this file is the deeper "what's next + how to continue" reference.
>
> **Spec sources** — All design decisions trace back to `~/workspace/work/_sys/rules/{frontmatter-schema,bu-lifecycle,hub-sync,evidence-policy}.md`. The 26-week plan itself lives at `~/.claude/plans/flickering-seeking-engelbart.md` (work-repo internal) and is mirrored here from Anchor's perspective.

## 1. The 7-module decomposition

Each module is owned by Anchor desktop. Hub backs them where shared catalog data is needed; spec details for the Hub side are in `dev/anchor-hub/ROADMAP.md`.

| # | Module | Purpose | Surface | Owners |
|---|--------|---------|---------|--------|
| M1 | Operations Catalog | "What needs my attention right now" — deadlines, in-flight approvals, unlinked evidence, inbox pending | Activity-rail `LayoutGrid` mode → 3-column pane | ✅ shipped |
| M2 | Document Studio | 7-step authoring wizard (source → template → guideline → sections → HWP fields → export → package) replacing ad-hoc dialog | `Studio` mode | ✅ W12 shipped |
| M3 | Template / Form Filling | Unified template catalog (workspace + `_sys/templates` + project `_templates` + hwpx skill + Hub) with `.hwpx` placeholder fill + binary `.hwp → .hwpx` conversion | Studio Step 2 + 5 | 🚧 HWPX slot/fill shipped · `.hwp` conversion manual fallback |
| M4 | Export Pipeline | Markdown SSOT → docx / hwpx / pdf with sha256 manifest + converter dispatch + format-specific validators | `export_*` Tauri commands + palette | ✅ W8-W10 shipped · lightweight validators shipped · richer validators planned |
| M5 | Evidence Binder | Bind evidence (originals + extracted text + summary + verification) to doc sections / KPIs / submission checklist | Right pane Evidence tab | 🚧 W13 shipped · W14-W15 planned |
| M6 | Deck Studio | gpt-images-deck wizard with 14-style catalog, image-mode × production-mode matrix, job artifacts | New `Decks` mode (W17+) | 📋 planned |
| M7 | Hub Connector | Read shared context (templates / guidelines / glossary / evidence index / KPI status / **finalized documents**) + create submission gates + **finalize approved documents to Hub** (markdown body + rendered artifacts + evidence binaries) | Background + `Hub` commands | ✅ read shipped (W4) · Hub sync API shipped · ⏳ Anchor sync caller · ⏳ finalize write (P6 W21) |

## 2. Week-by-week deliverables

Legend — ✅ shipped · 🚧 in progress · 📋 planned · ⏳ awaiting upstream

### Phase 3 — Unified Document Operations (W1–W6)

| W | Status | Deliverable | Critical files |
|---|--------|-------------|----------------|
| W1 | ✅ | Rule SSOTs (`frontmatter-schema`, `bu-lifecycle`, `hub-sync`, `evidence-policy`) + Rust `ops_catalog` + `hub_client` scaffolds + 4 BU seeds | `src-tauri/src/{ops_catalog,hub_client}/*` |
| W2 | ✅ | Hub catalog REST × 9 + Alembic 0001_core + 21-template seed + 12 pytest | `dev/anchor-hub/src/anchor_hub/api/routes/catalog.py` |
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
| W11 | ✅ | **Document Studio multi-step wizard (M2)** — new `Studio` activity-rail mode. 7 steps under `src/components/studio/StudioMode.tsx`: source picker, template picker (reuse `lib/hubLibrary`), guideline picker, section editor (Rich/Source modes), HWP field map placeholder state, export (wraps `export_plan` + dispatch), package (local body apply + version snapshot freeze). State persists at `<workspace>/.anchor/studio/<doc-id>/state.json` via `src-tauri/src/studio/mod.rs`, and `studio_apply_body` preserves frontmatter bytes while replacing only the markdown body. | `src-tauri/src/studio/*` · `src/components/studio/*` · `src/App.tsx` activity-rail wiring |
| W12 | ✅ | **HWP field map (M3) + 개조식 inline lint (M2 Step 4)** — `hwpx slots` extracts `{{field}}` placeholders from bundled/workspace HWPX templates; `kordoc_lite` adds HWPX structure checks, Korean public-form label/inline-label detection, preserved XML fill for label-value fields, and docx/hwpx/pdf export structure checks. Step 4 runs debounced `gaejosik_lint`, underlines violations via CodeMirror decorations and BlockNote custom marks, and stores dismissals under workspace-state `composer.lintDismissals` with per-document Studio fallback. | `src-tauri/src/{template_fill,kordoc_lite}.rs` · `src-tauri/src/export/validate.rs` · `src-tauri/src/linter/gaejosik.rs` · `src/components/studio/*` |

### Phase 5 — Evidence Binder + Deck Studio (W13–W18)

| W | Module | Deliverable |
|---|--------|-------------|
| W13 | ✅ M5 | Right-pane Evidence Binder tab + `<workspace>/.anchor/binder/<doc-id>.json` state. Auto-pulls inbox-processed attachments + `<binary>.evidence.yaml` sidecars under the active doc's BU, then uses `kordoc_lite` for local format detection and HWPX/form preview metadata. |
| W14 | M5 | Section / KPI / submission-checklist bindings — frontmatter `evidence_links[].section_bindings` (`"§ 2.1"`-style slugs), `kpi_bindings`, `submission_checklist_bindings`. Per-evidence Verify / Mark-as-submitted controls; reuse `kordoc_lite` HWPX fields as candidate binding labels. |
| W15 | M5 | Hub `evidence_index` integration — sha256 lookup ("이미 검증됨" hint), `evidence_index.suggest_reuse` palette command, and metadata-only kordoc_lite detection fields. Anchor still owns the binary; only sha256 + metadata flow to Hub. |
| W16 | M6 | Deck Studio mode + Plan step (Claude proposal → `slide_plan.json`) + 14-style catalog browser reading `dev/anchor/skills/docs/slide-decks/*.md`. |
| W17 | M6 | Generate step matrix — `imageMode` radio (codex-native / provider / html-css) × `productionMode` checkboxes (image-folder / html-deck / pptx-from-images / pdf-export). Job artifact directory `projects/.../05-decks/<slug>/`. |
| W18 | M6 | Per-page regenerate, drag-and-drop reorder, manifest.yaml hashing of every emitted page + final PPTX / PDF. |

### Phase 6 — Approval workflow + Finalize to Hub (W19–W22)

| W | Module | Deliverable |
|---|--------|-------------|
| W19 | M7 + M2 | Anchor Studio Step 7 emits `hub_submit_gate` (the existing W4 stub) with all safety pre-flights. `submission_gate_id` and `status: submitted` written back to the source markdown's frontmatter. |
| W20 | M7 | Hub polling for gate state changes; `frontmatter.status` auto-advances `submitted → received → approved/rejected` as Hub state matures. |
| W21 | M2 + M7 + M4 + M5 | Approval drawer in Anchor — right pane shows `approval` block from frontmatter; per-step sign-off button posts to Hub `approval_routes/<id>/actions`. **Finalize step**: the moment a route transitions to `approved`, Anchor auto-calls `POST /api/v1/documents/{id}/finalize` carrying the markdown body, every rendered artifact in the M4 manifest (docx/hwpx/pdf), and the binary bytes of every evidence file linked via `frontmatter.evidence_links`. On `201` response, frontmatter `status` flips to `archived-hub:<finalized_id>@v<N>` and future edits create a new local file that, when re-approved, will become version N+1 on Hub. |
| W22 | M2 + M7 | Status board mode (Kanban-style: draft / review / approval / archived) over the Catalog index, filtered by active BU. **New**: Hub Finalized tab inside `Catalog` mode — published version timeline + per-artifact download (via `GET /finalized-documents/{id}/artifacts/{format}`) + audit chain viewer. |

### Phase 7 — Certification & KPI bundle (W23–W26)

| W | Module | Deliverable |
|---|--------|-------------|
| W23 | M5 + Hub | Certification Vault mode reads Hub `certifications` + `certification_requirements`; checklists auto-bound to existing doc / evidence by document_type + business_unit. |
| W24 | M5 | `Cert: Bind evidence to item` + missing-requirement detection in Anchor UI. |
| W25 | M5 | KPI Composer pulls Hub `kpi_snapshots` + generates a 개조식 narrative md with evidence references. |
| W26 | M5 + Hub | `certification.bundle.create` proposal → Anchor downloads + presents the PDF bundle (cover + per-requirement section + KPI charts + evidence pages). The bundle is assembled by Hub directly from `finalized_documents` + `finalized_document_artifact` + `evidence_blobs` — **no Anchor binary push is needed at bundle time** (everything was pushed at Phase 6 W21 finalize). Phase 3-7 verification gate. |

## 3. Test matrix (target growth)

| Surface | W9 baseline | Phase 4 target | Phase 5 target | Phase 7 target |
|---------|-------------|----------------|----------------|----------------|
| Rust unit (`cargo test --lib`) | 343 | 360+ (Studio, slot scan, lint helpers) | 380+ (binder + decks) | 410+ (cert bundle) |
| Vitest (`pnpm test`) | 199 / 34 files | 220+ (Studio steps, ExportPanel) | 240+ (binder, decks) | 260+ |
| Hub pytest | 15 | 25 (sync endpoint + workflow seeds) | 40 | 60 |
| E2E playwright | smoke only | + Studio flow | + binder + decks | + full bundle |

## 4. Conventions to keep

1. **Frontmatter byte-identity** — every Anchor write that mutates a YAML field must preserve unrelated fields, comments, ordering, and quoting. `src-tauri/src/frontmatter/ops.rs` is the only allowed code path.
2. **Skill dispatch is proposal-only** — every Hub-write MCP tool and every multi-step automation passes through the `proposal_queue` table (Hub) or the `approval.rs` gate (Anchor). No silent destructive operations.
3. **Cache surfaces are disposable** — `<workspace>/.anchor/cache/*`, `.anchor/runs/*`, `.anchor/queue/*`, `.anchor/studio/*`, `.anchor/certification/*` are gitignored runtime data; never write canonical state there.
4. **Hub holds bodies only for approved documents.** Drafts stay under `~/workspace/work/` (Anchor = author SSOT). The Anchor → Hub write path is two-stage: `POST /documents/sync` (metadata snapshot, planned M7 caller) for any draft and `POST /documents/{id}/finalize` (markdown body + rendered artifacts + linked evidence binaries, Phase 6 W21) after the approval route closes. W21 must add the matching `hub_client/safety.rs` pre-flight so finalize is the only Anchor client path that may carry bodies/binaries, and only when the corresponding `submission_gate` state is `approved`.
5. **Private deployment is the product path.** Public/demo compatibility may remain in config and synthetic fixtures, but glossary scrubbing and real-name CI regex gates are not deployment logic.
6. **Korean filenames** — workspace path components stay in ASCII to avoid macOS NFD breakage. Templates handle Korean content; the file name doesn't.

## 5. Continuing work — concrete next steps

### Immediate (W14 entry)

```
# branch: fresh feat/evidence-binder-w13 off main
src-tauri/src/evidence_binder.rs         # extend binder binding model
src/components/evidence/*                # section/KPI/checklist controls
src/lib/evidenceBinder.ts                # binding shape + UI model
src/App.tsx                              # preserve right utility rail tab wiring
```

W10 follow-up hardening, if needed before Studio:
- Wrap converter runs in mission state when conversion duration becomes user-visible.
- Extend the W12 lightweight structure checks toward richer PDF font/embed checks if submission gates require it.
- Add an optional right-pane export progress surface; keep the palette command as the primary entrypoint.

### W12 shipped notes

- `template_get_fields` calls the bundled/user `hwpx` skill subprocess (`hwpx slots <template_path> --format json`) and normalizes slot keys for Studio field values.
- `template_get_fields` merges `hwpx slots` placeholders with `kordoc_lite` HWPX label/inline-label detection; field metadata includes source and confidence.
- `template_fill_hwpx` writes filled artifacts to `.anchor/studio/filled/` by default, preserves form-label fills through `kordoc_lite`, and validates the result with both `hwpx validate` and lightweight structure checks.
- `gaejosik_lint` is deterministic and dismissal-aware; the UI uses a 350 ms debounce, CodeMirror decorations for source mode, and a BlockNote `gaejosikLint` mark for rich mode.

### W13 shipped notes

- `evidence_binder_read/evidence_binder_save` persist document-scoped state at `<workspace>/.anchor/binder/<doc-id>.json`.
- Evidence candidates are seeded from processed inbox raw files and `<binary>.evidence.yaml` sidecars, with sidecar scanning scoped to the active document's BU root when available.
- Candidate metadata includes `kordoc_lite` format detection, lightweight structure checks, and HWPX field preview labels.

### W14 (Evidence binding model)

- Add section / KPI / submission-checklist binding controls on top of the W13 candidate list.
- Persist binding metadata in the binder state first; only promote to frontmatter after the W14 shape is final.
- Keep binaries local; Hub receives only sha256 + metadata in the W15 evidence-index integration.

## 6. Cross-cutting hand-off notes

- **Anchor MCP sidecar** (`sidecars/anchor-mcp/`, Phase 3+) lives outside this branch but is referenced by every M7 surface. Don't add new MCP tools without a matching `proposal_queue` row on the Hub side.
- **`workspace.config.yaml`** carries the `hub:` block (endpoint / token ref / scope / do_not_upload) and `bu_lifecycle:` block. New runtime knobs go there, not into `~/.anchor/settings.json`.
- **Skill registry** lives at `~/.anchor/skills/registry.json`; Anchor reads via `skill_host::list_skills`. New built-in skills get embedded under `skills/` and materialized into `~/.anchor/skills/_builtin/` at runtime.
- **Real-workspace verification** — every milestone repeats the W4 gate (`ANCHOR_CATALOG_BENCH_WORKSPACE=~/workspace/work cargo test --lib -- --ignored catalog_real_workspace_smoke`) plus the live-Hub procedure in README §"Live-Hub verification".

## 7. Glossary (Anchor-internal)

- **BU** — Business Unit (사업단 or 대학본부조직). Identified by a slug like `koica-tiu` or `chu-ai-innovation`. Configured per directory via `.anchor/bu-config.yaml`.
- **Bundle** — A directory of derived artifacts (`<source-stem>.exports/`) containing the manifest plus one file per requested format.
- **Manifest** — `manifest.yaml` next to the bundle. Anchor SSOT for export state; the file is the only place sha256s of generated outputs live.
- **Provenance trailer (deprecated W5→W7)** — `<!-- anchor:template ... -->` HTML comments. Replaced by proper frontmatter from Phase 4 W7 onward.
- **Studio** — The new Phase 4 W11+ multi-step authoring surface. Distinct from "Composer" view mode in the editor (W12+ work).
- **Finalize** — Phase 6 W21 action that pushes an approved document's markdown body + rendered artifacts (docx/hwpx/pdf) + linked evidence binaries to Hub via `POST /api/v1/documents/{id}/finalize`. After a successful finalize, the local markdown's frontmatter `status` flips to `archived-hub:<finalized_id>@v<N>`; subsequent edits create a new draft that, on re-approval, becomes version `N+1` on Hub.
