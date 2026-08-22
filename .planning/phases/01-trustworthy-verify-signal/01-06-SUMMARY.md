---
phase: 01-trustworthy-verify-signal
plan: 06
subsystem: testing
tags: [eslint, flat-config, typescript-eslint, react-hooks, hook-dependency-gate]

requires:
  - phase: 01-trustworthy-verify-signal
    provides: "01-04's tsconfig.e2e.json, which eslint.config.js's e2e/**/*.ts type-aware block points at"
provides:
  - "eslint.config.js: ESM flat config, ESLint 10, exactly the D-02 four-rule set (rules-of-hooks, exhaustive-deps, no-unused-vars with ^_ ignore patterns, no-floating-promises), no recommended preset, no-console off"
  - "package.json scripts.lint: eslint src e2e --max-warnings 0 (not wired into make verify yet)"
  - "src/App.tsx at zero ESLint errors/warnings - the largest single-file backlog and the Phase 4-5 decomposition target"
  - "Remaining repo-wide lint backlog measured and recorded (52 errors + 7 warnings, excluding src/lib/hwped.ts) for 01-07 to size against"
affects: ["01-07 (clears the rest of src/ + e2e/, wires make lint into verify)", "Phase 4-5 (App.tsx's 8 exhaustive-deps disable comments are the burn-down worklist)"]

actuals:
  tokens: 3200
  tasks: 3
  commits: 2

tech-stack:
  added: ["eslint@10.9.0 (devDependency)", "typescript-eslint@8.67.0 (devDependency)", "eslint-plugin-react-hooks@7.1.1 (devDependency)"]
  patterns:
    - "eslint-disable-next-line <rule> -- <reason> on one line, immediately above the flagged dependency-array (or directive) line - never a bare disable, never a separate comment line above it"
    - "Dead useCallback/useMemo bindings deleted outright (not just the unused-vars site but any dependency-array entry only that binding needed), which can retire an exhaustive-deps violation as a side effect of the no-unused-vars fix rather than needing its own disable comment"

key-files:
  created:
    - eslint.config.js
  modified:
    - package.json
    - pnpm-lock.yaml
    - src/App.tsx

key-decisions:
  - "Installed eslint@10.9.0, typescript-eslint@8.67.0, eslint-plugin-react-hooks@7.1.1 - approved at the blocking-human legitimacy checkpoint after independent live-registry re-verification (repo URLs, ESLint-10-inclusive peer ranges, 74M-133M weekly downloads each), matching RESEARCH.md's audit exactly."
  - "eslint's own dist-tags (latest=10.9.0, maintenance=9.39.5) confirm D-01's original 'ESLint 9' wording pointed at what is now the maintenance line, not current - carried into the checkpoint record as the cleanest evidence for the amendment."
  - "typescript-eslint@8.67.0's own version number is independent of the ESLint major it targets (its peerDependencies already cover ^10.0.0); the 8-vs-10 mismatch is expected, not a pinning error."
  - "Re-measured App.tsx's split as 13 no-unused-vars + 9 exhaustive-deps (22 total, matching RESEARCH.md's corrected count), not the plan's inventoried 12+10. One of those exhaustive-deps violations disappeared as a side effect of deleting the entirely-dead openBinaryWorkspaceFile callback (a no-unused-vars fix), so the actual final split committed is 12 no-unused-vars fixes + 8 new disable comments."
  - "Retrofitted same-line reasons onto the two pre-existing live exhaustive-deps directives (boot-once-on-mount, kg-focus-reset) rather than leaving them bare, to satisfy the plan's literal acceptance criterion that every exhaustive-deps disable comment in the file carry a reason after the rule name - not just the ones newly added."
  - "make verify could not be run to a clean exit: cargo fmt --check failed solely on files belonging to a concurrent, unrelated session (src-tauri/src/hwped.rs, src-tauri/src/lib.rs) working in the same checkout. Everything in this plan's own scope (pnpm typecheck, pnpm test, pnpm exec eslint src/App.tsx --max-warnings 0, cargo test --lib) passed cleanly before that unrelated failure. See Issues Encountered."

patterns-established:
  - "For a genuinely dead useCallback/useMemo (no-unused-vars on the binding itself), delete the whole declaration rather than gutting its body - this also removes any exhaustive-deps violation the same declaration carried, and can cascade to newly-orphaned imports the deleted body was the last user of (checked each one individually before removing)."

requirements-completed: []

coverage:
  - id: D1
    description: "eslint.config.js exists at repo root: ESM flat config, exactly the D-02 four rules (react-hooks/rules-of-hooks, react-hooks/exhaustive-deps, @typescript-eslint/no-unused-vars with ^_ ignore patterns, @typescript-eslint/no-floating-promises), no recommended/recommendedTypeChecked preset extended, no-console not enabled, src/**/*.{ts,tsx} scoped to tsconfig.app.json and e2e/**/*.ts scoped to tsconfig.e2e.json"
    requirement: "GATE-02"
    verification:
      - kind: unit
        ref: "pnpm exec eslint --version (v10.9.0)"
        status: pass
      - kind: unit
        ref: "pnpm exec eslint src/lib/e2eFlow.ts (exits 0, no config error)"
        status: pass
      - kind: unit
        ref: "grep -cE recommended(TypeChecked)? eslint.config.js == 0; grep -c no-console eslint.config.js == 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "src/App.tsx reports zero ESLint errors and zero warnings under the D-02 rule set; every hook-dependency disable comment names the rule and carries a same-line reason; the stale directive at (pre-edit) line 6974 is gone; no dependency array's contents changed; no console. call touched"
    requirement: "GATE-02"
    verification:
      - kind: unit
        ref: "pnpm exec eslint src/App.tsx --max-warnings 0 (exit 0)"
        status: pass
      - kind: unit
        ref: "grep -c 'eslint-disable-next-line$' src/App.tsx == 0 (no bare directives)"
        status: pass
      - kind: unit
        ref: "pnpm typecheck (exit 0); pnpm test (1853/1853, unchanged count)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Package legitimacy for eslint@10.9.0, typescript-eslint@8.67.0, eslint-plugin-react-hooks@7.1.1 confirmed at the blocking-human checkpoint"
    verification:
      - kind: manual_procedural
        ref: "Task 1 checkpoint:human-verify, gate=blocking-human; approved by team-lead: 'approved - install eslint@10.9.0, typescript-eslint@8.67.0, eslint-plugin-react-hooks@7.1.1'"
        status: pass
    human_judgment: true
    rationale: "Package-legitimacy checkpoints are never auto-approved by design (gate=blocking-human); this deliverable's proof is the human sign-off itself, already obtained."

duration: ~20min active (excludes the checkpoint wait for Task 1 approval, which spanned a status-check exchange and a mid-wait dispatch/stand-down of a duplicate executor by the team lead)
completed: 2026-08-22
status: complete
---

# Phase 1 Plan 06: ESLint Setup + App.tsx Backlog Clear Summary

**ESLint 10 flat config with the exact D-02 four-rule set stood up, and `src/App.tsx` - the largest single-file lint backlog and the Phase 4-5 decomposition target - driven to zero errors and warnings.**

## Performance

- **Duration:** ~20 min of active executor work; excludes the wait for the Task 1 human-verify checkpoint approval (during which the team lead briefly dispatched and then stood down a duplicate executor after my checkpoint message arrived late)
- **Started:** 2026-08-22 (checkpoint at Task 1; resumed after "approved - install eslint@10.9.0, typescript-eslint@8.67.0, eslint-plugin-react-hooks@7.1.1")
- **Completed:** 2026-08-22T18:38:18+09:00
- **Tasks:** 3/3 (Task 1 checkpoint, Task 2 install+config, Task 3 App.tsx clear)
- **Files modified:** 4 (1 created: eslint.config.js; 3 modified: package.json, pnpm-lock.yaml, src/App.tsx)

## Accomplishments

- `eslint.config.js` created at repo root: ESM flat config via `tseslint.config(...)`, exactly matching RESEARCH.md's Pattern 1 - `src/**/*.{ts,tsx}` scoped to `tsconfig.app.json`, `e2e/**/*.ts` scoped to `tsconfig.e2e.json`, exactly four rules registered by hand (no `recommended`/`recommendedTypeChecked` extended), `no-console` left off
- `eslint@10.9.0`, `typescript-eslint@8.67.0`, `eslint-plugin-react-hooks@7.1.1` installed as devDependencies, approved at the blocking-human legitimacy checkpoint after independent live npm-registry re-verification
- `package.json` gained `scripts.lint`: `eslint src e2e --max-warnings 0`, deliberately not wired into `make verify` (01-07's job)
- Full inventory run (`pnpm exec eslint src e2e`, `src/lib/hwped.ts` excluded - see Issues Encountered): **74 errors + 8 warnings** across `src/`, `e2e/` clean - matches RESEARCH.md's prior measurement exactly
- `src/App.tsx` re-measured at **22 real violations** (13 `no-unused-vars` + 9 `exhaustive-deps`), not the plan's inventoried 12+10; driven to zero via 12 mechanical unused-symbol fixes (one dead `useCallback` deletion retired its own paired `exhaustive-deps` violation as a side effect, landing the final count at 12+8) plus 8 new `eslint-disable-next-line react-hooks/exhaustive-deps` comments, each naming the rule and carrying a reason
- The stale directive at (pre-edit) `App.tsx:6974` removed; the two other pre-existing live directives kept and retrofitted with same-line reasons to satisfy the plan's "every disable comment carries a reason" acceptance criterion
- `pnpm exec eslint src/App.tsx --max-warnings 0` exits 0; `pnpm typecheck` exits 0; `pnpm test` 1853/1853 unchanged
- Remaining repo-wide backlog after App.tsx: **52 errors (24 no-unused-vars + 27 exhaustive-deps + 1 no-floating-promises) + 7 warnings (all stale no-console directives)**, `e2e/` still clean - recorded here for 01-07 to size against

## Task Commits

Each task was committed atomically:

1. **Task 1: Package legitimacy check for the three ESLint packages** - checkpoint:human-verify, `gate="blocking-human"` (no code change); returned the checkpoint with independent live-registry verification (repo URLs, ESLint-10-inclusive peer ranges, download counts), approved by team-lead: "approved - install eslint@10.9.0, typescript-eslint@8.67.0, eslint-plugin-react-hooks@7.1.1"
2. **Task 2: Install ESLint, write the flat config, add the lint script, inventory the backlog** - `cf14a79` (feat)
3. **Task 3: Clear src/App.tsx to zero errors and zero warnings** - `e68a63b` (fix)

**Plan metadata:** _(this commit, made after this SUMMARY)_

## Files Created/Modified

- `eslint.config.js` - new, repo-root ESM flat config; two file-scoped blocks (`src/**/*.{ts,tsx}` → `tsconfig.app.json`, `e2e/**/*.ts` → `tsconfig.e2e.json`) plus an ignores block; exactly the D-02 four rules
- `package.json` - three devDependencies added alphabetically with `^` ranges (`eslint`, `eslint-plugin-react-hooks`, `typescript-eslint`); `scripts.lint` added next to `lint:i18n`
- `pnpm-lock.yaml` - regenerated by `pnpm install`; pure addition (746 lines), no existing entry modified
- `src/App.tsx` - 12 no-unused-vars fixes (imports and dead bindings removed/renamed), 1 entirely-dead `useCallback` (`openBinaryWorkspaceFile`) deleted along with 5 imports/functions that were only it its own dependents, 8 new named-and-reasoned `exhaustive-deps` disable comments, 1 stale directive removed, 2 pre-existing live directives given reasons; no dependency array's contents changed anywhere

## Decisions Made

- **`eslint@10.9.0` / `typescript-eslint@8.67.0` / `eslint-plugin-react-hooks@7.1.1`**: all three independently re-verified live against the npm registry at the checkpoint (not trusted from RESEARCH.md alone) - repo URLs match, peer ranges include ESLint 10, download counts 74M-133M/week.
- **eslint's dist-tags are the cleanest evidence for D-01's amendment**: `latest=10.9.0` vs `maintenance=9.39.5` directly shows the original "ESLint 9" wording targeted what is now the old maintenance line.
- **App.tsx's actual fix count is 12+8, not the inventoried 13+9 or the original plan's 12+10**: deleting the dead `openBinaryWorkspaceFile` callback (a `no-unused-vars` fix) also removed its own `exhaustive-deps` violation as a side effect, since the violation lived in that same callback's dependency array. This is a real count, re-derived from the actual eslint run per the plan's own instruction not to trust an inventoried number.
- **Retrofitted reasons onto the two pre-existing live `exhaustive-deps` directives** (boot-once-on-mount at old line 4009, kg-focus-reset at old line 6449) rather than leaving them bare, because the plan's acceptance criteria state "every exhaustive-deps disable comment in src/App.tsx" carries a reason - not "every comment added by this task." Reading code around each to write an accurate reason, not a generic placeholder.
- **`no-unused-vars` fixes: delete-vs-rename per D-05's guidance**. Six dead icon imports, one dead import, and one entirely-dead `useCallback` (plus its now-orphaned dependencies) were deleted outright. `gmailDecisions` was renamed to `_gmailDecisions` because its setter (`setGmailDecisions`) is still live elsewhere - an array-destructuring positional case, not a delete case.

## Deviations from Plan

### Auto-fixed Issues

None that required Rule 1-3 code changes beyond what the plan's own action text specified - the App.tsx fixes and disable comments are exactly what Task 3 asked for. The one substantive divergence from the plan's literal expectation is a **measurement correction**, not a deviation requiring a fix:

**1. [Measurement correction, not a Rule 1-3 fix] App.tsx's actual violation split differs from both the plan's original 12+10 estimate and the Task 2 inventory's 13+9**
- **Found during:** Task 3, while working through the inventoried violation list
- **Detail:** Deleting the entirely-dead `openBinaryWorkspaceFile` `useCallback` (a mechanical `no-unused-vars` fix - the binding was never referenced anywhere in the file) also deleted its dependency array, which was independently flagged for an `exhaustive-deps` "unnecessary dependency" violation. Removing the whole dead function therefore retired one `no-unused-vars` violation and one `exhaustive-deps` violation in the same edit, landing the final committed count at 12 `no-unused-vars` fixes + 8 new disable comments (down from the Task 2 inventory's 13+9).
- **Verification:** `pnpm exec eslint src/App.tsx --max-warnings 0` exits 0 with the final counts; `git diff src/App.tsx` confirms no dependency array's *contents* were edited anywhere else, and no behavior changed (the deleted callback was provably unreachable - grepped for every symbol it introduced before deleting each one).
- **Committed in:** `e68a63b` (Task 3 commit)

### Contamination note (not a deviation in this plan's own scope)

A concurrent, unrelated Claude session was writing `src-tauri/src/hwped.rs` (new), `src/lib/hwped.ts` (new), and modifying `src-tauri/src/lib.rs` and `README.md` in the same checkout throughout this plan's execution. Per the team lead's explicit instructions, these files were never staged, never touched, and never diagnosed. `src/lib/hwped.ts` sits inside this plan's D-03 lint scope (`src/`), so every `pnpm exec eslint src e2e` inventory run in this plan was scoped with `--ignore-pattern 'src/lib/hwped.ts'` and is reported as excluding that file. See Issues Encountered for the `make verify` interaction.

---

**Total deviations:** 0 requiring a Rule 1-3 fix; 1 measurement correction (documented above); 1 external contamination interaction (documented in Issues Encountered)
**Impact on plan:** None beyond the corrected count, which is a more accurate number than either prior estimate, not a scope change.

## Issues Encountered

- **`make verify` could not be run to a clean exit inside this shared checkout.** `pnpm typecheck`, `pnpm test` (1853/1853), and `cargo test --lib` (1205/1205, run as part of the `make verify` chain) all passed cleanly. The chain then failed at `cargo fmt --check`, and every reported diff was in `src-tauri/src/hwped.rs` and the `hwped`-related import block of `src-tauri/src/lib.rs` - both files belonging to the concurrent session described above, not to this plan (this plan touches no Rust). Per the team lead's explicit instruction, this failure was reported and not diagnosed, fixed, or worked around. `clippy` and `build-frontend` were never reached. **This plan's own verification claim is therefore scoped to what it can prove in isolation:** `pnpm exec eslint src/App.tsx --max-warnings 0` (exit 0), `pnpm typecheck` (exit 0), `pnpm test` (1853/1853), and the `make verify` prerequisites that did run before the unrelated failure (typecheck, release-version-check, icons-check, lint-i18n, check-select-chrome, test-ts, test-rust) all passed. `fmt-check`, `clippy`, and `build-frontend` remain unverified end-to-end pending the concurrent session's own commit or the checkout being unblocked.
- **`pnpm add -D` failed once with `ERR_PNPM_ADDING_TO_ROOT`** because this repo has a `pnpm-workspace.yaml` (`packages: ["."]`) that pnpm's newer root-add guard flags. Re-ran with `-w`/`--workspace-root`; not a plan deviation, a pre-existing repo config unrelated to this task's files.
- **`pnpm add` without a caret initially pinned exact versions** (`"eslint": "10.9.0"` instead of `"eslint": "^10.9.0"`) because exact version strings were passed on the install command line. Corrected to `^`-range pins to match the file's existing convention before the Task 2 commit, per PATTERNS.md.

## Cross-Platform Risk Assessment (CI runs ubuntu-22.04, this session ran macOS)

Low risk. `eslint.config.js` uses only POSIX-style forward-slash glob patterns (`src/**/*.{ts,tsx}`, `e2e/**/*.ts`, `**/dist/**`, `**/node_modules/**`) which are case-sensitive and slash-normalized identically on both platforms; nothing in the config depends on filesystem case-folding (macOS's default case-insensitive HFS+/APFS could in principle hide a glob mismatch that a case-sensitive Linux runner would catch, but every path referenced here matches the actual on-disk casing exactly, verified by the successful `pnpm exec eslint src/lib/e2eFlow.ts` run). `src/App.tsx`'s changes are all TypeScript-level (import removal, dead-code deletion, comment-only disable directives) with no OS-conditional code path. The one item this session could not verify: whether CI's fresh-container `pnpm install --frozen-lockfile` resolves the three new packages' dependency tree identically to this session's `--virtual-store-dir=node_modules/.pnpm` local install; the lockfile is the shared source of truth either way, and `pnpm-lock.yaml`'s diff is a pure, unmodified-elsewhere addition.

## User Setup Required

None beyond the Task 1 checkpoint approval already given.

## Next Phase Readiness

- ESLint 10 flat config is live at `eslint.config.js`, `pnpm exec eslint --version` reports `v10.9.0`
- `src/App.tsx` is ESLint-clean; its 8 new `exhaustive-deps` disable comments (plus 2 pre-existing) are the grep-able worklist Phases 4-5 burn down as they touch each pane
- 01-07 has an exact, re-measured target: **52 errors (24 no-unused-vars + 27 exhaustive-deps + 1 no-floating-promises) + 7 warnings (stale no-console directives)** across 27 files in `src/`, `e2e/` clean - see the per-file breakdown table below
- `src/lib/hwped.ts` was excluded from every measurement in this plan; 01-07 will need its own fresh `pnpm exec eslint src e2e` run once the concurrent session's work has landed, since that file's real violation count (if any) is not yet known
- `make verify`'s `fmt-check`/`clippy`/`build-frontend` steps remain unverified end-to-end in this checkout pending the concurrent session; nothing in this plan's own diff is implicated
- `pnpm lint` remains red by design - `make lint` is not yet a target and `lint` is not in `verify`'s prerequisite list (01-07's job)

### Remaining lint backlog for 01-07 (measured, excludes `src/lib/hwped.ts`)

| File | no-unused-vars | exhaustive-deps (error) | no-floating-promises | stale no-console (warning) |
|---|---|---|---|---|
| `src/components/TerminalPanel.tsx` | 1 | 14 | 0 | 0 |
| `src/components/studio/StudioMode.tsx` | 0 | 3 | 0 | 0 |
| `src/components/catalog/WritingGuidelineSidebar.tsx` | 0 | 2 | 1 | 0 |
| `src/lib/i18n.ts` | 0 | 1 | 0 | 2 |
| `src/components/RichMarkdownEditor.tsx` | 0 | 0 | 0 | 2 |
| `src/lib/useInboxEvents.ts` | 0 | 0 | 0 | 2 |
| `src/lib/markdown.ts` | 0 | 0 | 0 | 1 |
| `src/components/dashboard/DashboardPane.tsx` | 2 | 1 | 0 | 0 |
| `src/components/OutlinePane.tsx` | 2 | 0 | 0 | 0 |
| `src/components/diagram/ribbon/RibbonTable.test.tsx` | 2 | 0 | 0 | 0 |
| `src/components/drafts/DraftsPane.tsx` | 2 | 0 | 0 | 0 |
| `src/lib/dashboard.ts` | 2 | 0 | 0 | 0 |
| `src/lib/diagram/templates.ts` | 2 | 0 | 0 | 0 |
| `src/components/graph/GraphCanvas.tsx` | 1 | 1 | 0 | 0 |
| `src/components/graph/GraphView.tsx` | 0 | 1 | 0 | 0 |
| `src/components/studio/MarkdownSourceEditor.tsx` | 0 | 1 | 0 | 0 |
| `src/components/tasks/TaskFormFields.tsx` | 0 | 1 | 0 | 0 |
| `src/components/today/useTodayPlanner.ts` | 0 | 1 | 0 | 0 |
| `src/components/today/useTodayTasks.ts` | 0 | 1 | 0 | 0 |
| `src/components/diagram/modals/MappingPreviewDialog.test.tsx` | 1 | 0 | 0 | 0 |
| `src/components/diagram/modals/PatternGalleryDialog.tsx` | 1 | 0 | 0 | 0 |
| `src/components/diagram/panels/RightPanel.tsx` | 1 | 0 | 0 | 0 |
| `src/components/diagram/ribbon/RibbonFormat.tsx` | 1 | 0 | 0 | 0 |
| `src/components/drafts/useIdeationDrafts.ts` | 1 | 0 | 0 | 0 |
| `src/components/meetings/MeetingsPane.tsx` | 1 | 0 | 0 | 0 |
| `src/lib/api.ts` | 1 | 0 | 0 | 0 |
| `src/lib/diagram/convert.ts` | 1 | 0 | 0 | 0 |
| `src/lib/diagram/tableActions.ts` | 1 | 0 | 0 | 0 |
| `src/lib/settings.ts` | 1 | 0 | 0 | 0 |
| **Total** | **24** | **27** | **1** | **7** |

---
*Phase: 01-trustworthy-verify-signal*
*Completed: 2026-08-22*

## Self-Check: PASSED

All created/modified files verified present on disk (eslint.config.js, package.json, pnpm-lock.yaml, src/App.tsx); both task commit hashes (cf14a79, e68a63b) verified present in git log.
