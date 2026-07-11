# Business Unit Lifecycle (Tree C)

This is the lifecycle overlay of the `business-unit-lifecycle` skill contract.

Canonical rule: workspace `_meta/rules/naming-and-placement.md` §B (Tree C
profiles), §B1a (numbering), §E (canonical vocabulary); decision record
DR-026. Runtime placement of files into any project is governed by
`_meta/rules/naming-and-placement.md` §C; this skill owns unit tree creation
and lifecycle transitions only.

## Profiles (Tree C)

Every unit is a maturity profile of one tree grammar:

| Profile | Shape | Note |
|---|---|---|
| L0 seed | `README.md` only | ≤5 files |
| L1 core | README + vocabulary dirs (`docs/ meetings/ refs/ mous/ ...`) | unnumbered |
| L2 operational | L1 + free domain dirs + years module (`YYYY/`, `00-<spine>/`, `<series>/YYYY/`) | |
| cycle | numbered `NN-<stage>/` dirs, gaps allowed | registry `profile: cycle` pin required |
| L3 managed | spine 00~07, obligation-activated | this skill's main scaffold |
| code-keep | untouchable code repo | |

This skill scaffolds L3 seeds (proposal-first) and cycle units, adds year
partitions, and generates graduation manifests.

## Standard Tree (L3 scaffold seed)

New units start proposal-first; 01~05 are activated per obligation, never as
empty scaffolds (§B2):

```text
projects/{domain}/{slug}/
├── README.md
├── 00-readme/
│   ├── README.md
│   ├── bu-config.yaml           # view copy of .maru/bu-config.yaml
│   ├── contact-tree.md          # 담당/대리/결재 line
│   └── kpi-targets.md           # yearly KPI targets
├── 06-proposal/                 # pre-selection space (subdirs on demand)
├── _incoming/                   # temporary intake (universal special)
├── _archive/                    # old versions (universal special)
└── .maru/
    └── bu-config.yaml           # primary BU metadata
```

Full spine when activated: `01-formal-reports/`, `02-admin-approvals/`,
`03-evidence-cert/`, `04-operations/`, `05-decks/`, `06-proposal/`,
`07-external-eval/<agency>/<YYYY>/`. The physical names
`02-admin-approvals/` and `03-evidence-cert/` plus the six evidence kind
subdir names are Maru app contracts; never rename them.

## Year Partition

Tree C nests the calendar year **inside** categories. There is no top-level
`YYYY/` folder in an L3 unit. Adding a year seeds these leaves, only under
categories that already exist:

```text
01-formal-reports/{YYYY}/
02-admin-approvals/{YYYY}/{internal-approval, official-documents}/
03-evidence-cert/{YYYY}/
04-operations/meetings/{YYYY}/
```

Evidence kind subdirs (`receipts/ contracts/ invoices/ payments/ attendance/
certificates/`) are created on demand; the Maru app detects the six kind
names anywhere in the path. Trips and events canon lives in the global
`trips/` and `events/`; a unit keeps only references/copies under
`04-operations/`.

## Cycle Units (§B6)

One external selection cycle per unit: numbered `NN-<stage>/` dirs where the
number means order only and gaps are allowed. Recommended stage vocabulary:
`01-announcement, 02-eligibility, 03-self-evaluation, 04-proposal, 05-budget,
06-interview, 07-agreements, 08-contracting`. Registry pin `profile: cycle`
is required (never inferred).

## Graduation (cycle → L3, DR-025 §5)

`graduate_unit.py` emits a `migrate_tree.py` manifest with this mapping:

| Stage slug | Destination |
|---|---|
| announcement, refs | `06-proposal/announcement/` |
| eligibility(-eval), interview, review | `06-proposal/review/` |
| self-evaluation | `01-formal-reports/{YYYY}/` |
| proposal | `06-proposal/final/` |
| budget | `06-proposal/budget/` |
| agreements | `03-evidence-cert/{YYYY}/contracts/` |
| contracting | `06-proposal/contracting/` |
| (other) | `04-operations/<slug>/` |

The workspace tool performs the moves, reference rewriting, and path-map
updates. Afterwards: remove the `profile: cycle` pin and regenerate
`structure.md` in the same commit.

## Root Areas

| Area | Purpose |
|------|---------|
| `00-readme/` | README, bu-config view copy, contact tree, KPI targets. |
| `01-formal-reports/` | 정형보고. Year partitions under `{YYYY}/`. |
| `02-admin-approvals/` | 행정결재 (`internal-approval/`, `official-documents/`), change requests. |
| `03-evidence-cert/` | 증빙·계약·인보이스·인증. Year partitions under `{YYYY}/<kind>/`. |
| `04-operations/` | meetings (copies), refs, domain dirs. Canonical vocabulary per §E. |
| `05-decks/` | 발표 덱. One subfolder per deck job; canon in global `presentations/`. |
| `06-proposal/` | Pre-selection space: announcement/drafts/final/review/contracting. |
| `07-external-eval/` | External evaluations per `<agency>/<YYYY>/`. |
| `_incoming/` | Temporary holding area before routing. No canonical files here. |
| `_archive/` | Old versions, discarded drafts, migration snapshots. |
| `.maru/` | Primary `bu-config.yaml` (plus tooling state). |

## Frontmatter

Use this minimal shape for Markdown files created inside a business unit:

```yaml
type: report
project: govt-example
domain: projects
status: draft
description: "one-line summary"
stage: 01-formal-reports
year: 2026
lifecycle_schema: business-unit-lifecycle-v2
```

`stage` values are the spine categories (e.g. `01-formal-reports`,
`04-operations`). Omit `year` for cross-year areas such as `00-readme/`.

## Registry Stub Fields

The bundled scripts print a registry stub. They do not edit the registry.

```yaml
profile: cycle            # cycle units only (pin, §B6); omit for inferred profiles
lifecycle_schema: business-unit-lifecycle-v2
lifecycle_stage: initiation
current_year: 2026
start_date:
end_date:
funding_source: ""
total_budget:
headquarters_director: ""
migrated: true
```

Lifecycle stage values are `proposal`, `initiation`, `implementing`,
`closing`, and `closed`. Update them manually because stage transitions
depend on real administrative decisions.
