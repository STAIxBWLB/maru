---
name: business-unit-lifecycle
description: >
  Create and manage standard business-unit project folders. Use when starting a
  new funded project, 사업단, government program, ODA program, research
  program, application/renewal cycle unit, or yearly project cycle; when adding
  a calendar-year partition; when graduating a selected cycle unit to the
  managed tree; or when deciding where reports, approvals, evidence,
  operations, and deck materials belong.
---

# Business Unit Lifecycle

Create standardized project folders (Tree C grammar) and manage their
lifecycle. This skill is public-safe: do not embed personal identity,
institutional private details, real credentials, or local absolute paths in
the skill package.

Grammar SSOT: workspace `_meta/rules/naming-and-placement.md` (§B profiles,
§B1a numbering, §E canonical vocabulary; DR-026). New directories must use
canonical slugs from §E.

## Boot Sequence

1. Find `workspace.config.yaml` by walking up from the current directory.
2. Treat the workspace root as the directory containing that file.
3. Read `project-registry.yaml` only when you need to inspect existing project
   IDs or avoid duplicate routes.
4. Read `references/lifecycle.md` before changing or evaluating a business-unit
   structure.

## Create A New Business Unit (proposal-first)

```bash
python3 ~/.maru/skills/business-unit-lifecycle/scripts/new_business_unit.py <domain> <slug> [--start-year YYYY] [--with 01,04]
```

The default scaffold is minimal: README + `00-readme/` charter +
`06-proposal/` + `_incoming/` `_archive/`. Categories 01~05 are never
pre-created empty (naming-and-placement §B2); pass `--with 01,04` to activate
categories that have a real obligation from day one. With `--start-year`,
year leaves are seeded only under active categories. The script prints a
registry stub; add it manually only when the user asks.

## Create A Cycle Unit (application/renewal, §B6)

```bash
python3 ~/.maru/skills/business-unit-lifecycle/scripts/new_business_unit.py <domain> <slug> --profile cycle [--stages 01-announcement,04-proposal]
```

Cycle units hold one external selection cycle as numbered `NN-<stage>/` dirs
(order-only numbers, gaps allowed). The registry stub includes the required
`profile: cycle` pin. Recommended stage vocabulary: 01-announcement,
02-eligibility, 03-self-evaluation, 04-proposal, 05-budget, 06-interview,
07-agreements, 08-contracting.

## Add A Year Cycle

```bash
python3 ~/.maru/skills/business-unit-lifecycle/scripts/new_year_cycle.py <slug> <year> [--domain DOMAIN]
```

Seeds the calendar-year partition only under categories that already exist
(first `new_year_cycle` run after selection doubles as 01~03 activation only
if those category dirs were already created for real content). Errors out if
`01-formal-reports/<year>` already exists.

## Graduate A Cycle Unit (selection won)

```bash
python3 ~/.maru/skills/business-unit-lifecycle/scripts/graduate_unit.py projects/<domain>/<slug> --year YYYY -o manifest.json
```

Emits a `migrate_tree.py`-compatible manifest implementing the DR-025 §5
mapping (announcement→`06-proposal/announcement/`,
self-evaluation→`01-formal-reports/YYYY/`, agreements→
`03-evidence-cert/YYYY/contracts/`, ...). It never moves files itself; run
the workspace tool with `--dry-run` first. Afterwards remove the unit's
`profile: cycle` registry pin and regenerate `structure.md` in the same
commit.

## Routing Guidance

- README, bu-config, contact tree, and KPI targets go under `00-readme/`.
- 정형보고 / formal reports go under `01-formal-reports/`.
- 행정결재 / approvals / change requests go under `02-admin-approvals/`
  (`internal-approval/`, `official-documents/`).
- 증빙·계약·인보이스·인증 / evidence / contracts / certs go under
  `03-evidence-cert/YYYY/<kind>/` (the six kind names are app-detected).
- meetings (local copies), trips, refs, and domain dirs go under
  `04-operations/`.
- 발표 덱 / decks go under `05-decks/<slug>/` (canon lives in the global
  `presentations/`).
- Keep unresolved incoming material in `_incoming/` only temporarily; keep old
  versions in `_archive/`.
- Runtime file placement into ANY project (incl. routed inbox items) follows
  workspace `_meta/rules/naming-and-placement.md` §C; this skill owns only
  unit tree creation and lifecycle transitions.

## References

- `references/lifecycle.md` - Tree C profiles, year partition, graduation table
- `templates/standard-business-unit/` - copied by `new_business_unit.py`
