# Refused edit reports (ahwp 2.0.0)

Exact released-binary `edit-report-v1` 1.1 reports and stderr, copied unchanged
from STAIxBWLB/hwp-editor `packages/core/test/fixtures/refusal-reports-v1.1/`
at b96b2e5 (MIT, see that repository's LICENSE). Engine: ahwp 2.0.0,
release asset `ahwp-v2.0.0-aarch64-apple-darwin.tar.gz`
(sha256 6ce7d60f2816d49078ea6269023bf53ed9150d02ebd5518801c65006fd7b92fc).

- `unapplied-replace`: an unmatched `--replace`; code `unapplied_requests`.
- `preservation-font`: a font typeInfo preservation refusal; code
  `preservation_loss` with a `font_type_info_unrepresentable` event.

The inputs are controlled documents the released binary created; see the
source README for the recorder and provenance. maru#620 replays these through a
fake engine to prove `hwped_edit` forwards the report.
