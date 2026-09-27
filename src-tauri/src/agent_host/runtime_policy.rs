//! Read-only dotfiles policy client. No native settings or executable paths are accepted.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::contracts::CompletionRequest;
use super::provider::CliProviderKind;
use crate::cli_path::{augmented_path, resolve_program};
use crate::win_process::NoWindow;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyOptions {
    pub enabled: bool,
    #[serde(default = "auto_workload")]
    pub workload: String,
    pub agent: Option<String>,
}
fn auto_workload() -> String {
    "auto".into()
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Resolution {
    pub schema_version: u32,
    pub policy_revision: String,
    pub target_id: String,
    #[serde(default)]
    pub switch_count: u8,
    pub workload: String,
    pub agent: String,
    pub executable: String,
    pub home: String,
    pub home_mode: String,
    pub version: String,
    pub billing: String,
    pub billing_verified: bool,
    pub model: String,
    pub effort: String,
    pub permission_intent: String,
    pub permission_mechanism: String,
    pub launch_args: Vec<String>,
    #[serde(default)]
    pub knowledge_approvals: Vec<KnowledgeApproval>,
    pub eligible: bool,
    pub reason: String,
    pub constraints: Vec<String>,
    pub capabilities: Vec<String>,
    pub continuity: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct KnowledgeApproval {
    pub server: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    pub tool: String,
    pub approval_mode: String,
}

impl Resolution {
    pub fn knowledge_scope(&self) -> String {
        if self.knowledge_approvals.is_empty() {
            return String::new();
        }
        let mut scopes: Vec<String> = self
            .knowledge_approvals
            .iter()
            .map(|grant| {
                let category = if grant.server == "obsidian" {
                    "vault"
                } else {
                    "memory"
                };
                format!("{category}/{}", grant.tool)
            })
            .collect();
        scopes.sort();
        scopes.dedup();
        serde_json::to_string(&scopes).expect("string-only knowledge scope serializes")
    }
}

pub fn knowledge_args(resolution: &Resolution) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut claude_tools = Vec::new();
    for grant in &resolution.knowledge_approvals {
        let vault = grant.server == "obsidian" && grant.plugin.is_none();
        let memory = (resolution.agent == "claude"
            && grant.server == "plugin_claude-mem_mcp-search"
            && grant.plugin.is_none())
            || (resolution.agent == "codex"
                && grant.server == "mcp-search"
                && grant.plugin.as_deref() == Some("claude-mem@claude-mem-local"));
        let tool_allowed = if vault {
            matches!(
                grant.tool.as_str(),
                "read_note"
                    | "read_multiple_notes"
                    | "search_notes"
                    | "list_directory"
                    | "get_frontmatter"
                    | "get_notes_info"
                    | "get_vault_stats"
                    | "list_all_tags"
                    | "write_note"
                    | "patch_note"
                    | "update_frontmatter"
                    | "manage_tags"
            )
        } else if memory {
            matches!(
                grant.tool.as_str(),
                "search"
                    | "timeline"
                    | "get_observations"
                    | "get_tool_uses"
                    | "session_start_context"
                    | "smart_search"
                    | "smart_outline"
                    | "smart_unfold"
                    | "important_workflow"
                    | "list_corpora"
                    | "query_corpus"
                    | "observation_add"
                    | "observation_record_event"
                    | "observation_search"
                    | "observation_context"
                    | "observation_generation_status"
            )
        } else {
            false
        };
        if grant.approval_mode != "approve" || !tool_allowed {
            return Err("adaptive_policy_knowledge_grant_unsupported".into());
        }
        match resolution.agent.as_str() {
            "claude" => claude_tools.push(format!("mcp__{}__{}", grant.server, grant.tool)),
            "codex" => {
                // Codex CLI splits raw dotted paths; unlike TOML files, quoted key
                // segments are literal names. Every segment above is allowlisted.
                let prefix = match &grant.plugin {
                    Some(plugin) => format!("plugins.{plugin}.mcp_servers"),
                    None => "mcp_servers".to_string(),
                };
                args.push("-c".into());
                args.push(format!(
                    "{prefix}.{}.tools.{}.approval_mode=\"approve\"",
                    grant.server, grant.tool
                ));
            }
            _ => return Err("adaptive_policy_knowledge_provider_unsupported".into()),
        }
    }
    if !claude_tools.is_empty() {
        claude_tools.sort();
        claude_tools.dedup();
        args.extend(["--allowedTools".into(), claude_tools.join(",")]);
    }
    Ok(args)
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fingerprint {
    pub agent: String,
    pub model: String,
    pub effort: String,
    pub target_id: String,
    pub home_mode: String,
    pub policy_revision: String,
    #[serde(default)]
    pub knowledge_scope: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Continuation {
    pub previous: Fingerprint,
    pub switch_count: u8,
    #[serde(default)]
    pub freeze: bool,
}
impl Resolution {
    pub fn fingerprint(&self) -> Fingerprint {
        Fingerprint {
            agent: self.agent.clone(),
            model: self.model.clone(),
            effort: self.effort.clone(),
            target_id: self.target_id.clone(),
            home_mode: self.home_mode.clone(),
            policy_revision: self.policy_revision.clone(),
            knowledge_scope: self.knowledge_scope(),
        }
    }
    pub fn checkpoint(&self, freeze: bool) -> Continuation {
        Continuation {
            previous: self.fingerprint(),
            switch_count: self.switch_count,
            freeze,
        }
    }
}

fn continuation_count(metadata: Option<&Value>, resolution: &Resolution) -> Result<u8, String> {
    let Some(raw) = metadata.and_then(|metadata| metadata.get("adaptiveContinuation")) else {
        return Ok(0);
    };
    let continuation: Continuation = serde_json::from_value(raw.clone())
        .map_err(|e| format!("adaptive_policy_invalid_continuation: {e}"))?;
    if continuation.switch_count > 2 {
        return Err("adaptive_policy_invalid_switch_count".into());
    }
    let previous = &continuation.previous;
    if [
        previous.agent.as_str(),
        previous.model.as_str(),
        previous.effort.as_str(),
        previous.target_id.as_str(),
        previous.home_mode.as_str(),
        previous.policy_revision.as_str(),
    ]
    .iter()
    .any(|value| value.trim().is_empty())
    {
        return Err("adaptive_policy_invalid_checkpoint".into());
    }
    let previous_scope: Vec<String> = if previous.knowledge_scope.is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&previous.knowledge_scope)
            .map_err(|_| "adaptive_policy_invalid_knowledge_checkpoint")?
    };
    let current_scope: Vec<String> = if resolution.knowledge_scope().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&resolution.knowledge_scope())
            .map_err(|_| "adaptive_policy_invalid_knowledge_scope")?
    };
    if previous_scope
        .iter()
        .any(|scope| !current_scope.contains(scope))
    {
        return Err("adaptive_policy_knowledge_access_reduced: selected runtime lost previously available memory or vault tools; restore the bindings before continuing".into());
    }
    let changed = continuation.previous != resolution.fingerprint();
    if changed && continuation.freeze {
        return Err("adaptive_policy_configuration_changed: frozen configuration changed; start a new task or explicitly review the policy".into());
    }
    if changed && continuation.switch_count >= 2 {
        return Err("adaptive_policy_switch_limit: two configuration switches already used; start a new task or explicitly review the policy".into());
    }
    Ok(continuation.switch_count + u8::from(changed))
}

pub fn options(request: &CompletionRequest) -> Result<Option<PolicyOptions>, String> {
    options_with_fallback(request.metadata.as_ref(), || {
        crate::agents::read_global_ai_block().and_then(|ai| ai.get("adaptivePolicy").cloned())
    })
}

pub(crate) fn options_with_fallback(
    metadata: Option<&Value>,
    global: impl FnOnce() -> Option<Value>,
) -> Result<Option<PolicyOptions>, String> {
    let raw = metadata
        .and_then(|m| m.get("adaptivePolicy"))
        .cloned()
        .or_else(global);
    let Some(raw) = raw else { return Ok(None) };
    let options: PolicyOptions =
        serde_json::from_value(raw).map_err(|e| format!("adaptive_policy_invalid: {e}"))?;
    Ok(options.enabled.then_some(options))
}

pub fn resolve(request: &CompletionRequest, options: &PolicyOptions) -> Result<Resolution, String> {
    let dot = resolve_program("dot").ok_or("adaptive_policy_dot_missing")?;
    let mut cmd = Command::new(dot);
    cmd.args([
        "ai",
        "policy",
        "resolve",
        "--json",
        "--task",
        &request.prompt,
        "--workload",
        &options.workload,
        "--origin",
        "maru",
        "--project",
        &request.cwd,
        "--unattended",
    ]);
    if let Some(agent) = &options.agent {
        cmd.args(["--agent", agent]);
    }
    cmd.env("PATH", augmented_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .no_window();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("adaptive_policy_spawn: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("adaptive_policy_stdout_missing")?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = sender.send(result);
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err("adaptive_policy_resolve_failed".into());
                }
                break;
            }
            Ok(None) if start.elapsed() < Duration::from_secs(15) => {
                std::thread::sleep(Duration::from_millis(50))
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "adaptive_policy_timeout_or_wait_failed: {result:?}"
                ));
            }
        }
    }
    let bytes = receiver
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "adaptive_policy_reader_timeout")?
        .map_err(|e| e.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("adaptive_policy_output_too_large".into());
    }
    let mut resolution: Resolution = serde_json::from_slice(&bytes)
        .map_err(|e| format!("adaptive_policy_invalid_response: {e}"))?;
    validate(&resolution)?;
    resolution.switch_count = continuation_count(request.metadata.as_ref(), &resolution)?;
    Ok(resolution)
}

pub fn validate(resolution: &Resolution) -> Result<CliProviderKind, String> {
    if resolution.schema_version != 1
        || resolution.policy_revision.trim().is_empty()
        || resolution.target_id.trim().is_empty()
        || resolution.model.trim().is_empty()
        || !matches!(resolution.home_mode.as_str(), "native-default" | "pinned")
        || !resolution.eligible
        || resolution.permission_intent != "auto-review"
        || resolution.permission_mechanism != "native-auto-review"
        || resolution.billing != "subscription"
        || !resolution.billing_verified
        || !matches!(resolution.effort.as_str(), "low" | "medium" | "high")
    {
        return Err(format!("adaptive_policy_ineligible: {}", resolution.reason));
    }
    let provider = CliProviderKind::parse(&resolution.agent)?;
    if !matches!(provider, CliProviderKind::Claude | CliProviderKind::Codex) {
        return Err("adaptive_policy_auto_review_unsupported".into());
    }
    for value in [&resolution.model, &resolution.effort] {
        if value.len() > 200 || value.starts_with('-') || value.contains(['\n', '\r', '\0']) {
            return Err("adaptive_policy_invalid_model_option".into());
        }
    }
    knowledge_args(resolution)?;
    // launch_args is diagnostic only. Maru builds all flags from typed fields.
    Ok(provider)
}

/// Version/profile evidence must describe the exact native binary and config home
/// Maru will use. A resolver cannot redirect Maru to an arbitrary executable.
pub fn validate_target(
    resolution: &Resolution,
    executable: &std::ffi::OsStr,
) -> Result<(), String> {
    let actual =
        std::fs::canonicalize(executable).map_err(|_| "adaptive_policy_executable_missing")?;
    let inspected = std::fs::canonicalize(&resolution.executable)
        .map_err(|_| "adaptive_policy_inspected_executable_missing")?;
    if actual != inspected {
        return Err("adaptive_policy_executable_mismatch".into());
    }
    let (variable, suffix) = if resolution.agent == "codex" {
        ("CODEX_HOME", ".codex")
    } else {
        ("CLAUDE_CONFIG_DIR", ".claude")
    };
    let ambient = std::env::var_os(variable);
    if (resolution.home_mode == "native-default" && ambient.is_some())
        || (resolution.home_mode == "pinned" && ambient.is_none())
    {
        return Err("adaptive_policy_home_mode_mismatch".into());
    }
    let active_home = ambient
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(suffix)))
        .ok_or("adaptive_policy_home_missing")?;
    let active_home =
        std::fs::canonicalize(active_home).map_err(|_| "adaptive_policy_home_missing")?;
    let inspected_home = std::fs::canonicalize(&resolution.home)
        .map_err(|_| "adaptive_policy_inspected_home_missing")?;
    if active_home != inspected_home {
        return Err(
            "adaptive_policy_home_mismatch: select the active native configuration target".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn resolution() -> Resolution {
        serde_json::from_value(serde_json::json!({
            "schema_version": 1, "policy_revision": "test", "target_id": "native-claude", "workload": "implementation",
            "agent": "claude", "executable": "/usr/local/bin/claude", "home": "/tmp/.claude", "home_mode": "native-default", "version": "2.1.283", "billing": "subscription", "billing_verified": true, "model": "sonnet", "effort": "medium",
            "permission_intent": "auto-review", "permission_mechanism": "native-auto-review",
            "launch_args": [], "eligible": true, "reason": "validated", "constraints": [],
            "capabilities": [], "continuity": "checkpoint-handoff"
        }))
        .unwrap()
    }
    #[test]
    fn provider_switch_preserves_semantic_knowledge_scope_and_refuses_reduction() {
        let mut r = resolution();
        r.knowledge_approvals = vec![
            KnowledgeApproval {
                server: "obsidian".into(),
                plugin: None,
                tool: "write_note".into(),
                approval_mode: "approve".into(),
            },
            KnowledgeApproval {
                server: "plugin_claude-mem_mcp-search".into(),
                plugin: None,
                tool: "observation_add".into(),
                approval_mode: "approve".into(),
            },
        ];
        let scope = r.knowledge_scope();
        let metadata = serde_json::json!({"adaptiveContinuation": r.checkpoint(false)});
        r.agent = "codex".into();
        r.model = "gpt-5.4".into();
        r.knowledge_approvals[1].server = "mcp-search".into();
        r.knowledge_approvals[1].plugin = Some("claude-mem@claude-mem-local".into());
        assert_eq!(r.knowledge_scope(), scope);
        assert_eq!(continuation_count(Some(&metadata), &r).unwrap(), 1);
        let all = r.knowledge_approvals.clone();
        for index in [0, 1] {
            r.knowledge_approvals = all.clone();
            r.knowledge_approvals.remove(index);
            assert!(continuation_count(Some(&metadata), &r)
                .unwrap_err()
                .starts_with("adaptive_policy_knowledge_access_reduced"));
        }
        r.knowledge_approvals.clear();
        assert!(continuation_count(Some(&metadata), &r).is_err());
    }

    #[test]
    fn knowledge_grants_are_exact_and_scope_is_part_of_checkpoint() {
        let mut r = resolution();
        let before = serde_json::json!({"adaptiveContinuation": r.checkpoint(true)});
        r.knowledge_approvals = vec![KnowledgeApproval {
            server: "obsidian".into(),
            plugin: None,
            tool: "write_note".into(),
            approval_mode: "approve".into(),
        }];
        assert_eq!(
            knowledge_args(&r).unwrap(),
            vec!["--allowedTools", "mcp__obsidian__write_note"]
        );
        assert!(continuation_count(Some(&before), &r)
            .unwrap_err()
            .starts_with("adaptive_policy_configuration_changed"));
        for forbidden in ["delete_note", "move_note", "move_file", "*"] {
            r.knowledge_approvals[0].tool = forbidden.into();
            assert!(knowledge_args(&r).is_err());
        }
        r.knowledge_approvals[0].tool = "write_note".into();
        r.agent = "codex".into();
        assert_eq!(
            knowledge_args(&r).unwrap(),
            vec![
                "-c",
                "mcp_servers.obsidian.tools.write_note.approval_mode=\"approve\""
            ]
        );
        r.knowledge_approvals[0] = KnowledgeApproval {
            server: "mcp-search".into(),
            plugin: Some("claude-mem@claude-mem-local".into()),
            tool: "observation_add".into(),
            approval_mode: "approve".into(),
        };
        assert_eq!(knowledge_args(&r).unwrap(), vec!["-c", "plugins.claude-mem@claude-mem-local.mcp_servers.mcp-search.tools.observation_add.approval_mode=\"approve\""]);
        r.knowledge_approvals[0].server = "unregistered".into();
        assert!(knowledge_args(&r).is_err());
    }

    #[test]
    fn bounds_all_configuration_changes_and_freezes_exact_checkpoint() {
        let mut r = resolution();
        let checkpoint = r.checkpoint(false);
        let metadata = serde_json::json!({"adaptiveContinuation": checkpoint});
        assert_eq!(continuation_count(Some(&metadata), &r).unwrap(), 0);
        r.model = "opus".into();
        assert_eq!(continuation_count(Some(&metadata), &r).unwrap(), 1);
        let mut checkpoint = resolution().checkpoint(false);
        checkpoint.switch_count = 2;
        let metadata = serde_json::json!({"adaptiveContinuation": checkpoint});
        assert!(continuation_count(Some(&metadata), &r)
            .unwrap_err()
            .starts_with("adaptive_policy_switch_limit"));
        checkpoint.switch_count = 0;
        checkpoint.freeze = true;
        let metadata = serde_json::json!({"adaptiveContinuation": checkpoint});
        assert!(continuation_count(Some(&metadata), &r)
            .unwrap_err()
            .starts_with("adaptive_policy_configuration_changed"));
        r = resolution();
        r.effort = "high".into();
        assert!(continuation_count(Some(&metadata), &r).is_err());
        r = resolution();
        r.target_id = "other-home".into();
        assert!(continuation_count(Some(&metadata), &r).is_err());
        r = resolution();
        r.policy_revision = "updated".into();
        assert!(continuation_count(Some(&metadata), &r).is_err());
    }

    #[test]
    fn rejects_ineligible_and_unreviewed_providers() {
        let mut r = resolution();
        assert!(validate(&r).is_ok());
        r.eligible = false;
        assert!(validate(&r).is_err());
        r.eligible = true;
        for agent in ["kimi", "kiro", "qwen", "opencode", "grok"] {
            r.agent = agent.into();
            assert!(validate(&r).is_err(), "{agent}");
        }
    }
    #[test]
    fn rejects_unknown_schema_permission_and_injected_options() {
        let mut r = resolution();
        r.schema_version = 2;
        assert!(validate(&r).is_err());
        r = resolution();
        r.home_mode = "unknown".into();
        assert!(validate(&r).is_err());
        r = resolution();
        r.billing_verified = false;
        assert!(validate(&r).is_err());
        r = resolution();
        r.billing = "dgx".into();
        assert!(validate(&r).is_err());
        r = resolution();
        r.permission_mechanism = "bypass".into();
        assert!(validate(&r).is_err());
        r = resolution();
        r.model = "--dangerously-bypass-permissions".into();
        assert!(validate(&r).is_err());
        r = resolution();
        r.effort = "high\"\nother=true".into();
        assert!(validate(&r).is_err());
    }
    #[test]
    fn rejects_executable_redirection_before_using_native_home() {
        let temp = tempfile::tempdir().unwrap();
        let actual = temp.path().join("actual");
        let redirected = temp.path().join("redirected");
        std::fs::write(&actual, "native").unwrap();
        std::fs::write(&redirected, "other").unwrap();
        let mut r = resolution();
        r.executable = redirected.to_string_lossy().into_owned();
        assert_eq!(
            validate_target(&r, actual.as_os_str()).unwrap_err(),
            "adaptive_policy_executable_mismatch"
        );
    }

    #[test]
    fn explicit_disable_and_malformed_override_do_not_inherit_global() {
        let mut request = CompletionRequest {
            schema_version: super::super::contracts::COMPLETION_REQUEST_SCHEMA_VERSION.into(),
            provider: "claude".into(),
            prompt: "hello".into(),
            cwd: "/tmp".into(),
            mode: "background".into(),
            metadata: Some(serde_json::json!({"adaptivePolicy":{"enabled":false}})),
        };
        assert!(options(&request).unwrap().is_none());
        request.metadata = Some(serde_json::json!({"adaptivePolicy":{"enabled":"yes"}}));
        assert!(options(&request).is_err());
    }
}
