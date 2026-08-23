# Phase 3: Typed IPC Error Contract - Pattern Map

**Mapped:** 2026-08-23
**Files analyzed:** 20 (3 new, 17 modified)
**Analogs found:** 20 / 20 — every file has an in-repo analog; this phase formalizes an existing convention, so the analogs ARE the migration sources

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src-tauri/src/ipc_error.rs` (new) | model (error struct) + config (code consts) + test | request-response (IPC boundary) | `src-tauri/src/evidence_binder.rs:22-54` (Serialize struct) + `src-tauri/src/hub_client/http.rs:18-35` (Display impl) | exact |
| `src/lib/ipcError.ts` (new) | utility (error normalization) | request-response | `src/lib/today.ts:696-717` (`todayErrorCode` idiom) + `src/lib/types.ts:52-60` (union idiom) | exact |
| `src/lib/ipcError.test.ts` (new) | test | unit | `src/lib/today.test.ts:194-228` | exact |
| `src/lib/types.ts` (modify) | model (TS type mirror) | — | `src/lib/types.ts:52-60` (existing union block) | exact |
| `src-tauri/src/today_store.rs` (modify) | service (today store) + test | request-response (Tauri command) | self: `check_revision` :506-518, inline guard :617-626, tests :780-800 | exact |
| `src-tauri/src/today_lifecycle.rs` (modify) | service + test | request-response | self: `load_context` :79-94, test :568-575 | exact |
| `src-tauri/src/today_calendar.rs` (modify) | controller (Tauri command) | request-response | self: `today_calendar_publish` :413-427 | exact |
| `src-tauri/src/document.rs` (modify) | service + controller + test | file-I/O + request-response | self: `assert_expected_revision` :122-132, `save_document` :134-193, test :730-743 | exact |
| `src-tauri/src/evidence_binder.rs` (modify) | controller + test | request-response | self: `evidence_binder_mutate` :248-278, test :1711-1723 | exact |
| `src-tauri/src/today_ai.rs` (modify) | service | request-response | self: `today_apply_plan_result` :280-299 (plain-fn call to `today_mutate`) | exact |
| `src-tauri/src/lib.rs` (modify) | config (module registry) | — | `lib.rs:68-74` (today module block) | exact |
| `src/lib/today.ts` (modify) | service (invoke funnel) + utility | request-response | self: `todayInvoke` :12-16, `todayErrorCode`/`isTodayConflict` :696-717 | exact |
| `src/lib/api.ts` (modify) | service (invoke facade) | request-response | self: `saveDocument` :1076-1101 | exact |
| `src/lib/evidenceBinder.ts` (modify) | service (invoke facade) | request-response | self: `mutateEvidenceBinder` :127-146 | exact |
| `src/components/evidence/EvidenceBinderPane.tsx` (modify) | component (branch site) | event-driven (mutation catch) | self: catch block :168-175 | exact |
| `src/lib/diagram/reportInsert.ts` (modify) | utility (branch helper) | request-response | self: `isConflict` :92-94 | exact |
| `src/components/today/TodayReview.tsx` (modify) | component (branch site) | event-driven | self: `saveReflection` catch :166-189 | exact |
| `src/lib/today.test.ts` (modify) | test | unit | self: `todayErrorCode`/conflict-helper describes :194-228 | exact |
| `e2e/helpers/todayFixtures.ts` (modify) | test (e2e fixture) | request-response (mock invoke) | self: `today_mutate`/`today_finalize_setup` mocks :745-794 | exact |
| `src/components/today/TodayPane.tsx`, `TodayExecute.tsx`, `useTodayCalendarSync.ts` (no code change — consumers of `isTodayConflict`/`isTaskConflict`) | component/hook | event-driven | verified call sites below | reference |

## Pattern Assignments

### `src-tauri/src/ipc_error.rs` (new — error struct + code constants + tests)

**Analogs:** `src-tauri/src/evidence_binder.rs:22-54` (Serialize struct convention), `src-tauri/src/hub_client/http.rs:18-35` (Display impl idiom), `src-tauri/src/tasks.rs:1225-1234` (`serde_json::from_value` test).

**Serialize struct pattern** (evidence_binder.rs:22-46 — note the derive set and `rename_all`):
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceBinding {
    pub binding_id: String,
    #[serde(default)]
    pub candidate_id: Option<String>,
    // ...
}
```
For `IpcError { code, message }` both fields are single lowercase words, so **no serde rename attribute is load-bearing** (RESEARCH Pattern 1). Copy the derive/visibility idiom, drop `Deserialize` unless a test needs it.

**Display impl pattern** (hub_client/http.rs:25-35):
```rust
impl std::fmt::Display for HubFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HubFetchError::Network(e) => write!(f, "network: {e}"),
            // ...
        }
    }
}
```
`IpcError`'s Display must be `write!(f, "{}: {}", self.code, self.message)` — this preserves today's byte-identical `"code: message"` user-visible string (Pitfall 1 mitigation; `today_ai.rs` `.map_err(|e| e.to_string())` depends on it).

**Anti-analog (do NOT copy placement):** the two existing error enums are *internal-only*, never cross the bridge:
```rust
// agent_host/status.rs:351-354 — pub(crate)-less, non-Serialize, internal
enum UsageProbeError {
    Unauthenticated(String),
    Other(String),
}
```
`IpcError` is a *boundary* struct — `pub`, `Serialize`, shared module. Copy the enums' match-on-variant idiom only if per-domain matching is wanted, not their placement (RESEARCH Anti-Patterns).

**Wire-shape test pattern** (tasks.rs:1225-1234 — the repo's existing `serde_json::from_value` test idiom, D-09):
```rust
#[test]
fn update_task_schedule_fields_rejects_unknown_fields() {
    let err = serde_json::from_value::<UpdateTaskScheduleFields>(json!({
        "project": "Maru",
        "unknown": "no",
    }))
    .unwrap_err();
    assert!(err.to_string().contains("unknown field"));
}
```
For the round-trip test use `serde_json::to_value(&err)` + `assert_eq!(value, serde_json::json!({"code": ..., "message": ...}))` per RESEARCH Pattern 3.

**Module registration** (lib.rs:68-74 — add `mod ipc_error;` in the alphabetical block):
```rust
pub mod today;
pub mod today_ai;
pub mod today_calendar;
pub mod today_lifecycle;
```

---

### `src-tauri/src/today_store.rs` (emit sites + shared helper + tests)

**Analog:** self — `check_revision` (lines 506-518):
```rust
/// Optimistic-concurrency guard shared by every revision-checked command.
pub(crate) fn check_revision(
    snapshot: &TodaySnapshot,
    expected_revision: &str,
) -> Result<(), String> {
    if snapshot.revision != expected_revision {
        return Err(format!(
            "today_conflict: expected revision {expected_revision}, found {}",
            snapshot.revision
        ));
    }
    Ok(())
}
```
Becomes `Result<(), IpcError>`; the `"today_conflict: "` prefix moves to the `code` field, message keeps the rest verbatim (D-02).

**Inline guard** (lines 617-626, `today_mutate`; identical at :1055-1075):
```rust
if snapshot.revision != expected_revision {
    return Err(format!(
        "today_conflict: expected revision {expected_revision}, found {}",
        snapshot.revision
    ));
}
```

**Existing test to migrate** (today_lifecycle.rs:568-575 shows the assertion idiom used across all four files):
```rust
let err = task_transition(work(&tmp), req).unwrap_err();
assert!(err.starts_with("task_conflict: expected hash bogus, found "));
```
After migration: `assert_eq!(err.code, TASK_CONFLICT)` + `assert_eq!(err.to_string(), "task_conflict: expected hash bogus, found ...")`. Same edit shape at `today_store.rs:788,1038`, `document.rs:738`, `evidence_binder.rs:1722` (`assert_eq!(error, "evidence_binder_revision_conflict")` → `assert_eq!(error.code, EVIDENCE_BINDER_REVISION_CONFLICT)`), `today_lifecycle.rs:574,789`.

---

### `src-tauri/src/document.rs` (assert_expected_revision + save_document)

**Analog:** self (lines 122-132):
```rust
fn assert_expected_revision(current: &str, expected: Option<&str>) -> Result<(), String> {
    if let Some(expected) = expected {
        let actual = revision_for(current);
        if actual != expected {
            return Err(format!(
                "document_conflict: expected revision {expected}, found {actual}"
            ));
        }
    }
    Ok(())
}
```
Three emit sites total: :126-128, :150-152, :185-188 — all inside `save_document` (:134-193), which flips to `Result<DocumentPayload, IpcError>`. Non-conflict `Err(format!("Cannot read document: {err}"))` strings at :147, :182 must be wrapped into `IpcError` too **or** the function keeps a crate-internal error type that converts — planner decides; simplest is an `IpcError` with a non-contract code constant for display-only paths (do NOT add these codes to the TS union).

---

### `src-tauri/src/evidence_binder.rs` (evidence_binder_mutate)

**Analog:** self (lines 248-278). Note the lock-poison and conflict errors:
```rust
let _guard = BINDER_WRITE_LOCK
    .lock()
    .map_err(|_| "evidence_binder_lock_poisoned".to_string())?;
// ...
if actual_revision != req.expected_revision {
    return Err("evidence_binder_revision_conflict".to_string());
}
```
The conflict error has **no message suffix today** — the migrated `IpcError.message` must be a real human string (e.g. `"revision changed"`); the facade re-adds the code prefix so user-visible text gains a suffix harmlessly. `evidence_binder_lock_poisoned` is a sibling non-contract error — same treatment question as document.rs's read errors.

---

### `src-tauri/src/today_lifecycle.rs` / `today_calendar.rs` / `today_ai.rs`

**load_context hash guard** (today_lifecycle.rs:89-94):
```rust
let actual_hash = revision_for(&raw);
if actual_hash != expected_task_hash {
    return Err(format!(
        "task_conflict: expected hash {expected_task_hash}, found {actual_hash}"
    ));
}
```
`load_context` returns `Result<TransitionContext, String>` and is shared by `task_transition` (:368) and `task_trash` (:448) — both in the migration set, so flipping the helper to `IpcError` leaves no String-typed straggler (RESEARCH Pitfall 4).

**Command consuming a shared helper** (today_calendar.rs:426-427):
```rust
let (_, entry_snapshot) = load_snapshot_with_raw(&work, &logical_day)?;
check_revision(&entry_snapshot, &expected_revision)?;
```
The `?` propagates the new `IpcError` once `today_calendar_publish`'s signature flips — no call-site edit beyond the signature.

**Plain-fn caller needing `.map_err`** (today_ai.rs:293-298):
```rust
today_mutate(
    work_path,
    logical_day,
    expected_revision,
    TodayMutation::SetPlan { plan },
)
```
`today_apply_plan_result` keeps `Result<TodaySnapshot, String>` (display-only, ERR-04) → append `.map_err(|e| e.to_string())`. The Display impl makes this byte-identical to today's prefix string.

---

### `src/lib/ipcError.ts` (new — union + Error subclass + normalizer)

**Union idiom analog** (types.ts:52-60):
```typescript
export type WorkspaceProvider =
  | "local"
  | "googleDrive"
  | "oneDrive"
  | "sharePoint"
  | "nextcloud"
  | "obsidian"
  | "unknown";
```
One literal per line, trailing `;` — copy this formatting for `IpcErrorCode`. If the union lives in `types.ts` (D-03 says it does), `ipcError.ts` imports it from `./types`.

**Error-shape handling analog** (today.ts:698-706 — the unknown-narrowing style to copy):
```typescript
export function todayErrorCode(err: unknown): string | null {
  const message =
    typeof err === "string" ? err : err instanceof Error ? err.message : null;
  if (!message) return null;
  // ...
}
```
`normalizeIpcError(reason: unknown)` follows the same defensive narrowing (RESEARCH Pattern 2 type-guard), then constructs `class IpcError extends Error` with `super(\`${body.code}: ${body.message}\`)` — the `"code: message"` message keeps toasts and the smoke.spec.ts:1281 assertion byte-identical (Pitfall 1).

---

### `src/lib/today.ts`, `api.ts`, `evidenceBinder.ts` (funnel wiring, D-07)

**Funnel analog 1** (today.ts:12-16 — single-entry invoke wrapper):
```typescript
async function todayInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const override = await invokeE2EOverride<T>(command, args);
  if (override !== null) return override;
  return invoke<T>(command, args);
}
```
Wrap the `invoke` line: `.catch((e) => { throw normalizeIpcError(e); })` — but **only** for migrated commands (per-command opt-in, since unmigrated commands still reject with raw strings; the normalizer passes those through unchanged anyway). Note the e2e override resolves *before* invoke — fixtures must throw the already-normalized shape (Pitfall 2).

**Funnel analog 2** (api.ts:1095-1100, `saveDocument`):
```typescript
return invoke<DocumentPayload>("save_document", {
  vaultPath,
  documentPath,
  content,
  expectedRevision: expectedRevision ?? null,
});
```

**Funnel analog 3** (evidenceBinder.ts:145):
```typescript
return invoke<EvidenceBinderResponse>("evidence_binder_mutate", { req: params });
```
Note its browser-mock sibling at :138-139 already throws `new Error("evidence_binder_revision_conflict")` — after migration the mock should throw the normalized shape (`Object.assign(new Error("evidence_binder_revision_conflict: ..."), { code: "evidence_binder_revision_conflict" })` or the new `IpcError` class) so component branches work in browser dev.

**Retired-helper pattern** (today.ts:708-717 — before/after per RESEARCH Code Examples):
```typescript
// Before
export function isTodayConflict(err: unknown): boolean {
  return todayErrorCode(err) === "today_conflict";
}
// After
export function isTodayConflict(err: unknown): boolean {
  return err instanceof IpcError && err.code === "today_conflict";
}
```

---

### Branch sites (5 edits, all the same shape)

**Raw `.includes` site 1** (EvidenceBinderPane.tsx:168-175):
```typescript
} catch (err) {
  if (mutationSeqRef.current === mutationSeq) {
    setState(previousState);
    setRevision(previousRevision);
    const message = err instanceof Error ? err.message : String(err);
    setError(message);
    if (message.includes("evidence_binder_revision_conflict")) void load();
  }
}
```
After: `if (err instanceof IpcError && err.code === "evidence_binder_revision_conflict") void load();` — the `err instanceof Error ? err.message : String(err)` toast line stays untouched (Pitfall 5: this site is safe under the new Error subclass).

**Raw `.includes` site 2** (reportInsert.ts:92-94):
```typescript
function isConflict(message: string): boolean {
  return message.includes("document_conflict");
}
```
After: takes `err: unknown`, checks `err instanceof IpcError && err.code === "document_conflict"` — call-site signature change at the one caller inside `insertDiagramIntoReport`.

**Helper-based sites** (TodayReview.tsx:176, TodayPane.tsx:253/271/294, TodayExecute.tsx:259, useTodayCalendarSync.ts:51) — no edit needed if `isTodayConflict`/`isTaskConflict` keep their names and signatures; only TodayReview's direct `todayErrorCode(err) === "document_conflict"` (:176) needs switching to a code check:
```typescript
} catch (err) {
  if (todayErrorCode(err) === "document_conflict") {   // → err instanceof IpcError && err.code === "document_conflict"
    setNotice("conflict");
    // ...
```

---

### `src/lib/today.test.ts` + `src/lib/ipcError.test.ts` (TS tests)

**Analog:** today.test.ts:194-228 — the describes being replaced/extended:
```typescript
describe("todayErrorCode", () => {
  it("extracts the machine-readable prefix before ': '", () => {
    expect(todayErrorCode("today_conflict: expected revision abc, found def")).toBe(
      "today_conflict",
    );
    // ...
  });
});

describe("conflict helpers", () => {
  it("isTodayConflict matches only today_conflict", () => {
    expect(isTodayConflict("today_conflict: expected revision a, found b")).toBe(true);
    expect(isTodayConflict(new Error("today_conflict: x"))).toBe(true);
    expect(isTodayConflict("task_conflict: x")).toBe(false);
    // ...
  });
});
```
New tests assert: `normalizeIpcError({code, message})` → `IpcError` with `.code`, `.message === "code: message"`, `instanceof Error`; pass-through for raw strings/plain objects lacking the shape; `isTodayConflict(new IpcError(...))` true / legacy string false (D-08 retirement).

---

### `e2e/helpers/todayFixtures.ts` (mock shape update, Pitfall 2)

**Analog:** self (lines 751-755, 790-794):
```typescript
if (expected !== snapRevision) {
  throw new Error(
    `today_conflict: expected revision ${expected}, found ${snapRevision}`,
  );
}
```
After: `throw Object.assign(new Error(\`today_conflict: expected revision ${expected}, found ${snapRevision}\`), { code: "today_conflict" })` — matching the normalized shape the funnel produces. `e2e/smoke.spec.ts:1266-1268`'s `throw new Error("document_conflict: revision changed")` can stay as-is **only if** the save-document path's normalization happens inside `saveDocument` after the e2e override — otherwise give it `.code` too; the :1281 `toContainText("document_conflict")` assertion survives either way because the message keeps the prefix.

## Shared Patterns

### Tauri command error contract
**Source:** `src-tauri/src/today_calendar.rs:413-421` + every migrated command
**Apply to:** All 7 migrated Rust commands
```rust
#[tauri::command]
pub fn today_calendar_publish(
    work_path: String,
    // ...
) -> Result<CalendarPublishOutcome, String> {   // → Result<_, IpcError> for migrated commands only
```
`Err(E: Serialize)` rejects the frontend promise with `E` serialized — framework behavior; the other ~1,131 `Result<T, String>` signatures stay untouched (ERR-04; re-run the baseline grep at execution time, RESEARCH Pitfall 6: current count 1,138).

### Catch-site error reading (unchanged contract)
**Source:** `src/components/evidence/EvidenceBinderPane.tsx:172`, `src/components/today/TodayPane.tsx:297`
**Apply to:** All branch sites — verify, don't rewrite
```typescript
const message = err instanceof Error ? err.message : String(err);
setError(message);
```
Safe under `IpcError extends Error` as long as `name` is managed (Pitfall 5: `String(err)` on an Error subclass yields `"IpcError: message"` — every migrated command's catch site uses the `instanceof` guard, keep it that way).

### Toast path (untouched, D-07)
**Source:** `src/lib/errorStore.ts` (full file — string-only store)
**Apply to:** Nothing changes; `setError` consumes strings, the normalized `Error.message` carries `"code: message"` so toasts render byte-identical text.

### E2E invoke seam
**Source:** `src/lib/e2eInvoke.ts` (full file)
**Apply to:** Funnel wiring + fixture updates — overrides run *before* real invoke and bypass normalization, so fixtures must throw the post-normalization shape.

### Gate set (ERR-02 mechanism)
**Source:** `Makefile:321` (`verify: typecheck lint ... test-ts test-rust fmt-check clippy build-frontend`)
**Apply to:** The rename drill — Rust const-pin test fails `cargo test` ⊂ verify; TS union rename fails `tsc -b` ⊂ verify. No new gate required; optional grep guard is planner's discretion (RESEARCH Open Question 3).

## No Analog Found

None — every new construct has an in-repo idiom. The closest thing to novel code is `class IpcError extends Error` (no existing Error subclass in `src/`); RESEARCH.md Pattern 2 supplies the full reference implementation and the `todayErrorCode` narrowing style supplies the repo idiom for `unknown` handling.

## Metadata

**Analog search scope:** `src-tauri/src/` (today_store, today_lifecycle, today_calendar, today_ai, document, evidence_binder, graph_authoring error enums, hub_client/http, agent_host/status, tasks tests, lib.rs), `src/lib/` (today, api, evidenceBinder, types, errorStore, e2eInvoke, today.test), `src/components/` (evidence, today panes/hooks), `e2e/` (todayFixtures, smoke.spec)
**Files scanned:** 22
**Pattern extraction date:** 2026-08-23
