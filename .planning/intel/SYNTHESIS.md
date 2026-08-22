# Synthesis

Entry point for downstream consumers (gsd-roadmapper). Produced 2026-08-22 by a
re-run of /gsd-ingest-docs synthesis. MODE: new. No existing `.planning/` context
to merge against -- `.planning/` held only `codebase/` from /gsd-map-codebase;
PROJECT.md, REQUIREMENTS.md, ROADMAP.md, and STATE.md were all absent.

## Doc counts by type

18 docs classified, 18 consumed.

- SPEC: 13
- DOC: 5
- ADR: 0
- PRD: 0

All 13 SPECs and all 5 DOCs were extracted. Nothing was withheld.

## Decisions locked

0. There are no ADRs in the set, so there are no locked decisions.
See `decisions.md` for what was deliberately not promoted to a decision entry
(the graph-UI design doc's `## Decisions (user-confirmed)` section, and the
distributed rationale prose in agents.md / drafts.md / kg-references.md /
gap-analysis.md).

## Requirements extracted

0. There are no PRDs in the set. No requirement IDs were minted and no competing
acceptance variants exist. See `requirements.md` for the QA-rubric and
measurement material that was routed to `context.md` instead.

## Constraints

64 entries in `constraints.md`, by type:

- schema: 16
- protocol: 27
- api-contract: 8
- nfr: 13

Grouped by source (precedence-pinned pair first, then default precedence,
alphabetical):

- docs/drafts.md (precedence 10) -- 8
- docs/gap-analysis.md (precedence 11) -- 6
- docs/BOUNDARIES.md -- 2
- docs/SSOT-TIERS.md -- 5
- docs/maru-doctor.md -- 3
- docs/agents.md -- 7
- docs/diagram.md -- 6
- docs/graph.md -- 9
- docs/kg-references.md -- 4
- docs/phase2-ai-boundary.md -- 4
- docs/studio.md -- 4
- docs/superpowers/specs/2026-07-12-graph-ui-obsidian-design.md -- 4
- docs/superpowers/plans/2026-07-12-graph-ui-obsidian.md -- 2

## Context topics

5 topics in `context.md`, one per DOC:

- Today mode visual QA (docs/design-qa.md)
- Graph canvas-first redesign design QA (docs/design-qa-graph.md)
- E2E flow evidence (docs/e2e-flow-evidence.md)
- Performance verification for issue #201 (docs/perf-baseline.md)
- macOS browser passkeys operator runbook (docs/macos-passkeys.md)

## Conflicts

0 blockers, 1 competing-variant warning, 4 auto-resolved / informational.

Detail: `.planning/INGEST-CONFLICTS.md`

The one WARNING is a tier-numbering divergence between `docs/SSOT-TIERS.md` (five
tiers, T4 Imported / T5 Managed Local) and
`~/workspace/work/_meta/rules/skills-ssot.md` (four tiers, T4 Managed Local, no
Imported tier), which `docs/BOUNDARIES.md` declares authoritative and requires to
be updated in the same change set. It was decided in favour of docs/SSOT-TIERS.md and
the workspace rule was corrected to match (work commit de0b0f70); see the
post-report resolution in INGEST-CONFLICTS.md. The tier map is settled.

## Previous-run items verified resolved (not carried into the report)

Checked against the current files on 2026-08-22, not taken on report:

- Hull removal. `src/lib/graph/hull.ts` does not exist and `grep -rniE "hull"
  src/` returns 0 matches. `docs/graph.md` contains no hull mention. The only
  remaining hull references in the repo are in the two superpowers docs that
  mandate the removal, which is consistent. Resolved.
- Graph default color mode. The enum is four-valued at `src/lib/settings.ts:391`;
  `defaultGraphDisplay` (`src/lib/settings.ts:469-478`) returns colorMode
  "origin" / theme "dark" / accent "seal"; `normalizeLegacyGraphDisplay`
  (`src/lib/settings.ts:1322-1338`) pins colorMode "community" / theme "app" /
  accent "violet" for pre-V3 data. `docs/graph.md:101-108` states all three
  consistently. Resolved. (A residual DOC-vs-SPEC wording mismatch in
  design-qa-graph.md is logged as INFO, auto-resolved by precedence.)
- BOUNDARIES.md SSOT pointer. `docs/BOUNDARIES.md:5` points at
  `~/workspace/work/_meta/rules/skills-ssot.md`, which exists on disk;
  `~/workspace/work/_sys` does not exist. Resolved. (The pointer is correct; the
  divergence in what it points at is the separate WARNING above.)
- Cross-reference cycle. Still present by design, now resolvable via the manifest
  precedence pin. Downgraded from BLOCKER to INFO, with both docs extracted.

## Pointers

- `.planning/intel/constraints.md` -- 64 technical constraints from the 13 SPECs
- `.planning/intel/context.md` -- 5 context topics from the 5 DOCs
- `.planning/intel/decisions.md` -- empty by design (0 ADRs)
- `.planning/intel/requirements.md` -- empty by design (0 PRDs)
- `.planning/INGEST-CONFLICTS.md` -- conflict report, three buckets
- `.planning/intel/classifications/` -- 18 per-doc classification JSON files
- `.planning/ingest-manifest.yaml` -- types and the precedence pins

## Notes for the roadmapper

This doc set describes shipped behavior. It states almost no forward work. The
only explicit deferral anywhere in the set is `docs/graph.md`: "The only
remaining Phase 8 item is Hub graph-metadata sync -- held out of scope until a
Hub consumer exists." Forward-looking material beyond that is not present in
these docs and was not invented; `.planning/codebase/CONCERNS.md` is the better
source for candidate work items.
