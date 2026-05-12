# Business Unit Lifecycle v1

This is the first version of the `business-unit-lifecycle` skill contract.

## Standard Tree

```text
projects/{domain}/{slug}/
├── README.md
├── _inbox/
├── _templates/
├── _archive/
├── 00-initiation/
│   ├── 01-opportunity/
│   ├── 02-feasibility/
│   ├── 03-partnerships/
│   ├── 04-proposal/
│   │   ├── drafts/
│   │   ├── attachments/
│   │   └── submitted/
│   ├── 05-evaluation/
│   └── 06-agreement/
├── 10-governance/
│   ├── organization/
│   ├── committees/
│   ├── consortium/
│   ├── policies/
│   └── compliance/
├── 20-shared/
│   ├── refs/
│   ├── meetings/
│   ├── communications/
│   ├── contacts/
│   └── assets/
├── YYYY-Y1/
│   ├── 01-notice/
│   ├── 02-planning/
│   ├── 03-execution/
│   │   ├── programs/
│   │   ├── budget/
│   │   ├── procurement/
│   │   ├── hr/
│   │   ├── contracts/
│   │   ├── deliverables/
│   │   ├── evidence/
│   │   ├── events-trips/
│   │   └── change-requests/
│   ├── 04-monitoring/
│   ├── 05-reporting/
│   ├── 06-evaluation/
│   ├── 07-settlement/
│   └── 08-year-close/
└── 99-closure/
    ├── final-report/
    ├── final-settlement/
    ├── asset-disposition/
    ├── sustainability/
    └── archive-index/
```

## Root Areas

| Area | Purpose |
|------|---------|
| `_inbox/` | Temporary holding area before routing. Do not keep canonical files here. |
| `_templates/` | Project-specific forms, prompts, and checklists. |
| `_archive/` | Old versions, discarded drafts, migration snapshots, and outgoing packages. |
| `00-initiation/` | Discovery, feasibility, partnerships, proposal, evaluation, and agreement. |
| `10-governance/` | Organization, committees, consortium, policies, and compliance. |
| `20-shared/` | Cross-year references, meetings, communications, contacts, and assets. |
| `YYYY-YN/` | One yearly operating cycle. Single-year projects still use `YYYY-Y1`. |
| `99-closure/` | Whole-project final report, settlement, asset disposition, sustainability, and archive index. |

## Year Cycle

| Stage | Purpose |
|-------|---------|
| `01-notice/` | Yearly notice, budget allocation, operating guide. |
| `02-planning/` | Year plan, budget plan, KPI, staffing, schedule. |
| `03-execution/` | Programs, spending, procurement, HR, contracts, deliverables, evidence, events, change requests. |
| `04-monitoring/` | Issues, risks, monthly checks, KPI tracking. |
| `05-reporting/` | Interim, annual, ad hoc reports and submissions. |
| `06-evaluation/` | Self-evaluation, external evaluation, Q&A, results. |
| `07-settlement/` | Interim/final settlement, audit, financial evidence. |
| `08-year-close/` | Handoff, retrospective, next-year bridge. |

## Frontmatter

Use this minimal shape for Markdown files created inside a business unit:

```yaml
type: report
project: govt-example
domain: projects
status: draft
description: "one-line summary"
stage: 03-execution
year: 2026-Y1
lifecycle_schema: business-unit-lifecycle-v1
```

Omit `year` only for root cross-year areas such as `00-initiation/`,
`10-governance/`, `20-shared/`, and `99-closure/`.

## Registry Stub Fields

The bundled scripts print a registry stub. They do not edit the registry.

```yaml
lifecycle_schema: business-unit-lifecycle-v1
lifecycle_stage: initiation
current_year: 2026-Y1
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
