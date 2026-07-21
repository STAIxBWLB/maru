use crate::binary_viewer::require_existing_file;
use crate::vault::resolve_inside_vault;
use crate::vault_list::assert_document_owner;
use serde::Serialize;
use std::ffi::OsStr;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareHtmlEditorAssetsResponse {
    pub document_directory: String,
}

/// Validation half of `prepare_html_editor_assets`: resolve the document
/// inside the vault, require an existing .html/.htm file owned by the caller,
/// and return the canonical directory that relative asset URLs resolve
/// against. Split out so unit tests can run without an `AppHandle`.
fn resolve_html_editor_document_directory(
    vault_path: &str,
    document_path: &str,
) -> Result<PathBuf, String> {
    let path = resolve_inside_vault(vault_path, document_path)?;
    require_existing_file(&path)?;
    let extension = path
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("html" | "htm")) {
        return Err(
            "prepare_html_editor_assets only supports .html/.htm documents".to_string(),
        );
    }
    assert_document_owner(vault_path, &path)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Document has no parent directory".to_string())?;
    parent
        .canonicalize()
        .map_err(|err| format!("Cannot resolve document directory: {err}"))
}

#[tauri::command]
pub fn prepare_html_editor_assets(
    app: tauri::AppHandle,
    vault_path: String,
    document_path: String,
) -> Result<PrepareHtmlEditorAssetsResponse, String> {
    let dir = resolve_html_editor_document_directory(&vault_path, &document_path)?;
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|err| format!("Cannot allow editor assets: {err}"))?;
    Ok(PrepareHtmlEditorAssetsResponse {
        document_directory: dir.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn rejects_non_html_extension() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        fs::write(tmp.path().join("note.md"), "# Note\n").unwrap();

        let error = resolve_html_editor_document_directory(&root, "note.md").unwrap_err();

        assert_eq!(
            error,
            "prepare_html_editor_assets only supports .html/.htm documents"
        );
    }

    #[test]
    fn rejects_path_escaping_vault() {
        let vault_tmp = TempDir::new().unwrap();
        let root = vault_tmp.path().to_string_lossy().to_string();
        let outside_tmp = TempDir::new().unwrap();
        fs::write(outside_tmp.path().join("outside.html"), "<html></html>").unwrap();
        let escape_target = format!(
            "../{}/outside.html",
            outside_tmp.path().file_name().unwrap().to_string_lossy()
        );

        let error = resolve_html_editor_document_directory(&root, &escape_target).unwrap_err();

        assert!(error.contains("escapes"), "unexpected error: {error}");
    }

    #[test]
    fn accepts_uppercase_html_extension() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let docs = tmp.path().join("docs");
        fs::create_dir_all(&docs).unwrap();
        fs::write(docs.join("page.HTML"), "<html></html>").unwrap();

        let dir = resolve_html_editor_document_directory(&root, "docs/page.HTML").unwrap();

        assert_eq!(dir, docs.canonicalize().unwrap());
    }

    #[test]
    fn rejects_missing_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        let error = resolve_html_editor_document_directory(&root, "gone.html").unwrap_err();

        assert!(error.contains("does not exist"), "unexpected error: {error}");
    }
}
