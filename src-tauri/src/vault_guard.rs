//! vault_guard — schema gate for managed vault writes (Wave 7 V2).
//!
//! maru-vault-graph-spec §2.4/§3 F1: when a workspace root has
//! `write_policy: "managed"`, every Anchor write to `notes/**/*.md` must pass
//! the frontmatter schema below. The rules are the V2 contract, hardcoded:
//!   - description: ≤ 200 chars (required)
//!   - type ∈ {insight, decision, observation, person, project, method, moc, reference}
//!   - domain ∈ {research, projects, teaching, operations, people, ai-practice}
//!   - topics: non-empty array, every item containing a `[[wikilink]]`
//! Unknown fields pass through untouched — a frontmatter field carrying a
//! wikilink IS a relation (vault README principle); validation must not strip
//! or reject it. Files outside `notes/` (log.md, reports/, templates/) are
//! not schema-validated (log.md append stays an MCP-domain practice).

use serde::Serialize;

use crate::vault::parse_frontmatter;
use crate::vault_list::load_registry;

pub const VAULT_NOTE_TYPES: [&str; 8] = [
    "insight", "decision", "observation", "person",
    "project", "method", "moc", "reference",
];
pub const VAULT_NOTE_DOMAINS: [&str; 6] = [
    "research", "projects", "teaching", "operations", "people", "ai-practice",
];
const DESCRIPTION_MAX: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSchemaIssue {
    pub field: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSchemaReport {
    pub valid: bool,
    pub issues: Vec<VaultSchemaIssue>,
}

fn is_vault_note(rel_path: &str) -> bool {
    let normalized = rel_path.trim_start_matches("./");
    normalized.starts_with("notes/") && normalized.to_lowercase().ends_with(".md")
}

fn issue(field: &str, code: &str, message: String) -> VaultSchemaIssue {
    VaultSchemaIssue {
        field: field.to_string(),
        code: code.to_string(),
        message,
    }
}

fn validate_note_content(content: &str) -> VaultSchemaReport {
    use serde_yaml::Value;
    let parts = parse_frontmatter(content);
    let meta = &parts.meta;
    let mut issues: Vec<VaultSchemaIssue> = Vec::new();

    match meta.get("description") {
        Some(Value::String(s)) if !s.trim().is_empty() => {
            if s.chars().count() > DESCRIPTION_MAX {
                issues.push(issue(
                    "description",
                    "too_long",
                    format!(
                        "description is {} chars (max {DESCRIPTION_MAX})",
                        s.chars().count()
                    ),
                ));
            }
        }
        _ => issues.push(issue(
            "description",
            "missing",
            "description is required (≤200 chars prose)".to_string(),
        )),
    }

    match meta.get("type") {
        Some(Value::String(s)) if VAULT_NOTE_TYPES.contains(&s.as_str()) => {}
        Some(Value::String(s)) => issues.push(issue(
            "type",
            "invalid_enum",
            format!("type '{s}' is not one of {VAULT_NOTE_TYPES:?}"),
        )),
        _ => issues.push(issue(
            "type",
            "missing",
            format!("type is required, one of {VAULT_NOTE_TYPES:?}"),
        )),
    }

    match meta.get("domain") {
        Some(Value::String(s)) if VAULT_NOTE_DOMAINS.contains(&s.as_str()) => {}
        Some(Value::String(s)) => issues.push(issue(
            "domain",
            "invalid_enum",
            format!("domain '{s}' is not one of {VAULT_NOTE_DOMAINS:?}"),
        )),
        _ => issues.push(issue(
            "domain",
            "missing",
            format!("domain is required, one of {VAULT_NOTE_DOMAINS:?}"),
        )),
    }

    match meta.get("topics") {
        Some(Value::Sequence(items)) if !items.is_empty() => {
            let all_wikilinks = items.iter().all(|item| {
                matches!(item, Value::String(s) if s.contains("[[") && s.contains("]]"))
            });
            if !all_wikilinks {
                issues.push(issue(
                    "topics",
                    "not_wikilink",
                    "every topics item must contain a [[MOC]] wikilink".to_string(),
                ));
            }
        }
        _ => issues.push(issue(
            "topics",
            "missing",
            "topics is required: a non-empty array of [[MOC]] wikilinks".to_string(),
        )),
    }

    VaultSchemaReport {
        valid: issues.is_empty(),
        issues,
    }
}

/// Stateless schema check for the editor validation strip (500ms debounce).
/// Paths outside `notes/**/*.md` always report valid (no schema there).
#[tauri::command]
pub fn vault_validate_note(content: String, rel_path: String) -> Result<VaultSchemaReport, String> {
    if !is_vault_note(&rel_path) {
        return Ok(VaultSchemaReport {
            valid: true,
            issues: Vec::new(),
        });
    }
    Ok(validate_note_content(&content))
}

/// Whether a workspace root is registered with `write_policy: "managed"`.
/// Drives the snapshot-before-overwrite behavior in document.rs.
pub fn is_managed_root(vault_path: &str) -> bool {
    load_registry()
        .map(|registry| {
            registry
                .workspaces
                .iter()
                .any(|w| w.path == vault_path && w.write_policy == "managed")
        })
        .unwrap_or(false)
}

/// Central managed-write gate — called from document.rs write commands at the
/// existing assert_anchor_can_write sites. No-op unless the workspace root is
/// registered with `write_policy: "managed"` AND the target is a vault note.
pub fn validate_managed_write(
    vault_path: &str,
    document_path: &str,
    content: &str,
) -> Result<(), String> {
    let registry = load_registry()?;
    let is_managed = registry
        .workspaces
        .iter()
        .any(|workspace| workspace.path == vault_path && workspace.write_policy == "managed");
    if !is_managed || !is_vault_note(document_path) {
        return Ok(());
    }
    let report = validate_note_content(content);
    if report.valid {
        return Ok(());
    }
    let detail = report
        .issues
        .iter()
        .map(|i| format!("{}: {}", i.field, i.message))
        .collect::<Vec<_>>()
        .join("; ");
    Err(format!("Managed vault schema check failed — {detail}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_NOTE: &str = "---\ndescription: 관리형 저장 경로가 스키마를 검증하는지 확인하는 노트\ntype: insight\ndomain: operations\ntopics:\n  - \"[[operations]]\"\nextra_field: \"[[free-relation]]\"\n---\n\n# 본문\n";

    #[test]
    fn valid_korean_note_passes() {
        let report = vault_validate_note(VALID_NOTE.to_string(), "notes/a.md".to_string()).unwrap();
        assert!(report.valid, "issues: {:?}", report.issues);
    }

    #[test]
    fn missing_domain_reports_structured_issue() {
        let content = VALID_NOTE.replace("domain: operations\n", "");
        let report = vault_validate_note(content, "notes/a.md".to_string()).unwrap();
        assert!(!report.valid);
        let domain = report.issues.iter().find(|i| i.field == "domain").unwrap();
        assert_eq!(domain.code, "missing");
    }

    #[test]
    fn invalid_type_enum_rejected() {
        let content = VALID_NOTE.replace("type: insight", "type: meeting");
        let report = vault_validate_note(content, "notes/a.md".to_string()).unwrap();
        assert!(report.issues.iter().any(|i| i.field == "type" && i.code == "invalid_enum"));
    }

    #[test]
    fn overlong_description_rejected() {
        let long = "가".repeat(201);
        let content = VALID_NOTE.replace(
            "관리형 저장 경로가 스키마를 검증하는지 확인하는 노트",
            &long,
        );
        let report = vault_validate_note(content, "notes/a.md".to_string()).unwrap();
        assert!(report.issues.iter().any(|i| i.field == "description" && i.code == "too_long"));
    }

    #[test]
    fn empty_topics_rejected() {
        let content = VALID_NOTE.replace("topics:\n  - \"[[operations]]\"\n", "topics: []\n");
        let report = vault_validate_note(content, "notes/a.md".to_string()).unwrap();
        assert!(report.issues.iter().any(|i| i.field == "topics"));
    }

    #[test]
    fn non_wikilink_topics_rejected() {
        let content = VALID_NOTE.replace("[[operations]]", "operations");
        let report = vault_validate_note(content, "notes/a.md".to_string()).unwrap();
        assert!(report.issues.iter().any(|i| i.field == "topics" && i.code == "not_wikilink"));
    }

    #[test]
    fn paths_outside_notes_skip_validation() {
        let report = vault_validate_note("no frontmatter".to_string(), "log.md".to_string()).unwrap();
        assert!(report.valid);
        let report =
            vault_validate_note("junk".to_string(), "templates/decision-note.md".to_string())
                .unwrap();
        assert!(report.valid);
    }

    #[test]
    fn unmanaged_workspace_is_noop() {
        // A path that is not in the registry (temp dirs never are) → Ok even
        // with invalid content — the gate only arms for managed roots.
        let result = validate_managed_write("/tmp/not-registered", "notes/a.md", "junk");
        assert!(result.is_ok());
    }
}
