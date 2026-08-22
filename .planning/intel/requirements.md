# Requirements (from PRD-classified docs)

No PRDs in the ingest set. 0 of 18 classified docs carry type `PRD`, so no
requirement entries and no acceptance criteria were extracted. No competing
acceptance variants exist.

This file is intentionally empty, not missing.

Adjacent material deliberately NOT recorded here:

- `docs/design-qa-graph.md` carries PASS-marked rubric lines that superficially
  resemble acceptance criteria. They record verification results of an
  already-shipped implementation, not stated requirements. Extracted to
  `context.md`.
- `docs/design-qa.md` carries an Expected / Measured / Status table. It is a
  record of a QA run against an existing implementation (post-fix measurements),
  not a normative contract. Extracted to `context.md`.
- `docs/e2e-flow-evidence.md` and `docs/perf-baseline.md` carry numeric gates.
  They are recorded measurements against already-set targets, not requirements.
  Extracted to `context.md`.

Downstream note: this doc set describes shipped behavior. It contains no
statement of what the product should do next beyond `docs/graph.md`'s single
deferred item ("Hub graph-metadata sync -- held out of scope until a Hub consumer
exists"), which is recorded in `SYNTHESIS.md` rather than invented as a
requirement here.
