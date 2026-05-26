//! Diagram-mode workspace commands.
//!
//! Phase 0 ships **stub** commands so the Tauri binary compiles with the
//! `diagram_*` invokes registered. Real implementations land in Phase 1 and
//! Phase 4 — see `~/.claude/plans/system-instruction-you-are-working-cozy-truffle.md`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramFile {
    pub name: String,
    pub size: u64,
    pub modified_at: i64,
    pub doc_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub doc_id: String,
    pub snapshot_ts: String,
    pub size: u64,
}

fn not_implemented(name: &str) -> String {
    format!("diagram command not yet implemented: {name}")
}

#[tauri::command]
pub fn diagram_save_document(
    _workspace: String,
    _name: String,
    _body: String,
) -> Result<(), String> {
    Err(not_implemented("diagram_save_document"))
}

#[tauri::command]
pub fn diagram_load_document(
    _workspace: String,
    _name: String,
) -> Result<String, String> {
    Err(not_implemented("diagram_load_document"))
}

#[tauri::command]
pub fn diagram_list_documents(
    _workspace: String,
) -> Result<Vec<DiagramFile>, String> {
    Err(not_implemented("diagram_list_documents"))
}

#[tauri::command]
pub fn diagram_delete_document(
    _workspace: String,
    _name: String,
) -> Result<(), String> {
    Err(not_implemented("diagram_delete_document"))
}

#[tauri::command]
pub fn diagram_export_blob(
    _workspace: String,
    _name: String,
    _kind: String,
    _bytes: Vec<u8>,
) -> Result<String, String> {
    Err(not_implemented("diagram_export_blob"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stubs_return_not_implemented() {
        assert!(
            diagram_save_document("w".into(), "n".into(), "b".into())
                .unwrap_err()
                .contains("not yet implemented")
        );
        assert!(diagram_load_document("w".into(), "n".into()).is_err());
        assert!(diagram_list_documents("w".into()).is_err());
        assert!(diagram_delete_document("w".into(), "n".into()).is_err());
        assert!(diagram_export_blob("w".into(), "n".into(), "png".into(), vec![]).is_err());
    }
}
