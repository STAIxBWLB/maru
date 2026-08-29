---
phase: 06-native-e2e-runner-foundation
reviewed: 2026-08-29T13:27:44Z
depth: standard
files_reviewed: 25
files_reviewed_list:
  - .github/workflows/ci.yml
  - .github/workflows/native-e2e.yml
  - docs/native-e2e.md
  - e2e-native/helpers/fixtureWorkspace.ts
  - e2e-native/helpers/ptyAssertions.ts
  - e2e-native/specs/ime.spec.ts
  - e2e-native/specs/menu.spec.ts
  - e2e-native/specs/pty.spec.ts
  - e2e-native/specs/webview.spec.ts
  - e2e-native/wdio.conf.ts
  - eslint.config.js
  - Makefile
  - package.json
  - scripts/check-native-e2e-isolation.mjs
  - src-tauri/Cargo.toml
  - src-tauri/src/lib.rs
  - src-tauri/src/maru_dir.rs
  - src-tauri/src/paths.rs
  - src-tauri/src/vault_list.rs
  - src/App.tsx
  - src/components/NativeTerminalView.tsx
  - src/lib/nativeE2eBridge.test.ts
  - src/lib/nativeE2eBridge.ts
  - tsconfig.e2e-native.json
  - tsconfig.json
findings:
  critical: 1
  warning: 2
  info: 5
  total: 8
status: issues_found
---

# Phase 6: Code Review Report

**Reviewed:** 2026-08-29T13:27:44Z
**Depth:** standard
**Files Reviewed:** 25 (pnpm-lock.yaml and src-tauri/Cargo.lock excluded per lock-file scoping rule)
**Status:** issues_found

## Summary

The phase adds a build-gated native WebDriver e2e runner: a default-off cargo
feature embedding `tauri-plugin-wdio-webdriver`, a Vite-flag-gated JS debug
bridge, fixture isolation via two env-var path overrides, four spec files, a
ship-isolation guard, and CI placement. The core isolation design is sound and
verified: `tsc -b` passes locally, the feature gate in `paths.rs` fails closed,
`lib.rs` compiles the plugin only under `native-e2e`, the guard script checks
both the bundle and the manifest, and `NativeTerminalView.tsx`'s reader effect
captures only module-scope `frameLineToText` plus a stable ref (no stale-closure
or `exhaustive-deps` violation). `App.tsx` correctly delegates to the same
`runMenuCommand` the Tauri menu listener uses.

The findings cluster around the runner's teardown and guard edges: a process
cleanup that can SIGKILL unrelated app instances, a guard that hard-fails the
frontend build on environmental cargo errors, and a between-test fixture reset
that is neither atomic nor faithful to its own documented invariant. No issues
were found in the IME/PTY/menu spec assertion logic itself; the recorded
verdicts are internally consistent with the assertions that lock them in.

## Critical Issues

### CR-01: Teardown SIGKILLs any process whose command line contains the repo's debug-binary path — including the developer's other running instances

**File:** `e2e-native/wdio.conf.ts:27-43`
**Issue:** `killSurvivingAppProcesses` runs `pgrep -f "./src-tauri/target/debug/maru"`
and SIGKILLs every match. Two compounding defects:

1. `pgrep -f` treats the pattern as an unanchored ERE. The literal `.`s are
   regex wildcards, so the pattern matches *any* command line containing
   `<any char>/src-tauri/target/debug/maru` — e.g. an absolute path like
   `/Users/yj.lee/workspace/work/dev/maru/src-tauri/target/debug/maru`
   (the leading `.` matches the `u` of `maru`).
2. The tauri-service spawns the app with the literal relative path
   (`spawn("./src-tauri/target/debug/maru")`, confirmed in
   `node_modules/@wdio/tauri-service/dist/esm/index.js` `spawnTauriApp`), so
   the pattern is not scoped to this run's child at all — it matches by path
   substring, not by PID or process ancestry.

Consequence: a developer running `make test-e2e-native` (or a failing CI-local
run) while their own `tauri dev` / debug instance from this checkout — or from
*any other checkout or worktree of the repo on the same machine* — is running
will have that instance SIGKILLed on `afterSession`/`onComplete`, losing
unsaved in-app state. This contradicts the phase's own D-09 spirit ("the
developer's real workspace is never opened" — here the developer's real
*session* is killed). On hosted runners it is harmless; locally it is a data-
loss trap that fires precisely when a run fails and the developer is likely to
also have the app open.

**Fix:**
```ts
// Anchor and escape the pattern, and match the exact relative argv the
// service spawns — or better, track the child PID instead of pgrep:
const escaped = APP_BINARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pids = execFileSync("pgrep", ["-f", `^${escaped}$`], { encoding: "utf8" })
```
A stronger fix is to record the spawned child PID (the service logs it:
"Tauri app spawned (PID: …)") or scope the kill to processes whose parent
chain includes this wdio run, so teardown can never reach a process this run
did not start.

## Warnings

### WR-01: Ship-isolation guard hard-fails `pnpm build:frontend` on environmental cargo errors

**File:** `scripts/check-native-e2e-isolation.mjs:101-122` (wired into
`package.json:14` `build:frontend` and thus `make verify`)
**Issue:** `checkManifest()` treats *any* `cargo metadata --offline` failure —
cargo not installed, cold registry cache, corrupted index — as an isolation
violation and exits 1. Because the guard is chained into `build:frontend`, a
frontend-only contributor (or a CI job with Node but no warmed Rust
toolchain) can no longer produce a frontend build: the error message claims
"cargo metadata failed" under a "runner-only affordances must not reach a
shippable build" banner, which misdiagnoses an environment problem as a
security violation and will train people to bypass the gate. The `--offline`
flag makes this likely: a machine that has never run cargo has no registry
index, so `cargo metadata --offline --no-deps` fails even though the manifest
is fine.
**Fix:** Distinguish the two failure classes. If the `cargo` binary is missing
or metadata fails for environmental reasons, print a warning and skip the
manifest half (the bundle half still guards the artifact that actually ships);
reserve exit-1 for a *successfully parsed* manifest that violates D-10. At
minimum, reword the failure so it is not reported as an isolation violation.

### WR-02: Between-test fixture reset is non-atomic and violates its own "never the directories" invariant for the config dir

**File:** `e2e-native/helpers/fixtureWorkspace.ts:138-152`
**Issue:** Two problems in `resetFixtureWorkspace`, which runs between tests
while the app is live:

1. For `configDir`, the entries include the `com.maru.app` **directory**,
   which is deleted wholesale (`fs.rm(path.join(dir, entry), …)`) — the
   docstring's load-bearing claim "removes the CONTENTS of each seeded
   directory, never the directories themselves" (the watcher-survival
   rationale) is only honored for `workspaceDir`. If anything in the app ever
   holds or watches the registry directory, the reset silently breaks it the
   same way the comment describes for the workspace watcher.
2. `workspaces.json` is deleted and then rewritten with a plain
   `fs.writeFile` (no tmp-file-plus-rename, unlike the app's own
   `write_atomic`). An app-side read of the registry landing between the
   delete and the rewrite observes a *missing* registry — exactly the
   zero-workspace state the module documents as causing the frontend to
   first-run-seed a Sample Workspace. The first-test latch protects the boot
   read, but resets 2..N have no such protection; this is a latent flake
   class in a suite whose value proposition is verdict stability.

**Fix:** Reset only files inside `configDir/com.maru.app/` (leave the
directory itself in place), and write the registry atomically:
```ts
const tmp = path.join(registryDir, `.${WORKSPACE_REGISTRY_FILE}.tmp`);
await fs.writeFile(tmp, JSON.stringify(registry, null, 2), "utf8");
await fs.rename(tmp, path.join(registryDir, WORKSPACE_REGISTRY_FILE));
```

## Info

### IN-01: webview.spec.ts hard-codes the Korean aria-label only

**File:** `e2e-native/specs/webview.spec.ts:22`
**Issue:** Queries only `button[aria-label="문서"]`. The sibling spec
(`ime.spec.ts:348-349`) falls back to `"Documents"`. A runner booting with an
English-resolved locale fails this spec with a 30s `waitForDisplayed` timeout
instead of testing anything.
**Fix:** Mirror the `??`-fallback used in `ime.spec.ts`'s `openRichEditor`.

### IN-02: `killSurvivingAppProcesses` swallows all pgrep errors, including "pgrep missing"

**File:** `e2e-native/wdio.conf.ts:40-42`
**Issue:** The blanket `catch` is correct for the no-match exit code, but it
also swallows ENOENT (pgrep absent) and other exec failures, silently
disarming the process-leak backstop the comment calls a load-bearing truth.
**Fix:** Log a one-line warning when the error is anything other than pgrep's
exit-1 no-match.

### IN-03: native-e2e.yml has no `paths-ignore`, so docs-only pushes to main run the 45-minute macOS suite

**File:** `.github/workflows/native-e2e.yml:23-29`
**Issue:** `ci.yml` ignores `docs/**`, `.planning/**`, etc.; the new workflow
does not, so a typo fix to `docs/native-e2e.md` merged to main burns a full
hosted macOS run. Deliberate trigger scope is documented (D-16) but the
docs-only case was presumably not intended to be included in it.
**Fix:** Copy the `paths-ignore` block from `ci.yml`.

### IN-04: `openShellSession` is duplicated ~verbatim between ime.spec.ts and pty.spec.ts

**File:** `e2e-native/specs/ime.spec.ts:65-182` (vs. `e2e-native/specs/pty.spec.ts:34-161`)
**Issue:** The comment says "kept verbatim so the two specs read the same
way" — which guarantees they drift instead. The shell-launcher flow is
exactly the kind of setup D-14's future specs (Phase 8 load test, Phase 9
SIGHUP test) will also need; a third verbatim copy will follow.
**Fix:** Move `openShellSession()` into `e2e-native/helpers/` alongside
`ptyAssertions.ts` and import it from both specs.

### IN-05: `fixtureDirty` latch comment overstates its guarantee for later spec files

**File:** `e2e-native/helpers/fixtureWorkspace.ts:31-33, 138-143`
**Issue:** "The first beforeTest sees the just-seeded state" is true only for
the *first* worker process. In every later spec file's worker, module state
resets (`fixtureDirty = false`) but the fixture was *not* re-seeded — it
carries the previous spec file's mutations (D-12 acknowledges this at the
suite level, but this comment asserts a per-worker freshness that does not
exist). A future maintainer trusting the comment could add an assertion that
assumes freshly-seeded state in a non-first spec file.
**Fix:** Reword to make clear the no-op first call protects the *first spec
file's* boot read, and that later workers skip their first reset while
inheriting prior-spec state.

---

_Reviewed: 2026-08-29T13:27:44Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
