---
name: vault-next
trigger: /vault-next
description: Recommend the highest-value next action for the vault
---

# /vault-next

Analyze vault state and recommend the most valuable next action.

## Process

1. Check ops/queue/ for pending items
2. Evaluate maintenance conditions:
   - Orphan notes (need /vault-connect)
   - Stale notes > 90 days (need /vault-update)
   - Inbox size (need /vault-extract or /vault-pipeline)
   - Observation/tension count (need /vault-rethink)
3. Consider recent activity patterns
4. Rank actions by impact

## Priority Order
1. Critical: schema violations, broken links
2. High: inbox overflow, orphan drift
3. Medium: stale notes, pending observations
4. Low: optimization, MOC refinement

## Output
- Recommended action with reasoning
- Estimated effort
- Command to execute
