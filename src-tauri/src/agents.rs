// Agent registry. An agent is a *named preset for one AI dispatch*: a skill
// binding + a backend runtime + a permission mode + a prompt. It is not a
// schedule (timing lives in `<work>/.maru/schedules.json`, which now carries an
// optional `agentId`) and it is not a skill (a skill has no backend).
//
// Storage is global — `~/.maru/agents.json` — because `maru_dir::GLOBAL_SETTINGS_PATHS`
// already treats the whole `["ai"]` block (defaultRuntime, permissionMode,
// commandOverrides) as user-global, and an agent is that block with a name on
// it. A user has one "회의록 정리" agent, not one per workspace.
//
// Builtins are a `const` array here, never a file, so an app upgrade has
// nothing to clobber. The user layer stores a *sparse patch* per builtin:
//
//   { "version": 1,
//     "agents":    [ /* user-created, full records */ ],
//     "overrides": { "inbox-triage": { "runtime": "codex" } } }
//
// On load, every field the user did not touch picks up the new seed value and
// every field they did touch survives. `skill_host` needs its SHA-256
// stored-hash dance (store.rs) because skills are opaque files edited by
// external tools; agents are structured records we fully own, so field-level
// provenance is free.
//
// Seeds never create schedules: scheduling autonomous AI is gated by
// `require_approval(.., "scheduler.add")` and shipping a JSON file must not
// bypass that gate. `recommended_schedule` only pre-fills the add dialog.

use crate::atomic_file::write_atomic;
use crate::skill_host::fs::maru_home;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

const AGENTS_FILE_VERSION: u32 = 1;

/// Fields of a builtin a user may override. `skillName` and `kind` are not in
/// the list on purpose: a call site is bound to its agent's output contract, so
/// re-pointing a builtin at another skill would break the feature that consumes
/// it rather than customize it.
const OVERRIDABLE_FIELDS: &[&str] = &[
    "runtime",
    "permissionMode",
    "prompt",
    "enabled",
    "label",
    "description",
];

const RUNTIMES: &[&str] = &["inherit", "claude", "codex", "kimi", "kiro"];
const PERMISSION_MODES: &[&str] = &[
    "inherit",
    "plan",
    "acceptEdits",
    "default",
    "bypassPermissions",
];
const KINDS: &[&str] = &["background", "inline"];

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecommendedSchedule {
    pub hour: u32,
    pub minute: u32,
    /// 0 = Sunday .. 6 = Saturday; empty means daily.
    pub days_of_week: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    pub id: String,
    /// i18n key — builtins only. Renderer: labelKey ? t(labelKey) : (label ?? id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_key: Option<String>,
    /// Literal label — user agents only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Skill *name* ("inbox-process"), resolved to the composite registry id at
    /// run time. Registry ids are `<sourceId>::<name>` and machine-local; names
    /// are portable. Empty for `kind == "inline"`.
    #[serde(default)]
    pub skill_name: String,
    /// "inherit" resolves to `ai.defaultRuntime`.
    pub runtime: String,
    /// "inherit" resolves to `ai.permissionMode`.
    pub permission_mode: String,
    #[serde(default)]
    pub prompt: String,
    /// "background" = tracked, stoppable mission. "inline" = request/response.
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Derived on load; never read from disk (a user file cannot forge these).
    #[serde(default, skip_deserializing)]
    pub builtin: bool,
    #[serde(default, skip_deserializing)]
    pub customized: bool,
    /// Derived from the seed. Pre-fills the "일정 추가" dialog; creating the
    /// schedule still goes through the `scheduler.add` approval.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub recommended_schedule: Option<RecommendedSchedule>,
}

fn default_kind() -> String {
    "background".to_string()
}

fn default_true() -> bool {
    true
}

fn default_version() -> u32 {
    AGENTS_FILE_VERSION
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentsFile {
    #[serde(default = "default_version")]
    version: u32,
    /// User-created agents only.
    #[serde(default)]
    agents: Vec<AgentRecord>,
    /// builtin id -> sparse patch of changed fields.
    #[serde(default)]
    overrides: BTreeMap<String, JsonValue>,
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

struct AgentSeed {
    id: &'static str,
    label_key: &'static str,
    skill_name: &'static str,
    prompt: &'static str,
    kind: &'static str,
    permission_mode: &'static str,
    enabled: bool,
    /// (hour, minute, days_of_week) — empty days means daily.
    schedule: Option<(u32, u32, &'static [u32])>,
}

const WEEKDAYS: &[u32] = &[1, 2, 3, 4, 5];
const SUNDAY: &[u32] = &[0];
const FRIDAY: &[u32] = &[5];

/// Every AI feature Maru ships, plus the four recurring agents registered for
/// this workspace. Read-only and proposal-only agents ship enabled; anything
/// that pushes to a remote or sends a message ships disabled. `enabled` only
/// makes an agent visible and runnable — nothing fires until the user attaches
/// a schedule through the approval dialog.
const SEEDS: &[AgentSeed] = &[
    AgentSeed {
        id: "inbox-triage",
        label_key: "agents.builtin.inboxTriage",
        skill_name: "inbox-process",
        prompt: "",
        kind: "background",
        permission_mode: "inherit",
        // Feature-bound: the Inbox pane builds the prompt from the selected
        // entries, so there is no schedule to recommend. Scheduling it means
        // typing an explicit prompt ("extract-tasks") in the add dialog.
        enabled: true,
        schedule: None,
    },
    AgentSeed {
        id: "inbox-classify",
        label_key: "agents.builtin.inboxClassify",
        skill_name: "",
        prompt: "",
        kind: "inline",
        permission_mode: "inherit",
        enabled: true,
        schedule: None,
    },
    AgentSeed {
        id: "meeting-notes",
        label_key: "agents.builtin.meetingNotes",
        skill_name: "meeting-notes",
        prompt: "",
        kind: "background",
        permission_mode: "inherit",
        enabled: true,
        schedule: None,
    },
    AgentSeed {
        id: "task-extract",
        label_key: "agents.builtin.taskExtract",
        skill_name: "task-management",
        prompt: "",
        kind: "background",
        permission_mode: "inherit",
        enabled: true,
        schedule: None,
    },
    AgentSeed {
        id: "ideation-draft",
        label_key: "agents.builtin.ideationDraft",
        skill_name: "ideation-drafts",
        prompt: "",
        kind: "background",
        permission_mode: "inherit",
        enabled: true,
        schedule: None,
    },
    AgentSeed {
        id: "commit-message",
        label_key: "agents.builtin.commitMessage",
        skill_name: "",
        prompt: "",
        kind: "inline",
        permission_mode: "inherit",
        enabled: true,
        schedule: None,
    },
    AgentSeed {
        id: "vault-hygiene",
        label_key: "agents.builtin.vaultHygiene",
        skill_name: "vault-lint",
        prompt: "vault/ + work/ 정합성 검증 리포트를 vault/reports/lint-YYMMDD.md 로 생성. \
dead wiki-link, orphan note, 스키마 위반, 명명규칙 위반, stale seed, 로그 포맷 위반을 포함. \
자동 수정 금지 — 제안만 기록.",
        kind: "background",
        permission_mode: "inherit",
        enabled: true,
        schedule: Some((22, 0, SUNDAY)),
    },
    AgentSeed {
        id: "vault-proposal",
        label_key: "agents.builtin.vaultProposal",
        skill_name: "vault-sync",
        prompt: "work/ 변경분을 스캔해 vault 추출 후보를 제안. \
확인 없이 vault 에 쓰지 말 것 — 제안 목록만 출력.",
        kind: "background",
        permission_mode: "inherit",
        enabled: true,
        schedule: Some((18, 0, FRIDAY)),
    },
    AgentSeed {
        id: "daily-digest",
        label_key: "agents.builtin.dailyDigest",
        skill_name: "draft-writer",
        prompt: "어제 처리한 inbox 항목, 오늘·내일 마감 task, 미결 승인 건을 개조식으로 요약해 \
scratchpad/drafts/ 아래 하루 브리핑 초안으로 작성. 확정 트리 수정 금지.",
        kind: "background",
        permission_mode: "inherit",
        enabled: false,
        schedule: Some((7, 50, WEEKDAYS)),
    },
    AgentSeed {
        id: "git-sync",
        label_key: "agents.builtin.gitSync",
        skill_name: "git-sync",
        prompt: "workspace 변경분을 의미 단위로 커밋하고 push. \
충돌과 force-push 는 보고만 하고 중단. secrets/ 는 제외.",
        kind: "background",
        permission_mode: "acceptEdits",
        enabled: false,
        schedule: Some((18, 30, WEEKDAYS)),
    },
];

fn seed_record(seed: &AgentSeed) -> AgentRecord {
    AgentRecord {
        id: seed.id.to_string(),
        label_key: Some(seed.label_key.to_string()),
        label: None,
        description: None,
        skill_name: seed.skill_name.to_string(),
        runtime: "inherit".to_string(),
        permission_mode: seed.permission_mode.to_string(),
        prompt: seed.prompt.to_string(),
        kind: seed.kind.to_string(),
        enabled: seed.enabled,
        builtin: true,
        customized: false,
        recommended_schedule: seed.schedule.map(|(hour, minute, days)| RecommendedSchedule {
            hour,
            minute,
            days_of_week: days.to_vec(),
        }),
    }
}

fn find_seed(id: &str) -> Option<&'static AgentSeed> {
    SEEDS.iter().find(|seed| seed.id == id)
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

fn agents_path() -> Result<PathBuf, String> {
    Ok(maru_home()?.join("agents.json"))
}

fn load_file() -> Result<AgentsFile, String> {
    let path = agents_path()?;
    if !path.is_file() {
        return Ok(AgentsFile {
            version: AGENTS_FILE_VERSION,
            ..AgentsFile::default()
        });
    }
    let raw =
        fs::read_to_string(&path).map_err(|err| format!("Cannot read {}: {err}", path.display()))?;
    // A corrupt file surfaces an error rather than being silently replaced:
    // agents are user data.
    serde_json::from_str(&raw).map_err(|err| format!("Cannot parse {}: {err}", path.display()))
}

fn save_file(file: &AgentsFile) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(file).map_err(|err| format!("Cannot serialize agents: {err}"))?;
    write_atomic(&agents_path()?, &bytes)
}

/// Seeds first (registry order), then user agents.
fn merged(file: &AgentsFile) -> Result<Vec<AgentRecord>, String> {
    let mut out = Vec::with_capacity(SEEDS.len() + file.agents.len());
    for seed in SEEDS {
        let base = seed_record(seed);
        let patch = file.overrides.get(seed.id).and_then(JsonValue::as_object);
        out.push(match patch {
            Some(patch) if !patch.is_empty() => apply_patch(&base, patch)?,
            _ => base,
        });
    }
    for agent in &file.agents {
        let mut agent = agent.clone();
        agent.builtin = false;
        agent.customized = false;
        agent.recommended_schedule = None;
        out.push(agent);
    }
    Ok(out)
}

fn apply_patch(base: &AgentRecord, patch: &JsonMap<String, JsonValue>) -> Result<AgentRecord, String> {
    let mut value = serde_json::to_value(base)
        .map_err(|err| format!("Cannot serialize agent {}: {err}", base.id))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| format!("agent_serialize_failed: {}", base.id))?;
    for (key, patched) in patch {
        if !OVERRIDABLE_FIELDS.contains(&key.as_str()) {
            continue;
        }
        object.insert(key.clone(), patched.clone());
    }
    let mut merged: AgentRecord = serde_json::from_value(value)
        .map_err(|err| format!("agent_override_invalid: {} ({err})", base.id))?;
    merged.builtin = true;
    merged.customized = true;
    merged.recommended_schedule = base.recommended_schedule.clone();
    Ok(merged)
}

/// The sparse set of overridable fields where `next` differs from the seed.
fn diff_vs_seed(seed: &AgentRecord, next: &AgentRecord) -> Result<JsonMap<String, JsonValue>, String> {
    let seed_value = serde_json::to_value(seed)
        .map_err(|err| format!("Cannot serialize agent {}: {err}", seed.id))?;
    let next_value = serde_json::to_value(next)
        .map_err(|err| format!("Cannot serialize agent {}: {err}", next.id))?;
    let mut patch = JsonMap::new();
    for field in OVERRIDABLE_FIELDS {
        // A field absent from the serialized seed (skip_serializing_if) is null
        // there; comparing the two Options this way keeps "cleared back to the
        // seed value" collapsing the patch entry instead of storing null.
        let before = seed_value.get(*field).cloned().unwrap_or(JsonValue::Null);
        let after = next_value.get(*field).cloned().unwrap_or(JsonValue::Null);
        if before != after {
            patch.insert((*field).to_string(), after);
        }
    }
    Ok(patch)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// `^[a-z0-9][a-z0-9-]{0,47}$` — safe as a filesystem segment and as a log key.
fn validate_agent_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 48
        && id
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(format!("agent_id_invalid: {id}"))
    }
}

/// A background agent's prompt is required only when nothing else supplies one.
/// Feature-bound builtins (inbox-triage, meeting-notes, …) are driven by a UI
/// surface that builds the prompt per run, so their stored prompt is empty by
/// design; a user agent has no such surface and must carry its own. An empty
/// prompt is therefore exactly what makes an agent non-standalone, which is
/// what `agent_can_run_standalone` reports to the pane.
fn validate_agent(agent: &AgentRecord, builtin: bool) -> Result<(), String> {
    validate_agent_id(&agent.id)?;
    if !RUNTIMES.contains(&agent.runtime.as_str()) {
        return Err(format!("agent_runtime_invalid: {}", agent.runtime));
    }
    if !PERMISSION_MODES.contains(&agent.permission_mode.as_str()) {
        return Err(format!(
            "agent_permission_mode_invalid: {}",
            agent.permission_mode
        ));
    }
    if !KINDS.contains(&agent.kind.as_str()) {
        return Err(format!("agent_kind_invalid: {}", agent.kind));
    }
    if agent.kind == "background" {
        if agent.skill_name.trim().is_empty() {
            return Err("agent_skill_required".to_string());
        }
        if !builtin && agent.prompt.trim().is_empty() {
            return Err("agent_prompt_required".to_string());
        }
    }
    Ok(())
}

/// True when the agent carries everything a standalone run needs. A background
/// agent with no prompt only runs from the feature that owns it, and a schedule
/// pointing at one would dispatch an empty prompt.
pub fn agent_can_run_standalone(agent: &AgentRecord) -> bool {
    agent.kind == "background" && !agent.prompt.trim().is_empty()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn agents_list() -> Result<Vec<AgentRecord>, String> {
    merged(&load_file()?)
}

/// Creates or updates one agent. For a builtin this stores the sparse diff
/// against the seed; for a user agent it stores the whole record.
#[tauri::command]
pub fn agents_upsert(agent: AgentRecord) -> Result<AgentRecord, String> {
    let mut file = load_file()?;
    if let Some(seed) = find_seed(&agent.id) {
        // A builtin's identity fields are the seed's, whatever the client sent.
        let base = seed_record(seed);
        let mut next = agent;
        next.skill_name = base.skill_name.clone();
        next.kind = base.kind.clone();
        next.label_key = base.label_key.clone();
        validate_agent(&next, true)?;
        let patch = diff_vs_seed(&base, &next)?;
        if patch.is_empty() {
            file.overrides.remove(&base.id);
        } else {
            file.overrides
                .insert(base.id.clone(), JsonValue::Object(patch));
        }
        save_file(&file)?;
        return merged(&file)?
            .into_iter()
            .find(|record| record.id == base.id)
            .ok_or_else(|| format!("agent_not_found: {}", base.id));
    }

    let mut next = agent;
    next.builtin = false;
    next.customized = false;
    next.recommended_schedule = None;
    next.label_key = None;
    validate_agent(&next, false)?;
    if next.label.as_ref().is_none_or(|label| label.trim().is_empty()) {
        return Err("agent_label_required".to_string());
    }
    match file.agents.iter_mut().find(|record| record.id == next.id) {
        Some(existing) => *existing = next.clone(),
        None => file.agents.push(next.clone()),
    }
    save_file(&file)?;
    Ok(next)
}

#[tauri::command]
pub fn agents_delete(id: String) -> Result<Vec<AgentRecord>, String> {
    if find_seed(&id).is_some() {
        // ~10 builtin rows: `enabled: false` is the delete. Revisit with
        // tombstones only when the builtin list becomes clutter.
        return Err("agent_builtin_not_deletable".to_string());
    }
    let mut file = load_file()?;
    let before = file.agents.len();
    file.agents.retain(|record| record.id != id);
    if file.agents.len() == before {
        return Err(format!("agent_not_found: {id}"));
    }
    save_file(&file)?;
    merged(&file)
}

/// Drops a builtin's override patch, restoring every seed default.
#[tauri::command]
pub fn agents_reset(id: String) -> Result<AgentRecord, String> {
    let seed = find_seed(&id).ok_or_else(|| format!("agent_not_builtin: {id}"))?;
    let mut file = load_file()?;
    file.overrides.remove(&id);
    save_file(&file)?;
    Ok(seed_record(seed))
}

/// Effective record for `id`, or `None`. Used by the scheduler to resolve a
/// schedule's `agentId` at dispatch time.
pub fn get_agent(id: &str) -> Option<AgentRecord> {
    let file = load_file().ok()?;
    merged(&file)
        .ok()?
        .into_iter()
        .find(|record| record.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill_host::fs::test_home_for_bundle_tests;

    fn user_agent(id: &str) -> AgentRecord {
        AgentRecord {
            id: id.to_string(),
            label_key: None,
            label: Some("문서 변환".to_string()),
            description: None,
            skill_name: "md2docx".to_string(),
            runtime: "kimi".to_string(),
            permission_mode: "inherit".to_string(),
            prompt: "최근 보고서를 docx 로 변환".to_string(),
            kind: "background".to_string(),
            enabled: true,
            builtin: false,
            customized: false,
            recommended_schedule: None,
        }
    }

    #[test]
    fn seeds_are_valid_and_uniquely_named() {
        let mut ids: Vec<&str> = SEEDS.iter().map(|seed| seed.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate seed id");
        for seed in SEEDS {
            let record = seed_record(seed);
            validate_agent(&record, true).unwrap_or_else(|err| {
                panic!("seed {} is invalid: {err}", seed.id);
            });
            // A seed that ships a recommended schedule must be runnable on its
            // own, or accepting that recommendation would dispatch an empty
            // prompt. Feature-bound seeds recommend nothing on purpose.
            assert!(
                seed.schedule.is_none() || agent_can_run_standalone(&record),
                "seed {} recommends a schedule but cannot run standalone",
                seed.id
            );
        }
    }

    #[test]
    fn override_patch_is_sparse_and_survives_a_seed_change() {
        let _home = test_home_for_bundle_tests();
        let base = seed_record(find_seed("inbox-triage").unwrap());

        let mut edited = base.clone();
        edited.runtime = "codex".to_string();
        agents_upsert(edited).unwrap();

        // Only the changed field is persisted, so every untouched field keeps
        // tracking the seed across an upgrade.
        let file = load_file().unwrap();
        let patch = file.overrides.get("inbox-triage").unwrap();
        assert_eq!(patch.as_object().unwrap().len(), 1);
        assert_eq!(patch["runtime"], JsonValue::from("codex"));

        // Simulate a seed whose prompt changed in a release: the merge reads
        // the new seed value for the untouched field.
        let mut next_seed = base.clone();
        next_seed.prompt = "새 시드 프롬프트".to_string();
        let merged_after_upgrade =
            apply_patch(&next_seed, patch.as_object().unwrap()).unwrap();
        assert_eq!(merged_after_upgrade.runtime, "codex");
        assert_eq!(merged_after_upgrade.prompt, "새 시드 프롬프트");
        assert!(merged_after_upgrade.customized);
    }

    #[test]
    fn editing_a_builtin_back_to_the_seed_value_drops_the_patch() {
        let _home = test_home_for_bundle_tests();
        let base = seed_record(find_seed("inbox-triage").unwrap());

        let mut edited = base.clone();
        edited.runtime = "kiro".to_string();
        agents_upsert(edited).unwrap();
        assert!(load_file().unwrap().overrides.contains_key("inbox-triage"));

        agents_upsert(base).unwrap();
        assert!(!load_file().unwrap().overrides.contains_key("inbox-triage"));
    }

    #[test]
    fn reset_restores_the_seed() {
        let _home = test_home_for_bundle_tests();
        let mut edited = seed_record(find_seed("git-sync").unwrap());
        edited.enabled = true;
        edited.runtime = "codex".to_string();
        agents_upsert(edited).unwrap();

        let restored = agents_reset("git-sync".to_string()).unwrap();
        assert!(!restored.enabled);
        assert_eq!(restored.runtime, "inherit");
        assert!(load_file().unwrap().overrides.is_empty());
    }

    #[test]
    fn a_builtin_cannot_be_repointed_at_another_skill_or_deleted() {
        let _home = test_home_for_bundle_tests();
        let mut edited = seed_record(find_seed("meeting-notes").unwrap());
        edited.skill_name = "git-sync".to_string();
        let saved = agents_upsert(edited).unwrap();
        assert_eq!(saved.skill_name, "meeting-notes");

        assert_eq!(
            agents_delete("meeting-notes".to_string()).unwrap_err(),
            "agent_builtin_not_deletable"
        );
    }

    #[test]
    fn user_agents_round_trip_and_validate() {
        let _home = test_home_for_bundle_tests();
        assert_eq!(
            agents_upsert(user_agent("Bad Id")).unwrap_err(),
            "agent_id_invalid: Bad Id"
        );

        let mut missing_prompt = user_agent("doc-convert");
        missing_prompt.prompt = "  ".to_string();
        assert_eq!(
            agents_upsert(missing_prompt).unwrap_err(),
            "agent_prompt_required"
        );

        agents_upsert(user_agent("doc-convert")).unwrap();
        let listed = agents_list().unwrap();
        assert_eq!(listed.len(), SEEDS.len() + 1);
        let created = listed.iter().find(|a| a.id == "doc-convert").unwrap();
        assert!(!created.builtin);
        assert_eq!(created.runtime, "kimi");

        // Upsert is idempotent on id, not append-only.
        agents_upsert(user_agent("doc-convert")).unwrap();
        assert_eq!(agents_list().unwrap().len(), SEEDS.len() + 1);

        agents_delete("doc-convert".to_string()).unwrap();
        assert_eq!(agents_list().unwrap().len(), SEEDS.len());
        assert_eq!(
            agents_delete("doc-convert".to_string()).unwrap_err(),
            "agent_not_found: doc-convert"
        );
    }

    #[test]
    fn a_user_agent_cannot_shadow_a_builtin_id() {
        let _home = test_home_for_bundle_tests();
        // Upserting a seed id always lands on the builtin override path, so a
        // second record with that id can never exist in `agents`.
        let mut shadow = user_agent("git-sync");
        shadow.runtime = "codex".to_string();
        agents_upsert(shadow).unwrap();

        assert!(load_file().unwrap().agents.is_empty());
        let listed = agents_list().unwrap();
        assert_eq!(listed.iter().filter(|a| a.id == "git-sync").count(), 1);
        assert!(listed.iter().find(|a| a.id == "git-sync").unwrap().builtin);
    }

    #[test]
    fn get_agent_reads_the_merged_record() {
        let _home = test_home_for_bundle_tests();
        let mut edited = seed_record(find_seed("vault-hygiene").unwrap());
        edited.runtime = "kimi".to_string();
        agents_upsert(edited).unwrap();

        assert_eq!(get_agent("vault-hygiene").unwrap().runtime, "kimi");
        assert!(get_agent("nope").is_none());
    }
}
