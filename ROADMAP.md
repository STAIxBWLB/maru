# Anchor Roadmap — Phase 3~7 (26 weeks)

> **Mission** — Bring 사업단(business unit) + 대학본부조직(university headquarters) document operations into one Anchor desktop workspace. The roadmap is a redefinition of Phase 3 and beyond into a **7-module** decomposition with weekly deliverables.
>
> **Status anchor** — Updated through Phase 4 W9 (export pipeline transitions + validate). See README's Status table for the canonical state column; this file is the deeper "what's next + how to continue" reference.
>
> **Spec sources** — All design decisions trace back to `~/workspace/work/_sys/rules/{frontmatter-schema,bu-lifecycle,hub-sync,evidence-policy}.md`. The 26-week plan itself lives at `~/.claude/plans/flickering-seeking-engelbart.md` (work-repo internal) and is mirrored here from Anchor's perspective.

## 1. The 7-module decomposition

Each module is owned by Anchor desktop. Hub backs them where shared catalog data is needed; spec details for the Hub side are in `dev/anchor-hub/ROADMAP.md`.

| # | Module | Purpose | Surface | Owners |
|---|--------|---------|---------|--------|
| M1 | Operations Catalog | "What needs my attention right now" — deadlines, in-flight approvals, unlinked evidence, inbox pending | Activity-rail `LayoutGrid` mode → 3-column pane | ✅ shipped |
| M2 | Document Studio | 7-step authoring wizard (source → template → guideline → sections → HWP fields → export → package) replacing ad-hoc dialog | New `Studio` mode (W11) | 🚧 in progress |
| M3 | Template / Form Filling | Unified template catalog (workspace + `_sys/templates` + project `_templates` + hwpx skill + Hub) with `.hwpx` placeholder fill + binary `.hwp → .hwpx` conversion | Studio Step 2 + 5 | 🚧 partial (W5 picker shipped) |
| M4 | Export Pipeline | Markdown SSOT → docx / hwpx / pdf with sha256 manifest + format-specific validators | `export_*` Tauri commands + palette (W12 finisher: auto-dispatch) | 🚧 scaffold + transitions shipped |
| M5 | Evidence Binder | Bind evidence (originals + extracted text + summary + verification) to doc sections / KPIs / submission checklist | Right pane tab (W14+) | 📋 planned |
| M6 | Deck Studio | gpt-images-deck wizard with 14-style catalog, image-mode × production-mode matrix, job artifacts | New `Decks` mode (W17+) | 📋 planned |
| M7 | Hub Connector | Read shared context (templates / guidelines / glossary / evidence index / KPI status) + create pending submission gates only | Background + `Hub` commands | ✅ read shipped (W4) · ⏳ write (P6 W19) |

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
| W10 | 📋 | **Skill auto-dispatch** — single "Export bundle" command drives `pending → ready/failed` via `skill_host::dispatch_background`. Three skill mappings: `docx → pandoc-or-docx-skill`, `hwpx → hwpx skill`, `pdf → hwpx-via-libreoffice` (fallback `pandoc → pdf`). Each conversion runs in a background mission with the existing skill subsystem; success calls `export_record_success`, failure calls `export_record_failure`. | `src-tauri/src/export/dispatch.rs` (new) · `src-tauri/src/skill_host/dispatch.rs` · `src/components/export/ExportPanel.tsx` (new) |
| W11 | 📋 | **Document Studio multi-step wizard (M2)** — new `Studio` activity-rail mode. 7 steps under `src/components/studio/StudioMode.tsx`: source picker, template picker (reuse `lib/hubLibrary`), guideline picker, section editor (BlockNote pinned per slot), HWP field map (Step 5 placeholder for now), export (Step 6 wraps `export_plan` + dispatch), package (Step 7 freezes versions). State persisted at `<workspace>/.anchor/studio/<doc-id>/state.json` via new `src-tauri/src/studio/{mod,steps,packaging}.rs`. | `src-tauri/src/studio/*` · `src/components/studio/*` · `src/App.tsx` activity-rail wiring |
| W12 | 📋 | **HWP field map (M3) + 개조식 inline lint (M2 Step 4)** — `hwpx` skill slot scan exposed as `template_get_fields(template_id)` + Studio Step 5 form. `gaejosik` skill wired as a debounced subprocess + CodeMirror decoration / BlockNote mark for live lint underline. Lint dismissals persisted under `composer.lintDismissals` in workspace-state. | `src-tauri/src/template_fill/{hwpx,hwp_convert}.rs` (new) · `src-tauri/src/linter/gaejosik.rs` (new) · `src/components/composer/SlotPanel.tsx` |

### Phase 5 — Evidence Binder + Deck Studio (W13–W18)

| W | Module | Deliverable |
|---|--------|-------------|
| W13 | M5 | Right-pane Evidence Binder tab + `<workspace>/.anchor/binder/<doc-id>.json` state. Auto-pulls inbox-processed attachments + `<binary>.evidence.yaml` sidecars under the active doc's BU. |
| W14 | M5 | Section / KPI / submission-checklist bindings — frontmatter `evidence_links[].section_bindings` (`"§ 2.1"`-style slugs), `kpi_bindings`, `submission_checklist_bindings`. Per-evidence Verify / Mark-as-submitted controls. |
| W15 | M5 | Hub `evidence_index` integration — sha256 lookup ("이미 검증됨" hint), `evidence_index.suggest_reuse` palette command. Anchor still owns the binary; only sha256 + metadata flow to Hub. |
| W16 | M6 | Deck Studio mode + Plan step (Claude proposal → `slide_plan.json`) + 14-style catalog browser reading `dev/anchor/skills/docs/slide-decks/*.md`. |
| W17 | M6 | Generate step matrix — `imageMode` radio (codex-native / provider / html-css) × `productionMode` checkboxes (image-folder / html-deck / pptx-from-images / pdf-export). Job artifact directory `projects/.../05-decks/<slug>/`. |
| W18 | M6 | Per-page regenerate, drag-and-drop reorder, manifest.yaml hashing of every emitted page + final PPTX / PDF. |

### Phase 6 — Approval workflow + Hub write (W19–W22)

| W | Module | Deliverable |
|---|--------|-------------|
| W19 | M7 + M2 | Anchor Studio Step 7 emits `hub_submit_gate` (the existing W4 stub) with all safety pre-flights. `submission_gate_id` and `status: submitted` written back to the source markdown's frontmatter. |
| W20 | M7 | Hub polling for gate state changes; `frontmatter.status` auto-advances `submitted → received → approved/rejected` as Hub state matures. |
| W21 | M2 + Hub | Approval drawer in Anchor — right pane shows `approval` block from frontmatter; per-step sign-off button posts to Hub `approval_routes/<id>/actions`. |
| W22 | M2 | Status board mode (Kanban-style: draft / review / approval / archived) over the Catalog index, filtered by active BU. |

### Phase 7 — Certification & KPI bundle (W23–W26)

| W | Module | Deliverable |
|---|--------|-------------|
| W23 | M5 + Hub | Certification Vault mode reads Hub `certifications` + `certification_requirements`; checklists auto-bound to existing doc / evidence by document_type + business_unit. |
| W24 | M5 | `Cert: Bind evidence to item` + missing-requirement detection in Anchor UI. |
| W25 | M5 | KPI Composer pulls Hub `kpi_snapshots` + generates a 개조식 narrative md with evidence references. |
| W26 | M5 + Hub | `certification.bundle.create` proposal → Anchor downloads + presents the PDF bundle (cover + per-requirement section + KPI charts + evidence pages). Phase 3-7 verification gate. |

## 3. Test matrix (target growth)

| Surface | W9 baseline | Phase 4 target | Phase 5 target | Phase 7 target |
|---------|-------------|----------------|----------------|----------------|
| Rust unit (`cargo test --lib`) | 340 | 360+ (dispatch, slot scan, lint helpers) | 380+ (binder + decks) | 410+ (cert bundle) |
| Vitest (`pnpm test`) | 199 / 34 files | 220+ (Studio steps, ExportPanel) | 240+ (binder, decks) | 260+ |
| Hub pytest | 15 | 25 (sync endpoint + workflow seeds) | 40 | 60 |
| E2E playwright | smoke only | + Studio flow | + binder + decks | + full bundle |

## 4. Conventions to keep

1. **Frontmatter byte-identity** — every Anchor write that mutates a YAML field must preserve unrelated fields, comments, ordering, and quoting. `src-tauri/src/frontmatter/ops.rs` is the only allowed code path.
2. **Skill dispatch is proposal-only** — every Hub-write MCP tool and every multi-step automation passes through the `proposal_queue` table (Hub) or the `approval.rs` gate (Anchor). No silent destructive operations.
3. **Cache surfaces are disposable** — `<workspace>/.anchor/cache/*`, `.anchor/runs/*`, `.anchor/queue/*`, `.anchor/studio/*`, `.anchor/certification/*` are gitignored runtime data; never write canonical state there.
4. **Hub never holds bodies** — only sha256 + metadata + status. Binary originals + document body stay under `~/workspace/work/`. The `hub-sync.md` `do_not_upload` list is enforced both client-side (`hub_client/safety.rs`) and server-side (`evidence_index` schema deliberately lacks a blob FK).
5. **Public vs private deployment** — public Hub seed must scrub real org/program/person names. CI gates this regex sweep in the Hub repo. The Anchor side never sends real names to a `deployment_mode=public` instance.
6. **Korean filenames** — workspace path components stay in ASCII to avoid macOS NFD breakage. Templates handle Korean content; the file name doesn't.

## 5. Continuing work — concrete next steps

### Immediate (W10 entry)

```
# branch: feat/anchor-e2e-flow (or a fresh feat/export-dispatch off main)
src-tauri/src/export/dispatch.rs        # new module
src-tauri/src/lib.rs                    # register export_dispatch command
src/lib/export.ts                       # exportDispatch wrapper
src/components/export/ExportPanel.tsx   # right-pane progress UI (optional)
src/App.tsx                             # "Export bundle (run)" palette
```

Suggested skill mapping for W10:
| Format | Primary skill | Fallback |
|--------|---------------|----------|
| docx | `docx` skill (`~/.anchor/skills/docx`) | `pandoc --from markdown --to docx` |
| hwpx | `hwpx` skill (Python venv at `~/.anchor/env/.venv`) | manual: `<file>.md` → `hwpx-skill compile` |
| pdf | `hwpx → pdf` via `hwpx to-pdf` (LibreOffice + H2Orestart) | `pandoc --pdf-engine=lualatex` |

Hand-off pattern (mirrors W4 hub_client retry + offline queue):
1. `export_dispatch(workspace_root, manifest_path, format)` → spawn the skill via `skill_host::dispatch_background` with `format` as input arg.
2. Skill output convention — write the artifact to the path the manifest already recorded (`bundle_dir/<stem>.<ext>`).
3. On skill exit code 0 + file present → call `record_output_success`. Non-zero or missing file → `record_output_failure(reason)`.
4. The palette command then re-runs `export_validate` to surface the new state in one toast.

### W11 (Studio) starter

- Add `studio` to `AnchorAppMode` enum (`src/lib/settings.ts`) and the `app-shell.studio-mode` grid template.
- Promote `NewDocumentDialog` Step 1-3 logic into reusable `Step1Source` / `Step2Template` / `Step3Guideline` components — already half-extractable.
- Persist per-doc Studio state under `<workspace>/.anchor/studio/<doc-id>/state.json` (json structure described in plan §M2).

### W12 (HWP field map + lint)

- `template_get_fields` command stubs out to `hwpx` skill subprocess (`hwpx slots <template_path>`).
- `gaejosik` lint: incremental check on save / 1.5s debounce. Surface as CodeMirror decoration (raw view) and BlockNote mark (rich view). Cache violations in `<workspace>/.anchor/composer/lint-cache.json` to avoid re-running on identical paragraphs.

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
