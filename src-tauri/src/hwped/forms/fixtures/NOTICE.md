# ahwp 2.0.0 form artifacts

`ahwp-2.0.0-form-g5.json` holds what the released agent-hwp 2.0.0 wrote for
hwp-editor's `packages/server/test/fixtures/form-g5.hwpx` (a Hancom-authored
form the project owner approved for redistribution as a test fixture, per that
repository's `form-g5.NOTICE.md`):

- `discovery`: `ahwp slots form-g5.hwpx --forms --occurrences --json`
- `receipt` and `preview`: a dry-run `ahwp edit --verify --dry-run` of one
  `apply_form_bindings` op binding the first bindable occurrence to "Reviewed"

It contains no local path. `scripts/record-hwped-form-parity.mjs` reads it as
its optional second argument, so the recorded upstream outputs in `parity.json`
include real engine output, not only synthetic rows.
