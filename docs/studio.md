# Document Studio (M2)

The `studio` activity-rail mode (label 스튜디오 / Studio) is a 7-step authoring
wizard that folds ad-hoc dialogs into one guided flow, backed by the M3 template
and M4 export subsystems. Shipped in Phase 4 W11–W12.

## The 7 steps

1. **Source** — start from an existing document or a blank draft.
2. **Template** — pick a Hub/workspace template (reuses `src/lib/hubLibrary.ts`).
3. **Guideline** — attach writing guidelines (multi-select).
4. **Sections** — edit section drafts in Rich or Source mode. Runs a debounced
   (350 ms) 개조식 (gaejosik) lint: violations underline via CodeMirror
   decorations (source) or a BlockNote `gaejosikLint` mark (rich). Dismissals
   persist under workspace-state `composer.lintDismissals` with a per-document
   Studio fallback.
5. **HWP fields** — HWPX `{{field}}` placeholder map. Legacy `hwpx_skill`
   templates continue through `template_get_fields` / `template_fill_hwpx`.
   Hub records with `source: hwp_cli_skill` keep the compatibility
   `hwpx_template_key` field, but its value is one of the six released Korean
   aliases. They resolve only through `hwp new --template`, then native slot
   scan/fill and `hwp validate`; output is staged and validated before it is
   published to `.maru/studio/filled/`.
6. **Export** — wraps `export_plan` + the M4 dispatch pipeline (docx / hwpx / pdf
   with a sha256 manifest; see below).
7. **Package** — applies the local body and freezes a version snapshot.
   `studio_apply_body` replaces only the markdown body and preserves the
   frontmatter bytes exactly.

## State

Per-document Studio state persists at
`<workspace>/.maru/studio/<doc-id>/state.json` via `src-tauri/src/studio/mod.rs`:
`studio_state_list`, `studio_state_read`, `studio_state_save`,
`studio_state_delete`, `studio_apply_body`. This directory is disposable runtime
data (gitignored) — canonical content stays in the source markdown.

Frontend: `src/components/studio/StudioMode.tsx` +
`src/components/studio/MarkdownSourceEditor.tsx`.

## Export pipeline (M4)

Studio Step 6 drives the same pipeline exposed by the `export_*` Tauri commands
and the command palette (`src-tauri/src/export/`):

- `export/manifest.rs` — `manifest.yaml` next to a `<source-stem>.exports/`
  bundle. The manifest is the SSOT for export state and the only place output
  sha256s live.
- `export/validate.rs` — format-specific structure checks (docx / hwpx / pdf)
  plus `kordoc_lite` HWPX/form checks.
- `export/dispatch.rs` — a single "Export bundle" command drives
  `pending → ready/failed` using deterministic local converters (`pandoc`,
  `hwpx`, LibreOffice-backed PDF fallback). Missing converters, missing outputs,
  and source-hash drift surface as partial failures rather than silent success.

## Related invariants

- **Frontmatter byte-identity** — every field mutation goes through
  `src-tauri/src/frontmatter/ops.rs`; unrelated fields, comments, ordering, and
  quoting are preserved.
- **Provenance** — `create_document` emits `maru:template` / `maru:business_unit`
  / `maru:guidelines` as proper frontmatter (the W5 HTML-comment trailer is
  deprecated).

## Tests

Rust: `cargo test --lib` filters `template_fill`, `kordoc_lite`, `validate`
(and the Studio state module). HWPX slot extraction is exercised against the
bundled `사업계획서_기본.hwpx`.
