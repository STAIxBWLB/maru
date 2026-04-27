mod document;
mod filename_rules;
mod frontmatter;
mod git;
mod vault;
mod vault_list;

use document::{
    create_document, create_version, read_document, save_document, update_frontmatter_field,
};
use git::{git_changes, git_commit, git_status};
use vault::{default_vault_path, sample_vault_path, scan_vault};
use vault_list::{add_vault, list_vaults, remove_vault, set_active_vault};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Anchor");
}
