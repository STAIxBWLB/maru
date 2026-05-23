use crate::vault::normalize_existing_dir;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GaejosikLintIssue {
    pub id: String,
    pub rule: String,
    pub severity: String,
    pub line: u32,
    pub column: u32,
    pub end_column: u32,
    pub text: String,
    pub message: String,
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GaejosikLintResponse {
    #[serde(default)]
    pub issues: Vec<GaejosikLintIssue>,
    pub dismissed_count: u32,
}

#[derive(Debug, Clone)]
struct RuleMatch {
    rule: &'static str,
    message: &'static str,
    suggestion: &'static str,
    suffix: String,
}

#[tauri::command]
pub fn gaejosik_lint(
    work_path: String,
    body_markdown: String,
    #[allow(non_snake_case)] dismissed_ids: Vec<String>,
) -> Result<GaejosikLintResponse, String> {
    let _workspace = normalize_existing_dir(&work_path)?;
    Ok(lint_markdown(&body_markdown, &dismissed_ids))
}

fn lint_markdown(markdown: &str, dismissed_ids: &[String]) -> GaejosikLintResponse {
    let dismissed: HashSet<&str> = dismissed_ids.iter().map(String::as_str).collect();
    let mut issues = Vec::new();
    let mut dismissed_count = 0;
    let mut in_code_fence = false;
    let mut in_frontmatter = markdown
        .lines()
        .next()
        .is_some_and(|line| line.trim() == "---");

    for (index, line) in markdown.lines().enumerate() {
        let line_number = (index + 1) as u32;
        let trimmed = line.trim();
        if index > 0 && in_frontmatter && trimmed == "---" {
            in_frontmatter = false;
            continue;
        }
        if in_frontmatter {
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_fence = !in_code_fence;
            continue;
        }
        if in_code_fence || should_skip_line(trimmed) {
            continue;
        }

        let Some(rule_match) = match_line(line) else {
            continue;
        };
        let line_char_count = line.chars().count() as u32;
        let suffix_len = rule_match.suffix.chars().count() as u32;
        let column = line_char_count.saturating_sub(suffix_len).saturating_add(1);
        let id = issue_id(rule_match.rule, line_number, column, line);
        if dismissed.contains(id.as_str()) {
            dismissed_count += 1;
            continue;
        }
        issues.push(GaejosikLintIssue {
            id,
            rule: rule_match.rule.to_string(),
            severity: "warning".to_string(),
            line: line_number,
            column,
            end_column: line_char_count.saturating_add(1),
            text: rule_match.suffix,
            message: rule_match.message.to_string(),
            suggestion: rule_match.suggestion.to_string(),
        });
    }

    GaejosikLintResponse {
        issues,
        dismissed_count,
    }
}

fn should_skip_line(trimmed: &str) -> bool {
    trimmed.is_empty()
        || trimmed.starts_with('#')
        || trimmed.starts_with('|')
        || trimmed.starts_with('>')
        || trimmed == "---"
        || trimmed
            .chars()
            .all(|ch| ch == '-' || ch == ':' || ch == '|')
}

fn match_line(line: &str) -> Option<RuleMatch> {
    let stripped = strip_markdown_prefix(line).trim_end();
    if stripped.is_empty() {
        return None;
    }
    let core = stripped
        .trim_end_matches(|ch: char| matches!(ch, '.' | '。' | '!' | '?' | ')' | ']' | '"' | '\''));
    if core.is_empty() {
        return None;
    }

    for ending in [
        "하였습니다",
        "되었습니다",
        "했습니다",
        "됩니다",
        "합니다",
        "있습니다",
        "없습니다",
        "드립니다",
        "입니다",
        "였습니다",
    ] {
        if core.ends_with(ending) {
            return Some(RuleMatch {
                rule: "formalVerbEnding",
                message: "격식체 문장 종결은 개조식 문서에서 눈에 띕니다.",
                suggestion: "명사형 종결(예: 추진, 완료, 필요) 또는 함/임/됨으로 정리",
                suffix: ending.to_string(),
            });
        }
    }

    if core.ends_with('다') {
        return Some(RuleMatch {
            rule: "declarativeEnding",
            message: "서술형 종결은 개조식 톤과 맞지 않습니다.",
            suggestion: "문장 끝을 명사형 또는 함/임/됨 형태로 축약",
            suffix: "다".to_string(),
        });
    }

    None
}

fn strip_markdown_prefix(line: &str) -> &str {
    let trimmed = line.trim_start();
    let without_checkbox = trimmed
        .strip_prefix("- [ ] ")
        .or_else(|| trimmed.strip_prefix("- [x] "))
        .or_else(|| trimmed.strip_prefix("- [X] "));
    if let Some(value) = without_checkbox {
        return value;
    }
    if let Some(value) = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("+ "))
    {
        return value;
    }
    if let Some(dot_index) = trimmed.find(". ") {
        if trimmed[..dot_index].chars().all(|ch| ch.is_ascii_digit()) {
            return &trimmed[dot_index + 2..];
        }
    }
    trimmed
}

fn issue_id(rule: &str, line: u32, column: u32, text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(rule.as_bytes());
    hasher.update(line.to_le_bytes());
    hasher.update(column.to_le_bytes());
    hasher.update(text.trim().as_bytes());
    let hash = hasher.finalize();
    format!("{hash:x}").chars().take(16).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_sentence_and_formal_endings() {
        let report = lint_markdown("- 추진합니다.\n- 완료됨\n문장이다", &[]);
        assert_eq!(report.issues.len(), 2);
        assert_eq!(report.issues[0].rule, "formalVerbEnding");
        assert_eq!(report.issues[1].rule, "declarativeEnding");
    }

    #[test]
    fn skips_code_fences_frontmatter_and_nominal_endings() {
        let report = lint_markdown(
            "---\ntitle: 테스트입니다\n---\n```text\n테스트입니다\n```\n- 완료됨\n",
            &[],
        );
        assert!(report.issues.is_empty());
    }

    #[test]
    fn honors_dismissals() {
        let first = lint_markdown("추진합니다", &[]);
        let dismissed = lint_markdown("추진합니다", &[first.issues[0].id.clone()]);
        assert!(dismissed.issues.is_empty());
        assert_eq!(dismissed.dismissed_count, 1);
    }
}
