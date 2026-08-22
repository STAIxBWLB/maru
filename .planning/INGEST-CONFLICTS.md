## Conflict Detection Report

Run: 2026-08-22, re-run of /gsd-ingest-docs synthesis. MODE new.
Set: 18 docs (13 SPEC, 5 DOC, 0 ADR, 0 PRD). No existing .planning context to
check against (PROJECT.md / REQUIREMENTS.md / ROADMAP.md / STATE.md all absent).
Fresh report -- resolved entries from the previous pass are not carried forward.

### BLOCKERS (0)

None. The previous pass reported one blocker (cross-reference cycle
docs/drafts.md <-> docs/gap-analysis.md). The cycle still exists in the source
files, but the manifest now pins an explicit traversal entry point, so it no
longer blocks synthesis. Recorded under INFO with current evidence.

### WARNINGS (1)

[WARNING] Skill tier numbering diverges from the SSOT this doc set names as authoritative
  Found: docs/SSOT-TIERS.md defines five tiers -- T4 Imported
    (`~/.maru/skills/_imported/skills/<name>/`, change path `maru skills import`)
    and T5 Managed Local (`~/.maru/skills/_managed/<name>/`).
  Found: docs/BOUNDARIES.md:3-5 declares this doc set a mirror of
    `~/workspace/work/_meta/rules/skills-ssot.md`, and states a Conflict Rule:
    "If a change needs to alter this ownership table, update both repositories'
    boundary documents in the same change set."
  Found: that file defines four tiers, with T4 Managed Local at
    `~/.maru/skills/_managed/<name>/` and no Imported tier at all
    (~/workspace/work/_meta/rules/skills-ssot.md:8-13, verified on disk
    2026-08-22).
  Found: .planning/codebase/CONCERNS.md ("Skill registry and install targets")
    independently reports "Five ownership tiers", matching the repo doc, not the
    workspace rule.
  Impact: The identifier "T4" resolves to two different tiers depending on which
    document a reader opens. Any downstream plan touching install, sync, or
    reconcile paths inherits an ambiguous tier map, and the doc set's own
    Conflict Rule is currently violated. Precedence cannot resolve this: the
    named authority is outside the ingest set, so no automatic winner is defined.
  → Decide which is correct and make the two agree in one change set: either
    renumber docs/SSOT-TIERS.md to match the workspace rule, or add the Imported
    tier to ~/workspace/work/_meta/rules/skills-ssot.md and renumber Managed
    Local to T5 there. Until then, do not treat either tier map as settled.

### INFO (4)

[INFO] Cross-reference cycle retained by design, traversed from the pinned entry point
  Found: docs/drafts.md:158 and :199 link to gap-analysis.md;
    docs/gap-analysis.md:18 links back to drafts.md. The cycle is still present
    (verified 2026-08-22) -- it was not broken, and no other cycle exists in the
    18-doc cross-ref graph (max traversal depth 2, well under the cap of 50).
  Note: .planning/ingest-manifest.yaml pins docs/drafts.md precedence 10 and
    docs/gap-analysis.md precedence 11 (lower = higher precedence). drafts.md is
    the upstream producer of the frozen baseline gap-analysis.md consumes, so it
    is the defined traversal entry point. Both docs were traversed from
    drafts.md and constraints were extracted from BOTH; nothing was withheld this
    run. The two links are complementary see-also prose, not a dependency
    inversion.

[INFO] Auto-resolved: docs/drafts.md (precedence 10) > docs/gap-analysis.md (11) on the task-promotion baseline
  Found: docs/gap-analysis.md:16-18 states `drafts_promote` "freezes the draft
    body, byte for byte" to `<work>/.maru/drafts/<id>/baseline.md".
  Found: docs/drafts.md:191-197 states that for a Task target the baseline is
    read back from the created note rather than reused from the draft body,
    because `create_task_note` injects `status`/`title` frontmatter -- freezing
    the raw body made every task promotion report its own generated frontmatter
    as a human edit.
  Note: The higher-precedence source wins; constraints.md records the
    read-back behavior. gap-analysis.md corroborates it elsewhere in its own
    text ("an older task baseline (frozen before the read-back fix)"), so its
    Baseline section wording is stale rather than contradictory in intent. No
    user action required, but gap-analysis.md:16-18 would be more accurate with
    the task-target carve-out spelled out.

[INFO] Auto-resolved: SPEC docs/graph.md > DOC docs/design-qa-graph.md on default color mode and accent
  Found: docs/design-qa-graph.md rubric asserts "the default canvas is near-black
    with subdued neutral nodes and edges", and its Evidence block records the
    capture state as "dark theme, neutral color mode, violet accent".
  Found: docs/graph.md:101-108 states the fresh-install defaults are dark theme,
    seal accent, origin colors, and that only legacy default displays keep the
    app theme with violet accent and community colors.
  Note: SPEC outranks DOC by default precedence, and the code agrees with the
    SPEC -- src/lib/settings.ts:469-478 (`defaultGraphDisplay`) returns
    colorMode "origin", theme "dark", accent "seal"; src/lib/settings.ts:1322-1338
    (`normalizeLegacyGraphDisplay`) deliberately pins colorMode "community",
    theme "app", accent "violet" for pre-V3 data; the enum at
    src/lib/settings.ts:391 is four-valued
    "neutral" | "domain" | "community" | "origin". design-qa-graph.md's line
    describes the neutral-mode state it captured, not the shipped default;
    context.md records it with that qualification. Nothing to fix in graph.md.

[INFO] Declared external SSOT for docs/graph.md sits outside the ingest set
  Found: docs/graph.md:22 names
    `_meta/migrations/2607-deep-restructure/specs/maru-vault-graph-spec.md`
    (DR-020) as the "Spec 정본 (work repo)", which would outrank docs/graph.md on
    conflict.
  Note: That file exists (~/workspace/work/..., 15,911 bytes, verified
    2026-08-22) but is not part of the 18-doc ingest set, so nothing from it was
    extracted. It was checked for contradictions on the topics graph.md's
    constraints cover (settings schema version, GraphSettings shape, color mode,
    defaults, hulls) and contains no mention of any of them, so no contradiction
    was found. docs/graph.md was taken at face value for those constraints. If a
    later pass needs the vault-graph spec as authority, add it to the manifest.

---

## Post-report resolution (2026-08-22)

[RESOLVED] Skill tier numbering divergence
  The WARNING above was decided in favour of docs/SSOT-TIERS.md. The Imported
  tier is shipped, not planned: ~/.maru/skills/_imported exists on disk,
  `maru skills import` and `maru skills import-unmanage` are real CLI commands
  (src-tauri/src/cli.rs:709,719,967), and the skill store creates _sources,
  _managed, _imported and _cache together (src-tauri/src/skill_host/store.rs:1238,2659).
  ~/workspace/work/_meta/rules/skills-ssot.md was the stale side and now carries
  T4 Imported and T5 Managed Local, matching this repo (work commit de0b0f70).
  Both sides of the BOUNDARIES.md Conflict Rule moved. The tier map is settled;
  downstream plans may rely on it.
