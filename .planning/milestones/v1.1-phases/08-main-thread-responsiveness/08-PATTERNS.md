# Phase 08: Main-Thread Responsiveness - Pattern Map

**Mapped:** 2026-09-05
**Dispatch:** generic-agent workaround using the project-local pattern-mapper role. Source inspection only; no implementation or runtime verification claimed.

## File Classification

The exhaustive command SSOT is `08-COMMAND-INVENTORY.md`: 365 commands in 79 definition modules. The groups below classify every module exactly once. Each implementation plan must claim concrete modules and all their inventory rows, including AUDIT and already-isolated rows. These are pattern families, not permission to put an entire family into one oversized plan. Paths in this table are relative to `src-tauri/src/`.

| Files or module family | Role and data flow | Pattern assignment |
| --- | --- | --- |
| `skill_host/store.rs`, `skill_host/env.rs`, `skill_host/dispatch.rs` | Controller/service; registry CRUD, network, subprocess, progress events | Current store transaction boundaries plus hwped wrapper; new lease/incarnation protocol required |
| `telegram_io.rs`, `gmail_gws.rs`, `outlook_mso.rs`, `kakao_relay.rs`, `hub_client/mod.rs` | Provider controllers; network/subprocess request-response and polling | hwped finite-work wrapper; preserve existing isolated methods and background loop ownership |
| `git.rs`, `dot_sync.rs`, `jobs.rs`, `scheduler.rs`, `launchd_migration.rs`, `terminal_hooks.rs`, `ai_router.rs`, `mission_state.rs`, `agents.rs`, `agent_host/proposal.rs`, `agent_host/structured_loop.rs`, `agent_host/cloud_dashboard.rs`, `agent_host/status.rs`, `agent_host/event_store.rs` | Controllers/services; subprocess, filesystem, lifecycle/event-driven | hwped wrapper around finite blocking work; retain sync domain entry points and existing long-lived workers |
| `terminal/mod.rs`, `scratchpad_watcher.rs`, `inbox_watcher.rs`, `vault_watcher.rs`, `ops_catalog/watcher.rs` | Lifecycle controllers; native resource setup, stream, event-driven | Owned worker input; preserve current session/epoch invariants and dedicated drain threads; partial-match only |
| `vault.rs`, `workspace_files.rs`, `content_search.rs`, `calendar_search.rs`, `project_activity.rs`, `ops_catalog/mod.rs`, `vault_graph.rs`, `kg_refs.rs` | Read/index controllers; walk, batch, transform | hwped async boundary with existing sync scanner/index helper |
| `document.rs`, `file_manager.rs`, `scratchpad.rs`, `shelf.rs`, `drafts.rs`, `gap.rs`, `meetings.rs`, `tasks.rs`, `graph_authoring.rs`, `vault_guard.rs` | Document services; guarded CRUD, file I/O, scans | hwped scheduling shape plus IpcError-preserving boundary; retain existing mutation guards |
| `inbox.rs`, `inbox_classifier.rs`, `share_outbox.rs`, `binary_viewer.rs`, `secrets.rs` | Processing controllers; filesystem/process batch | hwped finite worker; preserve authorization and update operation lifetime at caller |
| `today.rs`, `today_store.rs`, `today_calendar.rs`, `today_lifecycle.rs`, `today_outbox.rs`, `today_ai.rs`, `web_actions.rs`, `evidence_binder.rs` | Transaction services; revision-checked CRUD and external work | Preserve typed errors and sync transaction API; only async IPC wrapper changes |
| `studio/mod.rs`, `diagram/mod.rs`, `export/mod.rs`, `export/dispatch.rs`, `hwped.rs`, `hwp_cli_template.rs`, `template_fill.rs` | Document/export controllers; file I/O, subprocess, request-response | hwped exact shape for wrapper; keep validation and managed-write implementation |
| `maru_dir.rs`, `vault_list.rs`, `workspace.rs`, `inbox_settings.rs`, `telegram_config.rs`, `sites.rs`, `e2e_flow.rs` | Configuration controllers; CRUD and finite-file reads | Audit reachable helpers before retention; same wrapper if blocking work is reached |
| `html_editor.rs`, `browser_passkeys.rs`, `site_view.rs`, `today_notify.rs` | Native UI controllers; UI dispatch and incidental I/O | Preserve native thread affinity; do not blanket-copy whole-function offload |
| `approval.rs`, `korean_date.rs`, `linter/gaejosik.rs` | Policy/model/parser; bounded request-response | Retain positively bounded behavior; audit indirect effects before final disposition |

Non-command integration files:

| Existing or proposed file | Role and data flow | Closest existing analog |
| --- | --- | --- |
| `src/lib/skills.ts`, `src/lib/ipcError.ts`, `src/lib/types.ts`, `src-tauri/src/ipc_error.rs` | IPC contract; request-response | Existing normalizer and typed error conversion |
| `src/components/settings/tabs/SkillsTab.tsx` | Component; operation start, progress subscription, scoped refresh | Existing Skills API and progress protocol; external-store lifetime is new |
| Proposed `src/lib/skillOperations.ts` and focused test | Store/service; workspace-scoped operation events | `src/lib/knowledgeModeStore.ts`, `src/lib/errorStore.ts` |
| Existing error/toast renderer and `src/lib/errorStore.ts` | Notification surface; completion events | Extend existing surface minimally; no generic success API currently exists |
| `src/lib/nativeE2eBridge.ts`, proposed `src-tauri/src/native_e2e.rs` | Test-only bridge/controller; real IPC and async probe | Existing literal build gate; Rust probe is new |
| `e2e-native/helpers/fixtureWorkspace.ts`, `e2e-native/wdio.conf.ts`, proposed `e2e-native/specs/responsiveness.spec.ts` | Native fixture and test; lifecycle, filesystem, overlapping IPC | Existing fixture lifecycle and native runner |
| `scripts/check-native-e2e-isolation.mjs`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs` | Build guard and registration | Existing production bundle/binary artifact scans and feature gates |

## Pattern Assignments

### Finite blocking work with synchronous domain helpers

**Exact scheduling analog:** `src-tauri/src/hwped.rs:646-654`.

```rust
#[tauri::command]
pub async fn hwped_read(
    document: HwpedDocumentRef,
    workspace_root: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || read_now(document, workspace_root))
        .await
        .map_err(|err| format!("hwped_task_failed: {err}"))?
}
```

Copy the two-level shape: owned IPC arguments enter a finite blocking closure; the existing synchronous domain function remains usable by the CLI, other Rust helpers, and unit tests. `#[tauri::command(async)]` alone is not this pattern. Move lock acquisition and blocking helper chains into the worker too. Do not move borrowed `State`, a mutex guard, or a borrowed progress reporter across await. Obtain owned state handles, or create a reporter inside the closure from moved `AppHandle` and progress ID.

Existing concrete progress construction is `src-tauri/src/skill_host/store.rs:364-402`: `ProgressReporter::new(&app, progress_id.as_deref())` emits `skills-op://progress` with `progress_id`, `level`, `message`, `completed`, and `total`. Preserve this event contract.

Native UI and indefinite workers are exceptions: preserve their current dispatch/lifecycle and offload only finite incidental work. Terminal writes/resize/kill need existing ordering and session identity, not independent unordered jobs.

### Structured errors survive both result layers

**Current error analog:** `src-tauri/src/ipc_error.rs:49-57`.

```rust
impl From<String> for IpcError {
    fn from(message: String) -> Self {
        IpcError {
            code: String::new(),
            message,
        }
    }
}
```

The hwped example has String domain errors. For a typed domain result, the following is a **proposed adaptation**, not a current helper:

```rust
tauri::async_runtime::spawn_blocking(move || domain_impl(request))
    .await
    .map_err(|err| IpcError::from(format!("operation_task_failed: {err}")))?
```

The final expression returns the inner `Result<T, IpcError>` untouched. Join failure becomes a display-only legacy error; it must not fabricate a conflict code. Never stringify the inner domain error. Existing recursive ERR-06 source guard lives in `ipc_error.rs`; update emitter coverage when new code-producing helpers appear.

**Frontend analog:** `src/lib/ipcError.ts:31-47` checks known codes and constructs `IpcError`; unknown serialized codes become ordinary `Error`. The API funnel imports that normalizer in `src/lib/api.ts:26`. `src/lib/skills.ts:332-357` currently calls `invoke` directly, so newly coded busy/stale outcomes require normalization there plus matching Rust constants and `src/lib/types.ts` known-code union. Preserve the `skillsSyncAllSources` browser fallback, adding explicit skipped counts if the wire type gains them.

### Registry transaction and source ownership

**Current mutation analog:** `src-tauri/src/skill_host/store.rs:561-568`.

```rust
#[tauri::command]
pub fn skills_remove_source(source_id: String) -> Result<(), String> {
    let source_id = normalize_source_id(&source_id)?;
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;
    remove_source_from_registry(&mut registry, &source_id)?;
    save_registry_unlocked(&registry)
}
```

Retain the fresh-load-under-lock pattern. `registry_guard` at 2622-2631 uses the Phase 7 `recover_guard` justification: the mutex protects no in-memory invariant because disk is reloaded. Do not copy that recovery into a new invariant-bearing in-flight map without a separate justification.

Current sync at 582-709 holds this guard over pull and scan; this is the behavior to replace, not an analog to copy. Proposed flow: admit a per-source lease and capture identity under the registry lock; release before network; reacquire and reload; reject missing or changed incarnation/config generation; merge only still-current source results. Keep the fresh scan/commit guarded unless a separate content-generation protocol proves an unlocked scan safe.

`SkillSource` at 53-69 demonstrates `#[serde(default)]` and optional compatibility fields, but has no incarnation or configuration revision today. `upsert_linked_source` at 4151-4176 replaces existing linked configuration. `remove_source_from_registry` at 4178-4210 removes source/skills and records a tombstone; `clear_removed_source` at 4227-4231 clears it on re-add. Therefore tombstones or ID equality alone cannot detect identical delete/re-add. Cover default insertion, reset, add, linked upsert, remove/re-add, and change/revert when introducing generations. Timestamp-only sync changes must not invalidate configuration.

**No existing close analog:** nonblocking per-source lease with RAII release and ABA-safe mutation generation. Treat as new narrow registry protocol. Lease lifetime survives deletion until the old operation settles; duplicates return immediately, never queue. The same transaction owns single and batch paths. Batch stores each success against fresh state; busy is skipped and is not success. Retain all existing ownership, installed-source removal restrictions, and filesystem write checks.

### Workspace-scoped operation lifetime and notification

**Store analog:** `src/lib/knowledgeModeStore.ts:134-145`.

```typescript
setScratchpadWorkspace(workspacePath) {
  scratchpadWorkspaceGeneration += 1;
  publishScratchpad({ ...scratchpad, workspacePath });
  return scratchpadWorkspaceGeneration;
},
publishScratchpadForWorkspace(generation, patch) {
  if (generation !== scratchpadWorkspaceGeneration) return false;
  publishScratchpad({ ...scratchpad, ...patch });
  return true;
},
```

Copy stable immutable snapshots, subscriptions, and workspace-generation admission for view publication. Module-level operation ownership keyed by initiating workspace and operation ID is a **new extension**. It must keep the mutation promise and progress subscription alive through screen unmount, while preventing A->B or A->B->A stale refresh. View-subscription disposal is not operation cancellation. Returning to the source workspace reattaches current progress and can refresh disk results.

**Notification analog:** `src/lib/errorStore.ts:20-39` publishes a module-level value to subscribers; `useError` uses `useSyncExternalStore` at 46-53. It is error-only today. `src/lib/useUpdaterToasts.ts:24-33` provides update-specific success/error variants, not a general success port. Extend the existing toast area narrowly for operation success/info/failure and leave existing error setter callers compatible. No new job center or MainApp state/prop plumbing.

Keep listener registration failure and late registration cleanup explicit, as `src/lib/useUpdaterToasts.ts:179-199` already handles disposed listeners. Operation listeners dispose on settlement even if their initiating component has gone. Emit completion once, retain manual retry, and show actionable failure. Apply the same lifetime rules to scoped file-processing callers; do not wrap ordinary reads into a new operation service.

### Native proof and artifact isolation

**Fixture analog:** `e2e-native/helpers/fixtureWorkspace.ts:110-117`.

```typescript
const root = await fs.mkdtemp(path.join(os.tmpdir(), "maru-native-e2e-"));
fixtureRoot = root;
await writeFixtureContent(root);
const resolved = fixturePaths(root);
process.env.MARU_NATIVE_E2E_HOME = resolved.homeDir;
process.env.MARU_NATIVE_E2E_CONFIG_DIR = resolved.configDir;
return resolved;
```

Extend this root with local Git remotes and a real nonempty tree; seed before process launch. `e2e-native/wdio.conf.ts` sets one app instance, seeds in `onPrepare`, resets in `beforeTest`, and cleans the run root in `onComplete`. Do not move cleanup to per-session teardown or delete watched directories during reset. Store timing artifacts outside the temporary fixture before cleanup.

**Bridge analog:** `src/lib/nativeE2eBridge.ts:74-83`.

```typescript
if (import.meta.env.VITE_NATIVE_E2E !== "1") return () => {};
bridgeNamespace();
terminalTextReaders.set(sessionId, read);
return () => {
  terminalTextReaders.delete(sessionId);
};
```

Copy the literal build-time gate at each registration entry point. Add narrowly allowlisted real command calls on the existing namespace; an unrestricted arbitrary invoke/eval port is not needed. No existing native async latency probe or load-control protocol exists: the proposed Rust probe must be genuinely async on the same Tauri runtime, must not use spawn_blocking, and must be feature-gated with its registration. Real workload paths remain real registered commands; barrier-only or sleep-only commands do not substitute for production work.

`scripts/check-native-e2e-isolation.mjs:41-54,78-100,180-197` scans the produced frontend namespace and produced normal binary plugin markers. Extend binary checks for distinctive Rust probe/control markers, rebuild without native features, and verify actual artifacts. Cargo declaration checks alone cannot prove isolation. Preserve raw baseline/loaded/recovery timings, overlap, outcomes, runtime worker evidence, and a deliberately failing control as specified by `08-VALIDATION.md`.

## Shared Safety and Verification Patterns

- Scheduling changes preserve domain authorization, lexical containment, revision checks, atomic writes, and source ownership. Newly concurrent writes require review of transaction serialization.
- Keep sync domain helpers for Rust callers and CLI; compile both app and CLI after conversion. Do not replace internal calls with `block_on`.
- All AUDIT rows must end with a decisive reachable helper chain or positive bound. A regex miss is not RETAIN evidence. The final inventory has 365 owned rows and zero AUDIT entries.
- Reuse focused existing tests for domain contracts; add deterministic barriers for source races and controlled promises for frontend lifetimes. Native WebDriver proof is additional to mocked browser tests.

## Metadata

All existing code analogs named above were checked as tracked repository paths with `git ls-files`; proposed artifacts are explicitly labeled. Search stopped at five pattern families: finite worker, typed error, registry transaction, scoped frontend store, and native fixture/build isolation. Exact code excerpts come from live source. Research counts remain planning evidence, not final performance results.
