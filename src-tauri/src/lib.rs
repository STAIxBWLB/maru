mod ai_router;
mod anchor_dir;
mod document;
mod filename_rules;
mod frontmatter;
mod git;
mod gmail_gws;
mod inbox;
mod inbox_classifier;
mod inbox_watcher;
mod korean_date;
mod sys_import;
mod vault;
mod vault_list;
mod workspace;

use ai_router::start_claude_cli_invocation;
use anchor_dir::{
    bootstrap_anchor_dir, delete_anchor_rule, delete_anchor_template, list_anchor_rules,
    list_anchor_templates, read_anchor_imports, read_anchor_mcp, read_anchor_projects,
    read_anchor_rule, read_anchor_skills, read_anchor_template, read_anchor_workspace,
    save_anchor_mcp, save_anchor_projects, save_anchor_rule, save_anchor_skills,
    save_anchor_template, update_anchor_workspace,
};
use document::{
    create_document, create_version, read_document, save_document, update_frontmatter_field,
};
use git::{git_changes, git_commit, git_diff, git_status, git_status_fast};
use gmail_gws::fetch_gmail_unread;
use inbox::scan_inbox_drop;
use inbox_classifier::{build_inbox_classification_prompt, parse_inbox_classification};
use inbox_watcher::{start_inbox_watcher, stop_inbox_watcher, InboxWatcherState};
use korean_date::parse_korean_date_cmd;
use sys_import::{apply_sys_import, plan_sys_import};
use vault::{default_vault_path, read_vault_cache, sample_vault_path, scan_vault};
use vault_list::{add_vault, list_vaults, remove_vault, set_active_vault};
use workspace::{
    detect_workspace, list_workspaces, read_workspace_config, register_workspace_pair,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(InboxWatcherState::default())
        .invoke_handler(tauri::generate_handler![
            default_vault_path,
            sample_vault_path,
            scan_vault,
            read_vault_cache,
            read_document,
            save_document,
            create_document,
            create_version,
            update_frontmatter_field,
            list_vaults,
            add_vault,
            remove_vault,
            set_active_vault,
            git_status,
            git_status_fast,
            git_commit,
            git_changes,
            git_diff,
            scan_inbox_drop,
            start_inbox_watcher,
            stop_inbox_watcher,
            parse_korean_date_cmd,
            start_claude_cli_invocation,
            build_inbox_classification_prompt,
            parse_inbox_classification,
            fetch_gmail_unread,
            // workspace pairing + .anchor/ system mode
            detect_workspace,
            read_workspace_config,
            register_workspace_pair,
            list_workspaces,
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
            read_anchor_imports,
            plan_sys_import,
            apply_sys_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Anchor");
}
