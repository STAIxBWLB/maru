use crate::vault::{lexical_normalize, resolve_inside_vault};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxDropItem {
    pub id: String,
    pub path: String,
    pub rel_path: String,
    pub title: String,
    pub source: String,
    pub size_bytes: u64,
    pub received_at: Option<String>,
}

#[tauri::command]
pub fn scan_inbox_drop(vault_path: String) -> Result<Vec<InboxDropItem>, String> {
    let vault = resolve_inside_vault(&vault_path, ".")?;
    let inbox_root = resolve_inside_vault(&vault_path, "inbox/downloads")?;
    if !inbox_root.exists() {
        return Ok(Vec::new());
    }
    if !inbox_root.is_dir() {
        return Err("inbox/downloads exists but is not a directory".to_string());
    }

    let mut items = Vec::new();
    for entry in WalkDir::new(&inbox_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = lexical_normalize(entry.path());
        let metadata =
            fs::metadata(&path).map_err(|err| format!("Cannot read inbox item metadata: {err}"))?;
        let rel_path = path
            .strip_prefix(&vault)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        let source = path
            .parent()
            .and_then(|parent| parent.strip_prefix(&inbox_root).ok())
            .and_then(|rel| rel.components().next())
            .and_then(|component| component.as_os_str().to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("downloads")
            .to_string();
        let title = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Untitled")
            .to_string();
        let received_at = metadata
            .modified()
            .ok()
            .map(DateTime::<Utc>::from)
            .map(|dt| dt.to_rfc3339());
        items.push(InboxDropItem {
            id: rel_path.clone(),
            path: path.to_string_lossy().to_string(),
            rel_path,
            title,
            source,
            size_bytes: metadata.len(),
            received_at,
        });
    }

    items.sort_by(|a, b| {
        b.received_at
            .cmp(&a.received_at)
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn scan_inbox_drop_returns_empty_when_folder_is_absent() {
        let tmp = TempDir::new().unwrap();
        let items = scan_inbox_drop(tmp.path().to_string_lossy().to_string()).unwrap();

        assert!(items.is_empty());
    }

    #[test]
    fn scan_inbox_drop_finds_nested_source_files() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("inbox/downloads/gmail")).unwrap();
        fs::write(root.join("inbox/downloads/gmail/report.pdf"), b"pdf").unwrap();

        let items = scan_inbox_drop(root.to_string_lossy().to_string()).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].source, "gmail");
        assert_eq!(items[0].rel_path, "inbox/downloads/gmail/report.pdf");
        assert_eq!(items[0].size_bytes, 3);
    }
}
