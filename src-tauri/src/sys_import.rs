// One-shot, idempotent import from the user's pre-existing
// `<work>/_sys/` operational area into anchor's `<work>/.anchor/`. The
// `_sys/` directory remains the SSOT for external tools (Claude skills
// CLI, launchd services, public skills repo); anchor only reads from
// it on demand and stores its own copy under `.anchor/`.
//
// Single transaction shape:
//   plan_sys_import(work_path) -> ImportPlan       (dry run; cheap, read-only)
//   apply_sys_import(work_path, plan, selected) -> ImportReceipt   (copies)

use crate::anchor_dir::{
    append_imports, write_mcp, write_projects, write_rule_with_origin, write_skills,
    write_template_with_origin,
};
use crate::vault::{parse_frontmatter, title_from_content};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    pub category: String, // "rule" | "template" | "mcp" | "projects" | "skills"
    pub origin_abs: String,
    pub origin_rel: String,
    pub target_rel: String,
    /// "new" | "update" | "unchanged".
    pub status: String,
    pub origin_sha256: String,
    /// Display label (markdown title or file stem).
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub work_path: String,
    pub sys_present: bool,
    pub rules: Vec<ImportItem>,
    pub templates: Vec<ImportItem>,
    pub mcp: Option<ImportItem>,
    pub projects: Option<ImportItem>,
    pub skills: Option<ImportItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReceipt {
    pub applied: Vec<ImportItem>,
    pub skipped: Vec<ImportItem>,
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|err| format!("Cannot hash {}: {err}", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn read_imports_index(work: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let path = work.join(".anchor/imports.json");
    if !path.exists() {
        return map;
    }
    let Ok(content) = fs::read_to_string(&path) else {
        return map;
    };
    let Ok(value) = serde_json::from_str::<JsonValue>(&content) else {
        return map;
    };
    let Some(items) = value.get("items").and_then(JsonValue::as_array) else {
        return map;
    };
    for item in items {
        let Some(origin) = item.get("origin_rel").and_then(JsonValue::as_str) else {
            continue;
        };
        let Some(sha) = item.get("origin_sha256").and_then(JsonValue::as_str) else {
            continue;
        };
        // Last-write-wins: later entries overwrite earlier ones.
        map.insert(origin.to_string(), sha.to_string());
    }
    map
}

fn classify_status(prev_sha: Option<&String>, current_sha: &str) -> &'static str {
    match prev_sha {
        Some(prev) if prev == current_sha => "unchanged",
        Some(_) => "update",
        None => "new",
    }
}

fn rel_within(base: &Path, child: &Path) -> String {
    child
        .strip_prefix(base)
        .unwrap_or(child)
        .to_string_lossy()
        .replace('\\', "/")
}

fn make_item(
    category: &str,
    origin_abs: PathBuf,
    work: &Path,
    target_rel: &str,
    label: &str,
    prev_index: &std::collections::HashMap<String, String>,
) -> Result<ImportItem, String> {
    let origin_rel = rel_within(work, &origin_abs);
    let origin_sha256 = sha256_file(&origin_abs)?;
    let status = classify_status(prev_index.get(&origin_rel), &origin_sha256);
    Ok(ImportItem {
        category: category.to_string(),
        origin_abs: origin_abs.to_string_lossy().to_string(),
        origin_rel,
        target_rel: target_rel.to_string(),
        status: status.to_string(),
        origin_sha256,
        label: label.to_string(),
    })
}

fn label_for_markdown(path: &Path) -> String {
    let fallback = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();
    let Ok(content) = fs::read_to_string(path) else {
        return fallback;
    };
    title_from_content(&content, &fallback)
}

fn collect_rule_candidates(
    work: &Path,
    prev_index: &std::collections::HashMap<String, String>,
) -> Result<Vec<ImportItem>, String> {
    let dir = work.join("_sys/rules");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir)
        .map_err(|err| format!("Cannot read _sys/rules: {err}"))?
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        if stem.is_empty() {
            continue;
        }
        let target_rel = format!(".anchor/rules/{stem}.md");
        let label = label_for_markdown(&path);
        out.push(make_item(
            "rule",
            path,
            work,
            &target_rel,
            &label,
            prev_index,
        )?);
    }
    out.sort_by(|a, b| a.origin_rel.cmp(&b.origin_rel));
    Ok(out)
}

fn collect_template_candidates(
    work: &Path,
    prev_index: &std::collections::HashMap<String, String>,
) -> Result<Vec<ImportItem>, String> {
    let dir = work.join("_sys/templates");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in WalkDir::new(&dir)
        .max_depth(2)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !entry.file_type().is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        if stem.is_empty() {
            continue;
        }
        let target_rel = format!(".anchor/templates/{stem}.md");
        let label = label_for_markdown(path);
        out.push(make_item(
            "template",
            path.to_path_buf(),
            work,
            &target_rel,
            &label,
            prev_index,
        )?);
    }
    out.sort_by(|a, b| a.origin_rel.cmp(&b.origin_rel));
    Ok(out)
}

fn build_mcp_candidate(
    work: &Path,
    prev_index: &std::collections::HashMap<String, String>,
) -> Result<Option<ImportItem>, String> {
    let path = work.join("_sys/mcp.json");
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(make_item(
        "mcp",
        path,
        work,
        ".anchor/mcp.json",
        "MCP servers",
        prev_index,
    )?))
}

fn build_projects_candidate(
    work: &Path,
    prev_index: &std::collections::HashMap<String, String>,
) -> Result<Option<ImportItem>, String> {
    let path = work.join("project-registry.yaml");
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(make_item(
        "projects",
        path,
        work,
        ".anchor/projects.json",
        "Project registry",
        prev_index,
    )?))
}

fn build_skills_candidate(
    work: &Path,
    prev_index: &std::collections::HashMap<String, String>,
) -> Result<Option<ImportItem>, String> {
    let index = work.join("_sys/skills/SKILL_INDEX.md");
    if !index.is_file() {
        return Ok(None);
    }
    Ok(Some(make_item(
        "skills",
        index,
        work,
        ".anchor/skills.json",
        "Skills catalog",
        prev_index,
    )?))
}

#[tauri::command]
pub fn plan_sys_import(work_path: String) -> Result<ImportPlan, String> {
    let work = canonicalize_work(&work_path)?;
    let prev_index = read_imports_index(&work);
    let sys_present = work.join("_sys").is_dir();
    let rules = collect_rule_candidates(&work, &prev_index)?;
    let templates = collect_template_candidates(&work, &prev_index)?;
    let mcp = build_mcp_candidate(&work, &prev_index)?;
    let projects = build_projects_candidate(&work, &prev_index)?;
    let skills = build_skills_candidate(&work, &prev_index)?;
    Ok(ImportPlan {
        work_path: work.to_string_lossy().to_string(),
        sys_present,
        rules,
        templates,
        mcp,
        projects,
        skills,
    })
}

fn canonicalize_work(work_path: &str) -> Result<PathBuf, String> {
    let raw = PathBuf::from(work_path);
    if !raw.exists() {
        return Err(format!("Work path does not exist: {work_path}"));
    }
    raw.canonicalize()
        .map_err(|err| format!("Cannot canonicalize work path: {err}"))
}

fn apply_rule(work: &Path, item: &ImportItem) -> Result<(), String> {
    let body =
        fs::read_to_string(&item.origin_abs).map_err(|err| format!("Cannot read source: {err}"))?;
    let stem = Path::new(&item.target_rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Invalid target name".to_string())?
        .to_string();
    write_rule_with_origin(work, &stem, &body, &item.origin_rel, &item.origin_sha256)?;
    Ok(())
}

fn apply_template(work: &Path, item: &ImportItem) -> Result<(), String> {
    let body =
        fs::read_to_string(&item.origin_abs).map_err(|err| format!("Cannot read source: {err}"))?;
    let stem = Path::new(&item.target_rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Invalid target name".to_string())?
        .to_string();
    write_template_with_origin(work, &stem, &body, &item.origin_rel, &item.origin_sha256)?;
    Ok(())
}

fn apply_mcp(work: &Path, item: &ImportItem) -> Result<(), String> {
    let raw = fs::read_to_string(&item.origin_abs)
        .map_err(|err| format!("Cannot read mcp.json: {err}"))?;
    let mut value: JsonValue =
        serde_json::from_str(&raw).map_err(|err| format!("Cannot parse mcp.json: {err}"))?;
    if let JsonValue::Object(ref mut obj) = value {
        if !obj.contains_key("version") {
            obj.insert("version".into(), JsonValue::from(SCHEMA_VERSION));
        }
        obj.insert(
            "imported_origin".into(),
            JsonValue::String(item.origin_rel.clone()),
        );
        obj.insert(
            "imported_sha256".into(),
            JsonValue::String(item.origin_sha256.clone()),
        );
    }
    write_mcp(work, &value)
}

fn apply_projects(work: &Path, item: &ImportItem) -> Result<(), String> {
    let raw = fs::read_to_string(&item.origin_abs)
        .map_err(|err| format!("Cannot read project-registry.yaml: {err}"))?;
    let yaml: serde_yaml::Value = serde_yaml::from_str(&raw)
        .map_err(|err| format!("Cannot parse project-registry.yaml: {err}"))?;
    let json_form = yaml_to_json(&yaml);
    let mut wrapped = json!({
        "version": SCHEMA_VERSION,
        "imported_origin": item.origin_rel.clone(),
        "imported_sha256": item.origin_sha256.clone(),
    });
    if let JsonValue::Object(ref mut obj) = wrapped {
        obj.insert("registry".into(), json_form);
    }
    write_projects(work, &wrapped)
}

fn apply_skills(work: &Path, item: &ImportItem) -> Result<(), String> {
    let mut skills_arr: Vec<JsonValue> = Vec::new();
    let skills_root = work.join("_sys/skills/skills");
    if skills_root.is_dir() {
        for entry in WalkDir::new(&skills_root)
            .min_depth(2)
            .max_depth(3)
            .into_iter()
            .filter_map(Result::ok)
        {
            if entry.file_name() != "SKILL.md" {
                continue;
            }
            let skill_path = entry.path();
            let Ok(content) = fs::read_to_string(skill_path) else {
                continue;
            };
            let parts = parse_frontmatter(&content);
            let skill_dir = skill_path.parent().unwrap_or(skill_path);
            let rel_to_skills = skill_dir.strip_prefix(&skills_root).unwrap_or(skill_dir);
            let rel_components: Vec<String> = rel_to_skills
                .components()
                .filter_map(|component| component.as_os_str().to_str().map(str::to_string))
                .collect();
            let Some(folder_name) = rel_components.last().cloned() else {
                continue;
            };
            let category = if rel_components.len() >= 2
                && matches!(rel_components[0].as_str(), "public" | "private" | "vault")
            {
                rel_components[0].clone()
            } else {
                "public".to_string()
            };
            let name = parts
                .meta
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or(folder_name);
            let description = parts
                .meta
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let runtime = parts
                .meta
                .get("runtime")
                .and_then(|v| v.as_str())
                .unwrap_or("claude-code")
                .to_string();
            let source = rel_within(work, skill_path);
            skills_arr.push(json!({
                "name": name,
                "description": description,
                "runtime": runtime,
                "category": category,
                "source": source,
            }));
        }
    }
    let value = json!({
        "version": SCHEMA_VERSION,
        "imported_origin": item.origin_rel.clone(),
        "imported_sha256": item.origin_sha256.clone(),
        "skills": skills_arr,
    });
    write_skills(work, &value)
}

fn yaml_to_json(value: &serde_yaml::Value) -> JsonValue {
    match value {
        serde_yaml::Value::Null => JsonValue::Null,
        serde_yaml::Value::Bool(b) => JsonValue::Bool(*b),
        serde_yaml::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                JsonValue::from(i)
            } else if let Some(f) = n.as_f64() {
                serde_json::Number::from_f64(f)
                    .map(JsonValue::Number)
                    .unwrap_or(JsonValue::Null)
            } else {
                JsonValue::Null
            }
        }
        serde_yaml::Value::String(s) => JsonValue::String(s.clone()),
        serde_yaml::Value::Sequence(seq) => {
            JsonValue::Array(seq.iter().map(yaml_to_json).collect())
        }
        serde_yaml::Value::Mapping(map) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in map {
                let key = match k {
                    serde_yaml::Value::String(s) => s.clone(),
                    _ => serde_yaml::to_string(k)
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                };
                obj.insert(key, yaml_to_json(v));
            }
            JsonValue::Object(obj)
        }
        serde_yaml::Value::Tagged(tagged) => yaml_to_json(&tagged.value),
    }
}

#[tauri::command]
pub fn apply_sys_import(
    work_path: String,
    plan: ImportPlan,
    selected: Vec<String>,
) -> Result<ImportReceipt, String> {
    let work = canonicalize_work(&work_path)?;
    let allow: std::collections::HashSet<String> = selected.into_iter().collect();
    let mut applied: Vec<ImportItem> = Vec::new();
    let mut skipped: Vec<ImportItem> = Vec::new();
    let mut receipts: Vec<JsonValue> = Vec::new();
    let now = Utc::now().to_rfc3339();

    let process = |item: ImportItem,
                   applied: &mut Vec<ImportItem>,
                   skipped: &mut Vec<ImportItem>,
                   receipts: &mut Vec<JsonValue>|
     -> Result<(), String> {
        if !allow.contains(&item.origin_rel) {
            skipped.push(item);
            return Ok(());
        }
        match item.category.as_str() {
            "rule" => apply_rule(&work, &item)?,
            "template" => apply_template(&work, &item)?,
            "mcp" => apply_mcp(&work, &item)?,
            "projects" => apply_projects(&work, &item)?,
            "skills" => apply_skills(&work, &item)?,
            other => return Err(format!("Unknown import category: {other}")),
        }
        receipts.push(json!({
            "category": item.category,
            "origin_rel": item.origin_rel,
            "target_rel": item.target_rel,
            "origin_sha256": item.origin_sha256,
            "imported_at": now.clone(),
        }));
        applied.push(item);
        Ok(())
    };

    for item in plan.rules {
        process(item, &mut applied, &mut skipped, &mut receipts)?;
    }
    for item in plan.templates {
        process(item, &mut applied, &mut skipped, &mut receipts)?;
    }
    if let Some(item) = plan.mcp {
        process(item, &mut applied, &mut skipped, &mut receipts)?;
    }
    if let Some(item) = plan.projects {
        process(item, &mut applied, &mut skipped, &mut receipts)?;
    }
    if let Some(item) = plan.skills {
        process(item, &mut applied, &mut skipped, &mut receipts)?;
    }

    if !receipts.is_empty() {
        append_imports(&work, receipts)?;
    }

    Ok(ImportReceipt { applied, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anchor_dir::ensure_anchor_dir;
    use tempfile::TempDir;

    fn write_file(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn seed_workspace() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path();
        write_file(
            work,
            "_sys/rules/ingest-chain.md",
            "---\nscope: inbox\n---\n# Ingest Chain\n\nFlow.\n",
        );
        write_file(
            work,
            "_sys/rules/gitignore-policy.md",
            "# Gitignore Policy\n\nText.\n",
        );
        write_file(
            work,
            "_sys/templates/meeting.md",
            "---\ntype: meeting\n---\n# Meeting Template\n\n## Agenda\n",
        );
        write_file(work, "_sys/mcp.json", "{\"servers\":{\"obsidian\":{}}}");
        write_file(
            work,
            "project-registry.yaml",
            "version: 1\ncategories:\n  - key: rise\n    label: RISE\n",
        );
        write_file(work, "_sys/skills/SKILL_INDEX.md", "# Skills Index\n");
        write_file(
            work,
            "_sys/skills/skills/private/sample/SKILL.md",
            "---\nname: sample\ndescription: A sample skill\nruntime: claude-code\n---\n# sample\n",
        );
        ensure_anchor_dir(work).unwrap();
        tmp
    }

    #[test]
    fn plan_finds_known_categories() {
        let tmp = seed_workspace();
        let plan = plan_sys_import(tmp.path().to_string_lossy().to_string()).unwrap();
        assert!(plan.sys_present);
        assert_eq!(plan.rules.len(), 2);
        assert_eq!(plan.templates.len(), 1);
        assert!(plan.mcp.is_some());
        assert!(plan.projects.is_some());
        assert!(plan.skills.is_some());
        // All "new" since imports.json starts empty.
        assert!(plan.rules.iter().all(|i| i.status == "new"));
    }

    #[test]
    fn apply_writes_only_selected_and_records_receipts() {
        let tmp = seed_workspace();
        let plan = plan_sys_import(tmp.path().to_string_lossy().to_string()).unwrap();
        let selected: Vec<String> = plan
            .rules
            .iter()
            .map(|i| i.origin_rel.clone())
            .chain(plan.mcp.iter().map(|i| i.origin_rel.clone()))
            .collect();
        let receipt =
            apply_sys_import(tmp.path().to_string_lossy().to_string(), plan, selected).unwrap();
        assert_eq!(receipt.applied.len(), 3); // 2 rules + 1 mcp
        assert!(tmp.path().join(".anchor/rules/ingest-chain.md").exists());
        assert!(tmp
            .path()
            .join(".anchor/rules/gitignore-policy.md")
            .exists());
        assert!(tmp.path().join(".anchor/mcp.json").exists());
        // Templates not selected → not written.
        assert!(!tmp.path().join(".anchor/templates/meeting.md").exists());

        // imports.json receipts.
        let imports = fs::read_to_string(tmp.path().join(".anchor/imports.json")).unwrap();
        assert!(imports.contains("ingest-chain"));
        assert!(imports.contains("origin_sha256"));

        // Re-plan now sees those entries as "unchanged".
        let next = plan_sys_import(tmp.path().to_string_lossy().to_string()).unwrap();
        let ingest = next
            .rules
            .iter()
            .find(|i| i.origin_rel.ends_with("ingest-chain.md"))
            .unwrap();
        assert_eq!(ingest.status, "unchanged");
    }

    #[test]
    fn projects_yaml_to_json_round_trips() {
        let tmp = seed_workspace();
        let plan = plan_sys_import(tmp.path().to_string_lossy().to_string()).unwrap();
        let selected = vec![plan.projects.as_ref().unwrap().origin_rel.clone()];
        apply_sys_import(tmp.path().to_string_lossy().to_string(), plan, selected).unwrap();
        let written = fs::read_to_string(tmp.path().join(".anchor/projects.json")).unwrap();
        assert!(written.contains("\"key\": \"rise\""));
        assert!(written.contains("\"label\": \"RISE\""));
    }

    #[test]
    fn skills_import_collects_skill_md() {
        let tmp = seed_workspace();
        let plan = plan_sys_import(tmp.path().to_string_lossy().to_string()).unwrap();
        let selected = vec![plan.skills.as_ref().unwrap().origin_rel.clone()];
        apply_sys_import(tmp.path().to_string_lossy().to_string(), plan, selected).unwrap();
        let written = fs::read_to_string(tmp.path().join(".anchor/skills.json")).unwrap();
        assert!(written.contains("\"name\": \"sample\""));
        assert!(written.contains("\"category\": \"private\""));
    }

    #[test]
    fn plan_handles_missing_sys_dir() {
        let tmp = TempDir::new().unwrap();
        ensure_anchor_dir(tmp.path()).unwrap();
        let plan = plan_sys_import(tmp.path().to_string_lossy().to_string()).unwrap();
        assert!(!plan.sys_present);
        assert!(plan.rules.is_empty());
        assert!(plan.templates.is_empty());
        assert!(plan.mcp.is_none());
        assert!(plan.projects.is_none());
        assert!(plan.skills.is_none());
    }
}
