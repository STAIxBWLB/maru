---
phase: 06-native-e2e-runner-foundation
fixed_at: 2026-08-29T13:45:33Z
review_path: .planning/phases/06-native-e2e-runner-foundation/06-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 6: Code Review Fix Report

**Fixed at:** 2026-08-29T13:45:33Z
**Source review:** .planning/phases/06-native-e2e-runner-foundation/06-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 3 (fix_scope: critical_warning; 5 Info findings out of scope)
- Fixed: 3
- Skipped: 0

**Verification environment:** all fixes were applied and verified in the
isolated worktree `.claude/worktrees/rf-06-*` (temp branch
`gsd-reviewfix/06-*`), then fast-forwarded onto `docs/milestone-v1.1`. Tier 2
checks ran inside the worktree: `node --check` for the `.mjs` guard script and
`tsc --noEmit -p tsconfig.e2e-native.json` (using the main checkout's
`node_modules/.bin/tsc`, resolved upward from the repo-nested worktree path),
which passed with exit 0 after the final fix. The full test suite was not run
(per-fix verification only, by design).

## Fixed Issues

### CR-01: Teardown SIGKILLs any process whose command line contains the repo's debug-binary path

**Files modified:** `e2e-native/wdio.conf.ts`
**Commit:** a50661c
**Applied fix:** In `killSurvivingAppProcesses`, the `APP_BINARY` pattern is
now regex-escaped (`replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`) and anchored
(`^…$`) before being passed to `pgrep -f`, so the match is limited to the
exact relative argv the tauri-service spawns (`./src-tauri/target/debug/maru`)
and can no longer match absolute-path instances from this or any other
checkout. Verified by re-read plus a Node sanity check confirming the escaped
pattern matches the relative argv and rejects absolute paths from other
checkouts. The reviewer's optional stronger variant (PID tracking) was not
implemented; the anchored match is the reviewer's primary suggested fix.

### WR-01: Ship-isolation guard hard-fails `pnpm build:frontend` on environmental cargo errors

**Files modified:** `scripts/check-native-e2e-isolation.mjs`
**Commit:** 5636695
**Applied fix:** `checkManifest()`'s catch block no longer pushes
`cargo metadata failed` into `violations` (which exits 1 under the
isolation-violation banner). It now prints a `console.warn` explaining the
failure is environmental (cargo missing, cold `--offline` registry cache,
corrupted index) and skips the manifest half, leaving the bundle half as the
guard on the artifact that actually ships. Exit-1 is reserved for a
successfully parsed manifest that violates D-10. Verified by re-read and
`node --check` (syntax OK).

### WR-02: Between-test fixture reset is non-atomic and violates its own "never the directories" invariant for the config dir

**Files modified:** `e2e-native/helpers/fixtureWorkspace.ts`
**Commit:** bf8e7e9
**Applied fix:** (1) `resetFixtureWorkspace` now clears the *contents* of
`config/com.maru.app/` instead of deleting the `com.maru.app` directory entry
from `configDir`, so the watcher-survival invariant holds for the registry
dir exactly as documented. (2) `writeFixtureContent` now writes
`workspaces.json` atomically — tmp file plus `fs.rename`, mirroring the app's
own `write_atomic` — so an app-side read can no longer observe a missing
registry between delete and rewrite. Verified by re-read and
`tsc --noEmit -p tsconfig.e2e-native.json` (exit 0).

## Skipped Issues

None — all in-scope findings were fixed.

---

_Fixed: 2026-08-29T13:45:33Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
