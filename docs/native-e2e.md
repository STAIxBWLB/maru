# Native e2e runner

Runbook and evidence log for the native WebDriver e2e runner (`e2e-native/`,
`make test-e2e-native`). This file currently carries only the spike log;
plan 06-05 completes the rest of the document.

## Spike log

Scope of this section: **session establishment only** — whether the embedded
WebDriver provider establishes a session on a hosted macOS runner with no
interactive permission prompt. This is D-01's first condition only, not the
full three-condition CI-viability verdict (the PTY condition comes from plan
06-02).

Rules (06-CONTEXT.md D-02): an observed interactive/TCC permission prompt
settles the verdict as local-only on the spot, with no further attempts. Every
other failure class is retried within a cap of **3** hosted macOS job runs
total. The cap and the observed failure class are both recorded here.

Retry cap: 3 hosted runs. Runs used: 0.

### Attempts

| # | Date | Run URL | Result | Failure class | What changed before next attempt |
|---|------|---------|--------|---------------|----------------------------------|
| 1 | 2026-08-29 | (pending) | (pending) | — | initial run of the slice |

### Running verdict

(pending first run — one of `ci-viable-pending-full-suite`,
`local-only-permission-wall`, `local-only-cap-exhausted`)
