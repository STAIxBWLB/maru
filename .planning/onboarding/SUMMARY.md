# Onboarding Summary

## Project State
- PROJECT.md: present
- REQUIREMENTS.md: present
- ROADMAP.md: present
- STATE.md: present

## Codebase Context
- Brownfield repo: yes
- Map readiness: complete
- Codebase map: .planning/codebase/ (complete codebase map)
- Fast map available: yes

Mapped at v0.4.61. `origin/main` has since taken `b27f082 feat: expand
Scratchpad and Files document editing` and `bc8345e chore(release): v0.4.62`.
Re-map with `/gsd-map-codebase --paths src/` before Phase 4 touches EditorPane.

## Docs Context
- Existing ADR/PRD/SPEC/RFC candidates: 18 ingested from `docs/`
  (13 SPEC, 5 DOC, 0 ADR, 0 PRD)

The repo-root scan finds 60+ markdown files, over the 50-doc cap; the excess is
bundled slide-deck assets under `.context/cli-smoke-home/` and
`src-tauri/skills-bootstrap/`, `graphify-out/` reports, and `sample-workspace/`
fixtures. Real planning docs live only in `docs/`, so ingest was scoped there.

Synthesis produced 64 constraints and 5 context topics in `.planning/intel/`.
Because the set holds no ADRs and no PRDs, `decisions.md` and `requirements.md`
are empty by construction and every constraint is SPEC-tier, overridable by a
future ADR.

The doc set describes shipped behavior and states almost no forward work, so
its constraints are invariants to preserve, not features to build. Milestone 1
draws its phases from `.planning/codebase/CONCERNS.md`.

`.planning/ingest-manifest.yaml` pins `docs/drafts.md` above
`docs/gap-analysis.md` so their mutual see-also cycle has a defined traversal
entry point. Re-running ingest without it re-blocks on that cycle.

## Conflicts Resolved During Onboarding
- `docs/graph.md`: hulls dropped from the V3 capability list (`src/lib/graph/hull.ts`
  is gone, 0 refs in `src/`); color mode stated once against `src/lib/settings.ts`
  (four-valued enum, fresh-install default origin/seal, legacy path pinned to
  app/violet/community).
- `docs/BOUNDARIES.md`: workspace SSOT pointer moved `_sys` to `_meta`.
- `~/workspace/work/_meta/rules/skills-ssot.md`: gained T4 Imported, Managed
  Local renumbered to T5, matching `docs/SSOT-TIERS.md` (work commit de0b0f70).
  The Imported tier is shipped, not planned.

Full report: `.planning/INGEST-CONFLICTS.md`.

## Recommended Next Step
- /gsd-manager
