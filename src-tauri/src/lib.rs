mod ai_router;
mod document;
mod filename_rules;
mod frontmatter;
mod git;
mod gmail_gws;
mod inbox;
mod inbox_classifier;
mod inbox_watcher;
mod korean_date;
mod vault;
mod vault_list;

use ai_router::start_claude_cli_invocation;
use document::{
    create_document, create_version, read_document, save_document, update_frontmatter_field,
};
use git::{git_changes, git_commit, git_diff, git_status};
use gmail_gws::fetch_gmail_unread;
use inbox::scan_inbox_drop;
use inbox_classifier::{build_inbox_classification_prompt, parse_inbox_classification};
use inbox_watcher::{start_inbox_watcher, stop_inbox_watcher, InboxWatcherState};
use korean_date::parse_korean_date_cmd;
use vault::{default_vault_path, sample_vault_path, scan_vault};
use vault_list::{add_vault, list_vaults, remove_vault, set_active_vault};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(InboxWatcherState::default())
        .invoke_handler(tauri::generate_handler![
            default_vault_path,
            sample_vault_path,
            scan_vault,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Anchor");
}
