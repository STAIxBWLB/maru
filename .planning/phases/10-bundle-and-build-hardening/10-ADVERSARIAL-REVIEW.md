---
phase: 10-bundle-and-build-hardening
reviewed: 2026-09-25
scope: origin/main..main (phase 10 code; archify docs excluded)
method: static cascade-equivalence analysis against the pre-split styles.css, two read-only adversarial reviewers (build guards; CSS split + preload), mutation drills, targeted Playwright runs
status: fixed
---

# Phase 10 Adversarial Review

The phase passed verification, but the CSS split changed rendering, and the guards could not see it. Every finding below has been fixed in the working tree. The "Proof" column says how each fix was checked.

## Findings

| # | Severity | Finding | Fix | Proof |
| --- | --- | --- | --- | --- |
| 1 | critical | **Cascade inversion.** Lazy mode CSS loads after the entry CSS. So 24 declarations that a *later* styles.css rule used to override now win. The affected overrides are the container-query collapses (today sidebar, meetings, drafts/gap/agents list columns), the material header/sheet pass, prefers-contrast, and forced-colors (`.cal-day-number-today`). | Each mode-owned override moved to the end of its mode file, inside the same wrapper. | A declaration-level equivalence check against the pre-split file shows 0 inversions and 0 unintended deletions. The existing `today.spec.ts` "layout smoke at 1024x720" test **fails on the pre-fix tree**: the sidebar is 240px where 56px is expected. It passes after the fix. |
| 2 | critical | **Rules dropped.** The split deleted `@media (max-width: 980px)` `.tasks-calendar-shell` and `.tasks-unscheduled-tray`. It also left `.tasks-sidebar` inside `meetings-pane.css`. | Restored in `tasks.css` at their original position. | Equivalence check reports 0 deletions. |
| 3 | warning | **Cross-chunk class use.** `.task-new-dialog` lived only in `tasks.css`, but the entry shell uses it (unsaved-changes dialog) and so do the Sites dialogs. The TaskFormFields rules were also only in `tasks.css`, but Today's task sheet renders them. All of these were unstyled until the Tasks chunk happened to load. | `.task-new-dialog` is back in styles.css at its original position. The TaskFormFields rules moved to `tasks/taskFormFields.css`, imported by the shared component. | A new cold Sites-dialog case in `first-activation-styles.spec.ts` fails on the pre-fix CSS and passes after the fix. |
| 4 | warning | **The FOUC spec never ran a cold activation.** The idle preload warmed every chunk within about 0.7s, so each "first activation" was warm. | The spec disables idle callbacks, so every activation takes the lazy path. | 39/39 pass cold. |
| 5 | warning | **Preload burst.** All 17 chunks were requested in one loop about 50ms after load, before the rail was interactive. Production: 8 → 81 requests; JS heap 10 → 18 MB. | Staggered: one mode per idle callback, the next only after the previous settles. The cancel handle now stops the queue. The D-03 scope (every mode) is unchanged. | `src/lib/modePreload.test.ts`. |
| 6 | critical | **check-csp-blob dist half was blind.** The comment/string stripper desynced on minified regex literals (`/"/`) and swallowed the rest of the line, so both Worker spawns in the graph chunk were never examined. `import(u)` after `/"/` passed. | Rewritten to parse the bundle with Vite's `parseAst`. Also covers `.mjs`, `importScripts`, `SharedWorker`, and member-called Worker. An unparseable bundle fails closed. | Behavioral tests. The injected `import(zz);new Worker(location.hash)` in the real graph chunk now exits 1. |
| 7 | warning | **The binary half scanned the wrong copy.** Its only needle matched the pretty-printed `include_str!("../../tauri.conf.json")` copy (bundle_update.rs). The CSP tauri-codegen actually compiles in is stored as `script-src'self' blob:...`. | Matches the codegen form and fails closed when it is missing. The JSON copy is still checked for blob:. `script-src-elem` is covered. | Behavioral tests (codegen blob, clean, JSON-only fail-closed). The stale Sep 13 binary correctly fails. |
| 8 | warning | **An ordinary PR could re-add script-src blob:.** The binary half only runs at release. | The default (build:frontend) run also checks every `src-tauri/tauri*.conf.json` CSP. | Behavioral test with a probe config. |
| 9 | warning | **Policy pins were string-only.** Five guard weakenings still passed all 19 tests. | The csp-blob tests are behavioral (subprocess on fixtures). Mutation drill: 4/4 weakenings are now caught. | |
| 10 | warning | **The ownership guard could not see findings 1-2.** | New assertion 6, SPLIT HOME (src): a selector's property may live in only one of styles.css and the marker-bearing files. `ORDERED_HOMES` exempts calendar→tasks, which is load-ordered. Also added: a marker file without a fingerprint is a violation, and paths resolve from the repo root instead of the cwd. | On the pre-fix tree it reports 22 violations covering every inversion. It is clean on the fixed tree. Unit tests cover the parser edge cases. |

Removed as dead code while satisfying SPLIT HOME: 5 declarations in styles.css `@media (max-width: 759px)` targeting `.meetings-pane`, `.meetings-content-grid`, `.meetings-sidebar` and `.meetings-list-row`. They were already overridden by later meetings rules before the split.

## Open (user decision)

- **Preload scope vs memory.** D-03 preloads every mode, including Studio (about 1.8 MB), Graph and Diagram. None of those has per-mode CSS, and Vite already waits for a chunk's CSS before the lazy component renders. The FOUC goal needs only the 6 split modes plus calendar. Narrowing the scope would change D-03, and the native-memory idle-startup scenario (#327) has not been re-measured with preload on.
- **Worker aliasing** (`W=Worker; new W(u)`) and scope-blind createObjectURL bindings are known ceilings of the dist half. They are marked `ponytail:` in the guard.
