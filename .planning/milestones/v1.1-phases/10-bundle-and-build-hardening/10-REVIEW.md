---
status: findings
files_reviewed: 53
critical: 0
warning: 2
info: 7
total: 9
---

# Phase 10 Review — Bundle and Build Hardening

Scope: git diff `51ead32b^..HEAD` (plans 10-01/02/03; 84 files, +29694/−7750), standard depth, focused on security (CSP handling, command injection, path traversal, secret exposure), bugs (logic errors, race conditions, error swallowing, resource leaks), and code quality.

Security conclusions: the CSP `script-src` hardening (`'self' blob:` → `'self'`, src-tauri/tauri.conf.json ~line 35) is genuine; `worker-src` correctly retains `blob:` so graphology FA2 blob-URL worker spawns stay legal. The new binary-half guard (check-csp-blob.mjs) fails closed (missing serialization → violation) and is wired into `release-checks` before the artifact prune. No command injection: gws invocations use `Command::new` with JSON-encoded args, no shell. Path traversal safe: `normalize_existing_dir` canonicalizes and requires `is_dir`; `WalkDir` uses `follow_links(false)`; maruignore respected. No secret exposure in the diff. No critical findings.

Cross-checks verified: REGISTERED_MODE_IDS (18) matches `modeRegistry.getRegisteredModeIds()`; all 7 PANE_ROOT_BODY_PREFIX entries match the actual first rules of the per-mode CSS files; `scheduleStartupIdle(work, timeout)` signature matches modePreload usage; TerminalPanel `graphPanelMounted` refactor is semantically equivalent to the old conditionals; i18n en/ko additions symmetric; ai_router mission-registration reorder fixes the fast-child-line race.

## Critical

None found.

## Warnings

### WR-1

**File:** src-tauri/src/today_calendar.rs, lines 601-608
**Severity:** warning

The plan-publish loop resolves each item's destination with `destinations.resolve(...)?` inside the per-item `for` loop. Items earlier in the queue may already have published (each publish is durable via `with_path_transactions` + outbox enqueue), but a resolution failure on a later item propagates out of the whole publish call, discarding the partial `CalendarPublishOutcome` (the `published` count of earlier items is never reported) and leaving the failing item uncounted in any outcome at all. The caller (`useTodayCalendarSync.publishSelected`) then surfaces only a generic `error` notice, so the user cannot tell that some items succeeded and which one failed or why (e.g. `calendar_destination_unresolved` from an item carrying an invalid per-item destination).

**Suggested fix:** resolve the destination per item without `?`: on failure, record the item as failed (`outcome.failed += 1`, attach the resolve error to the item's `CalendarSyncState.message`), continue with the remaining queue, and return the completed outcome (with `blocked`/`failed` flags) instead of aborting. Keep the abort semantics only for pre-loop failures (`resolve_gws`, `CalendarDestinations::load`), which happen before any publish.

### WR-2

**File:** src-tauri/src/today_outbox.rs, lines 606-608
**Severity:** warning

`calendar_body` serializes `json!({})` when a `CalendarUpsert` record is missing its `calendar` payload. Unlike `upsert_body` (whose `{}` fallback is harmless because gws `tasks.patch` treats omitted fields as no-op), an empty calendar body is actively destructive-ish for the insert/patch verbs: `calendar.events.insert --json {}` would create a remote event with no summary/times, and `calendar.events.patch --json {}` would silently succeed while the record's real change never lands — the write-back then marks the record settled and the note's payload divergence is never synced. The payload should always be present (producers set it), so hitting the fallback means a serialization bug or a torn write, not a legitimate request.

**Suggested fix:** treat a missing `calendar` payload on a calendar op as a record error: back off (retry) or drop with `outbox_dropped_terminal`-style accounting and a log line, rather than sending an empty body. A `debug_assert!` plus a defensive `BackOff` return keeps release behavior safe while surfacing the invariant in tests.

## Info

### IN-1

**File:** src/components/graph/GraphCanvas.tsx, lines 1487-1489
**Severity:** info

The trailing effect `if (paused) stopLayoutRef.current?.()` stops the force layout when the surface hides, but nothing restarts it when the surface is revealed without suspension having occurred (hide + reveal both inside the grace window, or grace disabled): `paused` flipping false matches no branch, and the main layout effect only re-runs on nodes/edges/themeEpoch/rendererEpoch changes. The graph keeps rendering from the last snapshot positions, so the result is a frozen layout until the next topology trigger. The e2e coverage (graph-shell.spec.ts) exercises only the suspend/remount path (grace override 200ms → unmount → remount), not the quick-hide/reveal path.

**Suggested fix:** restart the layout on reveal — e.g. extend the trailing effect to `if (!paused && !canvasSuspended) startLayoutRef.current?.()` (mirror of stopLayoutRef) or re-invoke the renderer's resume. Add an e2e case for hide-within-grace → reveal asserting the layout resumes.

### IN-2

**File:** scripts/check-mode-css-ownership.mjs, lines 26-27
**Severity:** info

The guard resolves `dist/assets` and `src/components` with `path.resolve(...)` relative to `process.cwd()`, so running it from any directory other than the repo root fails with "dist/assets not found" (fail-closed, so safe but confusing). Its sibling guard check-csp-blob.mjs deliberately derives the repo root from `import.meta.url` to be cwd-independent, so the two guards have inconsistent invocation contracts.

**Suggested fix:** derive both paths from `import.meta.url` as check-csp-blob.mjs does (or document the repo-root-only contract next to the Makefile/pnpm script entries). Low priority since the wired-in invocations (`pnpm`, `make release-checks`) already run from the repo root.

### IN-3

**File:** scripts/check-csp-blob.mjs, lines 146-151
**Severity:** info

`hasBlobUrlBinding` scans a fixed 1024-character look-behind window for the `<id> = [...].createObjectURL(` binding. A future minifier layout that places the binding farther from the `new Worker(` use site would produce a false-positive violation. The failure mode is fail-closed (exit 1 → build blocks until investigated), so this is a maintenance annoyance, not a policy hole; today's esbuild output binds within a few dozen characters.

**Suggested fix:** if the window ever trips in practice, widen it or anchor the scan to the whole stripped half instead of a window; optionally note the assumption in the comment at line 142. No change needed now.

### IN-4

**File:** src-tauri/src/calendar_sync.rs, lines 27-29 and 558-559
**Severity:** info

Adoption adds a note that already carries `calendarEventId` to the ledger without any provider call, trusting the backref. This is a documented trade-off, and the blast radius is bounded: notes naming another `calendarId` are skipped, and a backref pointing at a nonexistent event in the configured destination surfaces as 404/410 on the first patch, which the outbox's terminal path turns into a fresh insert (upsert-recreate). Worst case is one wasted provider round-trip per stale backref.

**Suggested fix:** if stale backrefs ever show up in the ledger, add an optional existence check (dry-run style, batched `events.get`) before adopting. Not needed for this phase.

### IN-5

**File:** src-tauri/src/calendar_sync.rs, lines 32-35
**Severity:** info

The header comment ("ponytail") correctly documents that outbox claims are process-local (`ACTIVE_OUTBOX`): the daily `maru calendar-sync` CLI job and an app-side drain landing in the same second could both claim one record and double-insert (two remote events, one note). Documented with the remediation path (file-lock claim in `task_integrations_drain`) but not implemented.

**Suggested fix:** keep as a tracked known-issue; implement the file-lock claim in `task_integrations_drain` if the double-insert signature ever appears in the ledger. No change required now.

### IN-6

**File:** src-tauri/src/today_outbox.rs, lines 821-824
**Severity:** info

The new 410 terminal-error patterns (`"code": 410`, `"code":410`, `resource has been deleted`) have no unit test pinning them — grep shows the patterns exist only in source, and the existing `is_terminal_error` coverage (via the drain tests at lines 1108/1130) exercises the 404 path. A future refactor of `is_terminal_error` could silently drop the 410 handling, breaking the upsert-recreate path for remotely deleted calendar events.

**Suggested fix:** add a small unit test asserting `is_terminal_error` returns true for each of the three 410 patterns (and the existing 404 pattern), mirroring the hermetic source-pin style used by the guard tests.

### IN-7

**File:** src/components/today/useTodayCalendarSync.ts, lines 77-78
**Severity:** info

`syncNotes`'s catch block discards the thrown error entirely (`catch { setNotice("error"); }`), so the Rust error string (e.g. `calendar_destination_unresolved`, gws binary not found) never reaches the user or the console — the Today panel shows only the generic error notice. The sibling `publishSelected` at least distinguishes conflicts; neither surfaces detail.

**Suggested fix:** capture the error and surface a short detail: `catch (err) { console.error("calendar sync failed", err); setNotice("error"); }` at minimum, or extend `TodayCalendarNotice` to carry a message string rendered in `TodayCalendarSyncPanel`.
