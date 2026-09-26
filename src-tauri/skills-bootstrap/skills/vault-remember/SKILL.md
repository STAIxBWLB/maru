---
name: vault-remember
trigger: /vault-remember
description: Record an operational observation or methodology learning
---

# /vault-remember [observation]

Record an observation about methodology, process, or friction for later review.

**Not for**: knowledge — facts, decisions, insights about the world or the user's projects belong in `notes/` via `/vault-learn` (approval gate + LEARN log) or `/vault-extract`. `/vault-remember` only writes `ops/observations/` entries that `/vault-rethink` consumes.

## Input
- observation: text describing what was observed

## Categories
- **methodology**: how the vault methodology works (or doesn't)
- **process**: workflow improvements or issues
- **friction**: points where the system feels awkward
- **surprise**: unexpected outcomes (positive or negative)
- **quality**: note quality patterns

## Process

1. Determine category from observation content
2. Create timestamped entry in `ops/observations/` via `mcp__obsidian__write_note` (vault markdown — MCP only)
3. Filename: YYYYMMDD-brief-description.md
4. Content: observation text, category, context
5. Check observation count against rethink threshold (10+)

## Rule Zero
The methodology is the spec. Observations accumulate evidence for methodology changes, but changes require explicit /vault-rethink review.

## Output
- Confirmation with category and file path
- Warning if rethink threshold reached
