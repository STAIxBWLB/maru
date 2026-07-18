pub mod agent_host;
mod ai_router;
mod atomic_file;
mod maru_dir;
mod app_menu;
mod approval;
mod binary_viewer;
mod calendar_search;
mod cli;
mod cli_path;
mod diagram;
mod document;
mod e2e_flow;
mod evidence_binder;
mod export;
mod file_manager;
mod filename_rules;
mod frontmatter;
mod git;
mod gmail_gws;
mod graph_authoring;
mod hub_client;
mod inbox;
mod inbox_classifier;
mod inbox_drop;
mod inbox_settings;
mod inbox_watcher;
mod kordoc_lite;
mod korean_date;
mod launchd_migration;
mod linter;
mod maru_migration;
mod meetings;
mod mission_state;
mod ops_catalog;
mod outlook_mso;
mod secrets;
mod share_outbox;
mod shelf;
mod site_view;
mod sites;
mod skill_host;
mod studio;
mod sys_import;
mod tasks;
mod telegram_config;
mod telegram_io;
mod template_fill;
mod terminal;
mod terminal_hooks;
mod vault;
mod vault_graph;
mod vault_guard;
mod vault_list;
mod vault_watcher;
mod win_process;
mod workspace;
mod workspace_files;

use agent_host::{
    agent_apply_skill_proposal, agent_export_redacted_run_summary, agent_parse_skill_proposal,
    agent_read_run_events, agent_replay_run_summary, agent_run_structured_loop,
    agent_validate_marketplace_manifest, agent_write_redacted_run_summary,
};
use ai_router::{start_agent_cli_invocation, start_claude_cli_invocation};
use maru_dir::{
    bootstrap_maru_dir, delete_maru_rule, delete_maru_template, list_maru_rules,
    list_maru_templates, list_workspace_projects, read_maru_imports, read_maru_mcp,
    read_maru_projects, read_maru_rule, read_maru_settings, read_maru_skills,
    read_maru_template, read_maru_workspace, save_maru_mcp, save_maru_projects,
    save_maru_rule, save_maru_settings, save_maru_template,
    update_maru_workspace,
};
use approval::{prepare_approval, record_approval, ApprovalState};
use binary_viewer::{
    binary_viewer_classify, binary_viewer_extract_hwpx, binary_viewer_open_external,
    binary_viewer_prepare_asset, binary_viewer_preview_external, binary_viewer_read_archive,
    binary_viewer_read_text,
};
use calendar_search::search_calendar_notes;
use diagram::{
    diagram_delete_document, diagram_export_blob, diagram_export_blob_to_path,
    diagram_list_documents, diagram_list_snapshots, diagram_load_document,
    diagram_restore_snapshot, diagram_save_document, diagram_save_snapshot,
};
use document::{
    create_document, create_version, duplicate_document, move_document, read_document,
    save_document, trash_document, update_frontmatter_field,
};
use e2e_flow::{maru_e2e_read, maru_e2e_run};
use evidence_binder::{evidence_binder_read, evidence_binder_save};
use export::{export_dispatch, export_plan, export_validate};
use file_manager::{open_in_file_manager, reveal_in_file_manager};
use git::{
    git_changes, git_commit, git_diff, git_generate_commit_message, git_status, git_status_fast,
    git_sync_commit_push, git_sync_pull_rebase, git_sync_scan,
};
use gmail_gws::{
    check_gws_auth, decide_gmail_item, decide_gmail_items, fetch_gmail_unread, stage_gmail_items,
};
use graph_authoring::{graph_link_apply, graph_link_preview};
use hub_client::{hub_fetch_catalog, hub_poll_gate, hub_queue_drain, hub_status, hub_submit_gate};
use inbox::{
    accept_inbox_item, accept_inbox_items, apply_inbox_decisions, count_inbox_processed_by_channel,
    read_inbox_processed_item, read_inbox_source_runs, reject_inbox_item, reject_inbox_items,
    scan_inbox_drop, scan_inbox_entries, scan_inbox_processed_items, stage_inbox_drop_files,
    trash_inbox_items,
};
use inbox_classifier::{build_inbox_classification_prompt, parse_inbox_classification};
use inbox_settings::{
    read_inbox_runtime_config, read_inbox_settings, save_inbox_runtime_config, save_inbox_settings,
};
use inbox_watcher::{start_inbox_watcher, stop_inbox_watcher, InboxWatcherState};
use korean_date::parse_korean_date_cmd;
use launchd_migration::{detect_legacy_telegram_launchd, unload_legacy_telegram_launchd};
use linter::gaejosik_lint;
use meetings::{
    append_meetings_log, read_meeting_guides, read_meeting_metadata, read_meetings_log,
    scan_meeting_notes,
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
use secrets::{
    secrets_delete_text, secrets_doctor, secrets_migrate, secrets_read_text, secrets_scan,
    secrets_write_text,
};
use share_outbox::{
    ensure_share_outbox_root, prepare_share_outbox_files, read_share_outbox_config,
    save_share_outbox_root, scan_share_outbox,
};
use shelf::{
    delete_memo, list_memos, read_memo, save_memo, save_memo_as, store_shelf_files,
    store_shelf_files_as,
};
use site_view::{
    site_view_back, site_view_close, site_view_forward, site_view_hide, site_view_navigate,
    site_view_open, site_view_open_external, site_view_reload, site_view_set_bounds,
    site_view_show,
};
use sites::{read_sites, save_sites, scan_work_sites};
use skill_host::{
    skills_add_source, skills_adopt_external_links, skills_apply_bundle_update,
    skills_bundle_status, skills_check_bundle_update, skills_create_skill, skills_delete_skill,
    skills_dispatch_background, skills_dispatch_compose, skills_dispatch_terminal, skills_doctor,
    skills_env_bootstrap, skills_env_repair, skills_env_status, skills_import_external,
    skills_import_unmanage, skills_install_skill, skills_list_dirty, skills_list_installs,
    skills_list_skills, skills_list_sources, skills_read_skill, skills_read_skill_file,
    skills_reconcile_skill, skills_remove_source, skills_rescan_source, skills_reset_registry,
    skills_runtime_status, skills_save_skill_as, skills_save_skill_file, skills_sync_all_sources,
    skills_sync_source, skills_uninstall_skill,
};
use studio::{
    studio_apply_body, studio_state_delete, studio_state_list, studio_state_read, studio_state_save,
};
use sys_import::{apply_sys_import, plan_sys_import};
use tasks::{
    append_tasks_log, create_task_note, move_task_note, read_task_metadata, read_tasks_log,
    scan_task_notes, update_task_details, update_task_schedule_fields, update_task_status,
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
    terminal_clear, terminal_input, terminal_kill, terminal_resize, terminal_scroll,
    terminal_search, terminal_spawn, terminal_text, terminal_write, TerminalState,
};
use terminal_hooks::{
    remove_agent_context_hint, start_terminal_hook_watcher, terminal_hooks_install,
    terminal_hooks_status, terminal_hooks_uninstall, write_agent_context_hint,
    TerminalHookWatcherState,
};
use vault::{read_vault_cache, sample_workspace_path, scan_vault};
use vault_graph::{vault_graph_layout_read, vault_graph_layout_save, vault_graph_read};
use vault_guard::vault_validate_note;
use vault_list::{
    add_workspace_root, list_workspace_roots, refresh_workspace_capabilities,
    remove_workspace_root, set_active_workspace_root,
};
use vault_watcher::{start_vault_watcher, stop_vault_watcher, VaultWatcherState};
use workspace::{
    detect_workspace, list_workspaces, read_workspace_config, register_workspace_roots,
};
use workspace_files::{apply_file_queue, describe_file_queue_sources, scan_workspace_files};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(app_menu::build_app_menu)
        .on_menu_event(app_menu::handle_menu_event)
        // No Rust-side CloseRequested handler: force-destroying the window
        // here raced the webview's JS close guards (settings flush, dirty
        // draft confirm) and always won. Default close semantics apply, so
        // JS `preventDefault` now decides.

        .manage(InboxWatcherState::default())
        .manage(VaultWatcherState::default())
        .manage(TelegramIoState::default())
        .manage(TerminalState::default())
        .manage(TerminalHookWatcherState::default())
        .manage(ApprovalState::default())
        .manage(MissionState::default())
        .manage(CatalogWatcherState::default())
        .setup(|app| {
            // M0 Anchor→Maru one-time on-disk migration (~/.anchor → ~/.maru,
            // com.anchor.app → com.maru.app) — idempotent, before anything
            // touches the home runtime (DR-024).
            maru_migration::migrate_home();
            // Start the agent-hook status watcher (best-effort; absent hooks
            // simply produce no events).
            let _ = start_terminal_hook_watcher(&app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sample_workspace_path,
            scan_vault,
            read_vault_cache,
            start_vault_watcher,
            stop_vault_watcher,
            vault_graph_read,
            vault_graph_layout_read,
            vault_graph_layout_save,
            graph_link_preview,
            graph_link_apply,
            vault_validate_note,
            read_document,
            save_document,
            create_document,
            move_document,
            duplicate_document,
            trash_document,
            create_version,
            update_frontmatter_field,
            list_workspace_roots,
            add_workspace_root,
            remove_workspace_root,
            set_active_workspace_root,
            refresh_workspace_capabilities,
            git_status,
            git_status_fast,
            git_commit,
            git_generate_commit_message,
            git_sync_scan,
            git_sync_pull_rebase,
            git_sync_commit_push,
            git_changes,
            git_diff,
            open_in_file_manager,
            reveal_in_file_manager,
            scan_inbox_drop,
            scan_inbox_entries,
            scan_inbox_processed_items,
            read_inbox_processed_item,
            read_inbox_source_runs,
            count_inbox_processed_by_channel,
            trash_inbox_items,
            stage_inbox_drop_files,
            accept_inbox_item,
            accept_inbox_items,
            apply_inbox_decisions,
            reject_inbox_item,
            reject_inbox_items,
            start_inbox_watcher,
            stop_inbox_watcher,
            read_inbox_settings,
            save_inbox_settings,
            read_inbox_runtime_config,
            save_inbox_runtime_config,
            read_share_outbox_config,
            save_share_outbox_root,
            ensure_share_outbox_root,
            scan_share_outbox,
            prepare_share_outbox_files,
            parse_korean_date_cmd,
            scan_meeting_notes,
            read_meeting_metadata,
            read_meeting_guides,
            append_meetings_log,
            read_meetings_log,
            search_calendar_notes,
            scan_task_notes,
            read_task_metadata,
            create_task_note,
            update_task_status,
            update_task_schedule_fields,
            update_task_details,
            move_task_note,
            append_tasks_log,
            read_tasks_log,
            store_shelf_files,
            store_shelf_files_as,
            list_memos,
            read_memo,
            save_memo,
            delete_memo,
            save_memo_as,
            start_claude_cli_invocation,
            start_agent_cli_invocation,
            list_ai_missions,
            read_ai_mission_log,
            stop_ai_mission,
            terminal_input,
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
            build_inbox_classification_prompt,
            parse_inbox_classification,
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
            prepare_approval,
            record_approval,
            // workspace pairing + .maru/ system mode
            detect_workspace,
            read_workspace_config,
            register_workspace_roots,
            list_workspaces,
            scan_workspace_files,
            describe_file_queue_sources,
            apply_file_queue,
            binary_viewer_classify,
            binary_viewer_prepare_asset,
            binary_viewer_read_text,
            binary_viewer_read_archive,
            binary_viewer_extract_hwpx,
            binary_viewer_open_external,
            binary_viewer_preview_external,
            bootstrap_maru_dir,
            read_maru_workspace,
            update_maru_workspace,
            list_maru_rules,
            read_maru_rule,
            save_maru_rule,
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
            read_maru_imports,
            secrets_scan,
            secrets_doctor,
            secrets_migrate,
            secrets_read_text,
            secrets_write_text,
            secrets_delete_text,
            plan_sys_import,
            apply_sys_import,
            skills_list_sources,
            skills_add_source,
            skills_remove_source,
            skills_sync_source,
            skills_sync_all_sources,
            skills_rescan_source,
            skills_list_skills,
            skills_read_skill,
            skills_read_skill_file,
            skills_save_skill_file,
            skills_save_skill_as,
            skills_create_skill,
            skills_delete_skill,
            skills_list_installs,
            skills_install_skill,
            skills_uninstall_skill,
            skills_adopt_external_links,
            skills_reset_registry,
            skills_doctor,
            skills_list_dirty,
            skills_reconcile_skill,
            skills_import_external,
            skills_import_unmanage,
            skills_env_status,
            skills_env_bootstrap,
            skills_env_repair,
            skills_bundle_status,
            skills_check_bundle_update,
            skills_apply_bundle_update,
            skills_dispatch_compose,
            skills_dispatch_terminal,
            skills_dispatch_background,
            skills_runtime_status,
            agent_read_run_events,
            agent_replay_run_summary,
            agent_export_redacted_run_summary,
            agent_write_redacted_run_summary,
            agent_run_structured_loop,
            agent_parse_skill_proposal,
            agent_apply_skill_proposal,
            agent_validate_marketplace_manifest,
            maru_e2e_run,
            maru_e2e_read,
            evidence_binder_read,
            evidence_binder_save,
            // M1 Operations Catalog (Phase 3)
            catalog_scan,
            catalog_query,
            catalog_drilldown,
            catalog_watcher_start,
            catalog_watcher_stop,
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
            gaejosik_lint,
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
            // Sites (in-app browser pane + global registry + scanner)
            site_view_open,
            site_view_navigate,
            site_view_set_bounds,
            site_view_show,
            site_view_hide,
            site_view_close,
            site_view_reload,
            site_view_back,
            site_view_forward,
            site_view_open_external,
            read_sites,
            save_sites,
            scan_work_sites,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Maru")
        .run(|app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                let state = app_handle.state::<TelegramIoState>();
                stop_poller_on_exit(state.inner());
            }
        });
}

pub fn run_cli(args: Vec<String>) -> i32 {
    cli::run_cli(args)
}
