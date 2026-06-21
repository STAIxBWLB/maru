# Business Unit Lifecycle v2

This is the document-category overlay (Tree B) of the
`business-unit-lifecycle` skill contract.

Canonical rule: `_sys/rules/bu-lifecycle.md` §2 (standard tree). Runtime
placement of files into any project is governed by
`_sys/rules/folder-placement.md`; this skill owns only NEW-BU tree creation.

## Standard Tree

```text
projects/{domain}/{slug}/
├── 00-readme/
│   ├── README.md
│   ├── bu-config.yaml           # view copy of .anchor/bu-config.yaml
│   ├── contact-tree.md          # 담당/대리/결재 line
│   └── kpi-targets.md           # yearly KPI targets
├── 01-formal-reports/           # 정형보고
│   └── index.md
├── 02-admin-approvals/          # 행정결재
│   ├── change-requests/
│   └── index.md
├── 03-evidence-cert/            # 증빙·인증
│   ├── audits/
│   ├── certifications/
│   └── index.md
├── 04-operations/               # 운영문서
│   ├── proposals/
│   ├── specs/
│   ├── guides/
│   └── index.md
├── 05-decks/                    # 발표 덱 (per-slug deck job)
├── _inbox/                      # temporary intake (universal special)
├── _archive/                    # old versions (universal special)
└── .anchor/
    └── bu-config.yaml           # primary BU metadata
```

## Year Partition

Tree B nests the calendar year **inside** categories. There is no top-level
`YYYY-YN/` folder. Adding a year creates these leaves under the BU root, each
seeded with a `.gitkeep`:

```text
01-formal-reports/{YYYY}/{monthly, quarterly, annual, interim}/
02-admin-approvals/{YYYY}/{internal-approval, external-dispatch, proposal, expense}/
03-evidence-cert/{YYYY}/{receipts, contracts, invoices, payments, attendance, certificates}/
04-operations/meetings/{YYYY}/
04-operations/trips/{YYYY}/
04-operations/events/{YYYY}/
```

The `02-admin-approvals/{YYYY}/` leaves use English slugs
(`internal-approval/external-dispatch/proposal/expense`) to satisfy the
no-Korean-dirname naming policy; the canonical rule shows the Korean labels.

## Root Areas

| Area | Purpose |
|------|---------|
| `00-readme/` | README, bu-config view copy, contact tree, KPI targets. |
| `01-formal-reports/` | 정형보고. Year partitions under `{YYYY}/`. |
| `02-admin-approvals/` | 행정결재 and change requests. Year partitions under `{YYYY}/`. |
| `03-evidence-cert/` | 증빙·계약·인보이스·인증·감사. Year partitions under `{YYYY}/`; audits and certifications are flat. |
| `04-operations/` | meetings/trips/events (year-partitioned), proposals, specs, guides. |
| `05-decks/` | 발표 덱. One subfolder per deck job. |
| `_inbox/` | Temporary holding area before routing. Do not keep canonical files here. |
| `_archive/` | Old versions, discarded drafts, migration snapshots, outgoing packages. |
| `.anchor/` | Primary `bu-config.yaml` (plus tooling state). |

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

`stage` values are the Tree B categories (e.g. `01-formal-reports`,
`04-operations`). Omit `year` for cross-year areas such as `00-readme/`.

## Registry Stub Fields

The bundled scripts print a registry stub. They do not edit the registry.

```yaml
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

Lifecycle stage values are `initiation`, `implementing`, `closing`, and
`closed`. Update them manually because stage transitions depend on real
administrative decisions.
