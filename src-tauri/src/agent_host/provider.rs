use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use crate::agent_host::contracts::{
    CompletionRequest, CompletionResponse, COMPLETION_RESPONSE_SCHEMA_VERSION,
};
use crate::agent_host::usage::{parse_claude_json_result, UsageReceipt};
use crate::cli_path::{augmented_path, resolve_program};
use crate::win_process::NoWindow;

use super::runtime_policy::Resolution;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
/// What a backend can actually do. Only flags a gate reads live here — a flag
/// that is the same for every backend is a comment with a runtime cost.
/// Mirrored in `src/lib/agentCapabilities.ts`; `agentCapabilities.test.ts`
/// parses this file and fails the build if the two disagree.
pub struct ProviderCapabilities {
    pub provider: String,
    /// Native session resume (`--resume` / `resume` / `--session`).
    pub resume: bool,
    /// A machine-readable usage/quota source exists.
    pub usage: bool,
    /// Accepts `--add-dir` for extra readable roots.
    pub add_dirs: bool,
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
    Kimi,
    Kiro,
}

impl CliProviderKind {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_lowercase().as_str() {
            "claude" | "claude-code" => Ok(Self::Claude),
            "codex" | "codex-cli" => Ok(Self::Codex),
            "kimi" | "kimi-code" => Ok(Self::Kimi),
            "kiro" | "kiro-cli" => Ok(Self::Kiro),
            other => Err(format!("unsupported_provider: {other}")),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Kimi => "kimi",
            Self::Kiro => "kiro",
        }
    }

    /// Binary name used when no command override is configured. Differs from
    /// [`CliProviderKind::id`] for Kiro (`kiro` id, `kiro-cli` binary).
    pub fn default_binary_name(self) -> &'static str {
        match self {
            Self::Kiro => "kiro-cli",
            _ => self.id(),
        }
    }

    pub fn capabilities(self) -> ProviderCapabilities {
        let provider = self.id().to_string();
        match self {
            Self::Claude => ProviderCapabilities {
                provider,
                resume: true,
                usage: true,
                add_dirs: true,
            },
            Self::Codex => ProviderCapabilities {
                provider,
                resume: true,
                usage: true,
                add_dirs: true,
            },
            Self::Kimi => ProviderCapabilities {
                provider,
                resume: true,
                usage: false,
                add_dirs: true,
            },
            // kiro-cli has no resume flag, no usage/quota output, and no
            // --add-dir; its working directory is the process cwd.
            Self::Kiro => ProviderCapabilities {
                provider,
                resume: false,
                usage: false,
                add_dirs: false,
            },
        }
    }
}

/// User-facing AI permission modes shared by the CLI command builders.
/// Unknown/empty input falls back to the safe `plan` default.
pub fn normalize_permission_mode(value: &str) -> &'static str {
    match value.trim() {
        "auto-review" => "auto-review",
        "acceptEdits" => "acceptEdits",
        "bypassPermissions" => "bypassPermissions",
        "default" => "default",
        _ => "plan",
    }
}

fn apply_codex_permission_args(cmd: &mut Command, permission_mode: &str) {
    match normalize_permission_mode(permission_mode) {
        "auto-review" => {
            cmd.arg("--approve-for-me");
        }
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

fn apply_kimi_permission_args(cmd: &mut Command, permission_mode: &str) {
    match normalize_permission_mode(permission_mode) {
        "plan" => {
            cmd.arg("--plan");
        }
        "acceptEdits" => {
            cmd.arg("-y");
        }
        "bypassPermissions" => {
            cmd.arg("--auto");
        }
        "default" => {}
        _ => unreachable!("normalize_permission_mode only returns known modes"),
    }
}

fn apply_kiro_permission_args(cmd: &mut Command, permission_mode: &str) {
    match normalize_permission_mode(permission_mode) {
        "plan" => {
            cmd.arg("--trust-tools=read,grep");
        }
        "acceptEdits" => {
            cmd.arg("--trust-tools=read,grep,write");
        }
        "bypassPermissions" => {
            cmd.arg("--trust-all-tools");
        }
        "default" => {}
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
    build_cli_command_with_policy(
        provider,
        request,
        add_dirs,
        command_override,
        permission_mode,
    )
    .map(|(cmd, stdin, _)| (cmd, stdin))
}

type PolicyCommand = (
    Command,
    Option<String>,
    Option<super::runtime_policy::Resolution>,
);

pub fn build_cli_command_with_policy(
    provider: CliProviderKind,
    request: &CompletionRequest,
    add_dirs: &[String],
    command_override: Option<&str>,
    permission_mode: &str,
) -> Result<PolicyCommand, String> {
    request.validate()?;
    build_cli_command_with_session(
        provider,
        request,
        add_dirs,
        command_override,
        permission_mode,
        None,
    )
}

pub(crate) fn build_cli_command_with_session(
    provider: CliProviderKind,
    request: &CompletionRequest,
    add_dirs: &[String],
    command_override: Option<&str>,
    permission_mode: &str,
    session: Option<&crate::skill_host::session::BundleSession>,
) -> Result<PolicyCommand, String> {
    let mut bound_request = request.clone();
    if let Some(session) = session {
        bound_request.prompt = session.prompt(&request.prompt)?;
    }
    let request = &bound_request;
    request.validate()?;
    let policy = super::runtime_policy::options(request)?;
    let resolution = policy
        .as_ref()
        .map(|options| super::runtime_policy::resolve(request, options))
        .transpose()?;
    let provider = resolution
        .as_ref()
        .map(super::runtime_policy::validate)
        .transpose()?
        .unwrap_or(provider);
    if resolution.is_some() && command_override.is_some() {
        return Err("adaptive_policy_command_override_forbidden".into());
    }
    // Explicit plan restrictions (including source review and schedules) remain binding.
    let permission_mode = if resolution.is_some() && permission_mode != "plan" {
        "auto-review"
    } else {
        permission_mode
    };
    if permission_mode == "auto-review"
        && !matches!(provider, CliProviderKind::Claude | CliProviderKind::Codex)
    {
        return Err("auto_review_unsupported_for_provider".into());
    }
    let (mut cmd, stdin_payload) = match provider {
        CliProviderKind::Claude => {
            let bin = resolve_provider_binary(provider, command_override).ok_or_else(|| {
                "cli_missing: claude CLI not found in PATH or common install locations".to_string()
            })?;
            let mut cmd = Command::new(bin);
            apply_provider_env(&mut cmd);
            cmd.arg("-p")
                .arg(&request.prompt)
                .arg("--permission-mode")
                .arg(if permission_mode == "auto-review" {
                    "auto"
                } else {
                    normalize_permission_mode(permission_mode)
                })
                .stdin(Stdio::null());
            for dir in add_dirs {
                cmd.arg("--add-dir").arg(dir);
            }
            (cmd, None)
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
            (cmd, Some(request.prompt.clone()))
        }
        CliProviderKind::Kimi => {
            let bin = resolve_provider_binary(provider, command_override).ok_or_else(|| {
                "cli_missing: kimi CLI not found in PATH or common install locations".to_string()
            })?;
            let mut cmd = Command::new(bin);
            apply_provider_env(&mut cmd);
            apply_kimi_permission_args(&mut cmd, permission_mode);
            cmd.arg("-p").arg(&request.prompt);
            for dir in add_dirs {
                cmd.arg("--add-dir").arg(dir);
            }
            cmd.stdin(Stdio::null());
            (cmd, None)
        }
        CliProviderKind::Kiro => {
            let bin = resolve_provider_binary(provider, command_override).ok_or_else(|| {
                "cli_missing: kiro-cli not found in PATH or common install locations".to_string()
            })?;
            let mut cmd = Command::new(bin);
            apply_provider_env(&mut cmd);
            cmd.arg("chat").arg("--no-interactive");
            apply_kiro_permission_args(&mut cmd, permission_mode);
            // kiro-cli has no --cd/--add-dir: the working dir comes from the
            // process cwd, set by the spawn site (`current_dir`).
            cmd.arg(&request.prompt).stdin(Stdio::null());
            (cmd, None)
        }
    };
    if let Some(resolution) = &resolution {
        super::runtime_policy::validate_target(resolution, cmd.get_program())?;
        cmd.args(super::runtime_policy::knowledge_args(resolution)?);
        if !resolution.model.is_empty() {
            cmd.arg("--model").arg(&resolution.model);
        }
        if !resolution.effort.is_empty() {
            match provider {
                CliProviderKind::Claude => {
                    cmd.arg("--effort").arg(&resolution.effort);
                }
                CliProviderKind::Codex => {
                    cmd.arg("-c")
                        .arg(format!("model_reasoning_effort={:?}", resolution.effort));
                }
                _ => unreachable!(),
            }
        }
    }
    crate::agent_runtime_env::apply_to_command(&mut cmd, Path::new(&request.cwd))?;
    if let Some(session) = session {
        cmd.envs(session.env(Some(Path::new(&request.cwd)))?);
    }
    Ok((cmd, stdin_payload, resolution))
}

pub fn resolve_provider_binary(
    provider: CliProviderKind,
    command_override: Option<&str>,
) -> Option<PathBuf> {
    command_override
        .and_then(resolve_program)
        .or_else(|| resolve_program(provider.default_binary_name()))
}

/// Which machine-readable output a CLI call asks for, so its usage can be read
/// back (maru#431). Both the synchronous adapter (slice 1) and the background
/// dispatcher (slice 2) go through [`apply_usage_output_flags`]: the flag sets
/// differ, and a second copy of them would drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UsageOutputMode {
    /// One JSON result object printed when the call ends (slice 1). Cheap, but
    /// silent until then.
    Result,
    /// One JSON event per line, so assistant text reaches the caller while the
    /// run is still going (slice 2).
    Stream,
}

/// Add the flags that make `cmd` report usage, for the provider that will
/// actually run. Returns the mode to expect from stdout, or `None` for a
/// provider with no machine-readable usage: that call keeps its plain output
/// and its run records an `unavailable` receipt, never a fabricated zero.
pub(crate) fn apply_usage_output_flags(
    cmd: &mut Command,
    provider_id: &str,
    mode: UsageOutputMode,
) -> Option<UsageOutputMode> {
    if provider_id != CliProviderKind::Claude.id() {
        return None;
    }
    match mode {
        UsageOutputMode::Result => {
            cmd.arg("--output-format").arg("json");
        }
        UsageOutputMode::Stream => {
            // Print mode takes `stream-json` only together with `--verbose`.
            cmd.arg("--output-format")
                .arg("stream-json")
                .arg("--verbose");
        }
    }
    Some(mode)
}

/// The provider whose CLI will actually run: the adaptive-policy target when
/// one was resolved, the requested provider otherwise. Asking the requested
/// provider about output format is the wrong question as soon as a reroute
/// exists — Claude's flags on a codex command fail the call, and codex's
/// absence of flags on a claude command loses its usage (maru#431).
pub(crate) fn effective_provider_id<'a>(
    requested: &'a str,
    resolution: Option<&'a Resolution>,
) -> &'a str {
    resolution
        .map(|resolution| resolution.agent.as_str())
        .unwrap_or(requested)
}

/// Ask for the synchronous adapter's machine-readable output, from the provider
/// that will actually run. Returns whether this call now prints a result object.
fn apply_requested_usage_flags(
    cmd: &mut Command,
    requested: CliProviderKind,
    resolution: Option<&Resolution>,
) -> bool {
    let provider = effective_provider_id(requested.id(), resolution);
    apply_usage_output_flags(cmd, provider, UsageOutputMode::Result).is_some()
}

/// Real `ProviderAdapter` that drives a CLI provider (Claude/Codex/Kimi/Kiro)
/// synchronously:
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
    metadata: Option<serde_json::Value>,
    bundle_session: Option<crate::skill_host::session::BundleSession>,
    /// One usage receipt per `complete` call that reached the CLI, success or
    /// failure (maru#431). Drained by the run owner into `usage.recorded` events.
    usage_receipts: Vec<UsageReceipt>,
    /// `(cwd, run_id)`: when set, each receipt is appended to that run's event
    /// log as soon as its call ends, so a process stop mid-loop keeps the
    /// usage of finished calls.
    usage_sink: Option<(String, String)>,
    task_execution: Option<crate::task_execution_runtime::TaskExecutionSession>,
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
            metadata: None,
            bundle_session: None,
            usage_receipts: Vec::new(),
            usage_sink: None,
            task_execution: None,
        }
    }
}

impl CliProviderAdapter {
    pub(crate) fn with_bundle_session(
        mut self,
        session: Option<crate::skill_host::session::BundleSession>,
    ) -> Self {
        self.bundle_session = session;
        self
    }

    pub(crate) fn with_task_execution(
        mut self,
        session: Option<crate::task_execution_runtime::TaskExecutionSession>,
    ) -> Self {
        self.task_execution = session;
        self
    }

    /// Persist each receipt to `run_id`'s event log as soon as its call ends.
    pub fn with_usage_sink(mut self, cwd: String, run_id: String) -> Self {
        self.usage_sink = Some((cwd, run_id));
        self
    }

    fn record_usage(&mut self, receipt: UsageReceipt) {
        let Some((cwd, run_id)) = &self.usage_sink else {
            self.usage_receipts.push(receipt);
            return;
        };
        if let Err(err) = append_usage_receipt(cwd, run_id, &receipt) {
            // Keep it for `flush_pending_usage`; the same receiptId makes a
            // later double write harmless.
            eprintln!("maru: usage receipt not recorded for run {run_id}: {err}");
            self.usage_receipts.push(receipt);
        }
    }

    /// Retry receipts whose sink append failed. Returns how many are still
    /// unrecorded. No-op without a sink.
    pub fn flush_pending_usage(&mut self) -> usize {
        let Some((cwd, run_id)) = self.usage_sink.clone() else {
            return 0;
        };
        let pending = std::mem::take(&mut self.usage_receipts);
        for receipt in pending {
            if let Err(err) = append_usage_receipt(&cwd, &run_id, &receipt) {
                eprintln!("maru: usage receipt retry failed for run {run_id}: {err}");
                self.usage_receipts.push(receipt);
            }
        }
        self.usage_receipts.len()
    }

    /// Receipts not yet persisted, oldest first: every receipt without a sink,
    /// or the ones whose sink append failed.
    pub fn take_usage_receipts(&mut self) -> Vec<UsageReceipt> {
        std::mem::take(&mut self.usage_receipts)
    }

    pub fn with_metadata(mut self, metadata: Option<serde_json::Value>) -> Self {
        self.metadata = metadata;
        self
    }
}

fn append_usage_receipt(cwd: &str, run_id: &str, receipt: &UsageReceipt) -> Result<(), String> {
    crate::agent_host::event_store::append_run_event_payload(
        cwd,
        run_id,
        crate::agent_host::usage::USAGE_RECORDED_EVENT,
        &receipt.provider,
        serde_json::json!({ "receipt": receipt }),
    )
    .map(|_| ())
}

impl ProviderAdapter for CliProviderAdapter {
    fn id(&self) -> &str {
        self.provider.id()
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.provider.capabilities()
    }

    fn complete(&mut self, mut request: CompletionRequest) -> Result<CompletionResponse, String> {
        if self.metadata.is_some() {
            request.metadata = self.metadata.clone();
        }
        let (mut cmd, stdin_payload, resolution) = build_cli_command_with_session(
            self.provider,
            &request,
            &self.add_dirs,
            self.command_override.as_deref(),
            &self.permission_mode,
            self.bundle_session.as_ref(),
        )
        .inspect_err(|_| {
            if let Some(session) = &self.task_execution {
                session.admission_failed();
            }
        })?;
        // First usage slice (maru#431): Claude prints one JSON result object
        // carrying both the answer and its usage. The resolution decides which
        // CLI runs, so it decides the flags; other providers stay plain.
        let json_usage = apply_requested_usage_flags(&mut cmd, self.provider, resolution.as_ref());
        if let Some(session) = &self.task_execution {
            session.record_provider(CliProviderKind::parse(effective_provider_id(
                self.provider.id(),
                resolution.as_ref(),
            ))?)?;
        }
        cmd.current_dir(&request.cwd)
            .stdin(if stdin_payload.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window();
        let mut child = if let Some(session) = &self.task_execution {
            session
                .spawn_child(|| spawn_with_retry(&mut cmd).map_err(|err| spawn_error_kind(&err)))?
        } else {
            spawn_with_retry(&mut cmd).map_err(|err| spawn_error_kind(&err))?
        };
        if let Some(payload) = stdin_payload {
            if let Some(mut stdin) = child.stdin.take() {
                use std::io::Write;
                let _ = stdin.write_all(payload.as_bytes());
                // `stdin` drops here, closing the pipe so the child sees EOF.
            }
        }
        let child_pid = child.id();
        let output = child
            .wait_with_output()
            .map_err(|err| format!("wait_failed: {err}"))?;
        let outcome = if output.status.success() {
            "ok"
        } else {
            "failed"
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let parsed = if json_usage {
            parse_claude_json_result(&stdout, outcome)
        } else {
            None
        };
        let (content, receipt) = match parsed {
            Some((content, receipt)) => (content, receipt),
            None => (
                stdout.into_owned(),
                UsageReceipt::unavailable(
                    effective_provider_id(self.provider.id(), resolution.as_ref()),
                    outcome,
                ),
            ),
        };
        let usage = serde_json::to_value(&receipt).ok();
        self.record_usage(receipt);
        if let Some(session) = &self.task_execution {
            session.child_reaped(child_pid)?;
            session.check()?;
        }
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
            provider: resolution
                .as_ref()
                .map(|r| r.agent.clone())
                .unwrap_or_else(|| self.provider.id().to_string()),
            content,
            stop_reason: Some("cli".to_string()),
            usage,
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

/// Run a process operation, retrying briefly on `ETXTBSY` (os error 26). That
/// error is a transient race in a multithreaded process that writes an
/// executable and fork/execs concurrently: a fork in another thread can hold
/// the just-written file's writable fd across our exec. The other child execs
/// microseconds later (closing the fd), so a short bounded retry clears it.
/// Non-`ETXTBSY` errors (and success) return immediately.
pub(crate) fn retry_etxtbsy<T>(mut op: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    let mut attempts = 0u32;
    loop {
        match op() {
            Err(err) if err.raw_os_error() == Some(26) && attempts < 5 => {
                attempts += 1;
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            other => return other,
        }
    }
}

fn spawn_with_retry(cmd: &mut Command) -> std::io::Result<Child> {
    retry_etxtbsy(|| cmd.spawn())
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
            resume: false,
            usage: false,
            add_dirs: false,
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
    fn auto_review_is_distinct_from_bypass() {
        assert_eq!(normalize_permission_mode("auto-review"), "auto-review");
        let mut command = Command::new("codex");
        apply_codex_permission_args(&mut command, "auto-review");
        let args: Vec<_> = command
            .get_args()
            .map(|value| value.to_string_lossy())
            .collect();
        assert_eq!(args, vec!["--approve-for-me"]);
    }

    #[test]
    fn retry_etxtbsy_retries_only_the_transient_error() {
        let mut attempts = 0;
        let value = retry_etxtbsy(|| {
            attempts += 1;
            if attempts < 3 {
                Err(std::io::Error::from_raw_os_error(26))
            } else {
                Ok("ready")
            }
        })
        .unwrap();

        assert_eq!(value, "ready");
        assert_eq!(attempts, 3);

        let mut non_transient_attempts = 0;
        let err = retry_etxtbsy(|| -> std::io::Result<()> {
            non_transient_attempts += 1;
            Err(std::io::Error::new(std::io::ErrorKind::NotFound, "missing"))
        })
        .unwrap_err();

        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
        assert_eq!(non_transient_attempts, 1);
    }

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
        assert_eq!(
            CliProviderKind::parse("kimi-code").unwrap(),
            CliProviderKind::Kimi
        );
        assert_eq!(
            CliProviderKind::parse("kiro-cli").unwrap(),
            CliProviderKind::Kiro
        );
        assert_eq!(CliProviderKind::Kimi.id(), "kimi");
        assert_eq!(CliProviderKind::Kiro.id(), "kiro");
        assert_eq!(CliProviderKind::Kimi.default_binary_name(), "kimi");
        assert_eq!(CliProviderKind::Kiro.default_binary_name(), "kiro-cli");
        assert!(CliProviderKind::parse("openai").is_err());
    }

    #[test]
    fn general_commands_never_bind_or_rewrite_prompts_for_missing_or_corrupt_bundles() {
        let _home = crate::skill_host::fs::test_home_for_bundle_tests();
        let state = crate::skill_host::bundle_update::state_path().unwrap();
        std::fs::create_dir_all(state.parent().unwrap()).unwrap();
        let valid = serde_json::to_vec(&serde_json::json!({"schema":1,"active":{"bundleId":"missing","revision":1,"displayVersion":"missing","source":"remote","envHash":"hash","appliedAt":"t"}})).unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let program = std::env::current_exe().unwrap();
        for bytes in [valid, b"{corrupt state".to_vec()] {
            std::fs::write(&state, bytes).unwrap();
            let request = CompletionRequest {
                schema_version: super::super::contracts::COMPLETION_REQUEST_SCHEMA_VERSION.into(),
                provider: "codex".into(),
                prompt: "Discuss ~/.maru/skills/demo and ~/.maru/env without changing them".into(),
                cwd: cwd.path().to_string_lossy().into_owned(),
                mode: "background".into(),
                metadata: None,
            };
            let (command, stdin, _) = build_cli_command_with_policy(
                CliProviderKind::Codex,
                &request,
                &[],
                program.to_str(),
                "plan",
            )
            .unwrap();
            assert_eq!(stdin.as_deref(), Some(request.prompt.as_str()));
            assert!(!command
                .get_envs()
                .any(|(key, _)| key == "MARU_SKILLS_BUNDLE" || key == "MARU_SKILLS_ENV"));
        }
    }

    #[test]
    fn command_binding_keeps_bundle_paths_and_env_when_another_bundle_is_active() {
        let _home = crate::skill_host::fs::test_home_for_bundle_tests();
        let root = crate::skill_host::bundle_update::bundle_pristine_dir("captured").unwrap();
        std::fs::create_dir_all(root.join("skills/demo")).unwrap();
        let session = crate::skill_host::session::BundleSession {
            bundle_id: "captured".into(),
            root: root.clone(),
            env_root: crate::skill_host::fs::hashed_env_root("captured-env").unwrap(),
            env_hash: "captured-env".into(),
        };
        crate::skill_host::bundle_update::write_state(
            &crate::skill_host::bundle_update::BundleState {
                schema: 1,
                active: Some(crate::skill_host::bundle_update::SkillBundleRef {
                    bundle_id: "new-active".into(),
                    revision: 2,
                    display_version: "new".into(),
                    commit: None,
                    source: "remote".into(),
                    env_hash: "new-env".into(),
                    applied_at: "t".into(),
                }),
                previous: None,
            },
        )
        .unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let request = CompletionRequest {
            schema_version: super::super::contracts::COMPLETION_REQUEST_SCHEMA_VERSION.into(),
            provider: "codex".into(),
            prompt: "Read ~/.maru/skills/demo/SKILL.md and use ~/.maru/env/.venv/bin/python".into(),
            cwd: cwd.path().to_string_lossy().into_owned(),
            mode: "background".into(),
            metadata: None,
        };
        let (command, stdin, _) = build_cli_command_with_session(
            CliProviderKind::Codex,
            &request,
            &[],
            Some("rustc"),
            "plan",
            Some(&session),
        )
        .unwrap();
        let env: std::collections::BTreeMap<_, _> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(
            env["MARU_SKILLS_BUNDLE"].as_deref(),
            Some(root.to_string_lossy().as_ref())
        );
        assert_eq!(
            env["MARU_SKILLS_ENV"].as_deref(),
            Some(session.env_root.to_string_lossy().as_ref())
        );
        let prompt = stdin.unwrap();
        assert!(prompt.contains(&format!("{}/skills/demo/SKILL.md", root.display())));
        assert!(!prompt.contains("~/.maru/skills/demo"));
        assert!(!prompt.contains("~/.maru/env"));
    }

    #[cfg(unix)]
    fn write_fake_cli(path: std::path::PathBuf, script: &str) -> std::path::PathBuf {
        crate::test_support::write_executable_fixture(&path, script, 0o755).unwrap();
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
    fn claimed_provider_stops_before_the_next_role_when_task_source_changes() {
        let home = crate::atomic_file::phase08_06::Home::new();
        let work = home.root.path().join("claimed-work");
        std::fs::create_dir_all(work.join("tasks/active")).unwrap();
        let task = work.join("tasks/active/task.md");
        let source = "---\nstatus: active\n---\nTask\n";
        std::fs::write(&task, source).unwrap();
        let metadata = serde_json::json!({"taskExecution": {
            "requestId": "provider-request", "taskPath": "tasks/active/task.md",
            "sourceRevision": crate::document::revision_for(source)
        }});
        let (session, _) = crate::task_execution_runtime::TaskExecutionSession::admit(
            work.to_str().unwrap(),
            Some(&metadata),
            "provider-run",
        )
        .unwrap()
        .unwrap();
        let calls = work.join("calls");
        let cli = write_fake_cli(
            work.join("fake-provider"),
            &format!(
                "#!/bin/sh\nprintf x >> '{}'\necho answer\n",
                calls.display()
            ),
        );
        let mut adapter = CliProviderAdapter::new(
            CliProviderKind::Claude,
            vec![],
            Some(cli.to_string_lossy().into_owned()),
            "plan".into(),
        )
        .with_task_execution(Some(session));
        let request = completion_request("role", work.to_str().unwrap());
        assert_eq!(
            adapter.complete(request.clone()).unwrap().content.trim(),
            "answer"
        );
        let bound = std::fs::read_to_string(&task).unwrap();
        std::fs::write(&task, format!("{bound}Changed\n")).unwrap();
        let error = adapter.complete(request).unwrap_err();
        assert!(error.contains("source_changed"), "{error}");
        assert_eq!(std::fs::read_to_string(calls).unwrap(), "x");
        assert_eq!(adapter.usage_receipts.len(), 1);
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
        // Unknown output shape: content passes through, usage is unavailable.
        let receipts = adapter.take_usage_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(
            receipts[0].pricing_status,
            crate::agent_host::usage::PricingStatus::Unavailable
        );
    }

    #[cfg(unix)]
    #[test]
    fn cli_adapter_claude_error_result_keeps_usage_and_sink_persists_per_call() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap().to_string();
        // Shape of Claude's error_max_turns result: no `result`, is_error true.
        let ok = r#"{"type":"result","subtype":"success","is_error":false,"result":"A","usage":{"input_tokens":1,"output_tokens":2}}"#;
        let err = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"total_cost_usd":0.3,"usage":{"input_tokens":7,"cache_read_input_tokens":8,"output_tokens":9},"modelUsage":{"m":{"costBasis":"list"}}}"#;
        // Calls 1-2 succeed, call 3 is the error variant with exit 1.
        let script = format!(
            "#!/bin/sh\nN=$(cat '{c}' 2>/dev/null || echo 0)\nN=$((N+1))\necho \"$N\" > '{c}'\nif [ \"$N\" -ge 3 ]; then echo '{err}'; exit 1; fi\necho '{ok}'\n",
            c = dir.path().join("count").display()
        );
        let cli = write_fake_cli(dir.path().join("fake-claude"), &script);
        let mut adapter = CliProviderAdapter::new(
            CliProviderKind::Claude,
            vec![],
            Some(cli.to_string_lossy().into_owned()),
            "plan".to_string(),
        )
        .with_usage_sink(cwd.clone(), "ai-sink".into());
        adapter.complete(completion_request("a", &cwd)).unwrap();
        adapter.complete(completion_request("b", &cwd)).unwrap();
        // The process "stops" here: nothing drains, yet both calls are on disk.
        let read = || {
            crate::agent_host::event_store::replay_run_summary(&cwd, "ai-sink")
                .unwrap()
                .usage
        };
        assert_eq!(read().receipt_count, 2);
        adapter.complete(completion_request("c", &cwd)).unwrap_err();
        let usage = read();
        assert_eq!(usage.receipt_count, 3);
        assert_eq!(usage.failed_count, 1);
        assert_eq!(usage.input_tokens, 1 + 1 + 7);
        assert_eq!(usage.cached_read_tokens, 8);
        assert_eq!(usage.estimate_count, 1);
        assert_eq!(usage.unavailable_count, 0);
        assert!(adapter.take_usage_receipts().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn cli_adapter_usage_sink_failure_keeps_receipt_for_retry() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap().to_string();
        let ok = r#"{"type":"result","result":"A","usage":{"input_tokens":1}}"#;
        let cli = write_fake_cli(
            dir.path().join("fake-claude"),
            &format!("#!/bin/sh\necho '{ok}'\n"),
        );
        // A file where the run directory must go makes the append fail once.
        let skills = dir.path().join(".maru/runs/skills");
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(skills.join("ai-retry"), "blocker").unwrap();
        let mut adapter = CliProviderAdapter::new(
            CliProviderKind::Claude,
            vec![],
            Some(cli.to_string_lossy().into_owned()),
            "plan".to_string(),
        )
        .with_usage_sink(cwd.clone(), "ai-retry".into());
        adapter.complete(completion_request("a", &cwd)).unwrap();
        assert_eq!(adapter.flush_pending_usage(), 1);
        std::fs::remove_file(skills.join("ai-retry")).unwrap();
        assert_eq!(adapter.flush_pending_usage(), 0);
        let usage = crate::agent_host::event_store::replay_run_summary(&cwd, "ai-retry")
            .unwrap()
            .usage;
        assert_eq!((usage.receipt_count, usage.input_tokens), (1, 1));
    }

    #[cfg(unix)]
    #[test]
    fn cli_adapter_claude_parses_json_result_and_keeps_failed_usage() {
        let dir = tempfile::tempdir().unwrap();
        let fixture = r#"{"type":"result","result":"ANSWER","total_cost_usd":0.5,"usage":{"input_tokens":3,"cache_read_input_tokens":4,"cache_creation_input_tokens":5,"output_tokens":6},"modelUsage":{"m":{"costBasis":"list"}}}"#;
        // Exits 0 only when Maru asked for JSON output; the second call fails
        // after printing usage, as a CLI erroring mid-run does.
        let script = format!(
            "#!/bin/sh\ncase \"$*\" in *'--output-format json'*) ;; *) exit 9 ;; esac\necho '{fixture}'\n[ -f '{m}' ] && {{ echo boom >&2; exit 1; }}\ntouch '{m}'\n",
            m = dir.path().join("marker").display()
        );
        let cli = write_fake_cli(dir.path().join("fake-claude"), &script);
        let mut adapter = CliProviderAdapter::new(
            CliProviderKind::Claude,
            vec![],
            Some(cli.to_string_lossy().into_owned()),
            "plan".to_string(),
        );
        let cwd = dir.path().to_str().unwrap();
        let response = adapter
            .complete(completion_request("do work", cwd))
            .unwrap();
        assert_eq!(response.content, "ANSWER");
        assert!(response.usage.is_some());
        adapter
            .complete(completion_request("do work", cwd))
            .unwrap_err();
        let receipts = adapter.take_usage_receipts();
        assert_eq!(receipts.len(), 2);
        assert_eq!(receipts[0].outcome, "ok");
        assert_eq!(receipts[1].outcome, "failed");
        assert_eq!(receipts[1].tokens.output, Some(6));
        assert_ne!(receipts[0].receipt_id, receipts[1].receipt_id);
        assert!(adapter.take_usage_receipts().is_empty());
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

    #[cfg(unix)]
    #[test]
    fn build_cli_command_carries_structured_run_scratchpad_contract() {
        let work = tempfile::tempdir().unwrap();
        let scratchpad = work.path().join("scratchpad");
        std::fs::write(
            work.path().join("workspace.config.yaml"),
            format!(
                "version: 1\npaths:\n  scratchpad: {}\nscratchpad:\n  drafts_subdir: generated-drafts\n",
                scratchpad.display()
            ),
        )
        .unwrap();
        let drafts = crate::scratchpad::resolve_scratchpad_drafts_root(work.path()).unwrap();
        let cli = write_fake_cli(work.path().join("fake-claude"), "#!/bin/sh\nexit 0\n");

        let (cmd, _stdin) = build_cli_command(
            CliProviderKind::Claude,
            &completion_request("hi", work.path().to_str().unwrap()),
            &[],
            Some(cli.to_str().unwrap()),
            "plan",
        )
        .unwrap();
        let explicit_env: std::collections::HashMap<_, _> = cmd
            .get_envs()
            .filter_map(|(key, value)| {
                value.map(|value| {
                    (
                        key.to_string_lossy().into_owned(),
                        value.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect();

        assert_eq!(
            explicit_env.get("MARU_SCRATCHPAD"),
            Some(&scratchpad.to_string_lossy().into_owned())
        );
        assert_eq!(
            explicit_env.get("MARU_DRAFTS"),
            Some(&drafts.to_string_lossy().into_owned())
        );
        assert_eq!(
            explicit_env.get("MARU_TEMP"),
            Some(&scratchpad.join("temp").to_string_lossy().into_owned())
        );
        assert_eq!(
            explicit_env.get("CLAUDE_CODE_TMPDIR"),
            Some(
                &scratchpad
                    .join("temp/runtime/claude")
                    .to_string_lossy()
                    .into_owned()
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn build_cli_command_builds_kimi_headless_argv() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(dir.path().join("fake-kimi"), "#!/bin/sh\nexit 0\n");
        let add_dir = dir.path().join("extra");
        let (cmd, stdin) = build_cli_command(
            CliProviderKind::Kimi,
            &completion_request("do work", dir.path().to_str().unwrap()),
            &[add_dir.to_string_lossy().into_owned()],
            Some(cli.to_str().unwrap()),
            "default",
        )
        .unwrap();
        assert!(stdin.is_none(), "kimi takes the prompt as argv, not stdin");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[0], "-p");
        assert_eq!(args[1], "do work");
        assert_eq!(args[2..], ["--add-dir", add_dir.to_string_lossy().as_ref()]);
    }

    #[cfg(unix)]
    #[test]
    fn build_cli_command_applies_permission_mode_for_kimi() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(dir.path().join("fake-kimi"), "#!/bin/sh\nexit 0\n");
        let request = completion_request("hi", dir.path().to_str().unwrap());
        let args_for = |mode: &str| {
            let (cmd, _stdin) = build_cli_command(
                CliProviderKind::Kimi,
                &request,
                &[],
                Some(cli.to_str().unwrap()),
                mode,
            )
            .unwrap();
            cmd.get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect::<Vec<String>>()
        };
        assert!(args_for("plan").contains(&"--plan".to_string()));
        assert!(args_for("acceptEdits").contains(&"-y".to_string()));
        assert!(args_for("bypassPermissions").contains(&"--auto".to_string()));
        let default_args = args_for("default");
        assert!(!default_args
            .iter()
            .any(|a| a == "--plan" || a == "-y" || a == "--auto"));
    }

    #[cfg(unix)]
    #[test]
    fn build_cli_command_builds_kiro_headless_argv() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(dir.path().join("fake-kiro"), "#!/bin/sh\nexit 0\n");
        let (cmd, stdin) = build_cli_command(
            CliProviderKind::Kiro,
            &completion_request("do work", dir.path().to_str().unwrap()),
            &[],
            Some(cli.to_str().unwrap()),
            "plan",
        )
        .unwrap();
        assert!(stdin.is_none(), "kiro takes the prompt as a positional arg");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "chat",
                "--no-interactive",
                "--trust-tools=read,grep",
                "do work",
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn build_cli_command_applies_permission_mode_for_kiro() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(dir.path().join("fake-kiro"), "#!/bin/sh\nexit 0\n");
        let request = completion_request("hi", dir.path().to_str().unwrap());
        let args_for = |mode: &str| {
            let (cmd, _stdin) = build_cli_command(
                CliProviderKind::Kiro,
                &request,
                &[],
                Some(cli.to_str().unwrap()),
                mode,
            )
            .unwrap();
            cmd.get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect::<Vec<String>>()
        };
        assert!(args_for("plan").contains(&"--trust-tools=read,grep".to_string()));
        assert!(args_for("acceptEdits").contains(&"--trust-tools=read,grep,write".to_string()));
        assert!(args_for("bypassPermissions").contains(&"--trust-all-tools".to_string()));
        assert!(!args_for("default")
            .iter()
            .any(|arg| arg.starts_with("--trust-")));
        assert!(!["plan", "acceptEdits", "default", "bypassPermissions"]
            .into_iter()
            .flat_map(args_for)
            .any(|arg| arg == "-a"));
    }

    #[cfg(unix)]
    #[test]
    fn cli_adapter_kimi_returns_stdout_as_content() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(
            dir.path().join("fake-kimi"),
            "#!/bin/sh\necho '{\"ok\":true}'\n",
        );
        let mut adapter = CliProviderAdapter::new(
            CliProviderKind::Kimi,
            vec![],
            Some(cli.to_string_lossy().into_owned()),
            "plan".to_string(),
        );
        let response = adapter
            .complete(completion_request("do work", dir.path().to_str().unwrap()))
            .unwrap();
        assert_eq!(response.content.trim(), "{\"ok\":true}");
        assert_eq!(response.provider, "kimi");
    }

    #[cfg(unix)]
    #[test]
    fn cli_adapter_kiro_returns_stdout_as_content() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(
            dir.path().join("fake-kiro"),
            "#!/bin/sh\necho '{\"ok\":true}'\n",
        );
        let mut adapter = CliProviderAdapter::new(
            CliProviderKind::Kiro,
            vec![],
            Some(cli.to_string_lossy().into_owned()),
            "plan".to_string(),
        );
        let response = adapter
            .complete(completion_request("do work", dir.path().to_str().unwrap()))
            .unwrap();
        assert_eq!(response.content.trim(), "{\"ok\":true}");
        assert_eq!(response.provider, "kiro");
    }

    /// The per-provider tests below each check one mode. This is the whole
    /// 4x4 grid in one place, so the safety-relevant `plan` row cannot be
    /// dropped for a single backend without failing. `cli_backends_real_smoke`
    /// re-runs the same table against the real installed binaries.
    #[cfg(unix)]
    #[test]
    fn permission_modes_map_to_expected_argv() {
        let grid: &[(CliProviderKind, [(&str, &str); 4])] = &[
            (
                CliProviderKind::Claude,
                [
                    ("plan", "--permission-mode plan"),
                    ("acceptEdits", "--permission-mode acceptEdits"),
                    ("default", "--permission-mode default"),
                    ("bypassPermissions", "--permission-mode bypassPermissions"),
                ],
            ),
            (
                CliProviderKind::Codex,
                [
                    ("plan", "--sandbox read-only"),
                    ("acceptEdits", "--sandbox workspace-write"),
                    ("default", "exec"),
                    (
                        "bypassPermissions",
                        "--dangerously-bypass-approvals-and-sandbox",
                    ),
                ],
            ),
            (
                CliProviderKind::Kimi,
                [
                    ("plan", "--plan"),
                    ("acceptEdits", "-y"),
                    ("default", "-p"),
                    ("bypassPermissions", "--auto"),
                ],
            ),
            (
                CliProviderKind::Kiro,
                [
                    ("plan", "--trust-tools=read,grep"),
                    ("acceptEdits", "--trust-tools=read,grep,write"),
                    ("default", "--no-interactive"),
                    ("bypassPermissions", "--trust-all-tools"),
                ],
            ),
        ];
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        for (provider, modes) in grid {
            for (mode, needle) in modes {
                let (cmd, _stdin) = build_cli_command(
                    *provider,
                    &completion_request("hi", cwd),
                    &[],
                    Some("/bin/echo"),
                    mode,
                )
                .unwrap_or_else(|err| panic!("{} {mode}: {err}", provider.id()));
                let argv = cmd
                    .get_args()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join(" ");
                assert!(
                    argv.contains(needle),
                    "{} {mode}: expected {needle:?} in {argv:?}",
                    provider.id()
                );
            }
        }
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

    /// maru#431 slice 2: the CLI that runs decides the flags, not the one that
    /// was asked for. The adaptive resolution can reroute a call, and then
    /// Claude's output flags on a codex command fail the call while their
    /// absence on a claude command loses its usage.
    #[test]
    fn usage_flags_follow_the_effective_provider_of_the_resolution() {
        fn resolution(agent: &str) -> Resolution {
            serde_json::from_value(serde_json::json!({
                "schema_version": 1, "policy_revision": "test", "target_id": "native-target", "workload": "implementation",
                "agent": agent, "executable": format!("/usr/local/bin/{agent}"), "home": "/tmp/.claude", "home_mode": "native-default", "version": "2.1.283", "billing": "subscription", "billing_verified": true, "model": "sonnet", "effort": "medium",
                "permission_intent": "auto-review", "permission_mechanism": "native-auto-review",
                "launch_args": [], "eligible": true, "reason": "validated", "constraints": [],
                "capabilities": [], "continuity": "checkpoint-handoff"
            }))
            .unwrap()
        }
        fn argv(cmd: &Command) -> Vec<String> {
            cmd.get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect()
        }
        // Claude requested, codex resolved: a codex command takes no Claude flags.
        let resolved = resolution("codex");
        let mut cmd = Command::new("codex");
        assert!(!apply_requested_usage_flags(
            &mut cmd,
            CliProviderKind::Claude,
            Some(&resolved)
        ));
        assert!(argv(&cmd).is_empty(), "{:?}", argv(&cmd));
        // Codex requested, claude resolved: the flags come back, or the rerouted
        // call would report no usage at all.
        let resolved = resolution("claude");
        let mut cmd = Command::new("claude");
        assert_eq!(
            effective_provider_id(CliProviderKind::Codex.id(), Some(&resolved)),
            "claude"
        );
        assert!(apply_requested_usage_flags(
            &mut cmd,
            CliProviderKind::Codex,
            Some(&resolved)
        ));
        assert_eq!(argv(&cmd), ["--output-format", "json"]);
        // No resolution: the requested provider decides, exactly as before.
        let mut cmd = Command::new("claude");
        assert!(apply_requested_usage_flags(
            &mut cmd,
            CliProviderKind::Claude,
            None
        ));
        assert_eq!(argv(&cmd), ["--output-format", "json"]);
        let mut cmd = Command::new("kimi");
        assert!(!apply_requested_usage_flags(
            &mut cmd,
            CliProviderKind::Kimi,
            None
        ));
        assert!(argv(&cmd).is_empty());
    }
}
