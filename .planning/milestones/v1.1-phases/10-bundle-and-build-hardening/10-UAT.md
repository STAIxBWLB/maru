---
status: complete
phase: 10-bundle-and-build-hardening
source: [10-VERIFICATION.md]
started: 2026-09-25T08:22:01+09:00
updated: 2026-09-25T19:55:00+09:00
---

## Current Test

[testing complete]

## Tests

### 1. Packaged CSP runtime proof
expected: Run `make release-preflight` on macOS after the packaged build. Expected: the check-csp-blob `--binary` line passes against the freshly built debug binary (`src-tauri/target/debug/maru`), an observed `csp-blob: ... embedded CSP script-src carries no blob:` success line, before `clean:tauri-debug` prunes the binary. Machine evidence already in place: tauri.conf.json:35 `'self'`, the Makefile wiring, the green dist scan, and Release Preflight CI (Linux) runs 36093470159 and 36103227305 printing `csp-blob: src-tauri/target/debug/maru embedded CSP script-src carries no blob: (compiled source list: "'self'")`; v1.1.10 and v1.1.11 shipped from those checks.
result: pass

### 2. D-03 idle preload warm observation
expected: Open the packaged app with devtools performance/startupProfile. Expected (D-03 as amended in #340): the six split modes' chunks (today, tasks, meetings, drafts, gap, agents; JS and CSS) are fetched one per idle callback after load, and Studio/Graph/Diagram chunks are not fetched until opened; a failed chunk load must not throw unhandled and must not block activation (the normal lazy path still works). Machine evidence already in place: modePreload.ts + main.tsx wiring and the 39-test FOUC spec.
result: pass

## Summary

total: 2
passed: 2
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
