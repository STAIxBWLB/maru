# Phase 08 Command Inventory

Research snapshot: 2026-09-05. Generic-agent workaround. Source registration is `src-tauri/src/lib.rs:353-748` (the full `generate_handler!` block, opened this run). **365 registered commands, 365 matched definitions, zero unmatched names.**

This is exhaustive registration coverage, not a compiler-proven call graph. Function-body extraction and same-module/uniquely resolved helper traversal were supplemented with manual review. Dynamic calls, traits, aliased imports, external crates and conditionally compiled bodies can hide work. A missing detected primitive is never evidence of safety. Every `AUDIT` row is a required executor disposition task, not an exclusion from PERF-01. Keep the full table and record final helper evidence before marking PERF-01 complete.

Dispositions: **CONVERT** = wrap blocking operation in async + spawn_blocking, preserving sync domain helper and contracts. **ISOLATED** = existing spawn_blocking; preserve and test. **UI** = native UI dispatch must remain through required main-thread APIs; offload only incidental I/O. **RETAIN** = inspected pure/model operation; preserve behavior. **BACKGROUND** = existing worker lifetime; inspect setup/stop boundary. **AUDIT** = no conclusive call-chain classification yet; executor must resolve full reachable work, convert when network/subprocess/unbounded directory work exists, otherwise document bounded reason.

## Counts

Runtime forms: {'sync': 240, 'async fn': 49, 'command(async)': 76}.

Planning dispositions: {'CONVERT': 159, 'AUDIT': 152, 'ISOLATED': 20, 'BACKGROUND': 1, 'RETAIN': 18, 'UI': 15}. CONVERT is a lower bound pending AUDIT closure, not a final implementation count.

## Complete registry

| Command (verbatim) | Definition | Current form | Disposition and evidence |
| --- | --- | --- | --- |
| `fetch_telegram_recent` | `src-tauri/src/telegram_io.rs:124` | sync | **CONVERT**: process: fetch_telegram_recent -> fetch_telegram_recent_inner (src-tauri/src/telegram_io.rs:415); walk: fetch_telegram_recent -> fetch_telegram_recent_inner -> resolve_telegram_command_config -> default_public_env_setup -> builtin_env_setup_path -> ensure_active_bundle -> recover_interrupted_swap (src-tauri/src/skill_host/bundle_update.rs:195) |
| `accept_telegram_item` | `src-tauri/src/telegram_io.rs:132` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `reject_telegram_item` | `src-tauri/src/telegram_io.rs:150` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `stage_telegram_items` | `src-tauri/src/telegram_io.rs:166` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `check_telegram_auth` | `src-tauri/src/telegram_io.rs:185` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `start_telegram_polling` | `src-tauri/src/telegram_io.rs:285` | sync | **BACKGROUND**: Fetch loop is already thread::spawn; inspect stop/setup before returning and retain worker ownership. |
| `stop_telegram_polling` | `src-tauri/src/telegram_io.rs:368` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `telegram_polling_status` | `src-tauri/src/telegram_io.rs:376` | sync | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `prepare_html_editor_assets` | `src-tauri/src/html_editor.rs:64` | sync | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `web_action_repair_task_list_linkage` | `src-tauri/src/web_actions.rs:298` | sync | **CONVERT**: walk: web_action_repair_task_list_linkage -> receipt_for_web_action -> receipt_files_under (src-tauri/src/web_actions.rs:239) |
| `web_actions_import_top` | `src-tauri/src/web_actions.rs:910` | command(async) | **CONVERT**: walk: web_actions_import_top -> today_mutate -> newest_valid_revision -> list_revisions (src-tauri/src/today_store.rs:282) |
| `web_actions_scan` | `src-tauri/src/web_actions.rs:1020` | command(async) | **CONVERT**: walk: web_actions_scan -> pending_receipt_files -> receipt_files_under (src-tauri/src/web_actions.rs:239) |
| `web_actions_apply` | `src-tauri/src/web_actions.rs:1035` | command(async) | **CONVERT**: walk: web_actions_apply -> pending_receipt_files -> receipt_files_under (src-tauri/src/web_actions.rs:239); process: web_actions_apply -> apply_receipt -> blob_sha (src-tauri/src/web_actions.rs:521) |
| `agents_list` | `src-tauri/src/agents.rs:469` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `agents_upsert` | `src-tauri/src/agents.rs:476` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `agents_delete` | `src-tauri/src/agents.rs:522` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `agents_reset` | `src-tauri/src/agents.rs:540` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scan_project_activity` | `src-tauri/src/project_activity.rs:48` | command(async) | **CONVERT**: walk: scan_project_activity -> scan_project_activity_impl -> scan_meeting_days (src-tauri/src/project_activity.rs:119) |
| `start_scratchpad_watcher` | `src-tauri/src/scratchpad_watcher.rs:82` | sync | **CONVERT**: recursive native watcher registration before background drain thread |
| `stop_scratchpad_watcher` | `src-tauri/src/scratchpad_watcher.rs:271` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_share_outbox_config` | `src-tauri/src/share_outbox.rs:174` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `save_share_outbox_root` | `src-tauri/src/share_outbox.rs:181` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `ensure_share_outbox_root` | `src-tauri/src/share_outbox.rs:217` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scan_share_outbox` | `src-tauri/src/share_outbox.rs:240` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `prepare_share_outbox_files` | `src-tauri/src/share_outbox.rs:306` | sync | **CONVERT**: process: prepare_share_outbox_files (src-tauri/src/share_outbox.rs:307) |
| `vault_graph_read` | `src-tauri/src/vault_graph.rs:55` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `vault_graph_root` | `src-tauri/src/vault_graph.rs:87` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `vault_graph_layout_read` | `src-tauri/src/vault_graph.rs:120` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `vault_graph_layout_save` | `src-tauri/src/vault_graph.rs:139` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scan_meeting_notes` | `src-tauri/src/meetings.rs:65` | command(async) | **CONVERT**: walk: scan_meeting_notes (src-tauri/src/meetings.rs:66) |
| `read_meeting_metadata` | `src-tauri/src/meetings.rs:130` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_meeting_guides` | `src-tauri/src/meetings.rs:162` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `append_meetings_log` | `src-tauri/src/meetings.rs:175` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_meetings_log` | `src-tauri/src/meetings.rs:192` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_maru_workspace` | `src-tauri/src/maru_dir.rs:810` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `update_maru_workspace` | `src-tauri/src/maru_dir.rs:817` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `bootstrap_maru_dir` | `src-tauri/src/maru_dir.rs:862` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_maru_ignore` | `src-tauri/src/maru_dir.rs:989` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `save_maru_ignore` | `src-tauri/src/maru_dir.rs:998` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `list_maru_rules` | `src-tauri/src/maru_dir.rs:1025` | sync | **CONVERT**: walk: list_maru_rules (src-tauri/src/maru_dir.rs:1026) |
| `read_maru_rule` | `src-tauri/src/maru_dir.rs:1048` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `save_maru_rule` | `src-tauri/src/maru_dir.rs:1076` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `delete_maru_rule` | `src-tauri/src/maru_dir.rs:1089` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `list_maru_templates` | `src-tauri/src/maru_dir.rs:1147` | sync | **CONVERT**: walk: list_maru_templates (src-tauri/src/maru_dir.rs:1148) |
| `read_maru_template` | `src-tauri/src/maru_dir.rs:1170` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `save_maru_template` | `src-tauri/src/maru_dir.rs:1178` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `delete_maru_template` | `src-tauri/src/maru_dir.rs:1191` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_maru_mcp` | `src-tauri/src/maru_dir.rs:1206` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `save_maru_mcp` | `src-tauri/src/maru_dir.rs:1213` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_maru_projects` | `src-tauri/src/maru_dir.rs:1220` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `list_workspace_projects` | `src-tauri/src/maru_dir.rs:1227` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `save_maru_projects` | `src-tauri/src/maru_dir.rs:1269` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_maru_skills` | `src-tauri/src/maru_dir.rs:1403` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_maru_settings` | `src-tauri/src/maru_dir.rs:1410` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `save_maru_settings` | `src-tauri/src/maru_dir.rs:1417` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `today_notify_new_day` | `src-tauri/src/today_notify.rs:29` | sync | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `hwp_cli_template_fields` | `src-tauri/src/hwp_cli_template.rs:500` | sync | **CONVERT**: process: hwp_cli_template_fields -> fields_with_bin -> ensure_released_version -> run_hwp_ok -> run_hwp (src-tauri/src/hwp_cli_template.rs:190) |
| `hwp_cli_template_fill` | `src-tauri/src/hwp_cli_template.rs:508` | sync | **CONVERT**: process: hwp_cli_template_fill -> fill_with_bin -> run_hwp_ok -> run_hwp (src-tauri/src/hwp_cli_template.rs:190) |
| `dot_sync_overview` | `src-tauri/src/dot_sync.rs:328` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `dot_sync_run` | `src-tauri/src/dot_sync.rs:715` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `start_agent_cli_invocation` | `src-tauri/src/ai_router.rs:57` | sync | **CONVERT**: process: start_agent_cli_invocation -> spawn_streaming_invocation (src-tauri/src/ai_router.rs:189) |
| `start_claude_cli_invocation` | `src-tauri/src/ai_router.rs:108` | sync | **CONVERT**: process: start_claude_cli_invocation -> start_agent_cli_invocation -> spawn_streaming_invocation (src-tauri/src/ai_router.rs:189) |
| `browser_passkey_status` | `src-tauri/src/browser_passkeys.rs:234` | async fn | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `browser_passkey_request_authorization` | `src-tauri/src/browser_passkeys.rs:255` | async fn | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `scan_task_notes` | `src-tauri/src/tasks.rs:178` | command(async) | **CONVERT**: walk: scan_task_notes (src-tauri/src/tasks.rs:179) |
| `read_task_metadata` | `src-tauri/src/tasks.rs:221` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `create_task_note` | `src-tauri/src/tasks.rs:244` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `update_task_status` | `src-tauri/src/tasks.rs:379` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `update_task_schedule_fields` | `src-tauri/src/tasks.rs:414` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `update_task_details` | `src-tauri/src/tasks.rs:439` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `move_task_note` | `src-tauri/src/tasks.rs:506` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `append_tasks_log` | `src-tauri/src/tasks.rs:529` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_tasks_log` | `src-tauri/src/tasks.rs:545` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `site_view_open` | `src-tauri/src/site_view.rs:184` | async fn | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `site_view_navigate` | `src-tauri/src/site_view.rs:303` | async fn | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `site_view_set_bounds` | `src-tauri/src/site_view.rs:311` | async fn | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `site_view_show` | `src-tauri/src/site_view.rs:327` | async fn | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `site_view_hide` | `src-tauri/src/site_view.rs:344` | async fn | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `site_view_close` | `src-tauri/src/site_view.rs:354` | async fn | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `site_view_close_all` | `src-tauri/src/site_view.rs:367` | async fn | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `site_view_reload` | `src-tauri/src/site_view.rs:377` | async fn | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `site_view_back` | `src-tauri/src/site_view.rs:384` | async fn | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `site_view_forward` | `src-tauri/src/site_view.rs:393` | async fn | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `site_view_open_external` | `src-tauri/src/site_view.rs:400` | async fn | **CONVERT**: process: site_view_open_external -> open_in_system_browser (src-tauri/src/site_view.rs:439) |
| `site_view_open_safari` | `src-tauri/src/site_view.rs:410` | async fn | **CONVERT**: process: site_view_open_safari (src-tauri/src/site_view.rs:411) |
| `site_view_take_opened_urls` | `src-tauri/src/site_view.rs:427` | sync | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `today_open` | `src-tauri/src/today_store.rs:530` | sync | **CONVERT**: walk: today_open -> recover_finalize_journals (src-tauri/src/today_store.rs:195) |
| `today_mutate` | `src-tauri/src/today_store.rs:607` | sync | **CONVERT**: walk: today_mutate -> newest_valid_revision -> list_revisions (src-tauri/src/today_store.rs:282) |
| `today_finalize_setup` | `src-tauri/src/today_store.rs:672` | sync | **CONVERT**: walk: today_finalize_setup -> recover_finalize_journals (src-tauri/src/today_store.rs:195) |
| `today_rollover` | `src-tauri/src/today_store.rs:1228` | sync | **CONVERT**: walk: today_rollover -> rollover_inner -> newest_prior_day (src-tauri/src/today_store.rs:1213) |
| `read_task_events` | `src-tauri/src/today_store.rs:1417` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `today_calendar_commitments` | `src-tauri/src/today_calendar.rs:188` | sync | **CONVERT**: walk: today_calendar_commitments (src-tauri/src/today_calendar.rs:189) |
| `task_calendar_set_sync` | `src-tauri/src/today_calendar.rs:288` | sync | **CONVERT**: walk: task_calendar_set_sync -> today_mutate -> newest_valid_revision -> list_revisions (src-tauri/src/today_store.rs:282) |
| `today_calendar_publish` | `src-tauri/src/today_calendar.rs:414` | sync | **CONVERT**: process: today_calendar_publish (src-tauri/src/today_calendar.rs:415); walk: today_calendar_publish -> persist_item_sync -> snapshot_revision -> prune_revisions -> list_revisions (src-tauri/src/today_store.rs:282) |
| `list_ai_missions` | `src-tauri/src/mission_state.rs:65` | sync | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `stop_ai_mission` | `src-tauri/src/mission_state.rs:71` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_ai_mission_log` | `src-tauri/src/mission_state.rs:79` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `store_shelf_files` | `src-tauri/src/shelf.rs:56` | sync | **CONVERT**: store_files_into_dir supports recursive directory copy/move |
| `store_shelf_files_as` | `src-tauri/src/shelf.rs:66` | sync | **CONVERT**: store_files_into_dir supports recursive directory copy/move |
| `list_memos` | `src-tauri/src/shelf.rs:75` | sync | **CONVERT**: walk: list_memos -> scratchpad_list (src-tauri/src/scratchpad.rs:771) |
| `read_memo` | `src-tauri/src/shelf.rs:87` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `save_memo` | `src-tauri/src/shelf.rs:102` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `delete_memo` | `src-tauri/src/shelf.rs:123` | sync | **CONVERT**: scratchpad_trash platform trash |
| `save_memo_as` | `src-tauri/src/shelf.rs:146` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `maru_e2e_run` | `src-tauri/src/e2e_flow.rs:166` | sync | **CONVERT**: walk: maru_e2e_run -> ensure_sample_skill -> skills_list_skills -> ensure_default_sources -> ensure_builtin_source -> ensure_active_bundle -> recover_interrupted_swap (src-tauri/src/skill_host/bundle_update.rs:195); process: maru_e2e_run -> ensure_sample_skill -> skills_list_skills -> rescan_source_in_registry -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> git_dirty (src-tauri/src/skill_host/store.rs:5123) |
| `maru_e2e_read` | `src-tauri/src/e2e_flow.rs:299` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scratchpad_list` | `src-tauri/src/scratchpad.rs:770` | command(async) | **CONVERT**: walk: scratchpad_list (src-tauri/src/scratchpad.rs:771) |
| `scratchpad_read` | `src-tauri/src/scratchpad.rs:820` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scratchpad_save` | `src-tauri/src/scratchpad.rs:842` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scratchpad_rename` | `src-tauri/src/scratchpad.rs:897` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scratchpad_trash` | `src-tauri/src/scratchpad.rs:968` | command(async) | **CONVERT**: move_to_system_trash platform trash |
| `scratchpad_create_idea` | `src-tauri/src/scratchpad.rs:1049` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scratchpad_transition_idea` | `src-tauri/src/scratchpad.rs:1234` | command(async) | **CONVERT**: walk: scratchpad_transition_idea -> move_idea_directory_noreplace (src-tauri/src/scratchpad.rs:1100) |
| `scratchpad_cleanup_plan` | `src-tauri/src/scratchpad.rs:1347` | command(async) | **CONVERT**: walk: scratchpad_cleanup_plan (src-tauri/src/scratchpad.rs:1348) |
| `scratchpad_cleanup_apply` | `src-tauri/src/scratchpad.rs:1389` | command(async) | **CONVERT**: move_to_system_trash external/platform filesystem work |
| `scratchpad_migrate_legacy_memos` | `src-tauri/src/scratchpad.rs:1471` | command(async) | **CONVERT**: walk: scratchpad_migrate_legacy_memos (src-tauri/src/scratchpad.rs:1472) |
| `git_status` | `src-tauri/src/git.rs:43` | command(async) | **CONVERT**: process: git_status -> git_status_with_mode (src-tauri/src/git.rs:48) |
| `git_changes` | `src-tauri/src/git.rs:209` | command(async) | **CONVERT**: process: git_changes (src-tauri/src/git.rs:210) |
| `git_diff` | `src-tauri/src/git.rs:263` | command(async) | **CONVERT**: process: git_diff -> git_diff_for_path (src-tauri/src/git.rs:272) |
| `git_generate_commit_message` | `src-tauri/src/git.rs:317` | command(async) | **CONVERT**: process: git_generate_commit_message (src-tauri/src/git.rs:318) |
| `git_sync_scan` | `src-tauri/src/git.rs:489` | command(async) | **CONVERT**: git_toplevel, repo_status, list_submodule_paths subprocesses |
| `list_workspace_submodules` | `src-tauri/src/git.rs:577` | command(async) | **CONVERT**: list_submodule_paths subprocess |
| `git_sync_pull_rebase` | `src-tauri/src/git.rs:592` | command(async) | **CONVERT**: git stash/pull/pop subprocesses |
| `git_sync_commit_push` | `src-tauri/src/git.rs:655` | command(async) | **CONVERT**: git stage/commit/push subprocesses |
| `git_commit` | `src-tauri/src/git.rs:1029` | command(async) | **CONVERT**: process: git_commit (src-tauri/src/git.rs:1030) |
| `template_get_fields` | `src-tauri/src/template_fill.rs:91` | sync | **CONVERT**: process: template_get_fields -> run_command (src-tauri/src/template_fill.rs:499) |
| `template_prepare_hwpx_template` | `src-tauri/src/template_fill.rs:170` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `template_fill_hwpx` | `src-tauri/src/template_fill.rs:205` | sync | **CONVERT**: process: template_fill_hwpx -> run_command (src-tauri/src/template_fill.rs:499) |
| `list_workspace_roots` | `src-tauri/src/vault_list.rs:565` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `add_workspace_root` | `src-tauri/src/vault_list.rs:786` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `refresh_workspace_capabilities` | `src-tauri/src/vault_list.rs:819` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `remove_workspace_root` | `src-tauri/src/vault_list.rs:835` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `set_active_workspace_root` | `src-tauri/src/vault_list.rs:857` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `task_transition` | `src-tauri/src/today_lifecycle.rs:369` | sync | **CONVERT**: walk: task_transition -> run_reopen -> has_synced_complete -> list_records (src-tauri/src/today_outbox.rs:207) |
| `task_trash` | `src-tauri/src/today_lifecycle.rs:450` | sync | **CONVERT**: platform trash |
| `fetch_gmail_unread` | `src-tauri/src/gmail_gws.rs:122` | sync | **CONVERT**: process: fetch_gmail_unread (src-tauri/src/gmail_gws.rs:123) |
| `stage_gmail_items` | `src-tauri/src/gmail_gws.rs:183` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `check_gws_auth` | `src-tauri/src/gmail_gws.rs:202` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `decide_gmail_item` | `src-tauri/src/gmail_gws.rs:288` | sync | **CONVERT**: process: decide_gmail_item -> decide_gmail_item_now -> modify_gmail_message (src-tauri/src/gmail_gws.rs:516) |
| `decide_gmail_items` | `src-tauri/src/gmail_gws.rs:304` | sync | **CONVERT**: process: decide_gmail_items -> decide_gmail_item_now -> modify_gmail_message (src-tauri/src/gmail_gws.rs:516) |
| `reveal_in_file_manager` | `src-tauri/src/file_manager.rs:12` | sync | **CONVERT**: process: reveal_in_file_manager (src-tauri/src/file_manager.rs:13) |
| `open_in_file_manager` | `src-tauri/src/file_manager.rs:24` | sync | **CONVERT**: process: open_in_file_manager (src-tauri/src/file_manager.rs:25) |
| `build_inbox_classification_prompt` | `src-tauri/src/inbox_classifier.rs:70` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `parse_inbox_classification` | `src-tauri/src/inbox_classifier.rs:97` | sync | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `start_inbox_watcher` | `src-tauri/src/inbox_watcher.rs:86` | sync | **CONVERT**: recursive native watcher registration before background drain thread |
| `stop_inbox_watcher` | `src-tauri/src/inbox_watcher.rs:213` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `detect_workspace` | `src-tauri/src/workspace.rs:306` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_workspace_config` | `src-tauri/src/workspace.rs:319` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `register_workspace_roots` | `src-tauri/src/workspace.rs:343` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `list_workspaces` | `src-tauri/src/workspace.rs:446` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_inbox_runtime_config` | `src-tauri/src/inbox_settings.rs:580` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `save_inbox_runtime_config` | `src-tauri/src/inbox_settings.rs:586` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_inbox_settings` | `src-tauri/src/inbox_settings.rs:670` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `save_inbox_settings` | `src-tauri/src/inbox_settings.rs:676` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scheduler_list` | `src-tauri/src/scheduler.rs:593` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scheduler_add` | `src-tauri/src/scheduler.rs:599` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scheduler_remove` | `src-tauri/src/scheduler.rs:613` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scheduler_set_enabled` | `src-tauri/src/scheduler.rs:620` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scheduler_run_now` | `src-tauri/src/scheduler.rs:632` | sync | **CONVERT**: process: scheduler_run_now -> dispatch_schedule -> skills_dispatch_background -> build_cli_command (src-tauri/src/agent_host/provider.rs:174) |
| `gap_analyze` | `src-tauri/src/gap.rs:606` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `gap_append_log` | `src-tauri/src/gap.rs:613` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `gap_log_list` | `src-tauri/src/gap.rs:701` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `gap_reports_list` | `src-tauri/src/gap.rs:710` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `graph_link_preview` | `src-tauri/src/graph_authoring.rs:180` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `graph_link_apply` | `src-tauri/src/graph_authoring.rs:203` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `evidence_binder_read` | `src-tauri/src/evidence_binder.rs:245` | command(async) | **CONVERT**: walk: evidence_binder_read -> discover_candidates -> discover_sidecar_candidate_seeds (src-tauri/src/evidence_binder.rs:937) |
| `evidence_binder_mutate` | `src-tauri/src/evidence_binder.rs:261` | command(async) | **CONVERT**: walk: evidence_binder_mutate -> discover_candidates -> discover_sidecar_candidate_seeds (src-tauri/src/evidence_binder.rs:937) |
| `task_integrations_drain` | `src-tauri/src/today_outbox.rs:722` | sync | **CONVERT**: walk: task_integrations_drain -> list_records (src-tauri/src/today_outbox.rs:207); process: task_integrations_drain -> drain_record (src-tauri/src/today_outbox.rs:597) |
| `task_integrations_retry` | `src-tauri/src/today_outbox.rs:758` | sync | **CONVERT**: walk: task_integrations_retry -> list_records (src-tauri/src/today_outbox.rs:207) |
| `read_task_integrations` | `src-tauri/src/today_outbox.rs:788` | sync | **CONVERT**: walk: read_task_integrations -> list_records (src-tauri/src/today_outbox.rs:207) |
| `parse_korean_date_cmd` | `src-tauri/src/korean_date.rs:19` | sync | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `scan_workspace_files` | `src-tauri/src/workspace_files.rs:158` | command(async) | **CONVERT**: walk: scan_workspace_files -> scan_workspace_files_at (src-tauri/src/workspace_files.rs:601); process: scan_workspace_files -> scan_workspace_files_at -> git_tracked_paths (src-tauri/src/workspace_files.rs:1092) |
| `scan_workspace_entries` | `src-tauri/src/workspace_files.rs:168` | command(async) | **CONVERT**: walk: scan_workspace_entries -> recover_rename_transactions (src-tauri/src/workspace_files.rs:1030); process: scan_workspace_entries -> scan_workspace_entries_at -> git_tracked_paths (src-tauri/src/workspace_files.rs:1092) |
| `create_workspace_directory` | `src-tauri/src/workspace_files.rs:179` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `rename_workspace_entry` | `src-tauri/src/workspace_files.rs:203` | sync | **CONVERT**: walk: rename_workspace_entry -> rekey_document_states (src-tauri/src/evidence_binder.rs:656) |
| `duplicate_workspace_entries` | `src-tauri/src/workspace_files.rs:242` | command(async) | **CONVERT**: walk: duplicate_workspace_entries -> copy_entry -> copy_dir_recursive_with_symlinks (src-tauri/src/workspace_files.rs:946) |
| `paste_workspace_entries` | `src-tauri/src/workspace_files.rs:273` | command(async) | **CONVERT**: walk: paste_workspace_entries -> copy_entry -> copy_dir_recursive_with_symlinks (src-tauri/src/workspace_files.rs:946) |
| `trash_workspace_entries` | `src-tauri/src/workspace_files.rs:329` | command(async) | **CONVERT**: platform trash for selected directory trees |
| `describe_file_queue_sources` | `src-tauri/src/workspace_files.rs:392` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `apply_file_queue` | `src-tauri/src/workspace_files.rs:430` | command(async) | **CONVERT**: walk: apply_file_queue -> move_source (src-tauri/src/workspace_files.rs:529) |
| `read_document` | `src-tauri/src/document.rs:84` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `save_document` | `src-tauri/src/document.rs:137` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `update_frontmatter_field` | `src-tauri/src/document.rs:205` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `create_document` | `src-tauri/src/document.rs:272` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `move_document` | `src-tauri/src/document.rs:412` | sync | **CONVERT**: walk: move_document -> rekey_document_states (src-tauri/src/evidence_binder.rs:656) |
| `duplicate_document` | `src-tauri/src/document.rs:458` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `trash_document` | `src-tauri/src/document.rs:479` | sync | **CONVERT**: platform trash |
| `create_version` | `src-tauri/src/document.rs:594` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `today_build_plan_request` | `src-tauri/src/today_ai.rs:232` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `today_apply_plan_result` | `src-tauri/src/today_ai.rs:270` | sync | **CONVERT**: walk: today_apply_plan_result -> today_mutate -> newest_valid_revision -> list_revisions (src-tauri/src/today_store.rs:282) |
| `search_workspace_contents` | `src-tauri/src/content_search.rs:117` | command(async) | **CONVERT**: process: search_workspace_contents -> collect_with_rg (src-tauri/src/content_search.rs:335); walk: search_workspace_contents -> collect_with_rust (src-tauri/src/content_search.rs:460) |
| `start_vault_watcher` | `src-tauri/src/vault_watcher.rs:43` | sync | **CONVERT**: recursive native watcher registration before background drain thread |
| `stop_vault_watcher` | `src-tauri/src/vault_watcher.rs:119` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `fetch_outlook_unread` | `src-tauri/src/outlook_mso.rs:146` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `stage_outlook_items` | `src-tauri/src/outlook_mso.rs:218` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `check_mso_auth` | `src-tauri/src/outlook_mso.rs:237` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `decide_outlook_item` | `src-tauri/src/outlook_mso.rs:455` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `decide_outlook_items` | `src-tauri/src/outlook_mso.rs:480` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `vault_validate_note` | `src-tauri/src/vault_guard.rs:152` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `drafts_list` | `src-tauri/src/drafts.rs:923` | command(async) | **CONVERT**: walk: drafts_list -> adopt_orphan_bodies (src-tauri/src/drafts.rs:518) |
| `drafts_promote_default_dir` | `src-tauri/src/drafts.rs:942` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `drafts_read` | `src-tauri/src/drafts.rs:947` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `drafts_save` | `src-tauri/src/drafts.rs:952` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `drafts_create` | `src-tauri/src/drafts.rs:965` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `drafts_set_status` | `src-tauri/src/drafts.rs:992` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `drafts_discard` | `src-tauri/src/drafts.rs:1004` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `drafts_promote` | `src-tauri/src/drafts.rs:1011` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `drafts_relink_promoted` | `src-tauri/src/drafts.rs:1057` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_sites` | `src-tauri/src/sites.rs:95` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `save_sites` | `src-tauri/src/sites.rs:100` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scan_work_sites` | `src-tauri/src/sites.rs:158` | sync | **CONVERT**: walk: scan_work_sites (src-tauri/src/sites.rs:159) |
| `search_calendar_notes` | `src-tauri/src/calendar_search.rs:10` | sync | **CONVERT**: walk: search_calendar_notes (src-tauri/src/calendar_search.rs:11) |
| `prepare_approval` | `src-tauri/src/approval.rs:43` | sync | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `record_approval` | `src-tauri/src/approval.rs:54` | sync | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `scan_inbox_drop` | `src-tauri/src/inbox.rs:341` | command(async) | **CONVERT**: walk: scan_inbox_drop -> scan_inbox_with_settings (src-tauri/src/inbox.rs:853) |
| `scan_inbox_entries` | `src-tauri/src/inbox.rs:352` | command(async) | **CONVERT**: walk: scan_inbox_entries -> scan_inbox_entries_with_config (src-tauri/src/inbox.rs:933) |
| `scan_inbox_processed_items` | `src-tauri/src/inbox.rs:369` | command(async) | **CONVERT**: walk: scan_inbox_processed_items -> scan_processed_items_with_config -> collect_processed_candidates (src-tauri/src/inbox.rs:1245) |
| `scan_inbox_processed_snapshot` | `src-tauri/src/inbox.rs:382` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `read_inbox_processed_item` | `src-tauri/src/inbox.rs:399` | command(async) | **CONVERT**: walk: read_inbox_processed_item -> read_processed_item_with_config -> list_raw_files (src-tauri/src/inbox.rs:2375) |
| `read_inbox_source_runs` | `src-tauri/src/inbox.rs:409` | command(async) | **CONVERT**: walk: read_inbox_source_runs -> read_source_runs_with_config (src-tauri/src/inbox.rs:1568) |
| `count_inbox_processed_by_channel` | `src-tauri/src/inbox.rs:420` | command(async) | **CONVERT**: walk: count_inbox_processed_by_channel -> count_processed_by_channel_with_config (src-tauri/src/inbox.rs:1708) |
| `trash_inbox_items` | `src-tauri/src/inbox.rs:429` | command(async) | **CONVERT**: platform trash |
| `stage_inbox_drop_files` | `src-tauri/src/inbox.rs:448` | command(async) | **CONVERT**: walk: stage_inbox_drop_files -> stage_one_drop_file -> stage_one_drop_file_result -> copy_source -> copy_dir_recursive (src-tauri/src/workspace_files.rs:548) |
| `accept_inbox_item` | `src-tauri/src/inbox.rs:484` | command(async) | **CONVERT**: walk: accept_inbox_item -> accept_inbox_item_at -> move_inbox_file -> move_source (src-tauri/src/workspace_files.rs:529) |
| `accept_inbox_items` | `src-tauri/src/inbox.rs:500` | command(async) | **CONVERT**: walk: accept_inbox_items -> accept_inbox_item_at -> move_inbox_file -> move_source (src-tauri/src/workspace_files.rs:529) |
| `reject_inbox_item` | `src-tauri/src/inbox.rs:527` | command(async) | **CONVERT**: walk: reject_inbox_item -> reject_inbox_item_at -> move_inbox_file -> move_source (src-tauri/src/workspace_files.rs:529) |
| `reject_inbox_items` | `src-tauri/src/inbox.rs:542` | command(async) | **CONVERT**: walk: reject_inbox_items -> reject_inbox_item_at -> move_inbox_file -> move_source (src-tauri/src/workspace_files.rs:529) |
| `apply_inbox_decisions` | `src-tauri/src/inbox.rs:573` | command(async) | **CONVERT**: walk: apply_inbox_decisions -> apply_inbox_decision_at -> file_raw_originals (src-tauri/src/inbox.rs:699) |
| `read_telegram_monitor_config` | `src-tauri/src/telegram_config.rs:192` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `save_telegram_monitor_config` | `src-tauri/src/telegram_config.rs:203` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `kg_document_refs` | `src-tauri/src/kg_refs.rs:489` | command(async) | **CONVERT**: walk: kg_document_refs -> compute_document_refs -> scan_vault (src-tauri/src/vault.rs:337) |
| `kg_refs_clear` | `src-tauri/src/kg_refs.rs:526` | sync | **CONVERT**: walk: kg_refs_clear (src-tauri/src/kg_refs.rs:527) |
| `jobs_list` | `src-tauri/src/jobs.rs:680` | sync | **CONVERT**: jobs_*_in reaches platform scheduler subprocess helpers or directory enumeration; jobs_read_log is bounded tail, retain only after helper check |
| `jobs_install` | `src-tauri/src/jobs.rs:685` | sync | **CONVERT**: jobs_*_in reaches platform scheduler subprocess helpers or directory enumeration; jobs_read_log is bounded tail, retain only after helper check |
| `jobs_uninstall` | `src-tauri/src/jobs.rs:690` | sync | **CONVERT**: jobs_*_in reaches platform scheduler subprocess helpers or directory enumeration; jobs_read_log is bounded tail, retain only after helper check |
| `jobs_start` | `src-tauri/src/jobs.rs:695` | sync | **CONVERT**: jobs_*_in reaches platform scheduler subprocess helpers or directory enumeration; jobs_read_log is bounded tail, retain only after helper check |
| `jobs_stop` | `src-tauri/src/jobs.rs:700` | sync | **CONVERT**: jobs_*_in reaches platform scheduler subprocess helpers or directory enumeration; jobs_read_log is bounded tail, retain only after helper check |
| `jobs_run_now` | `src-tauri/src/jobs.rs:705` | sync | **CONVERT**: jobs_*_in reaches platform scheduler subprocess helpers or directory enumeration; jobs_read_log is bounded tail, retain only after helper check |
| `jobs_read_log` | `src-tauri/src/jobs.rs:710` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `read_kakao_relay_status` | `src-tauri/src/kakao_relay.rs:743` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `read_kakao_relay_messages` | `src-tauri/src/kakao_relay.rs:753` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `stage_kakao_relay_new` | `src-tauri/src/kakao_relay.rs:767` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `enqueue_kakao_send` | `src-tauri/src/kakao_relay.rs:783` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `read_kakao_send_results` | `src-tauri/src/kakao_relay.rs:801` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `binary_viewer_classify` | `src-tauri/src/binary_viewer.rs:72` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `binary_viewer_prepare_asset` | `src-tauri/src/binary_viewer.rs:101` | sync | **UI**: Native webview/asset/notification/passkey dispatch, preserve platform thread affinity; site_view_open lock needs load scrutiny. |
| `binary_viewer_read_text` | `src-tauri/src/binary_viewer.rs:115` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `binary_viewer_read_archive` | `src-tauri/src/binary_viewer.rs:144` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `binary_viewer_extract_hwpx` | `src-tauri/src/binary_viewer.rs:174` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `binary_viewer_open_external` | `src-tauri/src/binary_viewer.rs:184` | sync | **CONVERT**: process: binary_viewer_open_external -> spawn_external -> spawn_command (src-tauri/src/binary_viewer.rs:266) |
| `binary_viewer_preview_external` | `src-tauri/src/binary_viewer.rs:195` | sync | **CONVERT**: process: binary_viewer_preview_external -> spawn_preview -> spawn_command (src-tauri/src/binary_viewer.rs:266) |
| `secrets_scan` | `src-tauri/src/secrets.rs:124` | sync | **CONVERT**: walk: secrets_scan -> scan_at -> collect_managed (src-tauri/src/secrets.rs:489) |
| `secrets_doctor` | `src-tauri/src/secrets.rs:130` | sync | **CONVERT**: walk: secrets_doctor -> secrets_scan -> scan_at -> collect_managed (src-tauri/src/secrets.rs:489) |
| `secrets_migrate` | `src-tauri/src/secrets.rs:135` | sync | **CONVERT**: walk: secrets_migrate -> migrate_at -> directory_empty_or_missing (src-tauri/src/secrets.rs:993) |
| `secrets_read_text` | `src-tauri/src/secrets.rs:145` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `secrets_write_text` | `src-tauri/src/secrets.rs:154` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `secrets_delete_text` | `src-tauri/src/secrets.rs:164` | sync | **CONVERT**: walk: secrets_delete_text -> scan_at -> collect_managed (src-tauri/src/secrets.rs:489) |
| `sample_workspace_path` | `src-tauri/src/vault.rs:302` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `scan_vault` | `src-tauri/src/vault.rs:336` | command(async) | **CONVERT**: walk: scan_vault (src-tauri/src/vault.rs:337) |
| `scan_vault_paths` | `src-tauri/src/vault.rs:447` | command(async) | **CONVERT**: walk: scan_vault_paths -> collect_version_names (src-tauri/src/vault.rs:945) |
| `read_vault_cache` | `src-tauri/src/vault.rs:518` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `hwped_read` | `src-tauri/src/hwped.rs:646` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `hwped_render` | `src-tauri/src/hwped.rs:656` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `hwped_edit` | `src-tauri/src/hwped.rs:669` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `hwped_compose` | `src-tauri/src/hwped.rs:684` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `hwped_validate` | `src-tauri/src/hwped.rs:691` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `hwped_capabilities` | `src-tauri/src/hwped.rs:701` | async fn | **ISOLATED**: Entire heavy body already enters spawn_blocking; approval-only preamble where present. |
| `terminal_hooks_status` | `src-tauri/src/terminal_hooks.rs:587` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `terminal_hooks_install` | `src-tauri/src/terminal_hooks.rs:607` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `terminal_hooks_uninstall` | `src-tauri/src/terminal_hooks.rs:628` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `write_agent_context_hint` | `src-tauri/src/terminal_hooks.rs:724` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `remove_agent_context_hint` | `src-tauri/src/terminal_hooks.rs:748` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `detect_legacy_telegram_launchd` | `src-tauri/src/launchd_migration.rs:17` | sync | **CONVERT**: walk: detect_legacy_telegram_launchd -> detect_legacy_telegram_launchd_in (src-tauri/src/launchd_migration.rs:98); process: detect_legacy_telegram_launchd -> loaded_launchd_labels (src-tauri/src/launchd_migration.rs:127) |
| `unload_legacy_telegram_launchd` | `src-tauri/src/launchd_migration.rs:26` | sync | **CONVERT**: unload_launchctl subprocess passed as callback |
| `today_logical_day` | `src-tauri/src/today.rs:801` | sync | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `studio_state_list` | `src-tauri/src/studio/mod.rs:141` | sync | **CONVERT**: walk: studio_state_list (src-tauri/src/studio/mod.rs:142) |
| `studio_state_read` | `src-tauri/src/studio/mod.rs:172` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `studio_state_save` | `src-tauri/src/studio/mod.rs:184` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `studio_state_delete` | `src-tauri/src/studio/mod.rs:208` | sync | **CONVERT**: walk: studio_state_delete (src-tauri/src/studio/mod.rs:209) |
| `studio_apply_body` | `src-tauri/src/studio/mod.rs:222` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `diagram_save_document` | `src-tauri/src/diagram/mod.rs:118` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `diagram_load_document` | `src-tauri/src/diagram/mod.rs:140` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `diagram_list_documents` | `src-tauri/src/diagram/mod.rs:149` | sync | **CONVERT**: walk: diagram_list_documents (src-tauri/src/diagram/mod.rs:150) |
| `diagram_delete_document` | `src-tauri/src/diagram/mod.rs:186` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `diagram_export_blob` | `src-tauri/src/diagram/mod.rs:249` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `diagram_export_blob_to_path` | `src-tauri/src/diagram/mod.rs:275` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `diagram_backup_document` | `src-tauri/src/diagram/mod.rs:302` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `diagram_save_snapshot` | `src-tauri/src/diagram/mod.rs:362` | sync | **CONVERT**: walk: diagram_save_snapshot -> prune_snapshots (src-tauri/src/diagram/mod.rs:397) |
| `diagram_list_snapshots` | `src-tauri/src/diagram/mod.rs:428` | sync | **CONVERT**: walk: diagram_list_snapshots (src-tauri/src/diagram/mod.rs:429) |
| `diagram_restore_snapshot` | `src-tauri/src/diagram/mod.rs:465` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `diagram_write_report_asset` | `src-tauri/src/diagram/mod.rs:512` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `diagram_pattern_save` | `src-tauri/src/diagram/mod.rs:554` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `diagram_pattern_list` | `src-tauri/src/diagram/mod.rs:575` | sync | **CONVERT**: walk: diagram_pattern_list (src-tauri/src/diagram/mod.rs:576) |
| `diagram_pattern_delete` | `src-tauri/src/diagram/mod.rs:612` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `skills_runtime_status` | `src-tauri/src/skill_host/dispatch.rs:73` | sync | **CONVERT**: process: skills_runtime_status -> runtime_status -> run_status_command (src-tauri/src/skill_host/dispatch.rs:767) |
| `skills_dispatch_compose` | `src-tauri/src/skill_host/dispatch.rs:81` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `skills_dispatch_terminal` | `src-tauri/src/skill_host/dispatch.rs:91` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `skills_dispatch_background` | `src-tauri/src/skill_host/dispatch.rs:221` | sync | **CONVERT**: process: skills_dispatch_background -> build_cli_command (src-tauri/src/agent_host/provider.rs:174) |
| `skills_env_status` | `src-tauri/src/skill_host/env.rs:47` | sync | **CONVERT**: walk: skills_env_status -> env_status -> default_public_env_setup -> builtin_env_setup_path -> ensure_active_bundle -> recover_interrupted_swap (src-tauri/src/skill_host/bundle_update.rs:195) |
| `skills_env_bootstrap` | `src-tauri/src/skill_host/env.rs:52` | sync | **CONVERT**: process: skills_env_bootstrap (src-tauri/src/skill_host/env.rs:53); walk: skills_env_bootstrap -> default_public_env_setup -> builtin_env_setup_path -> ensure_active_bundle -> recover_interrupted_swap (src-tauri/src/skill_host/bundle_update.rs:195) |
| `skills_env_repair` | `src-tauri/src/skill_host/env.rs:145` | sync | **CONVERT**: process: skills_env_repair -> skills_env_bootstrap (src-tauri/src/skill_host/env.rs:53); walk: skills_env_repair -> skills_env_bootstrap -> default_public_env_setup -> builtin_env_setup_path -> ensure_active_bundle -> recover_interrupted_swap (src-tauri/src/skill_host/bundle_update.rs:195) |
| `skills_list_sources` | `src-tauri/src/skill_host/store.rs:414` | sync | **CONVERT**: walk: skills_list_sources -> ensure_default_sources -> ensure_builtin_source -> ensure_active_bundle -> recover_interrupted_swap (src-tauri/src/skill_host/bundle_update.rs:195) |
| `skills_add_source` | `src-tauri/src/skill_host/store.rs:423` | sync | **CONVERT**: process: skills_add_source (src-tauri/src/skill_host/store.rs:424); walk: skills_add_source -> validate_cloned_source_manifest (src-tauri/src/skill_host/store.rs:526) |
| `skills_remove_source` | `src-tauri/src/skill_host/store.rs:561` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `skills_sync_source` | `src-tauri/src/skill_host/store.rs:570` | sync | **CONVERT**: process: skills_sync_source -> skills_sync_source_impl -> sync_one_source_in_registry (src-tauri/src/skill_host/store.rs:608); walk: skills_sync_source -> skills_sync_source_impl -> sync_one_source_in_registry -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> discover_skill_roots (src-tauri/src/skill_host/store.rs:5023) |
| `skills_sync_all_sources` | `src-tauri/src/skill_host/store.rs:630` | sync | **CONVERT**: process: skills_sync_all_sources -> skills_sync_all_sources_impl -> sync_one_source_in_registry (src-tauri/src/skill_host/store.rs:608); walk: skills_sync_all_sources -> skills_sync_all_sources_impl -> ensure_default_sources -> ensure_builtin_source -> ensure_active_bundle -> recover_interrupted_swap (src-tauri/src/skill_host/bundle_update.rs:195) |
| `skills_rescan_source` | `src-tauri/src/skill_host/store.rs:711` | sync | **CONVERT**: walk: skills_rescan_source -> skills_rescan_source_impl -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> discover_skill_roots (src-tauri/src/skill_host/store.rs:5023); process: skills_rescan_source -> skills_rescan_source_impl -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> git_dirty (src-tauri/src/skill_host/store.rs:5123) |
| `skills_list_skills` | `src-tauri/src/skill_host/store.rs:738` | sync | **CONVERT**: walk: skills_list_skills -> ensure_default_sources -> ensure_builtin_source -> ensure_active_bundle -> recover_interrupted_swap (src-tauri/src/skill_host/bundle_update.rs:195); process: skills_list_skills -> rescan_source_in_registry -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> git_dirty (src-tauri/src/skill_host/store.rs:5123) |
| `skills_read_skill` | `src-tauri/src/skill_host/store.rs:760` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `skills_read_skill_file` | `src-tauri/src/skill_host/store.rs:774` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `skills_save_skill_file` | `src-tauri/src/skill_host/store.rs:781` | sync | **CONVERT**: walk: skills_save_skill_file -> rescan_source_in_registry -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> discover_skill_roots (src-tauri/src/skill_host/store.rs:5023); process: skills_save_skill_file -> rescan_source_in_registry -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> git_dirty (src-tauri/src/skill_host/store.rs:5123) |
| `skills_save_skill_as` | `src-tauri/src/skill_host/store.rs:820` | sync | **CONVERT**: walk: skills_save_skill_as -> copy_dir_all (src-tauri/src/skill_host/store.rs:5224); process: skills_save_skill_as -> rescan_source_in_registry -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> git_dirty (src-tauri/src/skill_host/store.rs:5123) |
| `skills_create_skill` | `src-tauri/src/skill_host/store.rs:859` | sync | **CONVERT**: walk: skills_create_skill -> rescan_source_in_registry -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> discover_skill_roots (src-tauri/src/skill_host/store.rs:5023); process: skills_create_skill -> rescan_source_in_registry -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> git_dirty (src-tauri/src/skill_host/store.rs:5123) |
| `skills_delete_skill` | `src-tauri/src/skill_host/store.rs:888` | sync | **CONVERT**: walk: skills_delete_skill (src-tauri/src/skill_host/store.rs:889); process: skills_delete_skill -> rescan_source_in_registry -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> git_dirty (src-tauri/src/skill_host/store.rs:5123) |
| `skills_list_installs` | `src-tauri/src/skill_host/store.rs:914` | sync | **CONVERT**: walk: skills_list_installs -> ensure_default_sources -> ensure_builtin_source -> ensure_active_bundle -> recover_interrupted_swap (src-tauri/src/skill_host/bundle_update.rs:195) |
| `skills_install_skill` | `src-tauri/src/skill_host/store.rs:923` | sync | **CONVERT**: walk: skills_install_skill -> install_copy (src-tauri/src/skill_host/store.rs:2491) |
| `skills_uninstall_skill` | `src-tauri/src/skill_host/store.rs:997` | sync | **CONVERT**: walk: skills_uninstall_skill (src-tauri/src/skill_host/store.rs:998) |
| `skills_adopt_external_links` | `src-tauri/src/skill_host/store.rs:1055` | sync | **CONVERT**: walk: skills_adopt_external_links -> skills_adopt_external_links_impl (src-tauri/src/skill_host/store.rs:1063); process: skills_adopt_external_links -> skills_adopt_external_links_impl -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> git_dirty (src-tauri/src/skill_host/store.rs:5123) |
| `skills_reset_registry` | `src-tauri/src/skill_host/store.rs:1219` | sync | **CONVERT**: walk: skills_reset_registry -> skills_reset_registry_impl -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> discover_skill_roots (src-tauri/src/skill_host/store.rs:5023); process: skills_reset_registry -> skills_reset_registry_impl -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> git_dirty (src-tauri/src/skill_host/store.rs:5123) |
| `skills_doctor` | `src-tauri/src/skill_host/store.rs:1314` | sync | **CONVERT**: walk: skills_doctor -> doctor_foreign_root_issues (src-tauri/src/skill_host/store.rs:4581); process: skills_doctor -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> git_dirty (src-tauri/src/skill_host/store.rs:5123) |
| `skills_list_dirty` | `src-tauri/src/skill_host/store.rs:1816` | sync | **CONVERT**: process: skills_list_dirty -> dirty_records_from_registry -> source_git_repo_root (src-tauri/src/skill_host/store.rs:2194); walk: skills_list_dirty -> rescan_registry_sources -> ensure_default_sources -> ensure_builtin_source -> ensure_active_bundle -> recover_interrupted_swap (src-tauri/src/skill_host/bundle_update.rs:195) |
| `skills_reconcile_skill` | `src-tauri/src/skill_host/store.rs:1826` | sync | **CONVERT**: process: skills_reconcile_skill -> source_git_repo_root (src-tauri/src/skill_host/store.rs:2194); walk: skills_reconcile_skill -> restore_builtin_skill (src-tauri/src/skill_host/store.rs:2291) |
| `skills_import_external` | `src-tauri/src/skill_host/store.rs:1963` | sync | **CONVERT**: walk: skills_import_external -> copy_dir_all (src-tauri/src/skill_host/store.rs:5224); process: skills_import_external -> rescan_source_in_registry -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> git_dirty (src-tauri/src/skill_host/store.rs:5123) |
| `skills_import_unmanage` | `src-tauri/src/skill_host/store.rs:2035` | sync | **CONVERT**: walk: skills_import_unmanage (src-tauri/src/skill_host/store.rs:2036); process: skills_import_unmanage -> rescan_source_in_registry -> rescan_source_in_registry_with_progress -> scan_source_with_progress -> git_dirty (src-tauri/src/skill_host/store.rs:5123) |
| `skills_bundle_status` | `src-tauri/src/skill_host/store.rs:3823` | sync | **CONVERT**: walk: skills_bundle_status -> skills_bundle_status_impl -> bundle_dirty_areas -> collect_bundle_hashes (src-tauri/src/skill_host/store.rs:3593) |
| `skills_check_bundle_update` | `src-tauri/src/skill_host/store.rs:3828` | sync | **CONVERT**: walk: skills_check_bundle_update -> ensure_active_bundle -> recover_interrupted_swap (src-tauri/src/skill_host/bundle_update.rs:195); network: skills_check_bundle_update -> discover_remote_bundle -> http_get_capped -> http_client (src-tauri/src/skill_host/bundle_update.rs:308) |
| `skills_apply_bundle_update` | `src-tauri/src/skill_host/store.rs:3907` | sync | **CONVERT**: walk: skills_apply_bundle_update -> skills_apply_bundle_update_impl (src-tauri/src/skill_host/store.rs:3930); process: skills_apply_bundle_update -> skills_apply_bundle_update_impl -> run_env_repair_blocking (src-tauri/src/skill_host/store.rs:3750); network: skills_apply_bundle_update -> skills_apply_bundle_update_impl -> discover_remote_bundle -> http_get_capped -> http_client (src-tauri/src/skill_host/bundle_update.rs:308) |
| `gaejosik_lint` | `src-tauri/src/linter/gaejosik.rs:36` | sync | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `terminal_spawn` | `src-tauri/src/terminal/mod.rs:369` | async fn | **CONVERT**: native_pty_system/openpty, resolve_terminal_program and spawn_command before reader thread |
| `terminal_write` | `src-tauri/src/terminal/mod.rs:508` | async fn | **CONVERT**: write_shared -> blocking PTY writer |
| `terminal_input` | `src-tauri/src/terminal/mod.rs:518` | async fn | **CONVERT**: write_shared -> blocking PTY writer |
| `terminal_input_batch` | `src-tauri/src/terminal/mod.rs:555` | async fn | **CONVERT**: write_shared -> blocking PTY writer |
| `terminal_ack` | `src-tauri/src/terminal/mod.rs:605` | async fn | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `terminal_request_full` | `src-tauri/src/terminal/mod.rs:616` | async fn | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `terminal_set_visibility` | `src-tauri/src/terminal/mod.rs:626` | async fn | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `terminal_selection` | `src-tauri/src/terminal/mod.rs:637` | async fn | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `terminal_copy_selection` | `src-tauri/src/terminal/mod.rs:712` | async fn | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `terminal_scroll` | `src-tauri/src/terminal/mod.rs:727` | async fn | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `terminal_clear` | `src-tauri/src/terminal/mod.rs:749` | async fn | **CONVERT**: write_shared -> blocking PTY writer |
| `terminal_text` | `src-tauri/src/terminal/mod.rs:772` | async fn | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `terminal_search` | `src-tauri/src/terminal/mod.rs:785` | async fn | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `terminal_resize` | `src-tauri/src/terminal/mod.rs:824` | async fn | **CONVERT**: master.resize ioctl under locks |
| `terminal_kill` | `src-tauri/src/terminal/mod.rs:866` | async fn | **CONVERT**: ChildKiller.kill under lock; retain generation/lifecycle semantics |
| `catalog_scan` | `src-tauri/src/ops_catalog/mod.rs:61` | command(async) | **CONVERT**: walk: catalog_scan -> scan_catalog_impl -> collect_bu_configs (src-tauri/src/ops_catalog/scan.rs:180) |
| `catalog_query` | `src-tauri/src/ops_catalog/mod.rs:80` | command(async) | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `catalog_drilldown` | `src-tauri/src/ops_catalog/mod.rs:108` | command(async) | **CONVERT**: walk: catalog_drilldown -> drilldown_impl (src-tauri/src/ops_catalog/index.rs:86) |
| `catalog_watcher_start` | `src-tauri/src/ops_catalog/watcher.rs:38` | sync | **CONVERT**: walk: catalog_watcher_start -> register_bu_watch_paths (src-tauri/src/ops_catalog/watcher.rs:149) |
| `catalog_watcher_stop` | `src-tauri/src/ops_catalog/watcher.rs:120` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `agent_parse_skill_proposal` | `src-tauri/src/agent_host/proposal.rs:102` | sync | **RETAIN**: Pure parsing, logical date/model or bounded in-memory control; no network/process/walk observed in opened boundary. |
| `agent_apply_skill_proposal` | `src-tauri/src/agent_host/proposal.rs:107` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `agent_run_structured_loop` | `src-tauri/src/agent_host/structured_loop.rs:27` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `agent_export_redacted_run_summary` | `src-tauri/src/agent_host/cloud_dashboard.rs:23` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `agent_write_redacted_run_summary` | `src-tauri/src/agent_host/cloud_dashboard.rs:44` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `agents_account_status` | `src-tauri/src/agent_host/status.rs:73` | sync | **CONVERT**: process: agents_account_status -> account_status -> run_cli (src-tauri/src/agent_host/status.rs:829) |
| `agents_usage_status` | `src-tauri/src/agent_host/status.rs:83` | sync | **CONVERT**: network: agents_usage_status -> usage_status -> probe_usage -> claude_usage_windows (src-tauri/src/agent_host/status.rs:356); walk: agents_usage_status -> usage_status -> probe_usage -> codex_usage_windows -> recent_rollout_files (src-tauri/src/agent_host/status.rs:730) |
| `agent_read_run_events` | `src-tauri/src/agent_host/event_store.rs:74` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `agent_replay_run_summary` | `src-tauri/src/agent_host/event_store.rs:79` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `hub_status` | `src-tauri/src/hub_client/mod.rs:52` | sync | **CONVERT**: walk: hub_status -> queue_depth (src-tauri/src/hub_client/cache.rs:159); network: hub_status -> probe_health -> build_client (src-tauri/src/hub_client/http.rs:45) |
| `hub_fetch_catalog` | `src-tauri/src/hub_client/mod.rs:111` | sync | **CONVERT**: network: hub_fetch_catalog -> fetch_with_cache -> build_client (src-tauri/src/hub_client/http.rs:45) |
| `hub_submit_gate` | `src-tauri/src/hub_client/mod.rs:248` | sync | **CONVERT**: network: hub_submit_gate -> post_submit_gate -> build_client (src-tauri/src/hub_client/http.rs:45) |
| `hub_queue_drain` | `src-tauri/src/hub_client/mod.rs:302` | sync | **CONVERT**: walk: hub_queue_drain -> list_queue (src-tauri/src/hub_client/cache.rs:201); network: hub_queue_drain -> post_submit_gate -> build_client (src-tauri/src/hub_client/http.rs:45) |
| `hub_poll_gate` | `src-tauri/src/hub_client/mod.rs:358` | sync | **CONVERT**: network: hub_poll_gate -> fetch_with_cache -> build_client (src-tauri/src/hub_client/http.rs:45) |
| `export_dispatch` | `src-tauri/src/export/dispatch.rs:49` | sync | **CONVERT**: process: export_dispatch -> dispatch_bundle -> convert_docx -> run (src-tauri/src/export/dispatch.rs:324) |
| `export_plan` | `src-tauri/src/export/mod.rs:57` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |
| `export_validate` | `src-tauri/src/export/mod.rs:90` | sync | **AUDIT**: Boundary delegates or reads/writes finite files; confirm all indirect helpers and conditional/platform branches, including transitive callers. |

## Mandatory AUDIT ownership closure

Each module group below must be assigned to exactly one implementation plan. Before conversion or retention, read the full definition and all reached local/cross-module helpers; account for traits, callbacks, platform cfg and recursive primitives. Replace AUDIT with CONVERT, ISOLATED, UI or RETAIN and cite the decisive call chain/bound. Final gate: zero AUDIT rows, all 365 commands accounted for, every converted boundary has offload evidence and existing sync internal callers still compile.

- `src-tauri/src/telegram_io.rs` (4): `accept_telegram_item`, `reject_telegram_item`, `stage_telegram_items`, `stop_telegram_polling`
- `src-tauri/src/agents.rs` (4): `agents_list`, `agents_upsert`, `agents_delete`, `agents_reset`
- `src-tauri/src/scratchpad_watcher.rs` (1): `stop_scratchpad_watcher`
- `src-tauri/src/share_outbox.rs` (4): `read_share_outbox_config`, `save_share_outbox_root`, `ensure_share_outbox_root`, `scan_share_outbox`
- `src-tauri/src/vault_graph.rs` (4): `vault_graph_read`, `vault_graph_root`, `vault_graph_layout_read`, `vault_graph_layout_save`
- `src-tauri/src/meetings.rs` (4): `read_meeting_metadata`, `read_meeting_guides`, `append_meetings_log`, `read_meetings_log`
- `src-tauri/src/maru_dir.rs` (19): `read_maru_workspace`, `update_maru_workspace`, `bootstrap_maru_dir`, `read_maru_ignore`, `save_maru_ignore`, `read_maru_rule`, `save_maru_rule`, `delete_maru_rule`, `read_maru_template`, `save_maru_template`, `delete_maru_template`, `read_maru_mcp`, `save_maru_mcp`, `read_maru_projects`, `list_workspace_projects`, `save_maru_projects`, `read_maru_skills`, `read_maru_settings`, `save_maru_settings`
- `src-tauri/src/tasks.rs` (8): `read_task_metadata`, `create_task_note`, `update_task_status`, `update_task_schedule_fields`, `update_task_details`, `move_task_note`, `append_tasks_log`, `read_tasks_log`
- `src-tauri/src/today_store.rs` (1): `read_task_events`
- `src-tauri/src/mission_state.rs` (2): `stop_ai_mission`, `read_ai_mission_log`
- `src-tauri/src/shelf.rs` (3): `read_memo`, `save_memo`, `save_memo_as`
- `src-tauri/src/e2e_flow.rs` (1): `maru_e2e_read`
- `src-tauri/src/scratchpad.rs` (4): `scratchpad_read`, `scratchpad_save`, `scratchpad_rename`, `scratchpad_create_idea`
- `src-tauri/src/template_fill.rs` (1): `template_prepare_hwpx_template`
- `src-tauri/src/vault_list.rs` (5): `list_workspace_roots`, `add_workspace_root`, `refresh_workspace_capabilities`, `remove_workspace_root`, `set_active_workspace_root`
- `src-tauri/src/gmail_gws.rs` (1): `stage_gmail_items`
- `src-tauri/src/inbox_classifier.rs` (1): `build_inbox_classification_prompt`
- `src-tauri/src/inbox_watcher.rs` (1): `stop_inbox_watcher`
- `src-tauri/src/workspace.rs` (4): `detect_workspace`, `read_workspace_config`, `register_workspace_roots`, `list_workspaces`
- `src-tauri/src/inbox_settings.rs` (4): `read_inbox_runtime_config`, `save_inbox_runtime_config`, `read_inbox_settings`, `save_inbox_settings`
- `src-tauri/src/scheduler.rs` (4): `scheduler_list`, `scheduler_add`, `scheduler_remove`, `scheduler_set_enabled`
- `src-tauri/src/gap.rs` (4): `gap_analyze`, `gap_append_log`, `gap_log_list`, `gap_reports_list`
- `src-tauri/src/graph_authoring.rs` (2): `graph_link_preview`, `graph_link_apply`
- `src-tauri/src/workspace_files.rs` (2): `create_workspace_directory`, `describe_file_queue_sources`
- `src-tauri/src/document.rs` (6): `read_document`, `save_document`, `update_frontmatter_field`, `create_document`, `duplicate_document`, `create_version`
- `src-tauri/src/today_ai.rs` (1): `today_build_plan_request`
- `src-tauri/src/vault_watcher.rs` (1): `stop_vault_watcher`
- `src-tauri/src/outlook_mso.rs` (1): `stage_outlook_items`
- `src-tauri/src/vault_guard.rs` (1): `vault_validate_note`
- `src-tauri/src/drafts.rs` (8): `drafts_promote_default_dir`, `drafts_read`, `drafts_save`, `drafts_create`, `drafts_set_status`, `drafts_discard`, `drafts_promote`, `drafts_relink_promoted`
- `src-tauri/src/sites.rs` (2): `read_sites`, `save_sites`
- `src-tauri/src/telegram_config.rs` (2): `read_telegram_monitor_config`, `save_telegram_monitor_config`
- `src-tauri/src/jobs.rs` (1): `jobs_read_log`
- `src-tauri/src/binary_viewer.rs` (4): `binary_viewer_classify`, `binary_viewer_read_text`, `binary_viewer_read_archive`, `binary_viewer_extract_hwpx`
- `src-tauri/src/secrets.rs` (2): `secrets_read_text`, `secrets_write_text`
- `src-tauri/src/vault.rs` (2): `sample_workspace_path`, `read_vault_cache`
- `src-tauri/src/terminal_hooks.rs` (5): `terminal_hooks_status`, `terminal_hooks_install`, `terminal_hooks_uninstall`, `write_agent_context_hint`, `remove_agent_context_hint`
- `src-tauri/src/studio/mod.rs` (3): `studio_state_read`, `studio_state_save`, `studio_apply_body`
- `src-tauri/src/diagram/mod.rs` (10): `diagram_save_document`, `diagram_load_document`, `diagram_delete_document`, `diagram_export_blob`, `diagram_export_blob_to_path`, `diagram_backup_document`, `diagram_restore_snapshot`, `diagram_write_report_asset`, `diagram_pattern_save`, `diagram_pattern_delete`
- `src-tauri/src/skill_host/dispatch.rs` (2): `skills_dispatch_compose`, `skills_dispatch_terminal`
- `src-tauri/src/skill_host/store.rs` (3): `skills_remove_source`, `skills_read_skill`, `skills_read_skill_file`
- `src-tauri/src/ops_catalog/mod.rs` (1): `catalog_query`
- `src-tauri/src/ops_catalog/watcher.rs` (1): `catalog_watcher_stop`
- `src-tauri/src/agent_host/proposal.rs` (1): `agent_apply_skill_proposal`
- `src-tauri/src/agent_host/structured_loop.rs` (1): `agent_run_structured_loop`
- `src-tauri/src/agent_host/cloud_dashboard.rs` (2): `agent_export_redacted_run_summary`, `agent_write_redacted_run_summary`
- `src-tauri/src/agent_host/event_store.rs` (2): `agent_read_run_events`, `agent_replay_run_summary`
- `src-tauri/src/export/mod.rs` (2): `export_plan`, `export_validate`
