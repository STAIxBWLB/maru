---
status: testing
phase: 05-shell-decomposition-completion
source: [05-VERIFICATION.md]
started: 2026-08-26T23:05:28Z
updated: 2026-08-26T23:05:28Z
---

# Phase 05 - Native UAT

## Current Test

number: 1
name: Documents native flow
expected: |
  Query and filter work, revealing the same path twice works, favorite/unfavorite
  stays correct, and applying a file queue produces the expected filesystem result.
awaiting: user response

## Tests

### 1. Documents native flow

expected: Query/filter, repeated reveal, favorite/unfavorite, and file-queue application preserve prior behavior and filesystem results.
result: pending

### 2. Terminal native flow

expected: Spawn/input/output, bottom/right dock, split/resize, Terminal/Graph switch, hide/show, kill, and recreate all work in the fresh Tauri app.
result: pending

### 3. Registry placement and lazy loading

expected: Representative modes open in primary and right placement with unchanged navigation, focus, fallback, and visible output; a lazy-loaded mode initializes correctly.
result: pending

### 4. Recycled terminal generation

expected: An operation carrying a stale session generation is rejected while the recreated current session continues to work.
result: pending

### 5. Native render isolation

expected: Document, terminal, and mode-local actions do not visibly refresh MainApp or unrelated panes.
result: pending

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps

None recorded.
