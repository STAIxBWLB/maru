use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::json;

use crate::inbox_settings;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageOutcome {
    pub message_id: String,
    pub channel: String,
    pub provider: String,
    pub target_path: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthStatus {
    pub provider: String,
    pub state: String,
    pub detail: Option<String>,
    pub cli_path: Option<String>,
    pub account: Option<String>,
}

pub fn stage_message_json<T: Serialize>(
    work: &Path,
    channel: &str,
    provider: &str,
    id: &str,
    message: &T,
) -> Result<String, String> {
    let config = inbox_settings::load_runtime_config_or_legacy(work)?;
    let root = inbox_settings::resolve_runtime_root(work, &config)?;
    let drop_path = config
        .channels
        .get(channel)
        .and_then(|channel| channel.drop_paths.first())
        .cloned()
        .unwrap_or_else(|| format!("drop/{channel}"));
    let target_dir = inbox_settings::lexical_normalize_path(&root.join(&drop_path));
    if !target_dir.starts_with(&root) {
        return Err(format!("drop_path_outside_inbox: {drop_path}"));
    }
    fs::create_dir_all(&target_dir)
        .map_err(|err| format!("Cannot create {}: {err}", target_dir.to_string_lossy()))?;
    let stamp = timestamp_for_filename();
    let name = sanitize_filename(&format!("{stamp}-{provider}-{id}.json"));
    let target = target_dir.join(name);
    let payload = serde_json::to_vec_pretty(&json!({
        "provider": provider,
        "kind": "message",
        "message": message,
    }))
    .map_err(|err| format!("{provider}_payload_failed: {err}"))?;
    fs::write(&target, payload)
        .map_err(|err| format!("Cannot write {}: {err}", target.to_string_lossy()))?;
    Ok(target.to_string_lossy().to_string())
}

pub fn stage_message_outcome<T: Serialize>(
    work: &Path,
    channel: &str,
    provider: &str,
    id: &str,
    message: &T,
) -> StageOutcome {
    match stage_message_json(work, channel, provider, id, message) {
        Ok(path) => StageOutcome {
            message_id: id.to_string(),
            channel: channel.to_string(),
            provider: provider.to_string(),
            target_path: Some(path),
            ok: true,
            error: None,
        },
        Err(err) => StageOutcome {
            message_id: id.to_string(),
            channel: channel.to_string(),
            provider: provider.to_string(),
            target_path: None,
            ok: false,
            error: Some(err),
        },
    }
}

pub fn timestamp_for_filename() -> String {
    let now: DateTime<Utc> = SystemTime::now().into();
    now.format("%Y%m%dT%H%M%SZ").to_string()
}

pub fn sanitize_filename(input: &str) -> String {
    input
        .chars()
        .map(|ch| match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' => ch,
            _ => '-',
        })
        .collect()
}

pub fn auth_status(
    provider: &str,
    state: &str,
    detail: Option<String>,
    cli_path: Option<PathBuf>,
    account: Option<String>,
) -> ProviderAuthStatus {
    ProviderAuthStatus {
        provider: provider.to_string(),
        state: state.to_string(),
        detail,
        cli_path: cli_path.map(|path| path.to_string_lossy().to_string()),
        account,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn stage_message_json_lands_in_resolved_drop() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("workspace.config.yaml"),
            r#"
inbox:
  root: inbox
  paths:
    drop: drop
    items: items
    pending: items/pending
    done: items/done
    failed: items/failed
    duplicate: items/duplicate
    state: _state
    receipts: _state/index.jsonl
  naming:
    item_id_template: "{date}-{channel}-{slug}"
    raw_dir: raw
    manifest_file: manifest.yaml
    extracted_file: extracted.md
    summary_file: summary.md
    route_file: route.md
  file_drop:
    channel: incoming
    drop_path: drop/incoming
    operation: copy
  channels:
    gws:
      provider: gws
      skill: io-gws
      kind: bundle
      drop_paths: [drop/gws]
      dedupe: provider-id
"#,
        )
        .unwrap();
        let path = stage_message_json(
            tmp.path(),
            "gws",
            "gws",
            "msg/1",
            &json!({"id": "msg/1", "subject": "Hello"}),
        )
        .unwrap();
        assert!(path.contains("/inbox/drop/gws/"));
        let raw = fs::read_to_string(path).unwrap();
        assert!(raw.contains("\"provider\": \"gws\""));
        assert!(raw.contains("\"kind\": \"message\""));
    }

    #[test]
    fn stage_message_json_rejects_drop_escape() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("workspace.config.yaml"),
            r#"
inbox:
  root: inbox
  channels:
    gws:
      provider: gws
      kind: bundle
      drop_paths: ["../escape"]
      dedupe: provider-id
"#,
        )
        .unwrap();
        let err =
            stage_message_json(tmp.path(), "gws", "gws", "1", &json!({"id": "1"})).unwrap_err();
        assert!(err.contains("drop_path_outside_inbox") || err.contains("inbox_path_outside_root"));
    }
}
