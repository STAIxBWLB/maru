---
status: testing
phase: 07-guardrails-before-churn
source: [07-VERIFICATION.md]
started: 2026-09-05T10:45:00Z
updated: 2026-09-05T10:45:00Z
---

## Current Test

number: 1
name: Run `pnpm exec playwright test e2e/inbox*.spec.ts` (deferred phase-gate regression watch from plans 07-04 and 07-05)
expected: |
  All inbox e2e specs pass — the standalone Inbox pane still lists pending/drop items after the index exclusion (07-04) and switcher removal (07-05)
awaiting: user response

## Tests

### 1. Playwright Inbox-pane regression watch
expected: All inbox e2e specs pass — the standalone Inbox pane still lists pending/drop items after the index exclusion (07-04) and switcher removal (07-05)
result: [pending]

### 2. Backstop UI check: switcher static rows visible/clickable while counts settle
expected: All -> Drafts -> Archive -> Recently Updated render and accept clicks during count settling
result: [pending]

### 3. Backstop UI check: count badges at 0 / 1 / many documents per remaining built-in view
expected: Correct badge values at all three volumes
result: [pending]

### 4. Backstop UI check: Inbox pane populated state (pending + drops, row layout and actions)
expected: Identical to pre-removal behavior
result: [pending]

### 5. Backstop UI check: Inbox pane empty state
expected: Existing empty state renders unchanged
result: [pending]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps
