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
5. **HWP fields** — HWPX `{{field}}` placeholder map. Hub records with
   `source: hwp_cli_skill` keep the compatibility `hwpx_template_key` field,
   but its value is one of the six released Korean aliases. They resolve only
   through `hwp new --template`, then native slot scan/fill and `hwp validate`;
   output is staged and validated before it is published to
   `.maru/studio/filled/`. Legacy `hwpx_skill` records take the same native
   path: `hwp_cli_template` maps their key (the retired skill's template stem,
   such as `사업계획서_기본`, or a Hub seed key such as `business_plan_default`,
   with or without `.hwpx`) onto the matching alias. A workspace template path
   typed in the step overrides an `hwpx_skill` key and goes through
   `template_get_fields` / `template_fill_hwpx`, also on the released `hwp`:
   fields come from `hwp slots --forms --json`, whose `fields` list merges
   every `{{slot}}` (under its normalized key) with the Korean form labels:
   label cells (`formLabel`) and inline `라벨:` text (`inlineLabel`). The fill
   is built in a staging directory next to the output in one pass: `hwp fill
   --forms --data … --json --allow-partial` gets every requested value and
   fills slots (padded `{{ name }}` too), the cell next to or below a label
   cell, inline labels, `라벨(  )` blanks, `□옵션` checkboxes and `(라벨:  )`
   blanks. A requested slot it cannot fill fails the fill closed; a form key it
   cannot match stays in `unmatchedFields`. `replacedCount` counts the slot
   keys and `formFilledCount` the form keys; `hwp validate --json` and `hwp
   info --json` check the staged file, which is then published atomically. The
   output may not be the template itself, through a symlink or another
   spelling either. Without a released `hwp` (>= 1.3.0) the field scan and the
   fill fail closed with their `cli_missing:` / `hwp_version:` reason and write
   nothing.
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
- `export/validate.rs` — per-output existence and sha256 checks plus the
  format structure checks of `artifact_checks.rs`: HWPX through `hwp validate
  --json` and `hwp info --json` (`zip-safety`, `hwpx-sections`, or
  `hwpx-structure` with hwp's first error), with a reduced offline
  `hwpx-structure` check (ZIP, `mimetype`, a `Contents/section*.xml`) when
  `hwp` is unavailable; DOCX and PDF locally.
- `export/dispatch.rs` — a single "Export bundle" command drives
  `pending → ready/failed` using deterministic local converters: `pandoc`
  (DOCX), the released `hwp` (`hwp new --from <md> --preset report` for HWPX,
  and `hwp convert <hwpx> --to pdf` for a PDF when the bundle's HWPX output is
  Ready), and `pandoc` as the PDF fallback; a pandoc PDF after an `hwp`
  failure keeps the `hwp` reason on its dispatch result. Missing converters, missing outputs,
  and source-hash drift surface as partial failures rather than silent success.

## Related invariants

- **Frontmatter byte-identity** — every field mutation goes through
  `src-tauri/src/frontmatter/ops.rs`; unrelated fields, comments, ordering, and
  quoting are preserved.
- **Provenance** — `create_document` emits `maru:template` / `maru:business_unit`
  / `maru:guidelines` as proper frontmatter (the W5 HTML-comment trailer is
  deprecated).

## Tests

Rust: `cargo test --lib` filters `template_fill`, `hwp_cli_template`,
`artifact_checks`, `doc_format`, `validate` (and the Studio state module). CI
has no `hwp`, so these tests drive stub `hwp` scripts through `MARU_HWP_BIN`.
The HWPX preview runs against the committed
`src-tauri/testdata/hwp-cli-plan-template.hwpx` (`hwp new --template
사업계획서`).
