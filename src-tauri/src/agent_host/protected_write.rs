use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

use crate::agent_host::contracts::PROTECTED_WRITE_CLAIM_SCHEMA_VERSION;
use crate::vault::resolve_inside_vault;
use crate::vault_guard::validate_managed_write;
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedWriteClaim {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_hash: Option<String>,
    pub operation: String,
    pub actor: String,
    pub reason: String,
    pub schema_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedWriteOutcome {
    pub path: String,
    pub operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub committed_hash: Option<String>,
}

impl ProtectedWriteClaim {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != PROTECTED_WRITE_CLAIM_SCHEMA_VERSION {
            return Err(format!(
                "protected_write_schema_unsupported: {}",
                self.schema_version
            ));
        }
        if self.path.trim().is_empty() {
            return Err("protected_write_path_required".to_string());
        }
        if self.actor.trim().is_empty() {
            return Err("protected_write_actor_required".to_string());
        }
        if self.reason.trim().is_empty() {
            return Err("protected_write_reason_required".to_string());
        }
        match self.operation.as_str() {
            "create" | "replace" | "append" | "delete" => Ok(()),
            other => Err(format!("protected_write_operation_unsupported: {other}")),
        }
    }
}

pub fn apply_protected_write_claim(
    cwd: &str,
    claim: &ProtectedWriteClaim,
    content: Option<&str>,
) -> Result<ProtectedWriteOutcome, String> {
    claim.validate()?;
    let target = resolve_inside_vault(cwd, &claim.path)?;
    let exists = target.exists();
    let previous_hash = if exists {
        Some(file_sha256_hex(&target)?)
    } else {
        None
    };
    if let Some(expected) = claim.expected_hash.as_deref() {
        if previous_hash.as_deref() != Some(expected) {
            return Err(format!(
                "write_conflict: expected {}, got {}",
                expected,
                previous_hash.as_deref().unwrap_or("<missing>")
            ));
        }
    }

    match claim.operation.as_str() {
        "create" => {
            assert_maru_can_write(cwd, WorkspaceWriteAction::Create)?;
            if exists {
                return Err("write_conflict: target_exists".to_string());
            }
            let next = content.ok_or_else(|| "write_content_required".to_string())?;
            validate_managed_write(cwd, &target.to_string_lossy(), next)?;
            write_content(&target, next)?;
        }
        "replace" => {
            assert_maru_can_write(cwd, WorkspaceWriteAction::Modify)?;
            let next = content.ok_or_else(|| "write_content_required".to_string())?;
            validate_managed_write(cwd, &target.to_string_lossy(), next)?;
            write_content(&target, next)?;
        }
        "append" => {
            assert_maru_can_write(cwd, WorkspaceWriteAction::Modify)?;
            let existing = if exists {
                fs::read_to_string(&target).map_err(|err| format!("Cannot read target: {err}"))?
            } else {
                String::new()
            };
            let mut next = existing;
            next.push_str(content.ok_or_else(|| "write_content_required".to_string())?);
            validate_managed_write(cwd, &target.to_string_lossy(), &next)?;
            write_content(&target, &next)?;
        }
        "delete" => {
            assert_maru_can_write(cwd, WorkspaceWriteAction::Delete)?;
            if exists {
                fs::remove_file(&target).map_err(|err| format!("Cannot delete target: {err}"))?;
            }
        }
        _ => unreachable!("validated operation"),
    }

    let committed_hash = if target.exists() {
        Some(file_sha256_hex(&target)?)
    } else {
        None
    };
    Ok(ProtectedWriteOutcome {
        path: target.to_string_lossy().to_string(),
        operation: claim.operation.clone(),
        previous_hash,
        committed_hash,
    })
}

pub fn file_sha256_hex(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|err| format!("Cannot read file for hash: {err}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn write_content(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Cannot create parent: {err}"))?;
    }
    let tmp = path.with_extension("maru-write.tmp");
    fs::write(&tmp, content).map_err(|err| format!("Cannot write temp file: {err}"))?;
    replace_file(&tmp, path)
}

#[cfg(windows)]
fn replace_file(tmp: &Path, path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path)
            .map_err(|err| format!("Cannot prepare protected write target: {err}"))?;
    }
    fs::rename(tmp, path).map_err(|err| format!("Cannot commit protected write: {err}"))
}

#[cfg(not(windows))]
fn replace_file(tmp: &Path, path: &Path) -> Result<(), String> {
    fs::rename(tmp, path).map_err(|err| format!("Cannot commit protected write: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn protected_write_rejects_hash_conflict() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("a.md");
        fs::write(&path, "old").unwrap();
        let claim = ProtectedWriteClaim {
            path: "a.md".to_string(),
            expected_hash: Some("bad".to_string()),
            operation: "replace".to_string(),
            actor: "test".to_string(),
            reason: "unit".to_string(),
            schema_version: PROTECTED_WRITE_CLAIM_SCHEMA_VERSION.to_string(),
        };
        let err = apply_protected_write_claim(&tmp.path().to_string_lossy(), &claim, Some("new"))
            .unwrap_err();
        assert!(err.starts_with("write_conflict"));
        assert_eq!(fs::read_to_string(path).unwrap(), "old");
    }

    #[test]
    fn protected_write_commits_when_hash_matches() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("a.md");
        fs::write(&path, "old").unwrap();
        let hash = file_sha256_hex(&path).unwrap();
        let claim = ProtectedWriteClaim {
            path: "a.md".to_string(),
            expected_hash: Some(hash),
            operation: "replace".to_string(),
            actor: "test".to_string(),
            reason: "unit".to_string(),
            schema_version: PROTECTED_WRITE_CLAIM_SCHEMA_VERSION.to_string(),
        };
        let outcome =
            apply_protected_write_claim(&tmp.path().to_string_lossy(), &claim, Some("new"))
                .unwrap();
        assert!(outcome.committed_hash.is_some());
        assert_eq!(fs::read_to_string(path).unwrap(), "new");
    }

    #[test]
    fn protected_write_into_managed_vault_note_requires_valid_schema() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let tmp = TempDir::new().unwrap();
        crate::scratchpad::phase08_08::registry(tmp.path(), "managed");
        let cwd = tmp.path().to_string_lossy().to_string();
        let claim = |path: String| ProtectedWriteClaim {
            path,
            expected_hash: None,
            operation: "create".to_string(),
            actor: "test".to_string(),
            reason: "unit".to_string(),
            schema_version: PROTECTED_WRITE_CLAIM_SCHEMA_VERSION.to_string(),
        };

        let err = apply_protected_write_claim(
            &cwd,
            &claim("notes/x.md".to_string()),
            Some("no frontmatter"),
        )
        .unwrap_err();
        assert!(err.contains("Managed vault schema check failed"), "{err}");
        assert!(!tmp.path().join("notes/x.md").exists());

        // Absolute claim paths still hit the gate. resolve_inside_vault works
        // against the canonical vault root, so build the path from it.
        let abs = tmp
            .path()
            .canonicalize()
            .unwrap()
            .join("notes/abs.md")
            .to_string_lossy()
            .to_string();
        let err = apply_protected_write_claim(&cwd, &claim(abs), Some("no frontmatter"))
            .unwrap_err();
        assert!(err.contains("Managed vault schema check failed"), "{err}");

        // Valid notes still write; non-note paths stay ungated.
        let valid = "---\ndescription: 보호된 쓰기 노트\ntype: insight\ndomain: operations\ntopics:\n  - \"[[operations]]\"\n---\n# Body\n";
        apply_protected_write_claim(&cwd, &claim("notes/ok.md".to_string()), Some(valid))
            .unwrap();
        apply_protected_write_claim(&cwd, &claim("inbox/x.md".to_string()), Some("junk"))
            .unwrap();
    }
}
