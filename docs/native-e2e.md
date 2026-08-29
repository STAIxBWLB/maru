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

Retry cap: 3 hosted runs. Runs used: 1.

### Attempts

| # | Date | Run URL | Result | Failure class | What changed before next attempt |
|---|------|---------|--------|---------------|----------------------------------|
| 1 | 2026-08-29 | https://github.com/STAIxBWLB/maru/actions/runs/33243419439 | pass | — (no failure; no permission prompt) | — (cap not needed) |

### Running verdict

`ci-viable-pending-full-suite`

Attempt 1 passed on the first hosted run: the embedded WebDriver provider
established a session on `macos-14` with no interactive permission prompt and
the suite ran green (`1 passing (46s)`, 1 spec). No TCC dialog appeared in the
log, and the failure-path screencapture step never fired. This settles only
session establishment; D-01's remaining conditions (PTY readability via the
canvas ink check from plan 06-02, and a full unattended run) are still open, so
this is not yet the phase verdict.
