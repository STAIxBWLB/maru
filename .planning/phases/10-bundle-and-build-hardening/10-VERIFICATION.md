---
phase: 10-bundle-and-build-hardening
verified: 2026-09-25T10:48:00Z
status: passed
score: 10/10 must-haves verified
behavior_unverified: 0
overrides_applied: 1
requirements: [SEC-01, PERF-05]
tree: main @ 838c8e3b (code as of 12a65187; 838c8e3b only touches 10-UAT.md)
overrides:

  - must_have: "Every registered mode chunk (JS and its CSS) is warmed during idle after app load and before first activation, by the D-03 idle preload built on the existing scheduleStartupIdle helper."
    reason: "D-03 amended 2026-09-25 by owner decision (issue #340, implemented in PR #341, recorded in 10-CONTEXT.md D-03 amendment): preload only the six split modes (today, tasks, meetings, drafts, gap, agents), one per idle callback. First activation stays styled without preload because Vite resolves a lazy mode only after its CSS lands (proven cold by the FOUC spec and the first-attach probe below). Also covers the 10-02 truth wording 'the D-03 idle preload warms every mode chunk' and the 10-03 key_link pattern getRegisteredModeIds, which modePreload.ts no longer calls."
    accepted_by: "project owner (D-03 amendment, issue #340; recorded by the verifier from 10-CONTEXT.md, not a new acceptance)"
    accepted_at: "2026-09-25"
re_verification:
  previous_status: human_needed
  previous_score: "all must-haves verified (no numeric score recorded)"
  gaps_closed: []
  gaps_remaining: []
  regressions: []
  corrections_to_previous_report:
    - "check-csp-blob was rewritten (AST parse via vite parseAst, codegen-form binary scan, config + overlay merge-patch check); the previous report described the old char-scanner and a string-only 19-test pin."
    - "Vitest pins are now 30 tests across 3 files (csp-blob tests are behavioral subprocess tests), not 19 source-string tests."
    - "The FOUC spec is 39 tests and runs COLD (idle callbacks disabled); the previous 38-test run was warmed by the preload and never exercised a cold activation (10-ADVERSARIAL-REVIEW finding 4)."
    - "modePreload no longer walks getRegisteredModeIds(); it walks PRELOAD_MODE_IDS (six modes), staggered one per idle callback (D-03 amendment, #340/#341)."
    - "The 18-mode inventory and entry-chunk exclusion live in check-mode-css-ownership.mjs (FULL INVENTORY, RED LIST), not in check-bundle-budget.mjs as the previous report implied."
    - "Entry CSS is 45.1 KiB gzip over 15 CSS chunks (was 45.3 KiB / 14 chunks); styles.css is 18,735 lines; the second .empty-state home moved from :17874 to :17879."
    - "The --binary half cannot read the shipped macOS release binary (fails closed, see WARNING 1); the previous report did not test this."

behavior_unverified_items: []
human_verification:

  - test: "10-UAT test 1 - Packaged CSP runtime proof: run `make release-preflight` on macOS; the check-csp-blob `--binary` line must print `csp-blob: src-tauri/target/debug/maru embedded CSP script-src carries no blob: ...` before clean:tauri-debug prunes the binary."
    expected: "Success line on a macOS-built debug binary. UAT (838c8e3b) records result: pass, but the evidence it cites is Linux: Release Preflight runs 36093470159 (37ca34bd) and 36103227305 (60eb0a63) on ubuntu-22.04, both printing compiled source list \"'self'\". No macOS --binary output is recorded."
    why_human: "The manual gate specifies macOS; CI runs release-preflight-core on Linux only. Close by attaching the macOS line, or by the owner explicitly accepting Linux CI plus the shipped-bundle config/dist checks as sufficient (then flip status to passed)."
  - test: "10-UAT test 2 - D-03 idle preload warm observation in the packaged app (devtools performance/startupProfile)."
    expected: "The six split modes' chunks (today, tasks, meetings, drafts, gap, agents; JS and CSS) are fetched one per idle callback after load; Studio/Graph/Diagram are not fetched until opened; a failed chunk load does not throw unhandled or block activation. UAT (838c8e3b) records result: pass."
    why_human: "requestIdleCallback timing inside WKWebView (which lacks requestIdleCallback, so the 250ms timer path applies) is only observable in the packaged app. Recorded as passed; listed so the report stays in sync with 10-UAT.md."
---

# Phase 10: Bundle and Build Hardening Verification Report

**Phase Goal:** The shipped bundle carries a tighter CSP and its original CSS budget headroom back, both verified against the packaged build rather than the dev server (ROADMAP.md:245-255).
**Verified:** 2026-09-25T10:48:00Z against `main` @ 838c8e3b
**Status:** human_needed (narrow; see Human Verification)
**Re-verification:** Yes. The previous report was written this morning, before #335, #337, #338, #341, #345, #346 and #348. Every claim was re-checked against today's tree.

Verdict: every must-have holds on today's code, and there are no blockers. The guards chained into `build:frontend` pass locally and in every leg of the shipped v1.1.11 release bundles. The binary half passes on two Linux Release Preflight runs. The FOUC spec passes cold against both the dev server and a production preview of `dist`. A first-attach probe shows no pane is ever attached unstyled. The status stays `human_needed` for one reason. 10-UAT.md (committed as 838c8e3b while this run was in progress) marks both manual tests as passed, but test 1's recorded evidence comes from Linux CI, and the gate specifies macOS. The owner decides whether that closes the test.

Method: I read the files and ran grep. I also re-ran the guards, the vitest pins and the Playwright spec live, and ran red/green drills on temporary fixtures in the session scratchpad. The fixtures were deleted and the preview server on :5411 was stopped. I did not modify any source or planning file other than this report.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| SC1 | `script-src 'self' blob:` is absent from the CSP measured against a packaged production build, if nothing in that build still requires it | ✓ VERIFIED (macOS --binary letter: human item 1) | Config: `src-tauri/tauri.conf.json:35` `"script-src": "'self'"`. Config guard over base plus overlays (merge-patch) at `scripts/check-csp-blob.mjs:101-139`. Dist: AST scan at `check-csp-blob.mjs:179-235`; the only Worker spawn is same-origin (`src/components/graph/GraphInsightsPanel.tsx:43`, `new URL(..., import.meta.url)`). Binary: `Makefile:309` inside `release-checks` (`:300-310`). Linux Release Preflight runs 36103227305 (60eb0a63) and 36093470159 (37ca34bd) both print `csp-blob: src-tauri/target/debug/maru embedded CSP script-src carries no blob: (compiled source list: "'self'")` (I confirmed with `gh run view --log`). Shipped v1.1.11 release bundles (run 36104798295): all four legs, including macos aarch64 and x86_64, print `csp-blob: config and dist carry no blob: script sources (76 JS bundles parsed ...)` from `beforeBuildCommand: pnpm build` (`tauri.conf.json:11`, `package.json:13-14`). The installed `/Applications/Maru.app` (v1.1.11, signed Sep 25 16:02) embeds the config copy `"script-src": "'self'"` (strings). |
| SC2 | Per-mode CSS ships in the mode's own lazy chunk, and the initial-CSS budget passes at its original threshold | ✓ VERIFIED | Local `pnpm build:frontend` exit 0: `bundle-budget: initial CSS 45.1 KiB gzip <= 70 KiB`, `mode-css-ownership: 15 CSS chunks, 7 marker-bearing per-mode files, ownership verified, entry chunk clean`. Thresholds are at `scripts/check-bundle-budget.mjs:29-30` (`320 * 1024` / `70 * 1024`). `git diff 4efd1c55 HEAD` on that file changes only the comment (`:26-28`). Seven marker files: today.css (2023 lines), meetings-pane.css (2063), tasks.css (1280), calendar.css (844), drafts.css (504), gap.css (573), agents.css (450). Each is imported at the top of its pane (TodayPane.tsx:7, MeetingsPane.tsx:1-2, TasksPane.tsx:2-3, DraftsPane.tsx:1, GapPane.tsx:1, AgentsPane.tsx:9). The same guard lines are green on the Windows, Linux and both macOS release legs of v1.1.11. |
| SC3 | No mode shows unstyled content on its first activation after the split | ✓ VERIFIED (Chromium; WKWebView via UAT 2) | `e2e/first-activation-styles.spec.ts` has 39 tests with idle callbacks disabled (`:74-80`), so every activation is cold. 39/39 pass against the spec's own dev server, and 39/39 pass against `vite preview` of the production `dist` (MARU_E2E_PORT=5411). A first-attach probe (a MutationObserver reads the computed style of each pane root the moment it enters the DOM, before paint, on the production preview, cold, 16 modes x light/dark) found 32/32 already styled and `unstyled-at-first-attach: 0`. `.mode-loading` covers the Suspense window (`src/styles.css:4025-4035`). The spec pins shared `.task-new-dialog` (`styles.css:14737`) cold via Sites (`spec:130-147`). |
| 10-01 T1 | The packaged CSP is proven by `--binary` inside `make release-checks` against the built artifact | ✓ VERIFIED | `Makefile:301` debug no-bundle build, then `:306` native-e2e scan, `:309` csp-blob `--binary`, `:310` prune. `release-preflight-core` runs it (`:313-315`) and so does CI `release-checks` (`.github/workflows/ci.yml:186`). The two Linux runs above show it green. The >512 MiB fix (#337) is at `check-csp-blob.mjs:243-254`: I built a 600 MiB fixture and it went red (exit 1) with blob and green (exit 0) without. |
| 10-01 T2 | Dist requires no blob: script URLs, chained into build:frontend | ✓ VERIFIED | `package.json:14` chain; local run `76 JS bundles parsed; no unclassifiable worker spawn, importScripts or non-literal dynamic import`. |
| 10-01 T3 | The guard has proven teeth | ✓ VERIFIED | 11 behavioral subprocess tests in `scripts/check-csp-blob.test.ts:33-128`, all green. My own drills: a codegen `script-src'self' blob:` fixture exits 1; a JSON-only fixture exits 1 (fail-closed); a `/"/;import(zz);new Worker(location.hash)` dist fixture exits 1 and names both constructs. All fixtures were deleted. |
| 10-01 T4 | worker-src keeps blob:; connect/img/media/font blob: untouched | ✓ VERIFIED | `tauri.conf.json:36-42`; `git diff 4efd1c55 HEAD -- src-tauri/tauri.conf.json` changes only `script-src` (and the version). |
| 10-02 T4 | The stale ~12% comment is gone and the budget numbers are byte-identical | ✓ VERIFIED | Old comment removed; the D-06 comment is at `check-bundle-budget.mjs:26-28`; the numbers are unchanged. |
| 10-03 T2 | Mode chunks warmed during idle on scheduleStartupIdle (amended to six modes) | ✓ PASSED (override) | `src/lib/modePreload.ts:11-18` sets `PRELOAD_MODE_IDS`. `:42-58` runs one step per idle callback: 2000ms first, then 2000ms with rIC or 250ms without. Cancel stops the queue. It reuses `scheduleStartupIdle` (`src/lib/startupProfile.ts:88-97`) and is wired at `src/main.tsx:4,14-15`. The unit tests `defaults to the six split modes only` and `warms one mode per idle callback` pass. Override: D-03 amendment #340. |
| 10-03 T3 | Preload failure degrades gracefully | ✓ VERIFIED | `modePreload.ts:49` `descriptor.load().catch(() => {})`. The unit test `skips unavailable modes and keeps going after a failed load` passes (`src/lib/modePreload.test.ts:86-95`). The normal lazy path is untouched, as the cold FOUC spec shows. |

**Score:** 10/10 truths verified (9 VERIFIED, 1 PASSED via override). 0 present-but-behavior-unverified.

Deduplicated into the rows above: 10-02 T1 and T2 fall under SC2; 10-02 T3 and 10-03 T1 fall under SC3.

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `scripts/check-csp-blob.mjs` | Two-half CSP guard; exit 1 on violation; one success line | ✓ VERIFIED | 287 lines. Checks config plus overlay merge-patch, parses dist with vite `parseAst` (unparseable fails closed), scans the codegen-form binary (a missing codegen form fails closed). Rewritten in #335; large-binary fix #337. |
| `scripts/check-csp-blob.test.ts` | Policy pin | ✓ VERIFIED (stronger than planned) | Behavioral subprocess tests replace the string pins. |
| `src-tauri/tauri.conf.json` | script-src narrowed, rest unchanged | ✓ VERIFIED | `:35`. |
| `package.json` | build:frontend chain + check script | ✓ VERIFIED | `:14`, `:18-19`. |
| `Makefile` | check-csp-blob target + release-checks line before the prune | ✓ VERIFIED | `:186-188`, `:309`. |
| `src/components/<mode>/*.css` | per-mode files with `/*! maru:mode:<id> */` | ✓ VERIFIED | 7 marker files, plus markerless `tasks/taskFormFields.css`, imported by `TaskFormFields.tsx:6` (#335 finding 3). |
| `scripts/check-mode-css-ownership.mjs` | Ownership guard chained into build:frontend | ✓ VERIFIED | 485 lines. Six assertion families, including SPLIT HOME (`:258-286`, #335) and POSIX path normalization (`:372-374`, #338). The Windows leg of v1.1.11 ran it green. |
| `scripts/check-mode-css-ownership.test.ts` | Policy pin | ✓ VERIFIED (partly weak, see WARNING 3) | SPLIT HOME is behavioral (`:76-103`). The rest are source-string pins. |
| `scripts/check-bundle-budget.mjs` | Comment refresh; thresholds identical; inventory / entry exclusion | ✓ VERIFIED (relocated) | Comment and thresholds are as planned. The 18-mode inventory and entry-chunk exclusion are enforced by the chained ownership guard (FULL INVENTORY `:453-466`, RED LIST `:316-358`), not by this file. The inventory matches `src/lib/modeRegistry.tsx:14-17`. |
| `src/lib/modePreload.ts` | Idle preload with cancel handle | ✓ VERIFIED | Imports only `./modeRegistry` and `./startupProfile` (`:1-2`), so no component import from src/lib. |
| `src/main.tsx` | Wiring at entry | ✓ VERIFIED | `:14` markStartup, `:15` scheduleModePreload(). |
| `e2e/first-activation-styles.spec.ts` | FOUC spec, both color schemes | ✓ VERIFIED | 218 lines, 39 tests, cold. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| package.json build:frontend | check-csp-blob.mjs | chain after native-e2e-isolation | WIRED | `package.json:14` |
| Makefile release-checks | check-csp-blob.mjs --binary | between the native-e2e scan and the prune | WIRED | `Makefile:306,309,310` |
| Pane components | per-mode css | top-of-module import | WIRED | Import lines listed under SC2 |
| per-mode css | owning dist chunk | markers survive minify (planned) | WIRED (alternative mechanism) | Vite's esbuild forces `legalComments: "none"`, so markers exist only in src. The guard proves ownership with pane-root rule fingerprints instead (`check-mode-css-ownership.mjs:148-156`, `:399-451`), documented in 10-02-SUMMARY:100-111. The link's target (the right chunk) is proven. Only the "via" differs. |
| package.json build:frontend | check-mode-css-ownership.mjs | tail of chain | WIRED | `package.json:14` |
| modePreload.ts | modeRegistry.tsx | getModeDescriptor, isAvailable skip, load | WIRED | `modePreload.ts:48-49`. `getRegisteredModeIds` is no longer used, as the D-03 amendment intends (override). |
| modePreload.ts | startupProfile.ts | scheduleStartupIdle reuse | WIRED | `modePreload.ts:51,54` |
| main.tsx | modePreload.ts | call at entry | WIRED | `main.tsx:4,15` |

### Data-Flow Trace (Level 4)

Not applicable. The phase ships build guards, CSS placement and a preload scheduler. There is no rendered dynamic data.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Produced-artifact guards | `pnpm build:frontend` | exit 0; budget JS 310.4 / CSS 45.1 KiB; native-e2e clean; csp-blob 76 bundles; ownership 15 chunks / 7 files | ✓ PASS |
| Guard + preload unit pins | `pnpm exec vitest run scripts/check-csp-blob.test.ts scripts/check-mode-css-ownership.test.ts src/lib/modePreload.test.ts` | 3 files, 30 tests passed | ✓ PASS |
| FOUC spec (dev server) | `pnpm exec playwright test e2e/first-activation-styles.spec.ts` (own server on :5307, port was free) | 39 passed (22.8s) | ✓ PASS |
| FOUC spec (production dist) | `vite preview --port 5411` + `MARU_E2E_PORT=5411 pnpm exec playwright test e2e/first-activation-styles.spec.ts` | 39 passed (20.3s); served `assets/index-26_Fe_Jn.js` matched local dist | ✓ PASS |
| No pane attached unstyled (production dist, cold) | Temporary Playwright script with a MutationObserver first-attach computed-style capture, 16 modes x 2 schemes | `unstyled-at-first-attach: 0` | ✓ PASS |
| Binary half, >512 MiB | 600 MiB fixture, red and green | exit 1 / exit 0 | ✓ PASS |
| Binary half, Linux CI | `gh run view 36103227305 / 36093470159 --log \| grep csp-blob` | `compiled source list: "'self'"` on both | ✓ PASS |
| Binary half vs shipped macOS release binary | `node scripts/check-csp-blob.mjs --binary /Applications/Maru.app/Contents/MacOS/maru` | exit 1: `carries no codegen CSP script-src serialization ... failing closed` | ℹ️ Fails closed by design (WARNING 1) |
| Stale local debug binary (Sep 13, pre-phase) | `--binary src-tauri/target/debug/maru` | reports `script-src carries blob: ("'self' blob:")` | ✓ PASS (guard catches the pre-phase CSP) |

### Probe Execution

Step 7c: no `scripts/*/tests/probe-*.sh` is declared or present for this phase. The produced-artifact guards above serve as the phase's probes and were run in this process.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| SEC-01 | 10-01 | Drop `script-src 'self' blob:` if the Vite build no longer needs it, verified against a packaged build | ✓ SATISFIED (macOS letter: human item 1) | SC1 and 10-01 T1-T4. REQUIREMENTS.md:101 `[x]`, :197 `Complete` |
| PERF-05 | 10-02, 10-03 | Per-mode CSS in the mode's lazy chunk, budget not raised, no unstyled first activation | ✓ SATISFIED | SC2, SC3, 10-02 T4, 10-03 T2-T3. REQUIREMENTS.md:49 `[x]`, :191 `Complete` |

There are no orphaned requirements; REQUIREMENTS.md maps only SEC-01 and PERF-05 to Phase 10.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| phase-10 guard/preload/spec files | - | TBD/FIXME/XXX | none found | - |
| per-mode CSS files | - | raw `font-size: Npx` | none found | The check-type-tokens escape prohibition holds |
| `src/styles.css` | 3608, 17879 | `.empty-state` defined twice | ⚠️ Warning | See WARNING 2 |
| `e2e/first-activation-styles.spec.ts` | 149 | test titled "empty-state stays single-homed" while two homes exist | ℹ️ Info | Misleading title; the assertion itself (winner's computed values) is correct |
| `scripts/check-csp-blob.mjs` | 201-204 | `ponytail:` name-based createObjectURL binding; Worker aliasing uncovered | ℹ️ Info | Known ceiling, recorded in 10-ADVERSARIAL-REVIEW "Open" |
| `src/components/today/today.css` | 913 | `color: #fff` | ℹ️ Info | Pre-existing rule moved verbatim (10-UI-REVIEW) |

### Human Verification Required

Kept in sync with 10-UAT.md tests 1 and 2. UAT is now `status: complete` with both tests passed (commit 838c8e3b, landed during this run).

#### 1. Packaged CSP runtime proof (UAT test 1, recorded pass)

**Test:** Run `make release-preflight` on macOS. The check-csp-blob `--binary` line must print `csp-blob: src-tauri/target/debug/maru embedded CSP script-src carries no blob: ...` before `clean:tauri-debug` prunes the binary.
**Evidence in hand:** Linux only. Release Preflight runs 36093470159 (37ca34bd) and 36103227305 (60eb0a63) both ran on `ubuntu-22.04` (`.github/workflows/release-preflight.yml:19`) and printed `compiled source list: "'self'"`. Separately, the macOS release legs of v1.1.10/v1.1.11 ran the config and dist halves, and the installed v1.1.11 binary embeds `"script-src": "'self'"`.
**Open point:** The manual gate specifies macOS, and no macOS `--binary` output is recorded. The UAT "pass" rests on the Linux evidence. Also, the guard cannot check the shipped macOS release binary itself (WARNING 1), so the macOS proof has to come from a macOS debug build, which is exactly what `make release-preflight` produces.
**Why human:** Only a human-run macOS preflight produces this line. Alternatively, the owner can accept the Linux CI evidence as sufficient, and the status becomes `passed`.

#### 2. D-03 idle preload warm observation (UAT test 2, recorded pass)

**Test:** Open the packaged app with devtools performance/startupProfile.
**Expected:** The six split modes' chunks are fetched one per idle callback after load. Studio/Graph/Diagram are not fetched until opened. A failed chunk load does not throw unhandled or block activation.
**Why human:** WKWebView has no `requestIdleCallback`, so the 250ms timer path applies. Its timing is observable only in the packaged app. This test also stands in for FOUC under WKWebView, because the Chromium spec proves nothing about WKWebView. Recorded as passed.

### Gaps Summary

There are no blocking gaps, and none carry over from the previous report. New and carried-forward findings:

- **WARNING 1 (new): the `--binary` half cannot measure the shipped release binary.** Against `/Applications/Maru.app/Contents/MacOS/maru` (v1.1.11 release) it exits 1 with "no codegen CSP script-src serialization". In the release build the linker separates and deduplicates the directive-name and source-list literals: `strings` shows `script-src` on its own, and the only `'self' blob:` literal is shared with `worker-src`. This is a correct fail-closed outcome, not a false pass. Still, D-04 proof (b) measures the debug no-bundle binary built from the same config, not the shipped artifact. The debug build is a reasonable proxy, because tauri-codegen compiles the CSP from config identically in both profiles. For the shipped artifact itself, the evidence is the release-leg config and dist checks plus the embedded config copy. If the owner wants the literal shipped binary measured, the guard needs a release-layout reader, for example the embedded JSON copy as the primary source in release builds. Recording only; this does not block.
- **WARNING 2 (carried): `.empty-state` still has two homes** at `src/styles.css:3608` and `:17879`. Both are entry-side, and the later block wins deterministically. The e2e spec pins the winner, and SPLIT HOME skips same-file pairs, so the pair cannot flip across chunks. The 10-02 prohibition allows "the selector stays entry-side", which this satisfies in substance. However, 10-02-SUMMARY's "D-02 Boundary Dispositions" (`:133`) still has no `.empty-state` entry, and the spec title claims "single-homed". This is a judgment-tier prohibition, flagged for the owner, not silently passed.
- **WARNING 3 (new): most ownership-guard pins are source-string checks.** `check-mode-css-ownership.test.ts:17-64` asserts that strings are present in the guard, and the "inventory in sync with modeRegistry" test (`:40-42`) checks only a comment. Only SPLIT HOME is behavioral. The inventory does match `modeRegistry.tsx:14-17` today. 10-ADVERSARIAL-REVIEW finding 9 converted the csp-blob pins to behavioral tests, but not these.
- **Info: bookkeeping drift (carried).** In ROADMAP.md, `:27` "- [ ] **Phase 10" and `:272` "- [ ] 10-03" are still unchecked. 10-VALIDATION.md:74, the D-03 manual row, still says "mode chunks" generically; the D-03 amendment and 10-UAT test 2 narrowed it to six modes.
- **Info: override applied.** The 10-03 "every registered mode chunk" truth is carried by the recorded D-03 owner amendment (#340 / #341, 10-CONTEXT.md). I did not grant a new acceptance. Remove the frontmatter override if the owner wants that truth re-litigated.

---

_Verified: 2026-09-25T10:48:00Z_
_Verifier: Claude (gsd-verifier)_
