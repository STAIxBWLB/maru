use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::agent_host::contracts::{
    CompletionRequest, CompletionResponse, COMPLETION_RESPONSE_SCHEMA_VERSION,
};
use crate::cli_path::resolve_program;

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

pub fn build_cli_command(
    provider: CliProviderKind,
    request: &CompletionRequest,
    add_dirs: &[String],
    command_override: Option<&str>,
) -> Result<(Command, Option<String>), String> {
    request.validate()?;
    match provider {
        CliProviderKind::Claude => {
            let bin = resolve_provider_binary(provider, command_override).ok_or_else(|| {
                "cli_missing: claude CLI not found in PATH or common install locations".to_string()
            })?;
            let mut cmd = Command::new(bin);
            cmd.arg("-p")
                .arg(&request.prompt)
                .arg("--permission-mode")
                .arg("plan")
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
            cmd.arg("exec").arg("--cd").arg(&request.cwd);
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
}
