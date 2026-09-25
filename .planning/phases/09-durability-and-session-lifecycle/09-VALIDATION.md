---
phase: "9"
slug: "durability-and-session-lifecycle"
# status lifecycle: draft (seeded by plan-phase) -> validated (set by validate-phase section 6)
# audit-milestone section 5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
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
| 09-01 | 01 | 1 | REL-04 | - | N/A | unit (Rust, existing) | `cargo test --manifest-path src-tauri/Cargo.toml --lib jobs::tests` | ✅ | ⬜ pending |
| 09-02 | 02 | 1 | REL-01 | - | Group kill never reaches a setsid/nohup grandchild | integration (Rust, real PTY) | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase09_02` | ❌ W0 | ⬜ pending |
| 09-02 | 02 | 1 | REL-01 | - | Generation-token invariant holds | integration (Rust, existing) | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_18` | ✅ | ⬜ pending |
| 09-03 | 03 | 1 | REL-02 | - | N/A | native e2e + human-attended | `make test-e2e-native` | ✅ | ⬜ pending |
| 09-05 | 05 | 1 | REL-02, REL-03 | - | Pending save flushes on unmount | unit (Vitest) | `pnpm exec vitest run src/components/ScratchpadPane.test.tsx src/lib/debouncedSave.test.ts src/lib/teardownSave.test.ts` | ❌ W0 (`teardownSave.test.ts`) | ⬜ pending |
| 09-04 | 04 | 2 | REL-03 | - | Recovery copy stays inside `.maru/recovery/` | unit (Rust) + command isolation | `cargo test --manifest-path src-tauri/Cargo.toml --lib phase09_04` | ❌ W0 | ⬜ pending |
| 09-07 | 07 | 2 | REL-02, REL-03 | - | N/A | unit (Vitest) | `pnpm exec vitest run src/components/meetings/MeetingSourceWorkbench.test.tsx` | ✅ | ⬜ pending |
| 09-06 | 06 | 3 | REL-03 | - | Failure toast names file and reason | unit (Vitest) | `pnpm exec vitest run src/lib/teardownSave.test.ts src/lib/errorStore.test.tsx src/components/OperationNoticeToast.test.tsx` | ❌ W0 | ⬜ pending |
| 09-08 | 08 | 4 | REL-02, REL-03 | - | Quit cancels on save failure; "quit anyway" is explicit | unit (Vitest, fake timers) | `pnpm exec vitest run src/lib/useDestructiveActionGuard.test.tsx src/lib/teardownSave.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/terminal/mod.rs` tests `phase09_02_*`: SIGHUP-trapping child killed within budget; backgrounded grandchild survives
- [ ] `src-tauri` tests `phase09_04_*` for the recovery-copy write
- [ ] `src/lib/teardownSave.test.ts`
- [ ] `src/lib/useDestructiveActionGuard.test.tsx`
- [ ] `e2e-native/specs/menu.spec.ts` `app.quit` case

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Cmd+Q keypress with a dirty draft shows the confirm dialog and does not exit | REL-02 | The macOS menu bar is behind the Accessibility permission wall, same limitation as the other native menu items in `docs/native-e2e.md` | Run the real app, dirty a Scratchpad draft, press Cmd+Q, confirm the dialog appears and the app stays open (09-03, 09-08 checkpoints) |
| Save failure during quit keeps the app open and offers "quit anyway" | REL-02, REL-03 | Needs a real failing disk write in the real app | Follow the 09-08 human-verify checkpoint |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 600s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
