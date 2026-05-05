mod ai_router;
mod anchor_dir;
mod app_menu;
mod document;
mod file_manager;
mod filename_rules;
mod frontmatter;
mod git;
mod gmail_gws;
mod inbox;
mod inbox_classifier;
mod inbox_settings;
mod inbox_watcher;
mod korean_date;
mod shelf;
mod sys_import;
mod terminal;
mod vault;
mod vault_list;
mod workspace;
mod workspace_files;

use ai_router::start_claude_cli_invocation;
use anchor_dir::{
    bootstrap_anchor_dir, delete_anchor_rule, delete_anchor_template, list_anchor_rules,
    list_anchor_templates, read_anchor_imports, read_anchor_mcp, read_anchor_projects,
    read_anchor_rule, read_anchor_settings, read_anchor_skills, read_anchor_template,
    read_anchor_workspace, save_anchor_mcp, save_anchor_projects, save_anchor_rule,
    save_anchor_settings, save_anchor_skills, save_anchor_template, update_anchor_workspace,
};
use document::{
    create_document, create_version, duplicate_document, move_document, read_document,
    save_document, trash_document, update_frontmatter_field,
};
use file_manager::reveal_in_file_manager;
use git::{git_changes, git_commit, git_diff, git_status, git_status_fast};
use gmail_gws::fetch_gmail_unread;
use inbox::scan_inbox_drop;
use inbox_classifier::{build_inbox_classification_prompt, parse_inbox_classification};
use inbox_settings::{read_inbox_settings, save_inbox_settings};
use inbox_watcher::{start_inbox_watcher, stop_inbox_watcher, InboxWatcherState};
use korean_date::parse_korean_date_cmd;
use shelf::{
    delete_memo, list_memos, read_memo, save_memo, save_memo_as, store_shelf_files,
    store_shelf_files_as,
};
use sys_import::{apply_sys_import, plan_sys_import};
use terminal::{terminal_kill, terminal_resize, terminal_spawn, terminal_write, TerminalState};
use vault::{default_vault_path, read_vault_cache, sample_vault_path, scan_vault};
use vault_list::{
    add_workspace_root, list_workspace_roots, refresh_workspace_capabilities,
    remove_workspace_root, set_active_workspace_root,
};
use workspace::{
    detect_workspace, list_workspaces, read_workspace_config, register_workspace_roots,
};
use workspace_files::{apply_file_queue, scan_workspace_files};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(app_menu::build_app_menu)
        .on_menu_event(app_menu::handle_menu_event)
        .manage(InboxWatcherState::default())
        .manage(TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            default_vault_path,
            sample_vault_path,
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
            git_changes,
            git_diff,
            reveal_in_file_manager,
            scan_inbox_drop,
            start_inbox_watcher,
            stop_inbox_watcher,
            read_inbox_settings,
            save_inbox_settings,
            parse_korean_date_cmd,
            store_shelf_files,
            store_shelf_files_as,
            list_memos,
            read_memo,
            save_memo,
            delete_memo,
            save_memo_as,
            start_claude_cli_invocation,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill,
            build_inbox_classification_prompt,
            parse_inbox_classification,
            fetch_gmail_unread,
            // workspace pairing + .anchor/ system mode
            detect_workspace,
            read_workspace_config,
            register_workspace_roots,
            list_workspaces,
            scan_workspace_files,
            apply_file_queue,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Anchor");
}
