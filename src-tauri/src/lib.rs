pub mod agent_host;
mod agent_runtime_env;
mod agents;
mod ai_router;
mod app_menu;
mod approval;
mod atomic_file;
mod binary_viewer;
mod browser_passkeys;
mod calendar_search;
mod cli;
mod cli_path;
mod command_output;
mod content_search;
mod diagram;
mod document;
mod dot_sync;
mod drafts;
mod e2e_flow;
mod evidence_binder;
mod export;
mod file_manager;
mod filename_rules;
mod frontmatter;
mod gap;
mod git;
mod gmail_gws;
mod graph_authoring;
mod html_editor;
mod hub_client;
mod hwp_cli_template;
mod hwped;
mod inbox;
mod inbox_classifier;
mod inbox_drop;
mod inbox_settings;
mod inbox_watcher;
mod ipc_error;
mod jobs;
mod kakao_relay;
mod kg_refs;
mod kordoc_lite;
mod korean_date;
mod launchd_migration;
mod linter;
mod lock_recovery;
mod maru_dir;
mod maru_migration;
mod meetings;
mod mission_state;
mod ops_catalog;
mod outlook_mso;
mod paths;
mod project_activity;
mod scheduler;
pub(crate) mod scratchpad;
mod scratchpad_watcher;
mod secrets;
mod share_outbox;
mod shelf;
mod site_view;
mod sites;
mod skill_host;
mod studio;
mod tasks;
mod telegram_config;
mod telegram_io;
mod template_fill;
mod terminal;
mod terminal_hooks;
pub mod today;
pub mod today_ai;
pub mod today_calendar;
pub mod today_lifecycle;
pub mod today_notify;
pub mod today_outbox;
pub mod today_store;
mod vault;
mod vault_graph;
mod vault_guard;
mod vault_list;
mod vault_watcher;
pub mod web_actions;
mod win_process;
mod workspace;
mod workspace_files;

use agent_host::{
    agent_apply_skill_proposal, agent_export_redacted_run_summary, agent_parse_skill_proposal,
    agent_read_run_events, agent_replay_run_summary, agent_run_structured_loop,
    agent_write_redacted_run_summary, agents_account_status, agents_usage_status,
};
use agents::{agents_delete, agents_list, agents_reset, agents_upsert};
use ai_router::{start_agent_cli_invocation, start_claude_cli_invocation};
use approval::{prepare_approval, record_approval, ApprovalState};
use browser_passkeys::{
    browser_passkey_request_authorization, browser_passkey_status, BrowserPasskeyState,
};
use diagram::{
    diagram_backup_document, diagram_delete_document, diagram_export_blob,
    diagram_export_blob_to_path, diagram_list_documents, diagram_list_snapshots,
    diagram_load_document, diagram_pattern_delete, diagram_pattern_list, diagram_pattern_save,
    diagram_restore_snapshot, diagram_save_document, diagram_save_snapshot,
    diagram_write_report_asset,
};
use dot_sync::{dot_sync_overview, dot_sync_run};
use e2e_flow::{maru_e2e_read, maru_e2e_run};
use evidence_binder::{evidence_binder_mutate, evidence_binder_read};
use export::{export_dispatch, export_plan, export_validate};
use gmail_gws::{
    check_gws_auth, decide_gmail_item, decide_gmail_items, fetch_gmail_unread, stage_gmail_items,
};
use graph_authoring::{graph_link_apply, graph_link_preview};
use html_editor::prepare_html_editor_assets;
use hub_client::{hub_fetch_catalog, hub_poll_gate, hub_queue_drain, hub_status, hub_submit_gate};
use hwp_cli_template::{hwp_cli_template_fields, hwp_cli_template_fill};
use hwped::{
    hwped_capabilities, hwped_compose, hwped_edit, hwped_read, hwped_render, hwped_validate,
};
use inbox_settings::{
    read_inbox_runtime_config, read_inbox_settings, save_inbox_runtime_config, save_inbox_settings,
};
use inbox_watcher::{start_inbox_watcher, stop_inbox_watcher, InboxWatcherState};
use jobs::{
    jobs_install, jobs_list, jobs_read_log, jobs_run_now, jobs_start, jobs_stop, jobs_uninstall,
};
use kakao_relay::{
    enqueue_kakao_send, read_kakao_relay_messages, read_kakao_relay_status,
    read_kakao_send_results, stage_kakao_relay_new,
};
use kg_refs::{kg_document_refs, kg_refs_clear};
use korean_date::parse_korean_date_cmd;
use launchd_migration::{detect_legacy_telegram_launchd, unload_legacy_telegram_launchd};
use linter::gaejosik_lint;
use maru_dir::{
    bootstrap_maru_dir, delete_maru_rule, delete_maru_template, list_maru_rules,
    list_maru_templates, list_workspace_projects, read_maru_ignore, read_maru_mcp,
    read_maru_projects, read_maru_rule, read_maru_settings, read_maru_skills, read_maru_template,
    read_maru_workspace, save_maru_ignore, save_maru_mcp, save_maru_projects, save_maru_rule,
    save_maru_settings, save_maru_template, update_maru_workspace,
};
use mission_state::{list_ai_missions, read_ai_mission_log, stop_ai_mission, MissionState};
use ops_catalog::{
    catalog_drilldown, catalog_query, catalog_scan,
    watcher::{catalog_watcher_start, catalog_watcher_stop, CatalogWatcherState},
};
use outlook_mso::{
    check_mso_auth, decide_outlook_item, decide_outlook_items, fetch_outlook_unread,
    stage_outlook_items,
};
use scheduler::{
    scheduler_add, scheduler_list, scheduler_remove, scheduler_run_now, scheduler_set_enabled,
};
use scratchpad_watcher::{
    start_scratchpad_watcher, stop_scratchpad_watcher, ScratchpadWatcherState,
};
#[cfg(target_os = "macos")]
use site_view::queue_opened_urls;
use site_view::{
    site_view_back, site_view_close, site_view_close_all, site_view_forward, site_view_hide,
    site_view_navigate, site_view_open, site_view_open_external, site_view_open_safari,
    site_view_reload, site_view_set_bounds, site_view_show, site_view_take_opened_urls,
    SiteOpenedUrlState,
};
use sites::{read_sites, save_sites, scan_work_sites};
use skill_host::{skills_sync_all_sources, skills_sync_source};
use studio::{
    studio_apply_body, studio_state_delete, studio_state_list, studio_state_read, studio_state_save,
};
use tauri::Manager;
use telegram_config::{read_telegram_monitor_config, save_telegram_monitor_config};
use telegram_io::{
    accept_telegram_item, check_telegram_auth, fetch_telegram_recent, reject_telegram_item,
    stage_telegram_items, start_telegram_polling, stop_poller_on_exit, stop_telegram_polling,
    telegram_polling_status, TelegramIoState,
};
use template_fill::{template_fill_hwpx, template_get_fields, template_prepare_hwpx_template};
use terminal::{
    terminal_ack, terminal_clear, terminal_copy_selection, terminal_input, terminal_input_batch,
    terminal_kill, terminal_request_full, terminal_resize, terminal_scroll, terminal_search,
    terminal_selection, terminal_set_visibility, terminal_spawn, terminal_text, terminal_write,
    TerminalState,
};
use terminal_hooks::{
    remove_agent_context_hint, start_terminal_hook_watcher, terminal_hooks_install,
    terminal_hooks_status, terminal_hooks_uninstall, write_agent_context_hint,
    TerminalHookWatcherState,
};
use today_notify::today_notify_new_day;
use vault_graph::{
    vault_graph_layout_read, vault_graph_layout_save, vault_graph_read, vault_graph_root,
};
use vault_list::{
    add_workspace_root, list_workspace_roots, refresh_workspace_capabilities,
    remove_workspace_root, set_active_workspace_root,
};
use vault_watcher::{start_vault_watcher, stop_vault_watcher, VaultWatcherState};
use workspace::{
    detect_workspace, list_workspaces, read_workspace_config, register_workspace_roots,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    // Behind the default-off `native-e2e` feature so this plugin, and the
    // in-app WebDriver server it starts, never compile into a build a
    // user can install (D-10, T-06-01). Placed after tauri_plugin_updater
    // so the shipped plugin order is unchanged when the feature is off.
    #[cfg(feature = "native-e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .menu(app_menu::build_app_menu)
        .on_menu_event(app_menu::handle_menu_event)
        // No Rust-side CloseRequested handler: force-destroying the window
        // here raced the webview's JS close guards (settings flush, dirty
        // draft confirm) and always won. Default close semantics apply, so
        // JS `preventDefault` now decides.
        .manage(InboxWatcherState::default())
        .manage(VaultWatcherState::default())
        .manage(ScratchpadWatcherState::default())
        .manage(TelegramIoState::default())
        .manage(TerminalState::default())
        .manage(TerminalHookWatcherState::default())
        .manage(ApprovalState::default())
        .manage(MissionState::default())
        .manage(CatalogWatcherState::default())
        .manage(BrowserPasskeyState::default())
        .manage(SiteOpenedUrlState::default())
        .setup(|app| {
            // M0 Anchor→Maru one-time on-disk migration (~/.anchor → ~/.maru,
            // com.anchor.app → com.maru.app) — idempotent, before anything
            // touches the home runtime (DR-024).
            maru_migration::migrate_home();
            // Start the agent-hook status watcher (best-effort; absent hooks
            // simply produce no events).
            let _ = start_terminal_hook_watcher(&app.handle().clone());
            // Start the skill-mission scheduler ticker (60s cadence; first
            // tick doubles as the launch catch-up pass).
            scheduler::start_scheduler_ticker(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault::ipc::sample_workspace_path,
            vault::ipc::scan_vault,
            vault::ipc::scan_vault_paths,
            vault::ipc::read_vault_cache,
            start_vault_watcher,
            stop_vault_watcher,
            start_scratchpad_watcher,
            stop_scratchpad_watcher,
            vault_graph_read,
            vault_graph_root,
            vault_graph_layout_read,
            vault_graph_layout_save,
            graph_link_preview,
            graph_link_apply,
            vault_guard::ipc::vault_validate_note,
            document::ipc::read_document,
            document::ipc::save_document,
            document::ipc::create_document,
            document::ipc::move_document,
            document::ipc::duplicate_document,
            document::ipc::trash_document,
            document::ipc::create_version,
            document::ipc::update_frontmatter_field,
            list_workspace_roots,
            add_workspace_root,
            remove_workspace_root,
            set_active_workspace_root,
            refresh_workspace_capabilities,
            git::ipc::git_status,
            git::ipc::git_commit,
            git::ipc::git_generate_commit_message,
            git::ipc::git_sync_scan,
            git::ipc::git_sync_pull_rebase,
            git::ipc::git_sync_commit_push,
            git::ipc::git_changes,
            git::ipc::git_diff,
            git::ipc::list_workspace_submodules,
            file_manager::ipc::open_in_file_manager,
            file_manager::ipc::reveal_in_file_manager,
            inbox::ipc::scan_inbox_drop,
            inbox::ipc::scan_inbox_entries,
            inbox::ipc::scan_inbox_processed_items,
            inbox::scan_inbox_processed_snapshot,
            inbox::ipc::read_inbox_processed_item,
            inbox::ipc::read_inbox_source_runs,
            inbox::ipc::count_inbox_processed_by_channel,
            inbox::ipc::trash_inbox_items,
            inbox::ipc::stage_inbox_drop_files,
            inbox::ipc::accept_inbox_item,
            inbox::ipc::accept_inbox_items,
            inbox::ipc::apply_inbox_decisions,
            inbox::ipc::reject_inbox_item,
            inbox::ipc::reject_inbox_items,
            start_inbox_watcher,
            stop_inbox_watcher,
            read_inbox_settings,
            save_inbox_settings,
            read_inbox_runtime_config,
            save_inbox_runtime_config,
            share_outbox::ipc::read_share_outbox_config,
            share_outbox::ipc::save_share_outbox_root,
            share_outbox::ipc::ensure_share_outbox_root,
            share_outbox::ipc::scan_share_outbox,
            share_outbox::ipc::prepare_share_outbox_files,
            parse_korean_date_cmd,
            meetings::ipc::scan_meeting_notes,
            meetings::ipc::read_meeting_metadata,
            meetings::ipc::read_meeting_guides,
            meetings::ipc::append_meetings_log,
            meetings::ipc::read_meetings_log,
            calendar_search::ipc::search_calendar_notes,
            content_search::ipc::search_workspace_contents,
            tasks::ipc::scan_task_notes,
            tasks::ipc::read_task_metadata,
            tasks::ipc::create_task_note,
            tasks::ipc::update_task_status,
            tasks::ipc::update_task_schedule_fields,
            tasks::ipc::update_task_details,
            tasks::ipc::move_task_note,
            tasks::ipc::append_tasks_log,
            tasks::ipc::read_tasks_log,
            // Maru Today (morning ritual core)
            today::ipc::today_logical_day,
            today_store::ipc::today_open,
            today_store::ipc::today_mutate,
            today_store::ipc::today_finalize_setup,
            today_store::ipc::today_rollover,
            today_store::ipc::read_task_events,
            // Maru Today (AI planning contracts)
            today_ai::ipc::today_build_plan_request,
            today_ai::ipc::today_apply_plan_result,
            // Maru Today (task lifecycle + integrations)
            today_lifecycle::ipc::task_transition,
            today_lifecycle::ipc::task_trash,
            today_outbox::ipc::task_integrations_drain,
            today_outbox::ipc::task_integrations_retry,
            today_outbox::ipc::read_task_integrations,
            today_notify_new_day,
            // Maru Today (selective calendar sync)
            today_calendar::ipc::today_calendar_commitments,
            today_calendar::ipc::task_calendar_set_sync,
            today_calendar::ipc::today_calendar_publish,
            // Web action receipts (maru.web-task-action.v1)
            web_actions::ipc::web_actions_scan,
            web_actions::ipc::web_actions_apply,
            web_actions::ipc::web_action_repair_task_list_linkage,
            web_actions::ipc::web_actions_import_top,
            shelf::ipc::store_shelf_files,
            shelf::ipc::store_shelf_files_as,
            shelf::ipc::list_memos,
            shelf::ipc::read_memo,
            shelf::ipc::save_memo,
            shelf::ipc::delete_memo,
            shelf::ipc::save_memo_as,
            scratchpad::ipc::scratchpad_list,
            scratchpad::ipc::scratchpad_read,
            scratchpad::ipc::scratchpad_save,
            scratchpad::ipc::scratchpad_rename,
            scratchpad::ipc::scratchpad_trash,
            scratchpad::ipc::scratchpad_create_idea,
            scratchpad::ipc::scratchpad_transition_idea,
            scratchpad::ipc::scratchpad_cleanup_plan,
            scratchpad::ipc::scratchpad_cleanup_apply,
            scratchpad::ipc::scratchpad_migrate_legacy_memos,
            drafts::ipc::drafts_list,
            drafts::ipc::drafts_read,
            drafts::ipc::drafts_save,
            drafts::ipc::drafts_create,
            drafts::ipc::drafts_set_status,
            drafts::ipc::drafts_discard,
            drafts::ipc::drafts_promote,
            drafts::ipc::drafts_promote_default_dir,
            drafts::ipc::drafts_relink_promoted,
            gap::ipc::gap_analyze,
            gap::ipc::gap_append_log,
            gap::ipc::gap_log_list,
            gap::ipc::gap_reports_list,
            kg_document_refs,
            kg_refs_clear,
            scheduler_list,
            scheduler_add,
            scheduler_remove,
            scheduler_set_enabled,
            scheduler_run_now,
            agents_list,
            agents_upsert,
            agents_delete,
            agents_reset,
            start_claude_cli_invocation,
            start_agent_cli_invocation,
            list_ai_missions,
            read_ai_mission_log,
            stop_ai_mission,
            terminal_input,
            terminal_input_batch,
            terminal_ack,
            terminal_request_full,
            terminal_set_visibility,
            terminal_selection,
            terminal_copy_selection,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_clear,
            terminal_scroll,
            terminal_text,
            terminal_search,
            terminal_kill,
            terminal_hooks_install,
            terminal_hooks_uninstall,
            terminal_hooks_status,
            write_agent_context_hint,
            remove_agent_context_hint,
            inbox_classifier::ipc::build_inbox_classification_prompt,
            inbox_classifier::ipc::parse_inbox_classification,
            fetch_gmail_unread,
            stage_gmail_items,
            check_gws_auth,
            decide_gmail_item,
            decide_gmail_items,
            fetch_outlook_unread,
            stage_outlook_items,
            check_mso_auth,
            decide_outlook_item,
            decide_outlook_items,
            fetch_telegram_recent,
            accept_telegram_item,
            reject_telegram_item,
            stage_telegram_items,
            check_telegram_auth,
            start_telegram_polling,
            stop_telegram_polling,
            telegram_polling_status,
            read_telegram_monitor_config,
            save_telegram_monitor_config,
            detect_legacy_telegram_launchd,
            unload_legacy_telegram_launchd,
            read_kakao_relay_status,
            read_kakao_relay_messages,
            stage_kakao_relay_new,
            enqueue_kakao_send,
            read_kakao_send_results,
            jobs_list,
            jobs_install,
            jobs_uninstall,
            jobs_start,
            jobs_stop,
            jobs_run_now,
            jobs_read_log,
            dot_sync_overview,
            dot_sync_run,
            prepare_approval,
            record_approval,
            // workspace pairing + .maru/ system mode
            detect_workspace,
            read_workspace_config,
            register_workspace_roots,
            list_workspaces,
            workspace_files::ipc::scan_workspace_files,
            workspace_files::ipc::scan_workspace_entries,
            workspace_files::ipc::describe_file_queue_sources,
            workspace_files::ipc::apply_file_queue,
            workspace_files::ipc::create_workspace_directory,
            workspace_files::ipc::rename_workspace_entry,
            workspace_files::ipc::duplicate_workspace_entries,
            workspace_files::ipc::paste_workspace_entries,
            workspace_files::ipc::trash_workspace_entries,
            binary_viewer::ipc::binary_viewer_classify,
            binary_viewer::ipc::binary_viewer_prepare_asset,
            binary_viewer::ipc::binary_viewer_read_text,
            binary_viewer::ipc::binary_viewer_read_archive,
            binary_viewer::ipc::binary_viewer_extract_hwpx,
            binary_viewer::ipc::binary_viewer_open_external,
            binary_viewer::ipc::binary_viewer_preview_external,
            prepare_html_editor_assets,
            bootstrap_maru_dir,
            read_maru_workspace,
            update_maru_workspace,
            list_maru_rules,
            read_maru_rule,
            save_maru_rule,
            read_maru_ignore,
            save_maru_ignore,
            delete_maru_rule,
            list_maru_templates,
            read_maru_template,
            save_maru_template,
            delete_maru_template,
            read_maru_mcp,
            save_maru_mcp,
            read_maru_projects,
            list_workspace_projects,
            save_maru_projects,
            read_maru_skills,
            read_maru_settings,
            save_maru_settings,
            secrets::ipc::secrets_scan,
            secrets::ipc::secrets_doctor,
            secrets::ipc::secrets_migrate,
            secrets::ipc::secrets_read_text,
            secrets::ipc::secrets_write_text,
            secrets::ipc::secrets_delete_text,
            skill_host::store::ipc::skills_list_sources,
            skill_host::store::ipc::skills_add_source,
            skill_host::store::ipc::skills_remove_source,
            skills_sync_source,
            skills_sync_all_sources,
            skill_host::store::ipc::skills_rescan_source,
            skill_host::store::ipc::skills_list_skills,
            skill_host::store::ipc::skills_read_skill,
            skill_host::store::ipc::skills_read_skill_file,
            skill_host::store::ipc::skills_save_skill_file,
            skill_host::store::ipc::skills_save_skill_as,
            skill_host::store::ipc::skills_create_skill,
            skill_host::store::ipc::skills_delete_skill,
            skill_host::store::ipc::skills_list_installs,
            skill_host::store::ipc::skills_install_skill,
            skill_host::store::ipc::skills_uninstall_skill,
            skill_host::store::ipc::skills_adopt_external_links,
            skill_host::store::ipc::skills_reset_registry,
            skill_host::store::ipc::skills_doctor,
            skill_host::store::ipc::skills_list_dirty,
            skill_host::store::ipc::skills_reconcile_skill,
            skill_host::store::ipc::skills_import_external,
            skill_host::store::ipc::skills_import_unmanage,
            skill_host::env::ipc::skills_env_status,
            skill_host::env::ipc::skills_env_bootstrap,
            skill_host::env::ipc::skills_env_repair,
            skill_host::store::ipc::skills_bundle_status,
            skill_host::store::ipc::skills_check_bundle_update,
            skill_host::store::ipc::skills_apply_bundle_update,
            skill_host::dispatch::ipc::skills_dispatch_compose,
            skill_host::dispatch::ipc::skills_dispatch_terminal,
            skill_host::dispatch::ipc::skills_dispatch_background,
            skill_host::dispatch::ipc::skills_runtime_status,
            agent_read_run_events,
            agent_replay_run_summary,
            agent_export_redacted_run_summary,
            agent_write_redacted_run_summary,
            agent_run_structured_loop,
            agent_parse_skill_proposal,
            agent_apply_skill_proposal,
            agents_account_status,
            agents_usage_status,
            maru_e2e_run,
            maru_e2e_read,
            evidence_binder_read,
            evidence_binder_mutate,
            // M1 Operations Catalog (Phase 3)
            catalog_scan,
            catalog_query,
            catalog_drilldown,
            catalog_watcher_start,
            catalog_watcher_stop,
            // Dashboard project portfolio (issue #256)
            project_activity::ipc::scan_project_activity,
            // M7 Hub Connector (Phase 3 read, Phase 6 write)
            hub_status,
            hub_fetch_catalog,
            hub_submit_gate,
            hub_poll_gate,
            hub_queue_drain,
            // M4 Export Pipeline (Phase 4 W8-W10). Manual record_* transition
            // commands were removed: export_dispatch owns the whole lifecycle.
            export_plan,
            export_validate,
            export_dispatch,
            // M2 Document Studio (Phase 4 W11)
            studio_state_list,
            studio_state_read,
            studio_state_save,
            studio_state_delete,
            studio_apply_body,
            // M2 Document Studio (Phase 4 W12)
            template_get_fields,
            template_prepare_hwpx_template,
            template_fill_hwpx,
            hwp_cli_template_fields,
            hwp_cli_template_fill,
            gaejosik_lint,
            // hwp-editor engine bridge (thin hwp-cli spawner; hwped.rs)
            hwped_read,
            hwped_render,
            hwped_edit,
            hwped_compose,
            hwped_validate,
            hwped_capabilities,
            // Diagram mode (Phase 1 + Phase 4)
            diagram_save_document,
            diagram_load_document,
            diagram_list_documents,
            diagram_delete_document,
            diagram_export_blob,
            diagram_export_blob_to_path,
            diagram_list_snapshots,
            diagram_save_snapshot,
            diagram_restore_snapshot,
            diagram_backup_document,
            diagram_pattern_save,
            diagram_pattern_list,
            diagram_pattern_delete,
            diagram_write_report_asset,
            // Sites (in-app browser pane + global registry + scanner)
            browser_passkey_status,
            browser_passkey_request_authorization,
            site_view_open,
            site_view_navigate,
            site_view_set_bounds,
            site_view_show,
            site_view_hide,
            site_view_close_all,
            site_view_close,
            site_view_reload,
            site_view_back,
            site_view_forward,
            site_view_open_external,
            site_view_open_safari,
            site_view_take_opened_urls,
            read_sites,
            save_sites,
            scan_work_sites,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Maru")
        .run(|app_handle, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => queue_opened_urls(app_handle, urls),
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                let state = app_handle.state::<TelegramIoState>();
                stop_poller_on_exit(state.inner());
            }
            _ => {}
        });
}

pub fn run_cli(args: Vec<String>) -> i32 {
    cli::run_cli(args)
}
