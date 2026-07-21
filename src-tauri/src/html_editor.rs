use crate::binary_viewer::require_existing_file;
use crate::vault::{normalize_existing_dir, resolve_inside_vault};
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
    let dir = parent
        .canonicalize()
        .map_err(|err| format!("Cannot resolve document directory: {err}"))?;
    // `resolve_inside_vault` is lexical and deliberately allows in-vault
    // symlinks that point outside (cloud-synced inbox/downloads). Canonicalizing
    // the parent follows those links, so re-assert containment against the
    // canonical vault before granting an asset-protocol read scope — otherwise a
    // symlinked directory inside the vault would hand out reads on its external
    // target (e.g. reports/ext -> ~/.ssh).
    let vault = normalize_existing_dir(vault_path)?;
    if !dir.starts_with(&vault) {
        return Err("Document directory escapes the selected workspace".to_string());
    }
    // The asset grant is recursive and app-global, so never scope it to a
    // directory that holds the `.maru` control dir (secrets) or to the vault
    // root itself: that would expose `.maru/secrets/**` (and sibling
    // workspaces) to the asset protocol. Assets alongside a document in a
    // subfolder are unaffected; a root-level document simply loads without
    // relative-asset resolution (Source/Preview are unaffected).
    if dir == vault || dir.join(".maru").is_dir() {
        return Err(
            "Cannot load assets from the workspace root; move the document into a subfolder"
                .to_string(),
        );
    }
    Ok(dir)
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

    #[test]
    fn rejects_workspace_root_document() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        fs::write(tmp.path().join("index.html"), "<html></html>").unwrap();

        let error = resolve_html_editor_document_directory(&root, "index.html").unwrap_err();

        assert!(error.contains("workspace root"), "unexpected error: {error}");
    }

    #[test]
    fn rejects_directory_holding_maru_secrets() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let space = tmp.path().join("space");
        fs::create_dir_all(space.join(".maru")).unwrap();
        fs::write(space.join("page.html"), "<html></html>").unwrap();

        let error =
            resolve_html_editor_document_directory(&root, "space/page.html").unwrap_err();

        assert!(error.contains("workspace root"), "unexpected error: {error}");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_directory_escaping_vault() {
        let vault_tmp = TempDir::new().unwrap();
        let root = vault_tmp.path().to_string_lossy().to_string();
        let outside_tmp = TempDir::new().unwrap();
        fs::write(outside_tmp.path().join("x.html"), "<html></html>").unwrap();
        // A symlinked directory inside the vault pointing outside it: lexical
        // containment passes, but canonicalizing the parent escapes the vault.
        std::os::unix::fs::symlink(outside_tmp.path(), vault_tmp.path().join("link")).unwrap();

        let error =
            resolve_html_editor_document_directory(&root, "link/x.html").unwrap_err();

        assert!(error.contains("escapes"), "unexpected error: {error}");
    }
}
