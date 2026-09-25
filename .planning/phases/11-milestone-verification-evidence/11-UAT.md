---
status: testing
phase: 11-milestone-verification-evidence
source: [11-VERIFICATION.md]
started: 2026-09-25T15:11:03Z
updated: 2026-09-25T15:11:03Z
---

## Current Test

number: 1
name: First push-to-main run of the coverage workflow
expected: |
  After this phase's PR merges, the `coverage` job of `.github/workflows/coverage.yml` runs on `main`, completes, appends a TS and Rust totals table to the run's Job Summary, and uploads a `coverage-report` artifact. Record the run URL, the Job Summary table, and the artifact in 11-EVIDENCE.md's `### Post-merge check` subsection, replacing the `(pending)` placeholders.
awaiting: user response

## Tests

### 1. First push-to-main run of the coverage workflow
expected: The `coverage` job runs on `main` after merge, completes, writes the totals table to the Job Summary, and uploads the `coverage-report` artifact; the run URL, table, and artifact are recorded in 11-EVIDENCE.md.
result: [pending]

## Summary

total: 1
passed: 0
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
