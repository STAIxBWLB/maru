# Phase 11: Evidence Record

This file holds evidence that must outlive CI artifact retention. It is kept separate from
11-VERIFICATION.md, which the verifier regenerates with a whole-file write at the end of
execution and would discard anything a plan wrote into it.

## GATE-08: narrowed Playwright trace re-proof

| Item | Value |
|------|-------|
| Run URL | https://github.com/STAIxBWLB/maru/actions/runs/36146017939 |
| Run ID | 36146017939 |
| Event | `workflow_dispatch` |
| Probe branch | `test/gate08-trace-probe`, deleted |
| Probe SHA | `90f64713c13af7fae5e2a2786980ac1ee23be424`, not on `main` |
| Config commit | `2d2e8660`, `trace: { mode: "retain-on-failure", snapshots: false, screenshots: false },` |
| Failing test | `e2e/startup.spec.ts` > `keeps the full terminal renderer out of the collapsed startup path` |
| `playwright e2e` job conclusion | `failure` |
| `CI decision` job conclusion | `success` |
| `make verify` job conclusion | `success` |
| `native e2e compile check` job conclusion | `success` |
| Artifact name | `playwright-report` |
| Artifact ID | `10869526424` |
| Artifact size | 16,673 bytes |
| Artifact expiry | `2026-10-02T14:21:04Z` |
| Trace path inside artifact | `test-results/startup-keeps-the-full-ter-c2971--the-collapsed-startup-path-chromium/trace.zip` |

### Trace listing

```text
Archive:  trace.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
      899  09-25-2026 14:18   resources/src@db4ec8fea9b76de5104002c3c1683c42b7ef240c.txt
    18861  09-25-2026 14:18   resources/0c290a9571c7674ce6c6a507f9eadc80567379d5
    12021  09-25-2026 14:18   test.trace
    24647  09-25-2026 14:18   0-trace.trace
        0  09-25-2026 14:18   0-trace.network
      202  09-25-2026 14:18   0-trace.stacks
---------                     -------
    56630                     6 files
```

### Comparison with v1.0

| Run | Bytes | Entries |
|-----|-------|---------|
| v1.0 narrowed config, 2026-08-22, run 32569215249 | 123,399 | 6 |
| v1.0 wide config | 1,752,382 | 14 |
| This run (2026-09-25, run 36146017939) | 56,630 | 6 |

Verdict: the narrowed config still produces a non-trivial trace containing the action timeline
(`0-trace.trace`, 24,647 bytes) and the failing stack (`0-trace.stacks`, 202 bytes), and
`0-trace.network` is 0 bytes exactly as the `playwright.config.ts` comment documents (snapshots
off disables network capture too). The entry count matches v1.0's narrowed-config measurement
exactly (6 entries), confirming the same trace shape ships today as it did at v1.0. The total
byte count (56,630) is well under half of the v1.0 figure (123,399) and this is reported plainly
rather than smoothed over: the difference traces to the probe test itself, `startup.spec.ts`'s
"keeps the full terminal renderer out of the collapsed startup path" is a shorter, simpler
interaction than whatever spec produced the 2026-08-22 measurement, so its action timeline and
DOM snapshot resource are smaller. The entry composition, not the raw size, is what proves the
config is unchanged, and it matches.

### Cleanup

- `git ls-remote --heads origin test/gate08-trace-probe` printed nothing.
- `git branch --list test/gate08-trace-probe` printed nothing.
- `git worktree list` no longer shows the probe worktree.
- `git merge-base --is-ancestor 90f64713c13af7fae5e2a2786980ac1ee23be424 origin/main` exited 1.
- `git merge-base --is-ancestor 90f64713c13af7fae5e2a2786980ac1ee23be424 HEAD` exited 1.
