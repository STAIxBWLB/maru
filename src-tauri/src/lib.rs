pub mod agent_host;
mod ai_router;
mod anchor_dir;
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
mod hub_client;
mod inbox;
mod inbox_classifier;
mod inbox_settings;
mod inbox_watcher;
mod kordoc_lite;
mod korean_date;
mod launchd_migration;
mod linter;
mod meetings;
mod mission_state;
mod ops_catalog;
mod outlook_mso;
mod shelf;
mod skill_host;
mod studio;
mod sys_import;
mod tasks;
mod telegram_io;
mod template_fill;
mod terminal;
mod vault;
mod vault_list;
mod workspace;
mod workspace_files;

use agent_host::{
    agent_apply_skill_proposal, agent_export_redacted_run_summary, agent_parse_skill_proposal,
    agent_read_run_events, agent_replay_run_summary, agent_run_structured_loop,
    agent_validate_marketplace_manifest, agent_write_redacted_run_summary,
};
use ai_router::{start_agent_cli_invocation, start_claude_cli_invocation};
use anchor_dir::{
    bootstrap_anchor_dir, delete_anchor_rule, delete_anchor_template, list_anchor_rules,
    list_anchor_templates, read_anchor_imports, read_anchor_mcp, read_anchor_projects,
    read_anchor_rule, read_anchor_settings, read_anchor_skills, read_anchor_template,
    read_anchor_workspace, save_anchor_mcp, save_anchor_projects, save_anchor_rule,
    save_anchor_settings, save_anchor_skills, save_anchor_template, update_anchor_workspace,
};
use approval::{prepare_approval, record_approval, ApprovalState};
use binary_viewer::{
    binary_viewer_classify, binary_viewer_extract_hwpx, binary_viewer_open_external,
    binary_viewer_prepare_asset, binary_viewer_preview_external, binary_viewer_read_archive,
    binary_viewer_read_text,
};
use calendar_search::search_calendar_notes;
use document::{
    create_document, create_version, duplicate_document, move_document, read_document,
    save_document, trash_document, update_frontmatter_field,
};
use e2e_flow::{anchor_e2e_read, anchor_e2e_run};
use evidence_binder::{evidence_binder_read, evidence_binder_save};
use export::{
    export_dispatch, export_manifest_load, export_plan, export_record_failure,
    export_record_pending, export_record_success, export_validate,
};
use file_manager::reveal_in_file_manager;
use git::{
    git_changes, git_commit, git_diff, git_generate_commit_message, git_status, git_status_fast,
    git_sync_commit_push, git_sync_pull_rebase, git_sync_scan,
};
use gmail_gws::{decide_gmail_item, decide_gmail_items, fetch_gmail_unread};
use hub_client::{hub_fetch_catalog, hub_poll_gate, hub_status, hub_submit_gate};
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
use outlook_mso::{decide_outlook_item, decide_outlook_items, fetch_outlook_unread};
use shelf::{
    delete_memo, list_memos, read_memo, save_memo, save_memo_as, store_shelf_files,
    store_shelf_files_as,
};
use skill_host::{
    skills_add_source, skills_adopt_external_links, skills_create_skill, skills_delete_skill,
    skills_dispatch_background, skills_dispatch_compose, skills_dispatch_terminal, skills_doctor,
    skills_env_bootstrap, skills_env_repair, skills_env_status, skills_import_external,
    skills_import_unmanage, skills_install_skill, skills_list_dirty, skills_list_installs,
    skills_list_skills, skills_list_sources, skills_read_skill, skills_read_skill_file,
    skills_reconcile_skill, skills_remove_source, skills_rescan_source, skills_reset_registry,
    skills_runtime_status, skills_save_skill_as, skills_save_skill_file, skills_sync_all_sources,
    skills_sync_source, skills_uninstall_skill,
};
use diagram::{
    diagram_delete_document, diagram_export_blob, diagram_export_blob_to_path,
    diagram_list_documents, diagram_list_snapshots, diagram_load_document, diagram_restore_snapshot,
    diagram_save_document, diagram_save_snapshot,
};
use studio::{
    studio_apply_body, studio_state_delete, studio_state_list, studio_state_read, studio_state_save,
};
use sys_import::{apply_sys_import, plan_sys_import};
use tasks::{
    append_tasks_log, create_task_note, move_task_note, read_task_metadata, read_tasks_log,
    scan_task_notes, update_task_schedule_fields, update_task_status,
};
use tauri::Manager;
use telegram_io::{
    accept_telegram_item, fetch_telegram_recent, reject_telegram_item, start_telegram_polling,
    stop_poller_on_exit, stop_telegram_polling, telegram_polling_status, TelegramIoState,
};
use template_fill::{template_fill_hwpx, template_get_fields, template_prepare_hwpx_template};
use terminal::{terminal_kill, terminal_resize, terminal_spawn, terminal_write, TerminalState};
use vault::{default_vault_path, read_vault_cache, sample_workspace_path, scan_vault};
use vault_list::{
    add_workspace_root, list_workspace_roots, refresh_workspace_capabilities,
    remove_workspace_root, set_active_workspace_root,
};
use workspace::{
    detect_workspace, list_workspaces, read_workspace_config, register_workspace_roots,
};
use workspace_files::{apply_file_queue, describe_file_queue_sources, scan_workspace_files};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(app_menu::build_app_menu)
        .on_menu_event(app_menu::handle_menu_event)
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let _ = window.destroy();
            }
        })
        .manage(InboxWatcherState::default())
        .manage(TelegramIoState::default())
        .manage(TerminalState::default())
        .manage(ApprovalState::default())
        .manage(MissionState::default())
        .manage(CatalogWatcherState::default())
        .invoke_handler(tauri::generate_handler![
            default_vault_path,
            sample_workspace_path,
            scan_vault,
            read_vault_cache,
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
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill,
            build_inbox_classification_prompt,
            parse_inbox_classification,
            fetch_gmail_unread,
            decide_gmail_item,
            decide_gmail_items,
            fetch_outlook_unread,
            decide_outlook_item,
            decide_outlook_items,
            fetch_telegram_recent,
            accept_telegram_item,
            reject_telegram_item,
            start_telegram_polling,
            stop_telegram_polling,
            telegram_polling_status,
            detect_legacy_telegram_launchd,
            unload_legacy_telegram_launchd,
            prepare_approval,
            record_approval,
            // workspace pairing + .anchor/ system mode
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
            bootstrap_anchor_dir,
            read_anchor_workspace,
            update_anchor_workspace,
            list_anchor_rules,
            read_anchor_rule,
            save_anchor_rule,
            delete_anchor_rule,
            list_anchor_templates,
            read_anchor_template,
            save_anchor_template,
            delete_anchor_template,
            read_anchor_mcp,
            save_anchor_mcp,
            read_anchor_projects,
            save_anchor_projects,
            read_anchor_skills,
            save_anchor_skills,
            read_anchor_settings,
            save_anchor_settings,
            read_anchor_imports,
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
            anchor_e2e_run,
            anchor_e2e_read,
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
            // M4 Export Pipeline (Phase 4 W8-W9)
            export_plan,
            export_manifest_load,
            export_validate,
            export_record_pending,
            export_record_success,
            export_record_failure,
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building Anchor")
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
