// Lifted from tolaria/src-tauri/src/frontmatter/mod.rs (adapted: removed
// gray_matter from non-test paths). Source: https://github.com/refactoringhq/tolaria
//
// Public API for editing frontmatter in markdown files while preserving
// YAML key order, comments, and surrounding whitespace. The line-by-line
// strategy in ops.rs is the load-bearing invariant — naive serde_yaml
// round-trip would alphabetize keys and drop comments.

mod ops;
#[cfg(test)]
mod ops_update_tests;
mod yaml;

use std::fs;
use std::path::Path;

pub use ops::update_frontmatter_content;
pub use yaml::{format_yaml_field, FrontmatterValue};

/// Helper to read a file, apply a frontmatter transformation, and write back.
pub fn with_frontmatter<F>(path: &str, transform: F) -> Result<String, String>
where
    F: FnOnce(&str) -> Result<String, String>,
{
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("File does not exist: {}", path));
    }

    let content =
        fs::read_to_string(file_path).map_err(|e| format!("Failed to read {}: {}", path, e))?;

    let updated = transform(&content)?;

    fs::write(file_path, &updated).map_err(|e| format!("Failed to write {}: {}", path, e))?;

    Ok(updated)
}

/// Update a single frontmatter property in a markdown file.
#[allow(dead_code)]
pub fn update_frontmatter(
    path: &str,
    key: &str,
    value: FrontmatterValue,
) -> Result<String, String> {
    with_frontmatter(path, |content| {
        update_frontmatter_content(content, key, Some(value.clone()))
    })
}

/// Delete a frontmatter property from a markdown file.
#[allow(dead_code)]
pub fn delete_frontmatter_property(path: &str, key: &str) -> Result<String, String> {
    with_frontmatter(path, |content| {
        update_frontmatter_content(content, key, None)
    })
}

/// Build a complete document with frontmatter from an ordered list of
/// (key, value) pairs and a body. Preserves the authored key order — unlike
/// serde_yaml's BTreeMap serialization which alphabetizes keys. Use this
/// when creating brand new documents; for updates to existing documents
/// use `update_frontmatter_content`.
pub fn build_frontmatter(fields: &[(&str, FrontmatterValue)], body: &str) -> String {
    let mut lines = vec!["---".to_string()];
    for (key, value) in fields {
        lines.extend(format_yaml_field(key, value));
    }
    lines.push("---".to_string());
    let trimmed_body = body.trim_start_matches('\n');
    if trimmed_body.is_empty() {
        format!("{}\n", lines.join("\n"))
    } else {
        format!("{}\n{}", lines.join("\n"), trimmed_body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_with_frontmatter_file_not_found() {
        let result = with_frontmatter("/nonexistent/path/file.md", |c| Ok(c.to_string()));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not exist"));
    }

    #[test]
    fn test_roundtrip_update_string() {
        let content = "---\nStatus: Draft\n---\n# Test\n";
        let updated = update_frontmatter_content(
            content,
            "Status",
            Some(FrontmatterValue::String("Active".to_string())),
        )
        .unwrap();
        assert!(updated.contains("Status: Active"));
        assert!(!updated.contains("Status: Draft"));
    }

    #[test]
    fn test_roundtrip_update_list() {
        let content = "---\nStatus: Draft\n---\n# Test\n";
        let updated = update_frontmatter_content(
            content,
            "aliases",
            Some(FrontmatterValue::List(vec![
                "A".to_string(),
                "B".to_string(),
            ])),
        )
        .unwrap();
        assert!(updated.contains("aliases:"));
        assert!(updated.contains("- \"A\""));
        assert!(updated.contains("- \"B\""));
    }

    #[test]
    fn test_roundtrip_add_then_delete() {
        let content = "---\nStatus: Draft\n---\n# Test\n";
        let with_owner = update_frontmatter_content(
            content,
            "Owner",
            Some(FrontmatterValue::String("Luca".to_string())),
        )
        .unwrap();
        assert!(with_owner.contains("Owner: Luca"));
        let without_owner = update_frontmatter_content(&with_owner, "Owner", None).unwrap();
        assert!(!without_owner.contains("Owner"));
        assert!(without_owner.contains("Status: Draft"));
    }

    #[test]
    fn test_update_frontmatter_empty_block() {
        let content = "---\n---\n\n# Test\n";
        let result = update_frontmatter_content(
            content,
            "title",
            Some(FrontmatterValue::String("New Title".to_string())),
        );
        assert!(result.is_ok());
        assert!(result.unwrap().contains("title: New Title"));
    }

    #[test]
    fn test_update_frontmatter_block_scalar_writes_and_rewrites() {
        let cases = [
            (
                "---\ntype: Type\n---\n# Project\n",
                "## Objective\n\n## Timeline",
                &["template: |", "  ## Objective", "type: Type"][..],
                &[][..],
            ),
            (
                "---\ntype: Type\ntemplate: |\n  ## Old\n  \n  ## Stuff\ncolor: green\n---\n# Project\n",
                "## New\n\n## Content",
                &["  ## New", "color: green"][..],
                &["## Old"][..],
            ),
        ];

        for (content, template, expected_present, expected_absent) in cases {
            let updated = update_frontmatter_content(
                content,
                "template",
                Some(FrontmatterValue::String(template.to_string())),
            )
            .unwrap();
            for expected in expected_present {
                assert!(updated.contains(expected));
            }
            for unexpected in expected_absent {
                assert!(!updated.contains(unexpected));
            }
        }
    }

    #[test]
    fn test_delete_frontmatter_block_scalar() {
        let content =
            "---\ntype: Type\ntemplate: |\n  ## Heading\n  \n  ## Body\ncolor: green\n---\n# Project\n";
        let updated = update_frontmatter_content(content, "template", None).unwrap();
        assert!(!updated.contains("template"));
        assert!(updated.contains("color: green"));
    }

    #[test]
    fn test_update_frontmatter_no_body_after_closing() {
        let content = "---\ntitle: Old\n---\n";
        let updated = update_frontmatter_content(
            content,
            "title",
            Some(FrontmatterValue::String("New".to_string())),
        )
        .unwrap();
        assert!(updated.contains("title: New"));
        assert!(!updated.contains("title: Old"));
    }

    /// Anchor extension: real-world Korean + Chinese frontmatter must round-trip
    /// without alphabetizing keys or losing the trailing newline.
    #[test]
    fn test_roundtrip_korean_chinese_preserves_order() {
        let content = "---\ntitle: 제주한라대학교 RISE 2026\nstatus: 진행중\ntags:\n  - 행정\n  - 학사\nauthor: 이영준 (李永俊)\n---\n# 제주한라대학교\n\n본문 내용...\n";
        let updated = update_frontmatter_content(
            content,
            "status",
            Some(FrontmatterValue::String("완료".to_string())),
        )
        .unwrap();
        // Order preserved: title comes before status, status before tags, tags before author.
        let title_pos = updated.find("title:").unwrap();
        let status_pos = updated.find("status:").unwrap();
        let tags_pos = updated.find("tags:").unwrap();
        let author_pos = updated.find("author:").unwrap();
        assert!(title_pos < status_pos, "title must come before status");
        assert!(status_pos < tags_pos, "status must come before tags");
        assert!(tags_pos < author_pos, "tags must come before author");
        // Korean values intact.
        assert!(updated.contains("제주한라대학교 RISE 2026"));
        assert!(updated.contains("status: 완료"));
        assert!(updated.contains("이영준 (李永俊)"));
        // Body intact.
        assert!(updated.contains("# 제주한라대학교"));
        assert!(updated.contains("본문 내용..."));
        // Trailing newline preserved.
        assert!(updated.ends_with('\n'));
    }

    /// Anchor extension: comments inside frontmatter must not be erased on update.
    #[test]
    fn test_roundtrip_preserves_comments() {
        let content = "---\n# Anchor metadata block\ntitle: Doc\n# Internal — do not edit\nstatus: draft\n---\n# Doc\n";
        let updated = update_frontmatter_content(
            content,
            "status",
            Some(FrontmatterValue::String("active".to_string())),
        )
        .unwrap();
        assert!(updated.contains("# Anchor metadata block"));
        assert!(updated.contains("# Internal — do not edit"));
        assert!(updated.contains("status: active"));
    }
}
