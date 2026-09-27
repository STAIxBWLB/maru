---
phase: "9"
slug: "durability-and-session-lifecycle"
# status lifecycle: draft (seeded by plan-phase) -> validated (set by validate-phase section 6)
# audit-milestone section 5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-09-25"
---

# Phase 9 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.5 (TS), `cargo test --lib` (Rust), WebdriverIO native e2e (`e2e-native/`, macOS-only, outside `make verify`) |
| **Config file** | `vite.config.ts` (TS), none for `cargo test`, `e2e-native/wdio.conf.ts` (native) |
| **Quick run command** | `cargo test --manifest-path src-tauri/Cargo.toml --lib <module>::` or `pnpm exec vitest run <touched test file>` |
| **Full suite command** | `make verify` |
| **Estimated runtime** | ~600 seconds for `make verify` |

---

## Sampling Rate

- **After every task commit:** Run the task's own `<automated>` command, scoped to the touched module
- **After every plan wave:** Run `make verify`
- **Before `/gsd-verify-work`:** Full suite must be green, plus the human-attended native Cmd+Q check (09-03, 09-08)
- **Max feedback latency:** 600 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 09-01 | 01 | 1 | REL-04 | - | N/A | unit (Rust, existing) | `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib jobs::tests` | ✅ | ✅ green |
| 09-02 | 02 | 1 | REL-01 | - | Group kill never reaches a setsid/nohup grandchild | integration (Rust, real PTY) | `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib phase09_02` | ✅ | ✅ green |
| 09-02 | 02 | 1 | REL-01 | - | Generation-token invariant holds | integration (Rust, existing) | `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib phase08_18` and `phase09_02_generation_invariant_blocks_late_output_and_stale_handle` | ✅ | ✅ green |
| 09-03 | 03 | 1 | REL-02 | - | N/A | native e2e + human-attended | `make test-e2e-native` (`menu.spec.ts` "app.quit routes into the window-close guard"; main CI `native-e2e.yml`) | ✅ | ✅ green |
| 09-05 | 05 | 1 | REL-02, REL-03 | - | Pending save flushes on unmount | unit (Vitest) | `pnpm exec vitest run src/components/ScratchpadPane.test.tsx src/lib/debouncedSave.test.ts src/lib/teardownSave.test.ts` | ✅ | ✅ green |
| 09-04 | 04 | 2 | REL-03 | - | Recovery copy stays inside `.maru/recovery/` | unit (Rust) + command isolation | `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib phase09_04`; `pnpm exec vitest run src/lib/maruDir.test.ts`; `node scripts/check-command-isolation.mjs --all --expected-count 383` | ✅ | ✅ green |
| 09-07 | 07 | 2 | REL-02, REL-03 | - | N/A | unit (Vitest) | `pnpm exec vitest run src/components/meetings/MeetingSourceWorkbench.test.tsx src/components/today/TodayPrepare.test.tsx src/lib/teardownSave.surfaces.test.ts` | ✅ | ✅ green |
| 09-07 | 07 | 2 | REL-02 | - | Studio edit inside the 600ms window saves on unmount and on a document switch | unit (Vitest, component) | `pnpm exec vitest run src/components/studio/StudioMode.teardown.test.tsx` | ✅ | ✅ green |
| 09-07 | 07 | 2 | REL-02 | - | Graph layout change inside the 1500ms window saves to `.maru/cache/graph-layout.json` on unmount | unit (Vitest, component) | `pnpm exec vitest run src/components/graph/GraphView.teardown.test.tsx` | ✅ | ✅ green |
| 09-06 | 06 | 3 | REL-03 | - | Failure toast names file and reason | unit (Vitest) | `pnpm exec vitest run src/lib/teardownSave.test.ts src/lib/errorStore.test.tsx src/components/OperationNoticeToast.test.tsx` | ✅ | ✅ green |
| 09-08 | 08 | 4 | REL-02, REL-03 | - | Quit cancels on save failure; "quit anyway" is explicit | unit (Vitest, fake timers) + Rust ACL | `pnpm exec vitest run src/lib/useDestructiveActionGuard.test.tsx src/lib/teardownSave.test.ts`; `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib quit_acl_tests` | ✅ | ✅ green |
| 09-08 | 08 | 4 | REL-02 | - | Clean `app.quit` exits the process | native e2e | `make test-e2e-native` (`quit.spec.ts`; main CI `native-e2e.yml`) | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `src-tauri/src/terminal/mod.rs` tests `phase09_02_*`: SIGHUP-trapping child killed within budget; backgrounded grandchild survives
- [x] `src-tauri` tests `phase09_04_*` for the recovery-copy write
- [x] `src/lib/teardownSave.test.ts`
- [x] `src/lib/useDestructiveActionGuard.test.tsx`
- [x] `e2e-native/specs/menu.spec.ts` `app.quit` case

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Cmd+Q keypress with a dirty draft shows the confirm dialog and does not exit | REL-02 | The macOS menu bar is behind the Accessibility permission wall, same limitation as the other native menu items in `docs/native-e2e.md` | Run the real app, dirty a Scratchpad draft, press Cmd+Q, confirm the dialog appears and the app stays open (09-03, 09-08 checkpoints) |
| Save failure during quit keeps the app open and offers "quit anyway" | REL-02, REL-03 | Needs a real failing disk write in the real app | Follow the 09-08 human-verify checkpoint |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 600s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-09-27

## Validation Audit 2026-09-27

| Metric | Count |
|--------|-------|
| Gaps found | 2 |
| Resolved | 2 |
| Escalated | 0 |

Gaps and their tests:

- 09-07 D2 (REL-02): Studio's unmount and document-switch flush had only a source pin (09-07-SUMMARY marked it human judgment). Added `src/components/studio/StudioMode.teardown.test.tsx`: an edit inside the 600ms window is saved on unmount, and a document switch inside the window saves the old document's state.
- 09-07 D3 (REL-02): the graph layout unmount flush had only a source pin. Added `src/components/graph/GraphView.teardown.test.tsx`: under fake timers, a settled layout is not saved at 1499ms, is saved on unmount inside the 1500ms window, and a failing save writes a recovery copy that names `.maru/cache/graph-layout.json`.

Both tests were checked against the implementation: removing `useTeardownFlush` from either surface fails its unmount case, and removing the load effect's `settleTeardownSave` call fails the document-switch case. Advancing the graph timers to 1501ms instead of 1499ms fails the "not saved before unmount" assertion, so that assertion really tests the timing window.

Existing coverage re-ran green on this branch (base 7c10b229): the Phase 9 vitest files (93 tests), the full `cargo test --offline --lib` run including every `phase09_02` and `phase09_04` test, and the native `menu.spec`/`quit.spec` on main run 36286207160 (8/8 spec files). The two Manual-Only rows (Cmd+Q keypress through the real menu bar, and quit with a real failing disk write) stay manual.
