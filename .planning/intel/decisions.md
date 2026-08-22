# Decisions (from ADR-classified docs)

No ADRs in the ingest set. 0 of 18 classified docs carry type `ADR`, so no
decision entries and no locked decisions were extracted.

This file is intentionally empty, not missing. Downstream consumers should treat
the absence of locked decisions as a fact about this doc set, not as a gap to
fill by inference.

Adjacent material deliberately NOT recorded here:

- `docs/superpowers/specs/2026-07-12-graph-ui-obsidian-design.md` carries a
  `## Decisions (user-confirmed)` section and `Status: approved (design)`. The
  manifest types it `SPEC` (`manifest_override: true`) and its status is
  "approved (design), pending implementation plan", not an ADR `Accepted`. Its
  content was extracted to `constraints.md` as implementation contract, and
  `locked` is false.
- `docs/agents.md`, `docs/drafts.md`, `docs/kg-references.md`, and
  `docs/gap-analysis.md` embed design rationale prose ("exists as a tab rather
  than an app mode because...", "Trade-off:"). This is distributed rationale for
  one subsystem, not a recorded decision with a status, and was not promoted to a
  decision entry.
