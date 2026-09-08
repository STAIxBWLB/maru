# Phase 08 Plan Map

Executable plan set: 29 plans, 29 waves, 62 tasks. All work is bounded; sequential registration edits deliberately keep every intermediate app/CLI build green. There are no same-wave file conflicts. No product implementation or native test has run during planning.

## Dependency graph and integration ownership

01 -> 02 -> 03 -> 04 -> 05 -> 06 -> 29 -> 07 -> 08 -> 09 -> 10 -> 11 -> 12 -> 13 -> 14 -> 15 -> 16 -> 17 -> 18 -> 19 -> 20 -> 21 -> 22 -> 23 -> 24 -> 25 -> 26 -> 27 -> 28.

- 01 proves the existing native Skills control to real local Git and persisted registry before broader conversion.
- 02 owns the whole-batch async/spawn_blocking boundary as well as additive busy/stale/skipped IPC contracts and existing toast/Skills lifetime.
- 03 closes store.rs blocking dispositions; 29 owns its final cross-domain integration. Plan 03 owns 24 command rows; source sync is owned only by 01 and batch sync only by 02. Earlier staged edits are prerequisites, not duplicate inventory ownership.
- 04 owns environment/dispatch and produces the evidence checker consumed by subsequent tranches.
- 05-24 own distinct module groups and serially edit only their registration paths in lib.rs. Original synchronous Rust functions remain stable; nested ipc wrappers preserve wire names. Public cross-module and CLI callers need no async adaptation.
- 06 owns shared hierarchical mutation admission in atomic_file.rs; 29 integrates earlier writers, then 07-24 integrate their writers before existing domain guards under the contract below. Existing guards are not exemptions. Only 06 modifies atomic_file.rs.
- 29 (wave 7) owns final integration of store.rs, git.rs, env.rs, dispatch.rs and dot_sync.rs, with staged event_store.rs/mission_state.rs adapters finalized by 17/16. Its three tasks touch 3, 4 and 3 files. It owns no command inventory rows. Execution is wave-ordered; filename 29 does not place it after 28.
- 25 owns wrapper completion and domain payload classification (all-success, partial-success, all-failed); 26 consolidates component/store terminal notices, visible refresh and complete caller mapping.
- 27 owns all native test hooks and produced performance evidence.
- 28 alone merges inventory/evidence and edits final README/Makefile/isolation guards.
- Shared store.rs, lib.rs, App.tsx, SkillsTab, frontend types and native fixture files have explicit preceding dependencies. Evidence shards are per-plan; no tranche writes the research inventory.

## Shared mutation admission contract (P08-02)

Plan 06 produces proposed `atomic_file::with_path_transactions`, `PathTransactionRequest` and RAII `PathTransactionLease`; Plan 29 and Plans 07-24 consume them. This is in-process filesystem exclusion, not a job service or a claim about external editors/processes.

- Declare the complete source, destination and sidecar/index/rekey write set before mutation. Normalize absolute lexical paths with existing containment rules. Each declared path conservatively covers its subtree: requests conflict on equality or component-wise ancestry (`Path::starts_with`, never string prefix). Rename/trash of A therefore conflicts with save/create of A/note.md; unrelated sibling targets can progress.
- Include physical alias keys for existing targets or nearest existing ancestors plus missing suffixes alongside lexical keys. These are exclusion identities only; never replace lexical authorization with canonical containment or reject intentional symlinks targeting outside the lexical root. Revalidate resolution after admission; changed aliases or required existing parents release admission and return the existing path/conflict error before effects. Capture the originally selected existing parent's filesystem identity (stable directory identity, not mtime) as a create/save precondition and compare it after admission, so removal/recreation at the same path also fails; `write_atomic` must not recreate a parent removed while waiting. Nested directory creation already permitted by a command is bounded by that still-existing selected ancestor. No new write capability or cross-process TOCTOU guarantee.
- Maintain one active request set under a short bookkeeping Mutex plus Condvar. Atomically admit the whole deduplicated path set only if no active set conflicts; all waiting occurs inside the blocking worker, holding no domain lock. Release bookkeeping before work. RAII removes the complete set and notifies waiters on success, error and unwind. Fail closed on unexplained poisoned invariant-bearing bookkeeping; do not copy registry poison recovery.
- Lock order: shared path-set admission, then existing domain guards in stable symbolic-name order if multiple are needed, then read/check/write and complete sidecar/index rekey. Existing guards retain validation/recovery responsibilities but are never an alternative to shared admission for overlapping writes. Never acquire admission while holding a domain guard. Nested helpers receive the existing lease, verify write-set coverage and use proposed `<owned_command>_in_transaction` adapters without reacquiring admission or already-held guards. Public sync signatures remain stable through outer entry adapters.
- Re-read ownership, lexical containment, required parents, destination absence and revisions after admission, inside the worker before effects. Hold admission through complete transactions, including rename rollback/recovery and sidecar/index rekey. Conflicts return existing domain errors without automatic mutation retry. Ordinary reads/UI work need no mutation admission.
- Every mutation tranche audits actual sync, IPC, nested and background callers into its owned entry points, including already-guarded writers. Evidence records the admission entry, complete path set, nested lock order and cross-domain contention case. If a reached writer bypasses admission or lies outside the tranche's writable files, correct file ownership before execution; a different mutex is not an exemption.

06-1 tests prefix conflicts, distinct siblings, reversed multi-path requests, successful physical/lexical symlink aliases, missing-parent rejection and error/unwind release. 07-2 calls real `workspace_files::ipc::rename_workspace_entry`/`trash_workspace_entries` and `document::ipc::save_document`/`create_document` wrappers on a temporary tree. Barriers hold the child after revision-check before write, or hold the parent before rename/trash while the child awaits admission. Cover all four parent/child pairs in both orderings, failure release and a frontmatter/domain writer contending with save. Require no recreated old tree, lost update, partial sidecar/index rekey or deadlock; waiters cannot enter mutation before release. A cfg(test) barrier seam in the shared helper exposes admission/pre-effect stages without changing production IPC. 29-1 additionally tests real Skills-save/Skills-sync/Git-pull versus parent rename/trash, all six pairs in both orders with aliases, parent replacement, error release, duplicate/skip and network registry-availability proof. 29-2 covers env background lifetime, dispatch event/mission callbacks and dot local targets. 07-2 then tests actual Skills-save/Skills-sync/Git-pull versus document-save/create wrappers, all six pairs in both orders and alias cases; these wrappers are produced by 07-1, so 29 never demands future document behavior. Later domain-guard tranches test real-command contention against an earlier writer, not only their own helper.

Source-operation reservations remain nonblocking and precede path admission. Never wait with reservation bookkeeping or REGISTRY_LOCK held. Checkout/network admission excludes registry.json and its ancestors; metadata-only removal and registry reads remain available. Release the network path lease before atomically reacquiring the complete commit set with registry/sidecars, retain source reservation, then revalidate incarnation/config/path/content before fresh rescan/commit. No nested set extension, automatic mutation retry or global registry admission over network. Only short metadata commits admit registry.json. Existing env/dispatch background mutation lifetimes and dot owned finite subprocesses participate. Independent external processes/daemon runs are outside this in-process guarantee.

## Multi-source coverage audit

| Source | Item | Owning plans |
|---|---|---|
| GOAL | Registry lock released for network and latest-state commit | 01-03 |
| GOAL | Complete blocking command surface | 01-24, including whole-batch wrapper in 02; final closure 28 |
| GOAL | Native concurrent real work and unrelated latency | 27-28 |
| REQ | PERF-02 | 01-03, 26-29 |
| REQ | PERF-01 | 01-29 |
| CONTEXT | D-01 settings/deletion win, manual restart | 01-03, 26-27 |
| CONTEXT | D-02 no duplicate or queued source run | 01-02, 27 |
| CONTEXT | D-03 skipped in-flight source in Sync All | 02, 27 |
| CONTEXT | D-04 continuing work and existing notification | 02, 25-27 |
| CONTEXT | D-05 actionable failure, manual retry, partial success | 01-02, 25-27 |
| RESEARCH | 365 rows / 79 definition modules / 159 CONVERT / 152 AUDIT | Exclusive table below, 03-24 close all dispositions, 28 verifies |
| RESEARCH | Async-pool starvation, State/borrow/UI affinity | 04-24, 27 |
| RESEARCH | Sync helper compatibility and typed errors | 01-24 |
| RESEARCH | Aliased checkout and hierarchical cross-domain mutation safety | 01, 03; protocol 06, earlier-writer integration/parent races 29, document pairs 07, guard integration 08-24, closure 28 |
| RESEARCH | Clone/bundle/reconcile network lock risk | 03 |
| RESEARCH | Phase 6/7 isolation/recovery/pruning | Each read-first/guards, 19, 27-28 |
| RESEARCH | Frozen samples, real negative control, runtime worker proof | 27-28 |

No source items are deferred except existing Phase 9 quit/terminal escalation and the explicitly deferred Inbox layout issue. No new UI, API integration, schema/ORM migration, dependency or retry framework.

## Spec-less fallback accounting

All four incoming probes were unresolved. None is silently auto-resolved by planning.

| Probe | Explicit flagged assumption / executable contract | Evidence owner |
|---|---|---|
| PERF-02 boundary | Missing/present source; before admission/during network/before commit; empty and singleton batch | 01-02 |
| PERF-02 precision | UUID identity equality avoids numeric wrap or rounding; exact integer batch counters reconcile every result | 01-02 |
| PERF-02 concurrency | In-process app-mutator ABA protection plus fresh disk validation; cross-process lock/identical offline ABA is not claimed | 01-03 |
| PERF-01 concurrency | Screen changes preserve work; same-runtime two-worker latency proof; no quit durability claim | 25-28 |

Descriptor-less prohibitions in each plan require verifier evidence and remain flagged-unverified until then. Planning does not assert backstop verification succeeded.

## Evidence shard schema and closure

New files `docs/performance/phase08-NN.json` are produced by the matching plan (01-24). Each has `plan`, `commands` and `moduleIntegrationOwner`. Each command row has `name`, `module`, `registrationPath`, `originalDisposition`, `disposition` (ISOLATED, UI, RETAIN or BACKGROUND), `helperChain` (source path + symbol + decisive blocking/bound/affinity), `workerBoundary` (path + symbol or positive exception reason), `syncCallers`, `mutationKey` (complete lexical/alias path set, shared admission entry, post-admission preconditions and domain-lock order; read-only rows state no mutation), `tests`, `processingCaller` and `evidence`. Empty, assumed-safe, unresolved and AUDIT values fail closure. Retained entries cite positive input/runtime bounds; UI entries cite platform dispatch requirements; background entries include setup and stop reasoning. A former CONVERT row finishes ISOLATED with its actual spawn_blocking boundary. Mutation rows cannot close with exact-target-only locks or domain-guard exemptions; cross-domain and parent/child evidence is required. Processing caller closure records fulfilled-payload classification, retained successes, actionable failure reasons and a single terminal-notice owner.

01 and 02 emit only their one command row; 03 includes module integration references to those shards without copying the rows. 28 joins 365 unique names and verifies current source registrations. Native-only test commands are a separate feature-gated allowlist, never silently added to the 365 production baseline. New production commands, if discovered, require a named owner and explicit count reconciliation.

## Earlier-writer integration evidence overlay

Plan 29 produces `docs/performance/phase08-29-integration.json`; it is distinct from command shards. Fields: `plan: "08-29"`, `commandCount: 365`, `integrations` and `documentRaceConsumer`. Each integration record has `id`, `module`, `entrySymbols`, `commandRefs` (existing module/name keys only), `stageOwner`, `finalModuleOwner`, `admissionEntry`, `pathSources` (actual source file/symbol/config key), `lexicalPaths`, `aliasPaths`, `parentPreconditions`, `sourceReservationOrder`, `domainLockOrder`, `lifetime`, `networkRegistryAvailability`, `testCases` and `evidence`. `testCases` records real entry pair, both admission orders, alias variant, failure release and outcome; no guessed safety or empty source path is accepted. Exact coverage is seven modules: store/git/env/dispatch/dot final owner 29; mission_state stage 29 final 16; event_store stage 29 final 17. No `commands` collection is allowed in this overlay. It refines integration fields by reference, never duplicates or replaces command ownership.

Early shards 01/02/03/04/05 record `integrationRequired: "08-29"` and final module owner 29 for their five modules. `--plan` accepts that explicit produced-later obligation while checking the stage's real boundary evidence; no early test imports a future helper. Checker producer 04 supports `--integration 29`; 29 extends fixtures with actual helpers. The overlay's `documentRaceConsumer` contains `plan: "08-07"`, selector `phase08_07_earlier_writer_document_races` and exact required pairs/orders/aliases. The 29 focused gate checks it as a dependency obligation and tests only already-produced parent commands. The 07 shard supplies `crossDomainConsumers` with actual results. Final 28 `--all` requires these results, all seven integration records and completed 16/17 handoffs, rejecting remaining pending integration, abbreviated write sets and registry network exclusion violations. Source/batch regressions from 01/02 run again in 29. The original 365 command rows remain unchanged.

## Exact command ownership

| Plan | Module | Command names (verbatim) |
|---|---|---|
| 08-01 | `src-tauri/src/skill_host/store.rs` | `skills_sync_source` |
| 08-02 | `src-tauri/src/skill_host/store.rs` | `skills_sync_all_sources` |
| 08-03 | `src-tauri/src/skill_host/store.rs` | `skills_list_sources`, `skills_add_source`, `skills_remove_source`, `skills_rescan_source`, `skills_list_skills`, `skills_read_skill`, `skills_read_skill_file`, `skills_save_skill_file`, `skills_save_skill_as`, `skills_create_skill`, `skills_delete_skill`, `skills_list_installs`, `skills_install_skill`, `skills_uninstall_skill`, `skills_adopt_external_links`, `skills_reset_registry`, `skills_doctor`, `skills_list_dirty`, `skills_reconcile_skill`, `skills_import_external`, `skills_import_unmanage`, `skills_bundle_status`, `skills_check_bundle_update`, `skills_apply_bundle_update` |
| 08-04 | `src-tauri/src/skill_host/dispatch.rs` | `skills_runtime_status`, `skills_dispatch_compose`, `skills_dispatch_terminal`, `skills_dispatch_background` |
| 08-04 | `src-tauri/src/skill_host/env.rs` | `skills_env_status`, `skills_env_bootstrap`, `skills_env_repair` |
| 08-05 | `src-tauri/src/git.rs` | `git_status`, `git_changes`, `git_diff`, `git_generate_commit_message`, `git_sync_scan`, `list_workspace_submodules`, `git_sync_pull_rebase`, `git_sync_commit_push`, `git_commit` |
| 08-05 | `src-tauri/src/dot_sync.rs` | `dot_sync_overview`, `dot_sync_run` |
| 08-06 | `src-tauri/src/vault.rs` | `sample_workspace_path`, `scan_vault`, `scan_vault_paths`, `read_vault_cache` |
| 08-06 | `src-tauri/src/workspace_files.rs` | `scan_workspace_files`, `scan_workspace_entries`, `create_workspace_directory`, `rename_workspace_entry`, `duplicate_workspace_entries`, `paste_workspace_entries`, `trash_workspace_entries`, `describe_file_queue_sources`, `apply_file_queue` |
| 08-06 | `src-tauri/src/content_search.rs` | `search_workspace_contents` |
| 08-06 | `src-tauri/src/calendar_search.rs` | `search_calendar_notes` |
| 08-07 | `src-tauri/src/document.rs` | `read_document`, `save_document`, `update_frontmatter_field`, `create_document`, `move_document`, `duplicate_document`, `trash_document`, `create_version` |
| 08-07 | `src-tauri/src/file_manager.rs` | `reveal_in_file_manager`, `open_in_file_manager` |
| 08-07 | `src-tauri/src/vault_guard.rs` | `vault_validate_note` |
| 08-08 | `src-tauri/src/scratchpad.rs` | `scratchpad_list`, `scratchpad_read`, `scratchpad_save`, `scratchpad_rename`, `scratchpad_trash`, `scratchpad_create_idea`, `scratchpad_transition_idea`, `scratchpad_cleanup_plan`, `scratchpad_cleanup_apply`, `scratchpad_migrate_legacy_memos` |
| 08-08 | `src-tauri/src/shelf.rs` | `store_shelf_files`, `store_shelf_files_as`, `list_memos`, `read_memo`, `save_memo`, `delete_memo`, `save_memo_as` |
| 08-08 | `src-tauri/src/drafts.rs` | `drafts_list`, `drafts_promote_default_dir`, `drafts_read`, `drafts_save`, `drafts_create`, `drafts_set_status`, `drafts_discard`, `drafts_promote`, `drafts_relink_promoted` |
| 08-08 | `src-tauri/src/gap.rs` | `gap_analyze`, `gap_append_log`, `gap_log_list`, `gap_reports_list` |
| 08-09 | `src-tauri/src/tasks.rs` | `scan_task_notes`, `read_task_metadata`, `create_task_note`, `update_task_status`, `update_task_schedule_fields`, `update_task_details`, `move_task_note`, `append_tasks_log`, `read_tasks_log` |
| 08-09 | `src-tauri/src/meetings.rs` | `scan_meeting_notes`, `read_meeting_metadata`, `read_meeting_guides`, `append_meetings_log`, `read_meetings_log` |
| 08-09 | `src-tauri/src/project_activity.rs` | `scan_project_activity` |
| 08-10 | `src-tauri/src/inbox.rs` | `scan_inbox_drop`, `scan_inbox_entries`, `scan_inbox_processed_items`, `scan_inbox_processed_snapshot`, `read_inbox_processed_item`, `read_inbox_source_runs`, `count_inbox_processed_by_channel`, `trash_inbox_items`, `stage_inbox_drop_files`, `accept_inbox_item`, `accept_inbox_items`, `reject_inbox_item`, `reject_inbox_items`, `apply_inbox_decisions` |
| 08-10 | `src-tauri/src/inbox_classifier.rs` | `build_inbox_classification_prompt`, `parse_inbox_classification` |
| 08-10 | `src-tauri/src/share_outbox.rs` | `read_share_outbox_config`, `save_share_outbox_root`, `ensure_share_outbox_root`, `scan_share_outbox`, `prepare_share_outbox_files` |
| 08-10 | `src-tauri/src/binary_viewer.rs` | `binary_viewer_classify`, `binary_viewer_prepare_asset`, `binary_viewer_read_text`, `binary_viewer_read_archive`, `binary_viewer_extract_hwpx`, `binary_viewer_open_external`, `binary_viewer_preview_external` |
| 08-10 | `src-tauri/src/secrets.rs` | `secrets_scan`, `secrets_doctor`, `secrets_migrate`, `secrets_read_text`, `secrets_write_text`, `secrets_delete_text` |
| 08-11 | `src-tauri/src/today_store.rs` | `today_open`, `today_mutate`, `today_finalize_setup`, `today_rollover`, `read_task_events` |
| 08-11 | `src-tauri/src/today.rs` | `today_logical_day` |
| 08-11 | `src-tauri/src/today_lifecycle.rs` | `task_transition`, `task_trash` |
| 08-11 | `src-tauri/src/today_ai.rs` | `today_build_plan_request`, `today_apply_plan_result` |
| 08-12 | `src-tauri/src/today_calendar.rs` | `today_calendar_commitments`, `task_calendar_set_sync`, `today_calendar_publish` |
| 08-12 | `src-tauri/src/today_outbox.rs` | `task_integrations_drain`, `task_integrations_retry`, `read_task_integrations` |
| 08-12 | `src-tauri/src/web_actions.rs` | `web_action_repair_task_list_linkage`, `web_actions_import_top`, `web_actions_scan`, `web_actions_apply` |
| 08-12 | `src-tauri/src/evidence_binder.rs` | `evidence_binder_read`, `evidence_binder_mutate` |
| 08-13 | `src-tauri/src/vault_graph.rs` | `vault_graph_read`, `vault_graph_root`, `vault_graph_layout_read`, `vault_graph_layout_save` |
| 08-13 | `src-tauri/src/kg_refs.rs` | `kg_document_refs`, `kg_refs_clear` |
| 08-13 | `src-tauri/src/graph_authoring.rs` | `graph_link_preview`, `graph_link_apply` |
| 08-13 | `src-tauri/src/ops_catalog/mod.rs` | `catalog_scan`, `catalog_query`, `catalog_drilldown` |
| 08-14 | `src-tauri/src/telegram_io.rs` | `fetch_telegram_recent`, `accept_telegram_item`, `reject_telegram_item`, `stage_telegram_items`, `check_telegram_auth`, `start_telegram_polling`, `stop_telegram_polling`, `telegram_polling_status` |
| 08-14 | `src-tauri/src/gmail_gws.rs` | `fetch_gmail_unread`, `stage_gmail_items`, `check_gws_auth`, `decide_gmail_item`, `decide_gmail_items` |
| 08-14 | `src-tauri/src/outlook_mso.rs` | `fetch_outlook_unread`, `stage_outlook_items`, `check_mso_auth`, `decide_outlook_item`, `decide_outlook_items` |
| 08-14 | `src-tauri/src/kakao_relay.rs` | `read_kakao_relay_status`, `read_kakao_relay_messages`, `stage_kakao_relay_new`, `enqueue_kakao_send`, `read_kakao_send_results` |
| 08-15 | `src-tauri/src/jobs.rs` | `jobs_list`, `jobs_install`, `jobs_uninstall`, `jobs_start`, `jobs_stop`, `jobs_run_now`, `jobs_read_log` |
| 08-15 | `src-tauri/src/system_jobs.rs` | `system_jobs_list`, `system_job_set_enabled`, `system_job_run_now`, `system_crontab_remove` |
| 08-15 | `src-tauri/src/scheduler.rs` | `scheduler_list`, `scheduler_add`, `scheduler_remove`, `scheduler_set_enabled`, `scheduler_run_now` |
| 08-15 | `src-tauri/src/launchd_migration.rs` | `detect_legacy_telegram_launchd`, `unload_legacy_telegram_launchd` |
| 08-15 | `src-tauri/src/terminal_hooks.rs` | `terminal_hooks_status`, `terminal_hooks_install`, `terminal_hooks_uninstall`, `write_agent_context_hint`, `remove_agent_context_hint` |
| 08-16 | `src-tauri/src/agents.rs` | `agents_list`, `agents_upsert`, `agents_delete`, `agents_reset` |
| 08-16 | `src-tauri/src/ai_router.rs` | `start_agent_cli_invocation`, `start_claude_cli_invocation` |
| 08-16 | `src-tauri/src/mission_state.rs` | `list_ai_missions`, `stop_ai_mission`, `read_ai_mission_log` |
| 08-16 | `src-tauri/src/agent_host/proposal.rs` | `agent_parse_skill_proposal`, `agent_apply_skill_proposal` |
| 08-16 | `src-tauri/src/agent_host/structured_loop.rs` | `agent_run_structured_loop` |
| 08-17 | `src-tauri/src/agent_host/status.rs` | `agents_account_status`, `agents_usage_status` |
| 08-17 | `src-tauri/src/agent_host/event_store.rs` | `agent_read_run_events`, `agent_replay_run_summary` |
| 08-17 | `src-tauri/src/agent_host/cloud_dashboard.rs` | `agent_export_redacted_run_summary`, `agent_write_redacted_run_summary` |
| 08-17 | `src-tauri/src/hub_client/mod.rs` | `hub_status`, `hub_fetch_catalog`, `hub_submit_gate`, `hub_queue_drain`, `hub_poll_gate` |
| 08-18 | `src-tauri/src/terminal/mod.rs` | `terminal_spawn`, `terminal_write`, `terminal_input`, `terminal_input_batch`, `terminal_ack`, `terminal_request_full`, `terminal_set_visibility`, `terminal_selection`, `terminal_copy_selection`, `terminal_scroll`, `terminal_clear`, `terminal_text`, `terminal_search`, `terminal_resize`, `terminal_kill` |
| 08-19 | `src-tauri/src/scratchpad_watcher.rs` | `start_scratchpad_watcher`, `stop_scratchpad_watcher` |
| 08-19 | `src-tauri/src/inbox_watcher.rs` | `start_inbox_watcher`, `stop_inbox_watcher` |
| 08-19 | `src-tauri/src/vault_watcher.rs` | `start_vault_watcher`, `stop_vault_watcher` |
| 08-19 | `src-tauri/src/ops_catalog/watcher.rs` | `catalog_watcher_start`, `catalog_watcher_stop` |
| 08-20 | `src-tauri/src/studio/mod.rs` | `studio_state_list`, `studio_state_read`, `studio_state_save`, `studio_state_delete`, `studio_apply_body` |
| 08-20 | `src-tauri/src/diagram/mod.rs` | `diagram_save_document`, `diagram_load_document`, `diagram_list_documents`, `diagram_delete_document`, `diagram_export_blob`, `diagram_export_blob_to_path`, `diagram_backup_document`, `diagram_save_snapshot`, `diagram_list_snapshots`, `diagram_restore_snapshot`, `diagram_write_report_asset`, `diagram_pattern_save`, `diagram_pattern_list`, `diagram_pattern_delete` |
| 08-21 | `src-tauri/src/export/dispatch.rs` | `export_dispatch` |
| 08-21 | `src-tauri/src/export/mod.rs` | `export_plan`, `export_validate` |
| 08-21 | `src-tauri/src/hwped.rs` | `hwped_read`, `hwped_render`, `hwped_edit`, `hwped_compose`, `hwped_validate`, `hwped_capabilities` |
| 08-21 | `src-tauri/src/hwp_cli_template.rs` | `hwp_cli_template_fields`, `hwp_cli_template_fill` |
| 08-21 | `src-tauri/src/template_fill.rs` | `template_get_fields`, `template_prepare_hwpx_template`, `template_fill_hwpx` |
| 08-22 | `src-tauri/src/maru_dir.rs` | `read_maru_workspace`, `update_maru_workspace`, `bootstrap_maru_dir`, `read_maru_ignore`, `save_maru_ignore`, `list_maru_rules`, `read_maru_rule`, `save_maru_rule`, `delete_maru_rule`, `list_maru_templates`, `read_maru_template`, `save_maru_template`, `delete_maru_template`, `read_maru_mcp`, `save_maru_mcp`, `read_maru_projects`, `list_workspace_projects`, `save_maru_projects`, `read_maru_skills`, `read_maru_settings`, `save_maru_settings` |
| 08-22 | `src-tauri/src/vault_list.rs` | `list_workspace_roots`, `add_workspace_root`, `refresh_workspace_capabilities`, `remove_workspace_root`, `set_active_workspace_root` |
| 08-22 | `src-tauri/src/workspace.rs` | `detect_workspace`, `read_workspace_config`, `register_workspace_roots`, `list_workspaces` |
| 08-23 | `src-tauri/src/inbox_settings.rs` | `read_inbox_runtime_config`, `save_inbox_runtime_config`, `read_inbox_settings`, `save_inbox_settings` |
| 08-23 | `src-tauri/src/telegram_config.rs` | `read_telegram_monitor_config`, `save_telegram_monitor_config` |
| 08-23 | `src-tauri/src/sites.rs` | `read_sites`, `save_sites`, `scan_work_sites` |
| 08-23 | `src-tauri/src/e2e_flow.rs` | `maru_e2e_run`, `maru_e2e_read` |
| 08-24 | `src-tauri/src/html_editor.rs` | `prepare_html_editor_assets` |
| 08-24 | `src-tauri/src/browser_passkeys.rs` | `browser_passkey_status`, `browser_passkey_request_authorization` |
| 08-24 | `src-tauri/src/site_view.rs` | `site_view_open`, `site_view_navigate`, `site_view_set_bounds`, `site_view_show`, `site_view_hide`, `site_view_close`, `site_view_close_all`, `site_view_reload`, `site_view_back`, `site_view_forward`, `site_view_open_external`, `site_view_open_safari`, `site_view_take_opened_urls` |
| 08-24 | `src-tauri/src/today_notify.rs` | `today_notify_new_day` |
| 08-24 | `src-tauri/src/approval.rs` | `prepare_approval`, `record_approval` |
| 08-24 | `src-tauri/src/korean_date.rs` | `parse_korean_date_cmd` |
| 08-24 | `src-tauri/src/linter/gaejosik.rs` | `gaejosik_lint` |

## Plan tasks and artifacts

| Plan | Wave | Tasks | Output |
|---|---|---|---|
| 08-01 | 1 | 2 | Single-source synchronization tracer |
| 08-02 | 2 | 3 | Sync All outcomes and surviving completion |
| 08-03 | 3 | 2 | Remaining registry commands and lock-free network stages |
| 08-04 | 4 | 2 | Environment and dispatch blocking boundaries |
| 08-05 | 5 | 2 | Git and workspace sync command isolation |
| 08-06 | 6 | 2 | Workspace scan and file queue command isolation |
| 08-29 | 7 | 3 | Earlier Skills/Git/env/dispatch/dot shared admission and overlay |
| 08-07 | 8 | 2 | Guarded documents command isolation |
| 08-08 | 9 | 2 | Scratchpad and drafts command isolation |
| 08-09 | 10 | 2 | Tasks and meetings command isolation |
| 08-10 | 11 | 2 | Inbox processing command isolation |
| 08-11 | 12 | 2 | Today transactions command isolation |
| 08-12 | 13 | 2 | Calendar and evidence command isolation |
| 08-13 | 14 | 2 | Graph and catalog command isolation |
| 08-14 | 15 | 2 | Message providers command isolation |
| 08-15 | 16 | 2 | Jobs and setup command isolation |
| 08-16 | 17 | 2 | Agent control command isolation |
| 08-17 | 18 | 2 | Agent data and Hub command isolation |
| 08-18 | 19 | 2 | Terminal boundaries command isolation |
| 08-19 | 20 | 2 | Watcher lifetimes command isolation |
| 08-20 | 21 | 2 | Studio and diagrams command isolation |
| 08-21 | 22 | 2 | Export and templates command isolation |
| 08-22 | 23 | 2 | Workspace configuration command isolation |
| 08-23 | 24 | 2 | Settings and native flows command isolation |
| 08-24 | 25 | 3 | Native UI and bounded parsers command isolation |
| 08-25 | 26 | 2 | File-processing completion ownership |
| 08-26 | 27 | 2 | Scope visible refreshes and close processing callers |
| 08-27 | 28 | 3 | Native saturation and source-race harness |
| 08-28 | 29 | 2 | Exhaustive closure and production isolation |
