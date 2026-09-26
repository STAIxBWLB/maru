---
name: vault-stats
trigger: /vault-stats
description: Show vault statistics and health overview
---

# /vault-stats

Display comprehensive vault statistics. Numbers only; the "what to do next" recommendation is `/vault-next`.

## Metrics

1. **Size**: total notes, by type, by domain
2. **MOCs**: domain MOC note counts, topic MOC list
3. **Connections**: average links per note, orphan count/ratio
4. **Sync lag**: days since `ops/sessions/last-sync-timestamp`
5. **Activity**: recently created/modified notes
6. **Growth**: notes per week/month trend
7. **Quality**: schema compliance rate

## Process

Do not recompute what the lint/graph pipeline already produces:

1. Size / MOCs / Activity / Growth: list `vault/notes/` (`mcp__obsidian__list_directory`, `get_notes_info`) and parse frontmatter (type, domain)
2. Connections (edges, density, top hubs): read the latest `reports/graph-report-YYMMDD.md` and `reports/graph-trend.md`
3. Orphan count and schema compliance: run `~/.maru/env/.venv/bin/python3 ~/.maru/skills/vault-lint/scripts/lint.py --vault <vault.path>` and take the L03 / L02 counts (same numbers `/vault-lint vault` reports)
4. Read `ops/sessions/last-sync-timestamp`
5. Assemble metrics

## Output
- Formatted statistics report
- Highlight any metrics outside healthy thresholds
