---
status: complete
phase: 07-guardrails-before-churn
source: [07-VERIFICATION.md, 07-UI-SPEC.md]
started: 2026-09-05T02:50:24Z
updated: 2026-09-05T02:54:34Z
executor: Codex, direct execution requested by user
---

## Current Test

[testing complete]

## Tests

### 1. Playwright Inbox-pane regression watch
expected: Existing Inbox E2E checks pass after document-index exclusion and switcher removal.
result: pass
source: automated
observed: 8/8 existing E2E tests passed in 38.2 seconds. Covered Inbox mode restore, dashboard entry and automated/manual count split, and primary/right-pane containment at multiple widths.
evidence: smoke.spec.ts, dashboard.spec.ts, workbench-layout.spec.ts; exact command below.

### 2. Switcher static rows visible and clickable while counts settle
expected: All -> Drafts -> Archive -> Recently Updated render and accept clicks before scan counts settle.
result: pass
source: automated and screenshot inspection
observed: Held scanVault unresolved behind a browser-only promise. All four rows were present in order and each became active on a real Playwright click while the promise remained unresolved, at all three volumes. Released the promise and repeated all four clicks.
evidence: uat-evidence/results.json; uat-evidence/counts-9582-settling.png; uat-evidence/check.cjs

### 3. Count badges at zero, one and many documents
expected: Correct badges for All, Drafts, Archive and Recently Updated without overflow or stale values.
result: pass
source: automated and screenshot inspection
observed: Each badge showed 0, 1 and 9582 for the corresponding isolated fixture. Each fixture document is a current draft under archive/, so membership in all four views is intentional. Badge scrollWidth equals clientWidth (7, 6 and 29 pixels). No page errors. Active view updates on clicks.
evidence: uat-evidence/counts-0.png; uat-evidence/counts-1.png; uat-evidence/counts-9582.png; uat-evidence/results.json

### 4. Inbox populated state and actions
expected: Pending items and drop/auto arrivals keep the pre-removal row layout and actions.
result: pass
source: automated and screenshot inspection
observed: One pending item, one automatic arrival and two drop files displayed. Checkbox selection succeeded. With the right panel closed through its normal close button, Process opened a dialog naming one selected item and inbox-process gws; Cancel dismissed it. No processing job was submitted. The pane, its components and shared styles have no diff from pre-removal commit 9efc875 to verified implementation a512891.
evidence: uat-evidence/inbox-populated.png; uat-evidence/inbox-action.png; uat-evidence/results.json
note: Existing right-panel overlap is documented below; passing this removal regression does not claim that separate layout issue is fixed.

### 5. Inbox empty state
expected: Existing empty state renders unchanged with no pending items or drops.
result: pass
source: automated and screenshot inspection
observed: Zero configured and file rows. Existing configured-items and files empty-state copy rendered; processed-items empty state also remained visible. No new removal notice or dead Inbox switcher row.
evidence: uat-evidence/inbox-empty.png; uat-evidence/results.json

## Summary

total: 5
passed: 5
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

No Phase 7 regression gaps.

## Verification Method and Limits

- Resumed the existing five-item UAT under the user's explicit instruction to test directly and complete the phase; no human pass responses were invented.
- The previously prescribed `e2e/inbox*.spec.ts` does not exist. Located and executed the actual existing Inbox coverage instead of accepting a zero-test result.
- Used repository Vite and real Chromium rendering with isolated browser fixtures. The harness intercepts only browser-served scan responses and uses the existing Inbox test seam; production source and user files are unchanged.
- This proves frontend runtime behavior with controlled data. It does not claim a native WKWebView or live-provider end-to-end run. Fresh Rust vault tests separately exercise real filesystem-backed scan and cache exclusion.
- Screenshots were directly inspected for labels, badge visibility, row composition and modal state.
- Chromium was initially absent; after installing the matching Playwright browser, the E2E rerun passed.

## Commands and Results

```bash
MARU_E2E_PORT=5319 pnpm exec playwright test e2e/smoke.spec.ts e2e/workbench-layout.spec.ts e2e/dashboard.spec.ts --grep 'restores the previous app state|every primary workbench|every right workbench|widget actions deep-link|inbox card splits' --workers=2 --reporter=line --output=/tmp/maru-07-regression-results
# 8 passed

# Start this server, then execute the held-out UAT harness in another terminal.
pnpm exec vite --host 127.0.0.1 --port 5318 --strictPort
node .planning/phases/07-guardrails-before-churn/uat-evidence/check.cjs
# PASS volume 0; PASS volume 1; PASS volume 9582

pnpm exec vitest run src/__tests__/inboxKeyboard.test.tsx src/lib/inbox.test.ts src/lib/inboxReview.test.ts src/lib/inboxSources.test.ts src/lib/contentSearch.test.ts --reporter=dot
# 58 passed

cargo test --manifest-path src-tauri/Cargo.toml --lib vault::tests:: -- --test-threads=2
# 38 passed, 1 existing ignored benchmark
```

Additional security checks: 33 TypeScript tests, 4 lock recovery tests, 19 generated-path Rust tests, six-sink sanitizer guard and 3738-key i18n parity passed. See 07-SECURITY.md.

## Existing Layout Observation

At 1440x1000, an open right Outline panel overlaps the populated Inbox row's Process button and intercepts pointer events. Closing that panel makes the ordinary row action usable. The Inbox component tree and shared styles are byte-identical to pre-removal commit 9efc875, and Phase 7 App changes only remove the Inbox count entry; this is classified as a pre-existing layout limitation rather than a Phase 7 removal regression. It remains unresolved, with evidence in uat-evidence/inbox-populated-right-panel.png. It is not hidden by a forced click.

## Preflight

Read current workspace configuration, workspace CLAUDE.md, repository README.md and phase artifacts. Registry identifies dev-maru as the code repository; vault lookup added no phase-specific guidance. claude-mem was not exposed in this session. Existing unrelated changes were preserved. Local project GSD runtime was used after the skill's stale Orca path was found missing.

Timestamp note: the inherited UAT start time was later than this run in UTC. `started` now records the first current-run browser harness timestamp.
