use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cli_path::resolve_program;
use crate::win_process::NoWindow;

const MIN_DOT_VERSION: &str = "2.63.0";
const MAX_OUTPUT_BYTES: usize = 512 * 1024;
static DOT_ACTION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotCliStatus {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub compatible: bool,
    pub minimum_version: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotSyncOverview {
    pub cli: DotCliStatus,
    pub mirror: Option<Value>,
    pub peer: Option<Value>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DotSyncMode {
    Clean,
    Force,
}

impl DotSyncMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Force => "force",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DotMirrorDirection {
    Push,
    Pull,
}

impl DotMirrorDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Push => "push",
            Self::Pull => "pull",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DotSyncActionRequest {
    ConfigureMirror {
        target: String,
        owner: String,
        filter_mode: String,
        create: bool,
        update: bool,
        delete: bool,
        max_delete: u32,
        push_interval_seconds: u32,
        pull_interval_seconds: u32,
        push_mode: DotSyncMode,
        pull_mode: DotSyncMode,
    },
    PauseMirror,
    ResumeMirror,
    RunMirror {
        direction: DotMirrorDirection,
        mode: DotSyncMode,
        dry_run: bool,
    },
    ConfigurePeer {
        host: String,
        remote_path: String,
        interval_seconds: u32,
        allow_patterns: String,
        home_paths: String,
        acknowledge_secrets: bool,
    },
    DisablePeer,
    RunPeer {
        dry_run: bool,
    },
    PeerDoctor,
    PeerDiff,
    SaveFilter {
        profile: String,
        kind: String,
        content: String,
        acknowledge_secrets: bool,
    },
    ReadFilter {
        profile: String,
        kind: String,
    },
    SavePeerHomePaths {
        content: String,
    },
    ReadPeerHomePaths,
    ReadLog {
        profile: String,
    },
    InstallCli,
    UpdateCli,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotSyncActionResult {
    pub stdout: String,
    pub stderr: String,
    pub overview: DotSyncOverview,
}

#[derive(Debug)]
struct CommandOutput {
    stdout: String,
    stderr: String,
}

fn dot_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("MARU_DOT_BINARY").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }
    resolve_program("dot")
}

fn capped(bytes: Vec<u8>) -> String {
    let start = bytes.len().saturating_sub(MAX_OUTPUT_BYTES);
    String::from_utf8_lossy(&bytes[start..]).to_string()
}

fn run_program(
    program: &Path,
    args: &[String],
    stdin: Option<&str>,
) -> Result<CommandOutput, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window();
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("dot_spawn_failed: {err}"))?;
    if let Some(input) = stdin {
        let mut pipe = child
            .stdin
            .take()
            .ok_or_else(|| "dot_stdin_unavailable".to_string())?;
        pipe.write_all(input.as_bytes())
            .map_err(|err| format!("dot_stdin_failed: {err}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|err| format!("dot_wait_failed: {err}"))?;
    let stdout = capped(output.stdout);
    let stderr = capped(output.stderr);
    if !output.status.success() {
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(format!("dot_command_failed: {}: {detail}", args.join(" ")));
    }
    Ok(CommandOutput { stdout, stderr })
}

fn parse_dot_version(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find_map(|part| part.strip_prefix('v'))
        .map(|part| {
            part.trim_matches(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
                .to_string()
        })
        .filter(|part| !part.is_empty())
}

fn version_tuple(value: &str) -> Option<(u32, u32, u32)> {
    let mut parts = value.split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

fn version_compatible(value: &str) -> bool {
    match (version_tuple(value), version_tuple(MIN_DOT_VERSION)) {
        (Some(current), Some(minimum)) => current >= minimum,
        _ => false,
    }
}

fn parse_status_json(output: &str, expected_kind: &str) -> Result<Value, String> {
    let value: Value =
        serde_json::from_str(output).map_err(|err| format!("dot_status_json_invalid: {err}"))?;
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("dot_status_schema_unsupported".to_string());
    }
    if value.get("kind").and_then(Value::as_str) != Some(expected_kind) {
        return Err(format!("dot_status_kind_invalid: expected {expected_kind}"));
    }
    Ok(value)
}

fn overview_sync() -> Result<DotSyncOverview, String> {
    let Some(binary) = dot_binary() else {
        return Ok(DotSyncOverview {
            cli: DotCliStatus {
                available: false,
                path: None,
                version: None,
                compatible: false,
                minimum_version: MIN_DOT_VERSION.to_string(),
                message: Some("dot is not installed".to_string()),
            },
            mirror: None,
            peer: None,
        });
    };
    let version_output = run_program(&binary, &["--version".to_string()], None)?;
    let version = parse_dot_version(&version_output.stdout);
    let compatible = version.as_deref().is_some_and(version_compatible);
    let cli = DotCliStatus {
        available: true,
        path: Some(binary.to_string_lossy().to_string()),
        version: version.clone(),
        compatible,
        minimum_version: MIN_DOT_VERSION.to_string(),
        message: (!compatible).then(|| format!("dot {} or newer is required", MIN_DOT_VERSION)),
    };
    if !compatible {
        return Ok(DotSyncOverview {
            cli,
            mirror: None,
            peer: None,
        });
    }
    let mirror_output = run_program(
        &binary,
        &[
            "sync".to_string(),
            "status".to_string(),
            "--json".to_string(),
        ],
        None,
    )?;
    let mirror = parse_status_json(&mirror_output.stdout, "mirror")?;
    let peer_output = run_program(
        &binary,
        &[
            "peer".to_string(),
            "status".to_string(),
            "--json".to_string(),
        ],
        None,
    )?;
    let peer = parse_status_json(&peer_output.stdout, "peer")?;
    Ok(DotSyncOverview {
        cli,
        mirror: Some(mirror),
        peer: Some(peer),
    })
}

#[tauri::command(async)]
pub async fn dot_sync_overview() -> Result<DotSyncOverview, String> {
    tauri::async_runtime::spawn_blocking(overview_sync)
        .await
        .map_err(|err| format!("dot_status_join_failed: {err}"))?
}

fn validate_interval(value: u32) -> Result<(), String> {
    if value != 0 && !(60..=86_400).contains(&value) {
        return Err("dot_interval_invalid: expected 0 or 60..86400 seconds".to_string());
    }
    Ok(())
}

fn safe_token(value: &str, name: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.contains('\0') {
        return Err(format!("dot_{name}_invalid"));
    }
    Ok(trimmed.to_string())
}

fn run_dot_action(request: DotSyncActionRequest) -> Result<DotSyncActionResult, String> {
    let _guard = DOT_ACTION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "dot_action_lock_poisoned".to_string())?;

    if matches!(&request, DotSyncActionRequest::InstallCli) {
        let brew = resolve_program("brew").ok_or_else(|| "homebrew_not_installed".to_string())?;
        let mut merged = CommandOutput {
            stdout: String::new(),
            stderr: String::new(),
        };
        for args in [
            vec!["tap".to_string(), "entelecheia/tap".to_string()],
            vec!["trust".to_string(), "entelecheia/tap".to_string()],
            vec!["install".to_string(), "dotfiles".to_string()],
        ] {
            let output = run_program(&brew, &args, None)?;
            merged.stdout.push_str(&output.stdout);
            merged.stderr.push_str(&output.stderr);
        }
        return Ok(DotSyncActionResult {
            stdout: merged.stdout,
            stderr: merged.stderr,
            overview: overview_sync()?,
        });
    }

    let binary = dot_binary().ok_or_else(|| "dot_not_installed".to_string())?;
    if matches!(&request, DotSyncActionRequest::UpdateCli) {
        let output = if binary.starts_with("/opt/homebrew") || binary.starts_with("/usr/local") {
            let brew =
                resolve_program("brew").ok_or_else(|| "homebrew_not_installed".to_string())?;
            run_program(
                &brew,
                &["upgrade".to_string(), "dotfiles".to_string()],
                None,
            )?
        } else {
            run_program(&binary, &["update".to_string()], None)?
        };
        return Ok(DotSyncActionResult {
            stdout: output.stdout,
            stderr: output.stderr,
            overview: overview_sync()?,
        });
    }

    let mut outputs = Vec::<CommandOutput>::new();
    match request {
        DotSyncActionRequest::ConfigureMirror {
            target,
            owner,
            filter_mode,
            create,
            update,
            delete,
            max_delete,
            push_interval_seconds,
            pull_interval_seconds,
            push_mode,
            pull_mode,
        } => {
            validate_interval(push_interval_seconds)?;
            validate_interval(pull_interval_seconds)?;
            let target = safe_token(&target, "target")?;
            let owner = safe_token(&owner, "owner")?;
            if filter_mode != "include" && filter_mode != "exclude" {
                return Err("dot_filter_mode_invalid".to_string());
            }
            let mut propagation = Vec::new();
            if create {
                propagation.push("create");
            }
            if update {
                propagation.push("update");
            }
            if delete {
                propagation.push("delete");
            }
            if propagation.is_empty() || (delete && max_delete == 0) {
                return Err("dot_propagation_invalid".to_string());
            }
            let args = vec![
                "sync".to_string(),
                "configure".to_string(),
                "--target".to_string(),
                target,
                "--owner".to_string(),
                owner,
                "--filter-mode".to_string(),
                filter_mode,
                "--propagate".to_string(),
                propagation.join(","),
                "--max-delete".to_string(),
                max_delete.max(1).to_string(),
                "--push-interval".to_string(),
                push_interval_seconds.to_string(),
                "--pull-interval".to_string(),
                pull_interval_seconds.to_string(),
                "--push-mode".to_string(),
                push_mode.as_str().to_string(),
                "--pull-mode".to_string(),
                pull_mode.as_str().to_string(),
                "--json".to_string(),
            ];
            outputs.push(run_program(&binary, &args, None)?);
        }
        DotSyncActionRequest::PauseMirror => outputs.push(run_program(
            &binary,
            &["sync".into(), "pause".into()],
            None,
        )?),
        DotSyncActionRequest::ResumeMirror => outputs.push(run_program(
            &binary,
            &["sync".into(), "resume".into()],
            None,
        )?),
        DotSyncActionRequest::RunMirror {
            direction,
            mode,
            dry_run,
        } => {
            let mut args = Vec::new();
            if dry_run {
                args.push("--dry-run".to_string());
            }
            args.extend([
                "sync".into(),
                direction.as_str().into(),
                "--mode".into(),
                mode.as_str().into(),
            ]);
            outputs.push(run_program(&binary, &args, None)?);
        }
        DotSyncActionRequest::ConfigurePeer {
            host,
            remote_path,
            interval_seconds,
            allow_patterns,
            home_paths,
            acknowledge_secrets,
        } => {
            validate_interval(interval_seconds)?;
            let host = safe_token(&host, "peer_host")?;
            let remote_path = safe_token(&remote_path, "peer_path")?;
            if !allow_patterns.trim().is_empty() && !acknowledge_secrets {
                return Err("peer_secret_ack_required".to_string());
            }
            outputs.push(run_program(
                &binary,
                &[
                    "peer".into(),
                    "init".into(),
                    "--host".into(),
                    host,
                    "--remote-path".into(),
                    remote_path,
                ],
                None,
            )?);
            if !allow_patterns.trim().is_empty() {
                let mut filter_args = vec![
                    "sync".into(),
                    "--profile=peer".into(),
                    "filters".into(),
                    "set".into(),
                    "allow".into(),
                    "--json".into(),
                ];
                if acknowledge_secrets {
                    filter_args.push("--ack-secret-exposure".into());
                }
                outputs.push(run_program(&binary, &filter_args, Some(&allow_patterns))?);
            }
            if !home_paths.trim().is_empty() {
                outputs.push(run_program(
                    &binary,
                    &[
                        "peer".into(),
                        "home-paths".into(),
                        "set".into(),
                        "--json".into(),
                    ],
                    Some(&home_paths),
                )?);
            }
            if interval_seconds > 0 {
                outputs.push(run_program(
                    &binary,
                    &[
                        "peer".into(),
                        "setup".into(),
                        format!("--interval={interval_seconds}s"),
                    ],
                    None,
                )?);
            } else {
                outputs.push(run_program(
                    &binary,
                    &["peer".into(), "setup".into(), "--off".into()],
                    None,
                )?);
            }
        }
        DotSyncActionRequest::DisablePeer => outputs.push(run_program(
            &binary,
            &["peer".into(), "setup".into(), "--off".into()],
            None,
        )?),
        DotSyncActionRequest::RunPeer { dry_run } => {
            let mut args = Vec::new();
            if dry_run {
                args.push("--dry-run".into());
            }
            args.extend(["peer".into(), "sync".into()]);
            outputs.push(run_program(&binary, &args, None)?);
        }
        DotSyncActionRequest::PeerDoctor => outputs.push(run_program(
            &binary,
            &["peer".into(), "doctor".into()],
            None,
        )?),
        DotSyncActionRequest::PeerDiff => {
            outputs.push(run_program(&binary, &["peer".into(), "diff".into()], None)?)
        }
        DotSyncActionRequest::SaveFilter {
            profile,
            kind,
            content,
            acknowledge_secrets,
        } => {
            if profile != "sync" && profile != "peer" {
                return Err("dot_profile_invalid".to_string());
            }
            if !["include", "exclude", "ignore", "allow"].contains(&kind.as_str()) {
                return Err("dot_filter_kind_invalid".to_string());
            }
            let mut args = vec![
                "sync".into(),
                format!("--profile={profile}"),
                "filters".into(),
                "set".into(),
                kind.clone(),
                "--json".into(),
            ];
            if kind == "allow" && acknowledge_secrets {
                args.push("--ack-secret-exposure".into());
            }
            outputs.push(run_program(&binary, &args, Some(&content))?);
        }
        DotSyncActionRequest::ReadFilter { profile, kind } => {
            if profile != "sync" && profile != "peer" {
                return Err("dot_profile_invalid".to_string());
            }
            if !["include", "exclude", "ignore", "allow"].contains(&kind.as_str()) {
                return Err("dot_filter_kind_invalid".to_string());
            }
            let output = run_program(
                &binary,
                &[
                    "sync".into(),
                    format!("--profile={profile}"),
                    "filters".into(),
                    "get".into(),
                    kind,
                    "--json".into(),
                ],
                None,
            )?;
            let value: Value = serde_json::from_str(&output.stdout)
                .map_err(|err| format!("dot_filter_json_invalid: {err}"))?;
            let content = value
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            outputs.push(CommandOutput {
                stdout: content,
                stderr: output.stderr,
            });
        }
        DotSyncActionRequest::SavePeerHomePaths { content } => outputs.push(run_program(
            &binary,
            &[
                "peer".into(),
                "home-paths".into(),
                "set".into(),
                "--json".into(),
            ],
            Some(&content),
        )?),
        DotSyncActionRequest::ReadPeerHomePaths => {
            let output = run_program(
                &binary,
                &[
                    "peer".into(),
                    "home-paths".into(),
                    "get".into(),
                    "--json".into(),
                ],
                None,
            )?;
            let value: Value = serde_json::from_str(&output.stdout)
                .map_err(|err| format!("dot_home_paths_json_invalid: {err}"))?;
            let content = value
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            outputs.push(CommandOutput {
                stdout: content,
                stderr: output.stderr,
            });
        }
        DotSyncActionRequest::ReadLog { profile } => {
            if profile != "sync" && profile != "peer" {
                return Err("dot_profile_invalid".to_string());
            }
            let output = run_program(
                &binary,
                &[
                    "sync".into(),
                    format!("--profile={profile}"),
                    "log".into(),
                    "--tail=200".into(),
                    "--json".into(),
                ],
                None,
            )?;
            let value: Value = serde_json::from_str(&output.stdout)
                .map_err(|err| format!("dot_log_json_invalid: {err}"))?;
            let content = value
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            outputs.push(CommandOutput {
                stdout: content,
                stderr: output.stderr,
            });
        }
        DotSyncActionRequest::InstallCli | DotSyncActionRequest::UpdateCli => unreachable!(),
    }
    let stdout = outputs
        .iter()
        .map(|item| item.stdout.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let stderr = outputs
        .iter()
        .map(|item| item.stderr.as_str())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(DotSyncActionResult {
        stdout,
        stderr,
        overview: overview_sync()?,
    })
}

#[tauri::command(async)]
pub async fn dot_sync_run(request: DotSyncActionRequest) -> Result<DotSyncActionResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_dot_action(request))
        .await
        .map_err(|err| format!("dot_action_join_failed: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_version_and_checks_minimum() {
        assert_eq!(
            parse_dot_version("dot v2.61.2 (5564167)"),
            Some("2.61.2".to_string())
        );
        assert!(!version_compatible("2.62.0"));
        assert!(version_compatible("2.63.0"));
        assert!(version_compatible("3.0.0"));
    }

    #[test]
    fn rejects_unsafe_intervals_and_tokens() {
        assert!(validate_interval(0).is_ok());
        assert!(validate_interval(60).is_ok());
        assert!(validate_interval(30).is_err());
        assert!(safe_token("--flag", "target").is_err());
        assert_eq!(
            safe_token("local:/tmp/work", "target").unwrap(),
            "local:/tmp/work"
        );
    }

    #[test]
    fn validates_status_schema_and_kind() {
        let good = r#"{"schemaVersion":1,"kind":"mirror"}"#;
        assert!(parse_status_json(good, "mirror").is_ok());
        assert!(parse_status_json(good, "peer").is_err());
        assert!(parse_status_json(r#"{"schemaVersion":2,"kind":"mirror"}"#, "mirror").is_err());
    }
}
