pub mod agent_host;
mod agent_runtime_env;
mod agents;
mod ai_router;
mod app_menu;
mod approval;
mod archify;
mod architecture;
mod artifact_checks;
mod atomic_file;
mod binary_viewer;
mod browser_passkeys;
mod calendar_search;
mod calendar_sync;
mod channel_delivery;
mod cli;
mod cli_path;
mod command_output;
mod content_search;
mod diagram;
mod doc_format;
mod document;
mod dot_sync;
mod drafts;
mod e2e_flow;
mod evidence_binder;
mod export;
mod family_tools;
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
mod ipc_policy;
mod jobs;
mod kakao_relay;
mod kg_refs;
mod korean_date;
mod launchd_migration;
mod linter;
mod lock_recovery;
mod maru_dir;
mod maru_migration;
mod meeting_sources;
mod meetings;
mod mission_state;
#[cfg(feature = "native-e2e")]
mod native_e2e;
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
mod site_launcher;
mod site_view;
mod sites;
mod skill_host;
mod studio;
mod system_jobs;
mod task_execution_claims;
mod task_execution_runtime;
mod tasks;
mod telegram_config;
mod telegram_io;
mod template_fill;
mod terminal;
mod terminal_hooks;
#[cfg(test)]
mod test_support;
pub mod today;
pub mod today_ai;
pub mod today_calendar;
pub mod today_lifecycle;
pub mod today_notify;
pub mod today_outbox;
pub mod today_store;
mod tool_manifest;
mod vault;
mod vault_graph;
mod vault_guard;
mod vault_list;
mod vault_watcher;
pub mod web_actions;
mod win_process;
mod workspace;
mod workspace_files;

use agent_host::cloud_dashboard::ipc::{
    agent_export_redacted_run_summary, agent_write_redacted_run_summary,
};
use agent_host::event_store::ipc::{agent_read_run_events, agent_replay_run_summary};
use agent_host::proposal::ipc::{agent_apply_skill_proposal, agent_parse_skill_proposal};
use agent_host::status::ipc::{agents_account_status, agents_usage_status};
use agent_host::structured_loop::ipc::agent_run_structured_loop;
use agents::ipc::{agents_delete, agents_list, agents_reset, agents_upsert};
use ai_router::ipc::{start_agent_cli_invocation, start_claude_cli_invocation};
use approval::ipc::{prepare_approval, record_approval};
use approval::ApprovalState;
use browser_passkeys::ipc::{browser_passkey_request_authorization, browser_passkey_status};
use browser_passkeys::BrowserPasskeyState;
use diagram::ipc::{
    diagram_backup_document, diagram_delete_document, diagram_export_blob,
    diagram_export_blob_to_path, diagram_list_documents, diagram_list_snapshots,
    diagram_load_document, diagram_pattern_delete, diagram_pattern_list, diagram_pattern_save,
    diagram_restore_snapshot, diagram_save_document, diagram_save_snapshot,
    diagram_write_report_asset,
};
use dot_sync::{dot_sync_overview, dot_sync_run};
use e2e_flow::ipc::{maru_e2e_read, maru_e2e_run};
use export::dispatch::ipc::export_dispatch;
use export::ipc::{export_plan, export_validate};
use gmail_gws::check_gws_auth;
use html_editor::ipc::prepare_html_editor_assets;
use hub_client::ipc::{
    hub_fetch_catalog, hub_poll_gate, hub_queue_drain, hub_status, hub_submit_gate,
};
use hwp_cli_template::ipc::{hwp_cli_template_fields, hwp_cli_template_fill};
use hwped::{
    hwped_capabilities, hwped_compose, hwped_edit, hwped_read, hwped_render, hwped_validate,
};
use inbox_settings::ipc::{
    read_inbox_runtime_config, read_inbox_settings, save_inbox_runtime_config, save_inbox_settings,
};
use inbox_watcher::InboxWatcherState;
use kakao_relay::{
    enqueue_kakao_send, read_kakao_relay_messages, read_kakao_relay_status,
    read_kakao_send_results, stage_kakao_relay_new,
};
use korean_date::ipc::parse_korean_date_cmd;
use linter::gaejosik_lint;
use maru_dir::ipc::{
    bootstrap_maru_dir, delete_maru_rule, delete_maru_template, list_maru_rules,
    list_maru_templates, list_workspace_projects, read_maru_ignore, read_maru_mcp,
    read_maru_projects, read_maru_rule, read_maru_settings, read_maru_skills, read_maru_template,
    read_maru_workspace, save_maru_ignore, save_maru_mcp, save_maru_projects, save_maru_rule,
    save_maru_settings, save_maru_template, update_maru_workspace,
};
use mission_state::ipc::{list_ai_missions, read_ai_mission_log, stop_ai_mission};
use mission_state::MissionState;
use ops_catalog::watcher::CatalogWatcherState;
use outlook_mso::{
    check_mso_auth, decide_outlook_item, decide_outlook_items, fetch_outlook_unread,
};
use scratchpad_watcher::ScratchpadWatcherState;
use site_view::ipc::{
    site_view_open, site_view_open_external, site_view_open_safari, site_view_take_opened_urls,
};
#[cfg(target_os = "macos")]
use site_view::queue_opened_urls;
use site_view::{
    site_view_back, site_view_close, site_view_close_all, site_view_forward, site_view_hide,
    site_view_navigate, site_view_reload, site_view_set_bounds, site_view_show, SiteOpenedUrlState,
};
use sites::ipc::{read_sites, save_sites, scan_work_sites};
use skill_host::{skills_sync_all_sources, skills_sync_source};
use studio::ipc::{
    studio_apply_body, studio_state_delete, studio_state_list, studio_state_read, studio_state_save,
};
use tauri::Manager;
use telegram_config::ipc::{read_telegram_monitor_config, save_telegram_monitor_config};
use telegram_io::{check_telegram_auth, stop_poller_on_exit, TelegramIoState};
use template_fill::ipc::{template_fill_hwpx, template_get_fields, template_prepare_hwpx_template};
use terminal::TerminalState;
use terminal_hooks::{start_terminal_hook_watcher, TerminalHookWatcherState};
use today_notify::ipc::today_notify_new_day;
use vault_list::ipc::{
    add_workspace_root, list_workspace_roots, refresh_workspace_capabilities,
    remove_workspace_root, set_active_workspace_root,
};
use vault_watcher::VaultWatcherState;
use workspace::ipc::{
    detect_workspace, list_workspaces, read_workspace_config, register_workspace_roots,
};

// `tauri::generate_context!()` embeds a `#[no_mangle] static _EMBED_INFO_PLIST`
// (embed_plist crate) — a linker-global symbol allowed exactly once per final
// binary, at whichever single source location invokes the macro, regardless of
// how many times the containing function runs. `cargo test --lib` compiles
// this whole file (run() included, since it carries no test gate normally) INTO
// the same test binary as any #[cfg(test)] module, so a second invocation
// anywhere else in a unit test collides with this one ("symbol `_EMBED_INFO_PLIST`
// is already defined"). Splitting run() itself behind #[cfg(not(test))], with a
// stub standing in under #[cfg(test)], keeps the real body's invocation and
// quit_acl_tests's own (its only other call site in the crate) mutually
// exclusive: never both compiled into the same binary. main.rs's dependency
// edge on this lib is unaffected — cargo compiles a library dependency without
// --cfg test for its dependents, so real builds always get the body below.
#[cfg(not(test))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // This single codegen context is shared by headless artifact inspection and
    // desktop startup; another macro invocation duplicates the macOS plist symbol.
    let context = tauri::generate_context!();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--print-compiled-csp") {
        if args.len() != 1 {
            eprintln!("--print-compiled-csp takes no arguments");
            std::process::exit(2);
        }
        let security = &context.config().app.security;
        let csp = if tauri::is_dev() {
            security.dev_csp.as_ref().or(security.csp.as_ref())
        } else {
            security.csp.as_ref()
        };
        println!(
            "{}",
            serde_json::json!({ "kind": "maru.compiled-csp.v1", "csp": csp })
        );
        return;
    }
    #[cfg(all(feature = "native-e2e", target_os = "macos"))]
    let context = native_e2e::isolate_webview_profile(context);
    // Phase 08-27 saturation harness: install the two-worker test runtime
    // before any Tauri runtime initialization (default builds never call
    // this and keep Tauri's lazily initialized runtime).
    #[cfg(feature = "native-e2e")]
    native_e2e::install_test_runtime();
    let builder = tauri::Builder::default()
        .channel_interceptor(channel_delivery::intercept)
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(site_view::external_link_plugin());
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
            #[cfg(all(feature = "native-e2e", target_os = "macos"))]
            native_e2e::create_fixture_webviews(app)?;
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
        .invoke_handler(ipc_policy::restrict_app_commands(tauri::generate_handler![
            vault::ipc::sample_workspace_path,
            vault::ipc::scan_vault,
            vault::ipc::scan_vault_paths,
            vault::ipc::read_vault_cache,
            vault_watcher::ipc::start_vault_watcher,
            vault_watcher::ipc::stop_vault_watcher,
            scratchpad_watcher::ipc::start_scratchpad_watcher,
            scratchpad_watcher::ipc::stop_scratchpad_watcher,
            vault_graph::ipc::vault_graph_read,
            vault_graph::ipc::vault_graph_root,
            vault_graph::ipc::vault_graph_layout_read,
            vault_graph::ipc::vault_graph_layout_save,
            graph_authoring::ipc::graph_link_preview,
            graph_authoring::ipc::graph_link_apply,
            vault_guard::ipc::vault_validate_note,
            document::ipc::read_document,
            document::ipc::save_document,
            document::ipc::create_document,
            document::ipc::move_document,
            document::ipc::duplicate_document,
            document::ipc::trash_document,
            document::ipc::document_delete_plan,
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
            architecture::ipc::list_architecture_blueprints,
            architecture::ipc::prepare_architecture_blueprint,
            architecture::ipc::architecture_read_sibling_spec,
            archify::ipc::archify_validate_candidate,
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
            inbox_watcher::ipc::start_inbox_watcher,
            inbox_watcher::ipc::stop_inbox_watcher,
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
            meeting_sources::create_meeting_source_session,
            meeting_sources::import_meeting_source,
            meeting_sources::read_meeting_source_session,
            meeting_sources::list_meeting_source_sessions,
            meeting_sources::delete_meeting_source_session,
            meeting_sources::save_meeting_source_draft,
            meeting_sources::checkpoint_meeting_source,
            meeting_sources::confirm_meeting_source,
            meeting_sources::restore_meeting_source_version,
            meeting_sources::read_meeting_source_version,
            meeting_sources::list_meeting_correction_examples,
            meeting_sources::save_meeting_correction_example,
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
            calendar_sync::ipc::calendar_sync_run,
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
            kg_refs::ipc::kg_document_refs,
            kg_refs::ipc::kg_refs_clear,
            scheduler::ipc::scheduler_list,
            scheduler::ipc::scheduler_add,
            scheduler::ipc::scheduler_remove,
            scheduler::ipc::scheduler_set_enabled,
            scheduler::ipc::scheduler_run_now,
            agents_list,
            agents_upsert,
            agents_delete,
            agents_reset,
            start_claude_cli_invocation,
            start_agent_cli_invocation,
            list_ai_missions,
            read_ai_mission_log,
            stop_ai_mission,
            terminal::ipc::terminal_input,
            terminal::ipc::terminal_input_batch,
            terminal::ipc::terminal_ack,
            terminal::ipc::terminal_request_full,
            terminal::ipc::terminal_set_visibility,
            terminal::ipc::terminal_selection,
            terminal::ipc::terminal_copy_selection,
            terminal::ipc::terminal_spawn,
            terminal::ipc::terminal_write,
            terminal::ipc::terminal_resize,
            terminal::ipc::terminal_clear,
            terminal::ipc::terminal_scroll,
            terminal::ipc::terminal_text,
            terminal::ipc::terminal_search,
            terminal::ipc::terminal_kill,
            terminal_hooks::ipc::terminal_hooks_install,
            terminal_hooks::ipc::terminal_hooks_uninstall,
            terminal_hooks::ipc::terminal_hooks_status,
            terminal_hooks::ipc::write_agent_context_hint,
            terminal_hooks::ipc::remove_agent_context_hint,
            inbox_classifier::ipc::build_inbox_classification_prompt,
            inbox_classifier::ipc::parse_inbox_classification,
            gmail_gws::ipc::fetch_gmail_unread,
            gmail_gws::ipc::stage_gmail_items,
            check_gws_auth,
            gmail_gws::ipc::decide_gmail_item,
            gmail_gws::ipc::decide_gmail_items,
            fetch_outlook_unread,
            outlook_mso::ipc::stage_outlook_items,
            check_mso_auth,
            decide_outlook_item,
            decide_outlook_items,
            telegram_io::ipc::fetch_telegram_recent,
            telegram_io::ipc::accept_telegram_item,
            telegram_io::ipc::reject_telegram_item,
            telegram_io::ipc::stage_telegram_items,
            check_telegram_auth,
            telegram_io::ipc::start_telegram_polling,
            telegram_io::ipc::stop_telegram_polling,
            telegram_io::ipc::telegram_polling_status,
            read_telegram_monitor_config,
            save_telegram_monitor_config,
            launchd_migration::ipc::detect_legacy_telegram_launchd,
            launchd_migration::ipc::unload_legacy_telegram_launchd,
            read_kakao_relay_status,
            read_kakao_relay_messages,
            stage_kakao_relay_new,
            enqueue_kakao_send,
            read_kakao_send_results,
            jobs::ipc::jobs_list,
            jobs::ipc::jobs_install,
            jobs::ipc::jobs_uninstall,
            jobs::ipc::jobs_start,
            jobs::ipc::jobs_stop,
            jobs::ipc::jobs_run_now,
            jobs::ipc::jobs_read_log,
            system_jobs::ipc::system_jobs_list,
            system_jobs::ipc::system_job_set_enabled,
            system_jobs::ipc::system_job_run_now,
            system_jobs::ipc::system_crontab_remove,
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
            maru_dir::ipc::write_recovery_copy,
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
            evidence_binder::ipc::evidence_binder_read,
            evidence_binder::ipc::evidence_binder_mutate,
            // M1 Operations Catalog (Phase 3)
            ops_catalog::ipc::catalog_scan,
            ops_catalog::ipc::catalog_query,
            ops_catalog::ipc::catalog_drilldown,
            ops_catalog::watcher::ipc::catalog_watcher_start,
            ops_catalog::watcher::ipc::catalog_watcher_stop,
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
            family_tools::ipc::family_tools_status,
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
            // Phase 08-27 native saturation/source-race harness (feature-only;
            // the registration itself repeats the feature gate).
            #[cfg(feature = "native-e2e")]
            native_e2e::native_e2e_async_probe,
            #[cfg(feature = "native-e2e")]
            native_e2e::native_e2e_load_control,
        ]))
        .build(context)
        .expect("error while building Maru")
        .run(|app_handle, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => queue_opened_urls(app_handle, urls),
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                let state = app_handle.state::<TelegramIoState>();
                stop_poller_on_exit(state.inner());
                // D-12: no orphaned terminal child outlives Maru. This is
                // the only call site (D-06) -- it fires only after the
                // webview's own close guards already let the quit proceed.
                terminal::shutdown_all_sessions(app_handle.state::<TerminalState>().inner());
            }
            _ => {}
        });
}

/// Never invoked (main.rs is compiled without --cfg test, so it always links
/// the real body above): exists only so a `cargo test --lib` build has
/// exactly one `tauri::generate_context!()` call site, which is
/// quit_acl_tests's own build_context() below — see the comment on the real
/// run().
#[cfg(test)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    unreachable!("run() is not exercised under cfg(test) builds");
}

pub fn run_cli(args: Vec<String>) -> i32 {
    cli::run_cli(args)
}

#[cfg(test)]
mod quit_acl_tests {
    // Plan 09-08, D-03 ("one quit path"): a reviewer build regressed to
    // never actually exiting on a clean quit (no dirty draft, no pending
    // save) — no crash, no dialog, the window/app just stayed open. The
    // native-e2e WebDriver harness (e2e-native/specs/quit.spec.ts's sibling
    // approach) cannot observe this in the sandboxed environment this test
    // was authored in (its embedded WebDriver server's loopback bind never
    // completes there — confirmed pre-existing: an untouched, unrelated
    // spec fails identically). This test instead drives the REAL IPC/ACL
    // path Tauri itself uses, with tauri::test's MockRuntime standing in
    // for the window server (no real window, no socket, no webview) but
    // this crate's REAL `tauri.conf.json` + `capabilities/*.json`, loaded by
    // this module's own `tauri::generate_context!()` call below — the only
    // one active in a `cfg(test)` build (see the comment above the real
    // run(), which carries the equivalent call for normal builds).
    //
    // Root cause: @tauri-apps/api's `onCloseRequested` wrapper
    // (node_modules/@tauri-apps/api/window.js) calls `this.destroy()` —
    // i.e. invokes `plugin:window|destroy` — whenever the JS handler does
    // not call `event.preventDefault()`. Tauri's own default
    // `on_window_event` (tauri-2.10.3/src/manager/window.rs) ALWAYS calls
    // `api.prevent_close()` at the native level once any JS
    // close-requested listener is registered (this app registers exactly
    // one, in useDestructiveActionGuard.ts), so the only path to an actual
    // close is that JS-side `destroy()` call succeeding. `destroy` was
    // never granted in src-tauri/capabilities/default.json (only
    // `core:window:allow-close` was), so the IPC call was silently denied
    // and the window never closed.
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{Manager, WebviewWindowBuilder};

    // Tauri's test helper accepts AsRef<Webview>, which WebviewWindow provides
    // but a child Webview itself does not. Keep the same IPC response path.
    struct ChildIpc<'a>(&'a tauri::Webview<tauri::test::MockRuntime>);

    impl AsRef<tauri::Webview<tauri::test::MockRuntime>> for ChildIpc<'_> {
        fn as_ref(&self) -> &tauri::Webview<tauri::test::MockRuntime> {
            self.0
        }
    }

    fn invoke_request(cmd: &str) -> InvokeRequest {
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            // The desktop local-origin scheme (manager::tauri_protocol_url):
            // "http://tauri.localhost" on Windows/Android, "tauri://localhost"
            // on macOS/Linux.
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        }
    }

    /// generate_context!() with no path argument reads THIS crate's own
    /// tauri.conf.json + capabilities/*.json — the same files `run()` above
    /// builds from — not an empty/default test fixture. Factored into one
    /// call site: the macro embeds a `#[no_mangle]` static once per compiled
    /// binary, so a second literal invocation anywhere else in this crate's
    /// test build is a link error ("symbol _EMBED_INFO_PLIST is already
    /// defined"), not just a run-time conflict.
    fn build_test_app() -> tauri::App<tauri::test::MockRuntime> {
        build_test_app_from(mock_builder().channel_interceptor(crate::channel_delivery::intercept))
    }

    #[derive(Default)]
    struct PolicyDispatchCount(AtomicUsize);

    fn policy_dispatch_count(app: &tauri::App<tauri::test::MockRuntime>) -> usize {
        app.state::<PolicyDispatchCount>().0.load(Ordering::SeqCst)
    }

    fn build_test_app_from(
        builder: tauri::Builder<tauri::test::MockRuntime>,
    ) -> tauri::App<tauri::test::MockRuntime> {
        builder
            .manage(PolicyDispatchCount::default())
            .invoke_handler(crate::ipc_policy::restrict_app_commands(|invoke| {
                invoke
                    .message
                    .webview_ref()
                    .state::<PolicyDispatchCount>()
                    .0
                    .fetch_add(1, Ordering::SeqCst);
                invoke.resolver.resolve("first-party-dispatch");
                true
            }))
            .build(tauri::generate_context!())
            .expect("failed to build the app with this crate's real context/capabilities")
    }

    fn isolated_channel_case() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        let root = tempfile::tempdir().unwrap();
        let output = std::fs::File::create(root.path().join("output.log")).unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.env_clear();
        for key in [
            "PATH",
            "SYSTEMROOT",
            "LD_LIBRARY_PATH",
            "DYLD_FALLBACK_LIBRARY_PATH",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = command
            .args([
                "--exact",
                "quit_acl_tests::large_terminal_frames_use_only_bound_inline_delivery",
                "--test-threads=1",
                "--nocapture",
            ])
            .env("MARU_BOUND_CHANNEL_TEST_CHILD", "1")
            .env("HOME", root.path())
            .env("USERPROFILE", root.path())
            .env("TMPDIR", root.path())
            .env("TEMP", root.path())
            .env("TOKIO_WORKER_THREADS", "2")
            .current_dir(root.path())
            .stdout(Stdio::from(output.try_clone().unwrap()))
            .stderr(Stdio::from(output))
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!(
                    "isolated channel test timed out: {}",
                    std::fs::read_to_string(root.path().join("output.log")).unwrap()
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let output = std::fs::read_to_string(root.path().join("output.log")).unwrap();
        assert!(status.success(), "isolated channel test failed: {output}");
        assert!(
            output.contains("bound_channel_isolation_complete"),
            "isolated scenario did not run: {output}"
        );
    }

    #[test]
    fn large_terminal_frames_use_only_bound_inline_delivery() {
        // Channel data IDs are process-wide. A fresh one-test process makes
        // the black-box empty-queue probe deterministic, even under parallel CI.
        if std::env::var("MARU_BOUND_CHANNEL_TEST_CHILD")
            .ok()
            .as_deref()
            != Some("1")
        {
            isolated_channel_case();
            return;
        }
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        };
        use tauri::ipc::{Channel, InvokeResponseBody, JavaScriptChannelId};
        let delivered = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let fail_eval = Arc::new(AtomicBool::new(false));
        let captured = delivered.clone();
        let failure = fail_eval.clone();
        let app = build_test_app_from(mock_builder().channel_interceptor(
            move |view, callback, index, body| {
                crate::channel_delivery::intercept_with_eval(
                    view,
                    callback,
                    index,
                    body,
                    |target, script| {
                        if failure.load(Ordering::Acquire) {
                            return Err(());
                        }
                        let recorded = script.clone();
                        target.eval(script).map_err(|_| ())?;
                        captured
                            .lock()
                            .unwrap()
                            .push((target.label().to_string(), recorded));
                        Ok(())
                    },
                )
            },
        ));
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let editor = WebviewWindowBuilder::new(&app, "skill-editor", Default::default())
            .build()
            .unwrap();
        let observer = WebviewWindowBuilder::new(
            &app,
            "observer",
            tauri::WebviewUrl::External("https://example.invalid/".parse().unwrap()),
        )
        .build()
        .unwrap();
        let channel_id: JavaScriptChannelId = "__CHANNEL__:41".parse().unwrap();
        let channel: Channel<crate::terminal::TerminalStreamMessage> =
            channel_id.channel_on(main.as_ref().clone());
        let frame = crate::terminal::full_screen_stream_fixture();
        let expected = serde_json::to_value(&frame).unwrap();
        assert!(serde_json::to_vec(&frame).unwrap().len() > 8192);
        channel.send(frame.clone()).unwrap();
        {
            let sent = delivered.lock().unwrap();
            assert_eq!(sent.len(), 1);
            assert_eq!(sent[0].0, "main");
            assert!(sent[0].1.contains("runCallback(41,"));
            assert!(sent[0].1.contains("index: 0"));
            let quoted = sent[0].1.split_once("JSON.parse(").unwrap().1;
            let json = serde_json::Deserializer::from_str(quoted)
                .into_iter::<String>()
                .next()
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&json).unwrap(),
                expected
            );
        }
        let editor_id: JavaScriptChannelId = "__CHANNEL__:42".parse().unwrap();
        let editor_channel: Channel<crate::terminal::TerminalStreamMessage> =
            editor_id.channel_on(editor.as_ref().clone());
        editor_channel.send(frame.clone()).unwrap();
        assert_eq!(delivered.lock().unwrap().len(), 2);
        assert_eq!(delivered.lock().unwrap()[1].0, "skill-editor");
        fail_eval.store(true, Ordering::Release);
        channel.send(frame.clone()).unwrap(); // consumed despite injected eval error
        assert_eq!(delivered.lock().unwrap().len(), 2);
        fail_eval.store(false, Ordering::Release);
        let foreign_id: JavaScriptChannelId = "__CHANNEL__:43".parse().unwrap();
        let foreign: Channel<crate::terminal::TerminalStreamMessage> =
            foreign_id.channel_on(observer.as_ref().clone());
        foreign.send(frame.clone()).unwrap();
        let own_url = main.as_ref().url().unwrap();
        main.navigate("https://example.invalid/".parse().unwrap())
            .unwrap();
        channel.send(frame).unwrap();
        main.navigate(own_url).unwrap();
        assert_eq!(delivered.lock().unwrap().len(), 2);
        let malformed_id: JavaScriptChannelId = "__CHANNEL__:44".parse().unwrap();
        let malformed: Channel<InvokeResponseBody> = malformed_id.channel_on(main.as_ref().clone());
        let malformed_body = "invalid JSON".repeat(1024);
        assert!(malformed_body.len() > 8192);
        malformed
            .send(InvokeResponseBody::Json(malformed_body))
            .unwrap();
        assert_eq!(delivered.lock().unwrap().len(), 2);
        let raw_id: JavaScriptChannelId = "__CHANNEL__:45".parse().unwrap();
        let raw: Channel<InvokeResponseBody> = raw_id.channel_on(main.as_ref().clone());
        raw.send(InvokeResponseBody::Raw(vec![255; 2048])).unwrap();
        assert_eq!(delivered.lock().unwrap().len(), 3);
        assert_eq!(delivered.lock().unwrap()[2].0, "main");
        for view in [&main, &editor, &observer] {
            let mut request = invoke_request("plugin:__TAURI_CHANNEL__|fetch");
            request.url = view.as_ref().url().unwrap();
            request
                .headers
                .insert("tauri-channel-id", "0".parse().unwrap());
            let response = get_ipc_response(view, request);
            assert!(
                response.is_err(),
                "inline delivery must leave no pending fetch body"
            );
        }
        // Positive control: the same framework route has data when an app
        // deliberately uses its default transport. It must allocate ID 0 in
        // this fresh process, proving no preceding intercepted send queued data.
        let control = build_test_app_from(mock_builder());
        let control_view = WebviewWindowBuilder::new(&control, "main", Default::default())
            .build()
            .unwrap();
        let payload = serde_json::json!({"control": "synthetic".repeat(2000)});
        let control_channel: Channel<serde_json::Value> =
            channel_id.channel_on(control_view.as_ref().clone());
        control_channel.send(payload.clone()).unwrap();
        let mut request = invoke_request("plugin:__TAURI_CHANNEL__|fetch");
        request
            .headers
            .insert("tauri-channel-id", "0".parse().unwrap());
        assert_eq!(
            get_ipc_response(&control_view, request)
                .unwrap()
                .deserialize::<serde_json::Value>()
                .unwrap(),
            payload
        );
        println!("bound_channel_isolation_complete");
    }

    #[test]
    fn app_command_dispatch_allows_only_current_first_party_webviews() {
        let app = build_test_app();
        for label in ["main", "skill-editor"] {
            let view = WebviewWindowBuilder::new(&app, label, Default::default())
                .build()
                .unwrap();
            assert_eq!(
                get_ipc_response(&view, invoke_request("policy_probe"))
                    .unwrap()
                    .deserialize::<String>()
                    .unwrap(),
                "first-party-dispatch"
            );
        }
        for label in [
            "sites-embed-t1",
            "other-webview",
            "main-copy",
            "skill-editor-copy",
        ] {
            let view = WebviewWindowBuilder::new(&app, label, Default::default())
                .build()
                .unwrap();
            for command in ["read_sites", "save_sites", "unknown_command"] {
                assert_eq!(
                    get_ipc_response(&view, invoke_request(command)).unwrap_err(),
                    serde_json::json!(
                        "app_command_unavailable: this webview cannot dispatch app commands; use the Maru main window or skill editor"
                    )
                );
            }
        }
    }

    #[test]
    fn first_party_labels_require_a_current_app_url_regardless_of_headers() {
        for label in ["main", "skill-editor"] {
            for origin in [
                "https://example.invalid/",
                "http://127.0.0.1:43210/",
                "tauri://other/",
            ] {
                let app = build_test_app();
                let remote: tauri::Url = origin.parse().unwrap();
                let view = WebviewWindowBuilder::new(
                    &app,
                    label,
                    tauri::WebviewUrl::External(remote.clone()),
                )
                .build()
                .unwrap();
                assert_eq!(view.as_ref().url().unwrap(), remote);
                for with_header in [false, true] {
                    let mut request = invoke_request("policy_probe");
                    request.url = remote.clone();
                    if with_header {
                        request
                            .headers
                            .insert("origin", "http://tauri.localhost".parse().unwrap());
                    }
                    // Tauri refuses remote-origin requests before our wrapper.
                    assert!(get_ipc_response(&view, request).is_err());
                    assert_eq!(policy_dispatch_count(&app), 0);
                }
                // A locally classified request still reaches our wrapper, which
                // must independently reject the current remote native URL.
                assert_eq!(
                    get_ipc_response(&view, invoke_request("policy_probe")).unwrap_err(),
                    serde_json::json!("app_command_unavailable: this webview cannot dispatch app commands; use the Maru main window or skill editor")
                );
                assert_eq!(policy_dispatch_count(&app), 0);
            }
            let app = build_test_app();
            let view = WebviewWindowBuilder::new(&app, label, Default::default())
                .build()
                .unwrap();
            let mut request = invoke_request("policy_probe");
            request
                .headers
                .insert("origin", "https://example.invalid".parse().unwrap());
            assert_eq!(
                get_ipc_response(&view, request)
                    .unwrap()
                    .deserialize::<String>()
                    .unwrap(),
                "first-party-dispatch"
            );
        }
    }

    #[test]
    fn first_party_admission_rechecks_the_native_url_after_navigation() {
        for label in ["main", "skill-editor"] {
            let app = build_test_app();
            let view = WebviewWindowBuilder::new(&app, label, Default::default())
                .build()
                .unwrap();
            let own_url = view.as_ref().url().unwrap();
            assert!(get_ipc_response(&view, invoke_request("policy_probe")).is_ok());
            let remote: tauri::Url = "https://example.invalid/".parse().unwrap();
            view.navigate(remote.clone()).unwrap();
            let mut request = invoke_request("policy_probe");
            request.url = remote;
            assert!(get_ipc_response(&view, request).is_err());
            assert_eq!(policy_dispatch_count(&app), 1);
            // Keep the wrapper's native-URL recheck covered separately from
            // Tauri's request-origin gate.
            assert_eq!(
                get_ipc_response(&view, invoke_request("policy_probe")).unwrap_err(),
                serde_json::json!("app_command_unavailable: this webview cannot dispatch app commands; use the Maru main window or skill editor")
            );
            assert_eq!(policy_dispatch_count(&app), 1);
            view.navigate(own_url).unwrap();
            assert!(get_ipc_response(&view, invoke_request("policy_probe")).is_ok());
            assert_eq!(policy_dispatch_count(&app), 2);
        }
    }

    #[test]
    fn remote_child_in_main_cannot_dispatch_app_or_plugin_commands() {
        let app = build_test_app();
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        // This plugin command is granted to main for a local app origin.
        assert!(get_ipc_response(&main, invoke_request("plugin:window|is_maximized")).is_ok());
        for (index, origin) in ["http://127.0.0.1:43210/", "https://example.invalid/"]
            .iter()
            .enumerate()
        {
            let remote: tauri::Url = origin.parse().unwrap();
            let child = main
                .as_ref()
                .window()
                .add_child(
                    tauri::WebviewBuilder::new(
                        format!("sites-embed-policy-{index}"),
                        tauri::WebviewUrl::External(remote.clone()),
                    ),
                    tauri::Position::Logical(tauri::LogicalPosition::new(0.0, 0.0)),
                    tauri::Size::Logical(tauri::LogicalSize::new(200.0, 100.0)),
                )
                .unwrap();
            let child_ipc = ChildIpc(&child);
            let mut request = invoke_request("read_sites");
            request.url = remote.clone();
            assert!(get_ipc_response(&child_ipc, request).is_err());
            assert_eq!(policy_dispatch_count(&app), 0);
            let mut request = invoke_request("plugin:window|is_maximized");
            request.url = remote;
            let refused = get_ipc_response(&child_ipc, request).unwrap_err();
            assert!(
                refused.as_str().unwrap_or_default().contains("not allowed"),
                "{origin}: {refused}"
            );
            assert_eq!(policy_dispatch_count(&app), 0);
        }
    }

    #[test]
    fn main_window_can_destroy_itself_through_the_real_capabilities() {
        let app = build_test_app();
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("failed to build the \"main\" webview window");

        let response = get_ipc_response(&webview, invoke_request("plugin:window|destroy"));

        assert!(
            response.is_ok(),
            "plugin:window|destroy was denied for the \"main\" window: {:?}. This is exactly \
             the call @tauri-apps/api's onCloseRequested wrapper makes when the JS handler does \
             not preventDefault() — without \"core:window:allow-destroy\" granted in \
             src-tauri/capabilities/default.json, a confirmed clean quit (D-03) never actually \
             closes the window (checkpoint items 2/5/6/8).",
            response,
        );
    }

    // Review finding #2 / T-09-08-05 evidence gap: the "default" capability's
    // `windows` list already names both "main" and "skill-editor" (same
    // capability object, both windows), so this should already pass without
    // a capabilities change — this test only closes the gap the security
    // audit trail flagged: no direct test exercised the skill-editor label's
    // own destroy grant. requestAppQuit (useDestructiveActionGuard.ts) calls
    // this exact IPC command on the skill-editor window once its own guard
    // has cleared, as the last step before main itself closes.
    #[test]
    fn skill_editor_window_can_destroy_itself_through_the_real_capabilities() {
        let app = build_test_app();
        let webview = WebviewWindowBuilder::new(&app, "skill-editor", Default::default())
            .build()
            .expect("failed to build the \"skill-editor\" webview window");

        let response = get_ipc_response(&webview, invoke_request("plugin:window|destroy"));

        assert!(
            response.is_ok(),
            "plugin:window|destroy was denied for the \"skill-editor\" window: {:?}. \
             requestAppQuit's closeSkillEditorForQuit (windowLayout.ts) calls exactly this IPC \
             command; without it granted for this window label, a whole-app quit would flush \
             and confirm successfully but leave the skill editor window behind.",
            response,
        );
    }
}
