mod ai;
mod document;
mod vault;

use ai::generate_ai_draft;
use document::{create_document, create_version, read_document, save_document};
use vault::{default_vault_path, sample_vault_path, scan_vault};

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
            generate_ai_draft,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Anchor");
}
