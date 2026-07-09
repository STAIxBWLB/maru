use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use crate::agent_host::contracts::{
    CompletionRequest, CompletionResponse, COMPLETION_RESPONSE_SCHEMA_VERSION,
};
use crate::cli_path::{augmented_path, resolve_program};
use crate::win_process::NoWindow;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub provider: String,
    pub streaming: bool,
    pub cli: bool,
    pub proposal_only: bool,
    pub autonomous_writes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStreamEvent {
    pub stream: String,
    pub line: String,
}

pub trait ProviderAdapter {
    fn id(&self) -> &str;
    fn capabilities(&self) -> ProviderCapabilities;
    fn complete(&mut self, request: CompletionRequest) -> Result<CompletionResponse, String>;
    fn stream(&mut self, request: CompletionRequest) -> Result<Vec<ProviderStreamEvent>, String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliProviderKind {
    Claude,
    Codex,
}

impl CliProviderKind {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_lowercase().as_str() {
            "claude" | "claude-code" => Ok(Self::Claude),
            "codex" | "codex-cli" => Ok(Self::Codex),
            other => Err(format!("unsupported_provider: {other}")),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn capabilities(self) -> ProviderCapabilities {
        ProviderCapabilities {
            provider: self.id().to_string(),
            streaming: true,
            cli: true,
            proposal_only: true,
            autonomous_writes: false,
        }
    }
}

/// User-facing AI permission modes shared by Claude and Codex command builders.
/// Unknown/empty input falls back to the safe `plan` default.
pub fn normalize_permission_mode(value: &str) -> &'static str {
    match value.trim() {
        "acceptEdits" => "acceptEdits",
        "bypassPermissions" => "bypassPermissions",
        "default" => "default",
        _ => "plan",
    }
}

fn apply_codex_permission_args(cmd: &mut Command, permission_mode: &str) {
    match normalize_permission_mode(permission_mode) {
        "plan" => {
            cmd.arg("--sandbox").arg("read-only");
        }
        "acceptEdits" => {
            cmd.arg("--sandbox").arg("workspace-write");
        }
        "default" => {}
        "bypassPermissions" => {
            cmd.arg("--dangerously-bypass-approvals-and-sandbox");
        }
        _ => unreachable!("normalize_permission_mode only returns known modes"),
    }
}

fn apply_provider_env(cmd: &mut Command) {
    cmd.env("PATH", augmented_path());
}

pub fn build_cli_command(
    provider: CliProviderKind,
    request: &CompletionRequest,
    add_dirs: &[String],
    command_override: Option<&str>,
    permission_mode: &str,
) -> Result<(Command, Option<String>), String> {
    request.validate()?;
    match provider {
        CliProviderKind::Claude => {
            let bin = resolve_provider_binary(provider, command_override).ok_or_else(|| {
                "cli_missing: claude CLI not found in PATH or common install locations".to_string()
            })?;
            let mut cmd = Command::new(bin);
            apply_provider_env(&mut cmd);
            cmd.arg("-p")
                .arg(&request.prompt)
                .arg("--permission-mode")
                .arg(normalize_permission_mode(permission_mode))
                .stdin(Stdio::null());
            for dir in add_dirs {
                cmd.arg("--add-dir").arg(dir);
            }
            Ok((cmd, None))
        }
        CliProviderKind::Codex => {
            let bin = resolve_provider_binary(provider, command_override).ok_or_else(|| {
                "cli_missing: codex CLI not found in PATH or common install locations".to_string()
            })?;
            let mut cmd = Command::new(bin);
            apply_provider_env(&mut cmd);
            cmd.arg("exec");
            apply_codex_permission_args(&mut cmd, permission_mode);
            cmd.arg("--cd").arg(&request.cwd);
            for dir in add_dirs {
                cmd.arg("--add-dir").arg(dir);
            }
            cmd.arg("-");
            Ok((cmd, Some(request.prompt.clone())))
        }
    }
}

pub fn resolve_provider_binary(
    provider: CliProviderKind,
    command_override: Option<&str>,
) -> Option<PathBuf> {
    command_override
        .and_then(resolve_program)
        .or_else(|| resolve_program(provider.id()))
}

/// Real `ProviderAdapter` that drives a CLI provider (Claude/Codex) synchronously:
/// `complete` spawns the command via [`build_cli_command`], pipes the prompt to
/// stdin when required, blocks on `wait_with_output` (which drains both pipes —
/// no deadlock; the five-role loop calls roles sequentially), and returns stdout
/// as the completion content. Used by the structured-loop command.
#[derive(Debug, Clone)]
pub struct CliProviderAdapter {
    provider: CliProviderKind,
    add_dirs: Vec<String>,
    command_override: Option<String>,
    permission_mode: String,
}

impl CliProviderAdapter {
    pub fn new(
        provider: CliProviderKind,
        add_dirs: Vec<String>,
        command_override: Option<String>,
        permission_mode: String,
    ) -> Self {
        Self {
            provider,
            add_dirs,
            command_override,
            permission_mode,
        }
    }
}

impl ProviderAdapter for CliProviderAdapter {
    fn id(&self) -> &str {
        self.provider.id()
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.provider.capabilities()
    }

    fn complete(&mut self, request: CompletionRequest) -> Result<CompletionResponse, String> {
        let (mut cmd, stdin_payload) = build_cli_command(
            self.provider,
            &request,
            &self.add_dirs,
            self.command_override.as_deref(),
            &self.permission_mode,
        )?;
        cmd.current_dir(&request.cwd)
            .stdin(if stdin_payload.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window();
        let mut child = spawn_with_retry(&mut cmd).map_err(|err| spawn_error_kind(&err))?;
        if let Some(payload) = stdin_payload {
            if let Some(mut stdin) = child.stdin.take() {
                use std::io::Write;
                let _ = stdin.write_all(payload.as_bytes());
                // `stdin` drops here, closing the pipe so the child sees EOF.
            }
        }
        let output = child
            .wait_with_output()
            .map_err(|err| format!("wait_failed: {err}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let kind = classify_cli_error(&stderr);
            let first = stderr
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("")
                .trim();
            return Err(format!("{kind}: exit {:?}: {first}", output.status.code()));
        }
        Ok(CompletionResponse {
            schema_version: COMPLETION_RESPONSE_SCHEMA_VERSION.to_string(),
            provider: self.provider.id().to_string(),
            content: String::from_utf8_lossy(&output.stdout).into_owned(),
            stop_reason: Some("cli".to_string()),
            usage: None,
        })
    }

    fn stream(&mut self, request: CompletionRequest) -> Result<Vec<ProviderStreamEvent>, String> {
        let response = self.complete(request)?;
        Ok(vec![ProviderStreamEvent {
            stream: "stdout".to_string(),
            line: response.content,
        }])
    }
}

/// Spawn a command, retrying briefly on `ETXTBSY` (os error 26). That error is a
/// transient race in a multithreaded process that writes an executable and
/// fork/execs concurrently: a fork in another thread can hold the just-written
/// file's writable fd across our exec. The other child execs microseconds later
/// (closing the fd), so a short bounded retry clears it. Non-`ETXTBSY` errors
/// (and success) return immediately.
fn spawn_with_retry(cmd: &mut Command) -> std::io::Result<Child> {
    let mut attempts = 0u32;
    loop {
        match cmd.spawn() {
            Err(err) if err.raw_os_error() == Some(26) && attempts < 5 => {
                attempts += 1;
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            other => return other,
        }
    }
}

fn spawn_error_kind(err: &std::io::Error) -> String {
    let kind = if err.kind() == std::io::ErrorKind::NotFound {
        "cli_missing"
    } else if err.kind() == std::io::ErrorKind::PermissionDenied {
        "permission_denied"
    } else {
        "spawn_failed"
    };
    format!("{kind}: {err}")
}

fn classify_cli_error(text: &str) -> &'static str {
    let lower = text.to_lowercase();
    if lower.contains("auth")
        || lower.contains("login")
        || lower.contains("not logged in")
        || lower.contains("api key")
        || lower.contains("unauthorized")
    {
        "auth_required"
    } else if lower.contains("permission") || lower.contains("denied") {
        "permission_denied"
    } else if lower.contains("not found") || lower.contains("cli_missing") {
        "cli_missing"
    } else {
        "runtime_failed"
    }
}

#[derive(Debug, Clone)]
pub struct MockProviderAdapter {
    id: String,
    responses: Vec<String>,
    calls: usize,
}

impl MockProviderAdapter {
    pub fn new(responses: Vec<String>) -> Self {
        Self {
            id: "mock".to_string(),
            responses,
            calls: 0,
        }
    }

    pub fn calls(&self) -> usize {
        self.calls
    }
}

impl ProviderAdapter for MockProviderAdapter {
    fn id(&self) -> &str {
        &self.id
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            provider: self.id.clone(),
            streaming: false,
            cli: false,
            proposal_only: true,
            autonomous_writes: false,
        }
    }

    fn complete(&mut self, request: CompletionRequest) -> Result<CompletionResponse, String> {
        request.validate()?;
        let content = self
            .responses
            .get(self.calls)
            .cloned()
            .unwrap_or_else(|| "{}".to_string());
        self.calls += 1;
        Ok(CompletionResponse {
            schema_version: COMPLETION_RESPONSE_SCHEMA_VERSION.to_string(),
            provider: self.id.clone(),
            content,
            stop_reason: Some("mock".to_string()),
            usage: None,
        })
    }

    fn stream(&mut self, request: CompletionRequest) -> Result<Vec<ProviderStreamEvent>, String> {
        let response = self.complete(request)?;
        Ok(vec![ProviderStreamEvent {
            stream: "stdout".to_string(),
            line: response.content,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_host::contracts::COMPLETION_REQUEST_SCHEMA_VERSION;

    #[test]
    fn mock_provider_validates_request_schema() {
        let mut adapter = MockProviderAdapter::new(vec!["ok".to_string()]);
        let response = adapter
            .complete(CompletionRequest {
                schema_version: COMPLETION_REQUEST_SCHEMA_VERSION.to_string(),
                provider: "mock".to_string(),
                prompt: "hello".to_string(),
                cwd: "/tmp".to_string(),
                mode: "background".to_string(),
                metadata: None,
            })
            .unwrap();
        assert_eq!(response.content, "ok");
        assert_eq!(adapter.calls(), 1);
    }

    #[test]
    fn provider_kind_accepts_cli_aliases() {
        assert_eq!(
            CliProviderKind::parse("claude-code").unwrap(),
            CliProviderKind::Claude
        );
        assert_eq!(
            CliProviderKind::parse("codex-cli").unwrap(),
            CliProviderKind::Codex
        );
        assert!(CliProviderKind::parse("openai").is_err());
    }

    #[cfg(unix)]
    fn write_fake_cli(path: std::path::PathBuf, script: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&path, script).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[cfg(unix)]
    fn completion_request(prompt: &str, cwd: &str) -> CompletionRequest {
        CompletionRequest {
            schema_version: COMPLETION_REQUEST_SCHEMA_VERSION.to_string(),
            provider: "cli".to_string(),
            prompt: prompt.to_string(),
            cwd: cwd.to_string(),
            mode: "autonomous-loop".to_string(),
            metadata: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn cli_adapter_claude_returns_stdout_as_content() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(
            dir.path().join("fake-claude"),
            "#!/bin/sh\necho '{\"ok\":true}'\n",
        );
        let mut adapter = CliProviderAdapter::new(
            CliProviderKind::Claude,
            vec![dir.path().to_string_lossy().into_owned()],
            Some(cli.to_string_lossy().into_owned()),
            "plan".to_string(),
        );
        let response = adapter
            .complete(completion_request("do work", dir.path().to_str().unwrap()))
            .unwrap();
        assert_eq!(response.content.trim(), "{\"ok\":true}");
        assert_eq!(response.provider, "claude");
    }

    #[cfg(unix)]
    #[test]
    fn cli_adapter_codex_pipes_prompt_over_stdin() {
        let dir = tempfile::tempdir().unwrap();
        // `cat` (no args) echoes whatever is piped to stdin; the codex argv is ignored.
        let cli = write_fake_cli(dir.path().join("fake-codex"), "#!/bin/sh\ncat\n");
        let mut adapter = CliProviderAdapter::new(
            CliProviderKind::Codex,
            vec![dir.path().to_string_lossy().into_owned()],
            Some(cli.to_string_lossy().into_owned()),
            "plan".to_string(),
        );
        let response = adapter
            .complete(completion_request(
                "PROMPT-MARKER",
                dir.path().to_str().unwrap(),
            ))
            .unwrap();
        assert_eq!(response.content.trim(), "PROMPT-MARKER");
        assert_eq!(response.provider, "codex");
    }

    #[cfg(unix)]
    #[test]
    fn cli_adapter_maps_nonzero_exit_to_typed_error() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(
            dir.path().join("fake-claude"),
            "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n",
        );
        let mut adapter = CliProviderAdapter::new(
            CliProviderKind::Claude,
            vec![dir.path().to_string_lossy().into_owned()],
            Some(cli.to_string_lossy().into_owned()),
            "plan".to_string(),
        );
        let err = adapter
            .complete(completion_request("do work", dir.path().to_str().unwrap()))
            .unwrap_err();
        assert!(err.starts_with("auth_required"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn cli_adapter_validates_request() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(dir.path().join("fake-claude"), "#!/bin/sh\nexit 0\n");
        let mut adapter = CliProviderAdapter::new(
            CliProviderKind::Claude,
            vec![],
            Some(cli.to_string_lossy().into_owned()),
            "plan".to_string(),
        );
        let err = adapter
            .complete(completion_request("   ", dir.path().to_str().unwrap()))
            .unwrap_err();
        assert_eq!(err, "completion_prompt_required");
    }

    #[cfg(unix)]
    #[test]
    fn build_cli_command_carries_augmented_path_for_env_node_wrappers() {
        let dir = tempfile::tempdir().unwrap();
        let bin_dir = dir.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let fake_node = write_fake_cli(
            bin_dir.join("node"),
            "#!/bin/sh\nprintf 'fake-node-ok\\n'\n",
        );
        let provider = write_fake_cli(
            dir.path().join("fake-claude"),
            "#!/usr/bin/env node\nthis is intentionally not valid javascript\n",
        );

        let old_path = std::env::var_os("PATH");
        let mut path_with_fake_node = bin_dir.as_os_str().to_os_string();
        if let Some(value) = old_path.as_ref() {
            path_with_fake_node.push(":");
            path_with_fake_node.push(value);
        }
        std::env::set_var("PATH", &path_with_fake_node);
        let (mut cmd, _stdin) = build_cli_command(
            CliProviderKind::Claude,
            &completion_request("hi", dir.path().to_str().unwrap()),
            &[],
            Some(provider.to_str().unwrap()),
            "plan",
        )
        .unwrap();
        if let Some(value) = old_path.as_ref() {
            std::env::set_var("PATH", value);
        } else {
            std::env::remove_var("PATH");
        }

        let explicit_path = cmd
            .get_envs()
            .find_map(|(key, value)| (key == "PATH").then_some(value.unwrap()))
            .unwrap();
        let explicit_entries: Vec<_> = std::env::split_paths(explicit_path).collect();
        assert!(explicit_entries.contains(&bin_dir));
        assert_eq!(fake_node, bin_dir.join("node"));

        let output = cmd
            .current_dir(dir.path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "fake-node-ok"
        );
    }

    #[test]
    fn permission_mode_normalizes_unknown_to_plan() {
        assert_eq!(normalize_permission_mode("acceptEdits"), "acceptEdits");
        assert_eq!(
            normalize_permission_mode("bypassPermissions"),
            "bypassPermissions"
        );
        assert_eq!(normalize_permission_mode("default"), "default");
        assert_eq!(normalize_permission_mode(""), "plan");
        assert_eq!(normalize_permission_mode("nonsense"), "plan");
    }

    #[cfg(unix)]
    #[test]
    fn build_cli_command_applies_permission_mode_for_claude() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(dir.path().join("fake-claude"), "#!/bin/sh\nexit 0\n");
        let (cmd, _stdin) = build_cli_command(
            CliProviderKind::Claude,
            &completion_request("hi", dir.path().to_str().unwrap()),
            &[],
            Some(cli.to_str().unwrap()),
            "acceptEdits",
        )
        .unwrap();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[idx + 1], "acceptEdits");
    }

    #[cfg(unix)]
    #[test]
    fn build_cli_command_applies_permission_mode_for_codex() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(dir.path().join("fake-codex"), "#!/bin/sh\nexit 0\n");
        let request = completion_request("hi", dir.path().to_str().unwrap());

        let (plan_cmd, _stdin) = build_cli_command(
            CliProviderKind::Codex,
            &request,
            &[],
            Some(cli.to_str().unwrap()),
            "plan",
        )
        .unwrap();
        let plan_args: Vec<String> = plan_cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(plan_args
            .windows(2)
            .any(|pair| pair == ["--sandbox", "read-only"]));

        let (write_cmd, _stdin) = build_cli_command(
            CliProviderKind::Codex,
            &request,
            &[],
            Some(cli.to_str().unwrap()),
            "acceptEdits",
        )
        .unwrap();
        let write_args: Vec<String> = write_cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(write_args
            .windows(2)
            .any(|pair| pair == ["--sandbox", "workspace-write"]));

        let (default_cmd, _stdin) = build_cli_command(
            CliProviderKind::Codex,
            &request,
            &[],
            Some(cli.to_str().unwrap()),
            "default",
        )
        .unwrap();
        let default_args: Vec<String> = default_cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(!default_args.iter().any(|arg| arg == "--sandbox"));

        let (bypass_cmd, _stdin) = build_cli_command(
            CliProviderKind::Codex,
            &request,
            &[],
            Some(cli.to_str().unwrap()),
            "bypassPermissions",
        )
        .unwrap();
        let bypass_args: Vec<String> = bypass_cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(bypass_args
            .iter()
            .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox"));
    }
}
