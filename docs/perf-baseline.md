# Performance verification

This document records the reproducible measurements for issue #201. The
comparison uses product source from `252b65a` (`v0.4.45`) versus product source
from `976fa63` (`v0.4.46`) on the same machine. The latter contains steps 1-9;
this verification is step 10. Both trees received the same measurement-only
instrumentation described below; those probes are not part of the historical
baseline commit.

## Environment and method

- Machine: Apple Mac15,10, Apple silicon, 36 GB RAM, macOS 26.6.1 (25G76)
- Toolchain: Node v25.9.0, pnpm 9.15.0, Rust 1.96.0
- Date: 2026-08-08
- Workspace: the real `/Users/yj.lee/workspace/work`; only entry counts,
  byte totals, and timings are recorded below
- Baseline product source: detached worktree at `252b65a`
- After product source: worktree at `976fa63`

The browser measurements use the same `scripts/perf-startup-profile.mjs`
harness and Vite dev shell for both trees. `MARU_PERF_ROOT` lets the current
harness profile a detached historical checkout without copying the script:

```bash
MARU_PERF_ROOT=/tmp/maru-201-baseline \
  MARU_PERF_PORT=5334 \
  pnpm exec node scripts/perf-startup-profile.mjs /tmp/profile.json
```

The shell uses mocked Tauri IPC. It therefore measures module loading, React
mount, and the mocked boot path, not native IPC or a production WebView.

## Bundle (`pnpm build`)

The gzip values in the table are from `scripts/check-bundle-budget.mjs`, the
same gate used by the build. Raw sizes are the Vite reporter's initial
`index-*.js` output.

| Metric | Baseline `252b65a` | After `976fa63` | Change |
|---|---:|---:|---:|
| Initial JS entry | 1,328.83 kB raw / 379.3 KiB gzip (budget 500) | 966.97 kB raw / 286.5 KiB gzip (budget 320) | -27.2% raw / -24.5% gzip |
| Initial CSS entry | 408.59 kB raw / 59.0 KiB gzip (budget 70) | 408.59 kB raw / 59.0 KiB gzip (budget 70) | unchanged |
| i18n chunks | dictionaries bundled in entry | `ko` 51.78 KiB gzip, `en` 45.38 KiB gzip, both lazy | moved out of entry |

Both builds passed the bundle budgets. The Vite reporter's gzip values were
388.35 KiB (baseline) and 293.38 KiB (after); the table intentionally uses the
budget script's values for like-for-like gate reporting.

## Browser startup profile (three runs, mocked IPC)

Each run used `?startupProfile=1`. Dev StrictMode emits duplicate mount/boot
marks; for each run the later mark was used. Absolute `app:entry` timestamps
include Vite/browser startup variance, so the comparison uses elapsed time
from `app:entry`.

| Measure (ms) | Baseline runs 1 / 2 / 3 | Baseline median | After runs 1 / 2 / 3 | After median |
|---|---:|---:|---:|---:|
| `app:entry` -> `app:mounted` | 182.4 / 256.4 / 189.2 | 189.2 | 64.4 / 40.8 / 42.7 | 42.7 |
| `app:entry` -> `workspace:first-usable` | 278.3 / 372.0 / 283.2 | 283.2 | 81.3 / 55.6 / 55.8 | 55.8 |
| `app:entry` -> `vault:authoritative-scan-done` | 278.6 / 372.3 / 283.6 | 283.6 | 87.3 / 61.3 / 60.7 | 61.3 |
| `boot:start` -> `boot:end` | 95.6 / 115.5 / 93.7 | 95.6 | 21.4 / 18.3 / 16.6 | 18.3 |

The median elapsed time from entry to first usable fell from 283.2 ms to
55.8 ms in this mocked browser shell. This is evidence for the frontend
startup path only; it is not a native launch-time claim.

## Native `scan_vault` (three release-test runs)

The ignored Rust benchmark was extended to serialize the returned
`Vec<VaultEntry>` and report its byte length. For provenance, the exact same
measurement-only `vault.rs` probe was temporarily applied to the baseline
worktree and is present in the after branch; it does not alter scan behavior.
The same real workspace and command were used for both trees:

```bash
MARU_BENCH_WORKSPACE=/Users/yj.lee/workspace/work \
  cargo test --release bench_scan_real_workspace -- \
  --ignored --nocapture --test-threads=1
```

| Metric | Baseline runs 1 / 2 / 3 | Baseline median | After runs 1 / 2 / 3 | After median |
|---|---:|---:|---:|---:|
| Entries | 10,701 / 10,701 / 10,701 | 10,701 | 10,701 / 10,701 / 10,701 | 10,701 |
| Snippet bytes | 4,277,483 each | 4,277,483 | 4,277,483 each | 4,277,483 |
| Serialized payload bytes | 11,452,111 each | 11,452,111 | 11,452,111 each | 11,452,111 |
| `scan_vault` time | 720.159 / 566.224 / 475.223 ms | 566.224 ms | 1,242.280 / 499.672 / 563.589 ms | 563.589 ms |

The measured medians are effectively unchanged (0.5% lower after). The
benchmark includes the existing cache read/write path, and the real workspace
cache state can affect individual runs; this result should not be read as a
statistically controlled native speedup. The important step-10 result is that
the current native scan payload is measured and stable at about 11.45 MB for
10,701 entries, rather than left as a manual placeholder.

## Measurements intentionally not claimed

- Native app cold startup marks were not captured. The existing startup marks
  are exposed in the browser harness, but there is no automated native
  WebView capture in this checkout.
- React Profiler interaction scenarios (document selection, typing, tab
  switching, and mode switching) were not assigned numbers. The browser shell
  uses mocked IPC and the app has no stable production Profiler scenario
  harness; inventing render counts or durations would make the comparison
  misleading.
- Native idle CPU and RSS were not remeasured in this verification. Older
  development-build samples are not comparable to this clean baseline/after
  pair and are intentionally excluded from the result.

These are explicit measurement limits, not estimated values.

## Verification

The clean after tree was checked with:

- `pnpm build` - passed; TypeScript build and bundle budgets passed
- `pnpm typecheck` - passed
- `pnpm lint:i18n` - passed; 3,583 keys in parity, no hardcoded UI strings
- `pnpm test` - passed; 179 files / 1,717 tests
- `scripts/perf-startup-profile.mjs` - three baseline and three after runs passed
- `cargo test --release bench_scan_real_workspace -- --ignored --nocapture --test-threads=1` - three baseline and three after runs passed
- Targeted Rust vault tests - passed; 16 tests
- Playwright smoke (`smoke.spec.ts`, `startup.spec.ts`, `graph-shell.spec.ts`) - passed; 52 tests
- `git diff --check` - passed

`cargo fmt --check` still reports pre-existing formatting differences across
unrelated Rust files in the clean after tree. The benchmark addition itself is
rustfmt-shaped; no unrelated formatting was changed for this verification.
