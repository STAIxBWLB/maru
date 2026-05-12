---
name: business-unit-lifecycle
description: >
  Create and manage standard business-unit project folders. Use when starting a
  new funded project, 사업단, government program, ODA program, research
  program, or yearly project cycle; when adding a YYYY-YN year folder; or when
  deciding where proposal, governance, reporting, evidence, settlement, and
  closure materials belong.
---

# Business Unit Lifecycle

Create standardized project folders for new business units and add yearly
cycles to existing units. This skill is public-safe: do not embed personal
identity, institutional private details, real credentials, or local absolute
paths in the skill package.

## Boot Sequence

1. Find `workspace.config.yaml` by walking up from the current directory.
2. Treat the workspace root as the directory containing that file.
3. Read `project-registry.yaml` only when you need to inspect existing project
   IDs or avoid duplicate routes.
4. Read `references/lifecycle.md` before changing or evaluating a business-unit
   structure.

## Create A New Business Unit

Use the bundled script whenever the user asks to create the standard structure:

```bash
python3 ~/.anchor/skills/business-unit-lifecycle/scripts/new_business_unit.py <domain> <slug> [--start-year YYYY]
```

If the skill is being edited from the source repo, run the source script:

```bash
python3 dev/anchor/skills/skills/business-unit-lifecycle/scripts/new_business_unit.py <domain> <slug> [--start-year YYYY]
```

The script creates `projects/<domain>/<slug>/`, optionally creates
`<YYYY>-Y1/`, writes a project README, and prints a registry stub. It does not
edit `project-registry.yaml`; add the stub manually only when the user asks.

## Add A Year Cycle

```bash
python3 ~/.anchor/skills/business-unit-lifecycle/scripts/new_year_cycle.py <slug> <year> [--domain DOMAIN] [--year-number N]
```

The script finds `projects/*/<slug>` when `--domain` is omitted and only
continues if there is exactly one match.

## Routing Guidance

- Proposal and selection materials go under `00-initiation/`.
- Organization, committees, consortium, policy, and compliance materials go
  under `10-governance/`.
- Cross-year references, meetings, communications, contacts, and reusable
  assets go under `20-shared/`.
- Year-specific execution, monitoring, reporting, evaluation, settlement, and
  closeout materials go under the active `YYYY-YN/` folder.
- Keep unresolved incoming material in `_inbox/` only temporarily.
- Keep current canonical files out of `_archive/`.

## References

- `references/lifecycle.md` - lifecycle v1 tree, fields, and routing rules
- `templates/standard-business-unit/` - copied by the bundled scripts
