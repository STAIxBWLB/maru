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
const SUPPORTED_STATUS_SCHEMAS: [u64; 2] = [1, 2];
// D-03: DOT_ACTION_LOCK serializes external dot CLI invocations; the guarded
// state is the external dotfiles repository on disk, not an in-memory
// invariant, so recovering the guard cannot serve tainted state.
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

fn dot_candidates() -> [Option<PathBuf>; 3] {
    #[cfg(test)]
    if phase08_05::capture().is_some() {
        return [Some(PathBuf::from("fixture-dot")), None, None];
    }
    let configured = std::env::var_os("MARU_DOT_BINARY")
        .map(PathBuf::from)
        .filter(|path| path.is_file());
    // The Homebrew formula installs both names. Prefer the unambiguous alias,
    // but validate every candidate because Graphviz also owns `dot` and a
    // stale or unrelated `dotfiles` executable can precede the real CLI.
    [
        configured,
        resolve_program("dotfiles"),
        resolve_program("dot"),
    ]
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
    #[cfg(test)]
    if let Some(fixture) = phase08_05::capture() {
        return (fixture.program)(program, args, stdin);
    }
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
    let mut parts = output.split_whitespace();
    if parts.next()? != "dot" {
        return None;
    }
    let marker = parts.next()?;
    let raw = if marker == "version" {
        parts.next()?
    } else {
        marker.strip_prefix('v')?
    };
    let version = raw
        .trim_matches(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .to_string();
    version_tuple(&version).map(|_| version)
}

fn select_dot_binary(
    candidates: impl IntoIterator<Item = PathBuf>,
    mut version_for: impl FnMut(&Path) -> Option<String>,
) -> Option<(PathBuf, String)> {
    candidates.into_iter().find_map(|binary| {
        let version = version_for(&binary)?;
        Some((binary, version))
    })
}

fn dot_binary() -> Option<(PathBuf, String)> {
    select_dot_binary(dot_candidates().into_iter().flatten(), |binary| {
        let output = run_program(binary, &["--version".to_string()], None).ok()?;
        parse_dot_version(&output.stdout)
    })
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

fn schema_supported(version: Option<u64>) -> bool {
    version.is_some_and(|v| SUPPORTED_STATUS_SCHEMAS.contains(&v))
}

fn parse_status_json(output: &str, expected_kind: &str) -> Result<Value, String> {
    let value: Value =
        serde_json::from_str(output).map_err(|err| format!("dot_status_json_invalid: {err}"))?;
    let schema = value.get("schemaVersion").and_then(Value::as_u64);
    if !schema_supported(schema) {
        let observed = value
            .get("schemaVersion")
            .map_or("missing".to_string(), Value::to_string);
        return Err(format!(
            "dot_status_schema_unsupported: got {observed} (supported: {}-{})",
            SUPPORTED_STATUS_SCHEMAS[0],
            SUPPORTED_STATUS_SCHEMAS[SUPPORTED_STATUS_SCHEMAS.len() - 1]
        ));
    }
    if value.get("kind").and_then(Value::as_str) != Some(expected_kind) {
        return Err(format!("dot_status_kind_invalid: expected {expected_kind}"));
    }
    Ok(value)
}

fn overview_sync() -> Result<DotSyncOverview, String> {
    let Some((binary, version)) = dot_binary() else {
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
    let compatible = version_compatible(&version);
    let cli = DotCliStatus {
        available: true,
        path: Some(binary.to_string_lossy().to_string()),
        version: Some(version),
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
    #[cfg(test)]
    let fixture = phase08_05::capture();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        let _fixture = phase08_05::enter(fixture, "overview");
        overview_sync()
    })
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

// Schema-1 contract verified against dotfiles-v2 v2.63.0:
// internal/cli/{sync_json,peer_status,sync_filters_edit,sync_log,peer_home_paths}.go
// and internal/syncer/{local_store,helpers,sync}.go. Unknown schemas or local
// effects fail closed; these are process-local leases, not daemon exclusion.
#[derive(Debug, PartialEq)]
struct DotMutationPaths {
    paths: Vec<PathBuf>,
    workspace: PathBuf,
    home: PathBuf,
    mapping: Value,
    config: Option<Vec<u8>>,
    home_paths: Option<Vec<u8>>,
}

fn dot_local_path(value: &str, key: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_absolute() || value.contains('\0') {
        return Err(format!(
            "dot_action_paths_unresolved: {key} must be an absolute local path"
        ));
    }
    Ok(crate::vault::lexical_normalize(&path))
}

fn dot_read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "dot_action_paths_unresolved: cannot read {}: {error}",
            path.display()
        )),
    }
}

fn dot_read_only(request: &DotSyncActionRequest) -> bool {
    // v2.63.0 uses syncBootstrapReadOnly / peerBootstrapReadOnly for these.
    // PeerDiff and PeerDoctor instead call peerBootstrap, which can heal the
    // store and .gitignore, so both must participate in mutation admission.
    matches!(
        request,
        DotSyncActionRequest::ReadFilter { .. }
            | DotSyncActionRequest::ReadLog { .. }
            | DotSyncActionRequest::ReadPeerHomePaths
    )
}

fn dot_mutation_paths(
    binary: &Path,
    request: &DotSyncActionRequest,
) -> Result<DotMutationPaths, String> {
    let peer = matches!(
        request,
        DotSyncActionRequest::ConfigurePeer { .. }
            | DotSyncActionRequest::DisablePeer
            | DotSyncActionRequest::RunPeer { .. }
            | DotSyncActionRequest::PeerDoctor
            | DotSyncActionRequest::PeerDiff
            | DotSyncActionRequest::SavePeerHomePaths { .. }
    ) || matches!(request, DotSyncActionRequest::SaveFilter { profile, .. } if profile == "peer");
    let output = run_program(
        binary,
        &[
            if peer { "peer" } else { "sync" }.into(),
            "status".into(),
            "--json".into(),
        ],
        None,
    )?;
    let status = parse_status_json(&output.stdout, if peer { "peer" } else { "mirror" })?;
    let profile = if peer {
        let profile = status
            .get("profile")
            .ok_or("dot_action_paths_unresolved: peer.profile")?;
        if !schema_supported(profile.get("schemaVersion").and_then(Value::as_u64))
            || profile.get("kind").and_then(Value::as_str) != Some("peer-profile")
        {
            return Err("dot_action_paths_unresolved: unsupported peer.profile schema".into());
        }
        profile
    } else {
        &status
    };
    let field = |key: &str| -> Result<PathBuf, String> {
        dot_local_path(
            profile
                .get(key)
                .and_then(Value::as_str)
                .ok_or_else(|| format!("dot_action_paths_unresolved: {key}"))?,
            key,
        )
    };
    let workspace = field("workspacePath")?;
    let store = field("storeDir")?;
    let home = {
        #[cfg(test)]
        if let Some(fixture) = phase08_05::capture() {
            fixture.home.clone()
        } else {
            dirs::home_dir().ok_or("dot_action_paths_unresolved: home")?
        }
        #[cfg(not(test))]
        {
            dirs::home_dir().ok_or("dot_action_paths_unresolved: home")?
        }
    };
    // Bootstrap repairs .gitignore and may migrate the legacy store before the
    // action. Reserving the complete workspace covers those temporary siblings
    // and transfer/conflict/staging trees, even for a dry-run transfer.
    let mut paths = vec![workspace.clone(), store.clone()];
    for key in [
        "logPath",
        "includePath",
        "excludePath",
        "ignorePath",
        "allowPath",
    ] {
        paths.push(field(key)?);
    }
    let mut mapping = serde_json::Map::new();
    for key in [
        "schemaVersion",
        "kind",
        "workspacePath",
        "storeDir",
        "target",
        "logPath",
        "includePath",
        "excludePath",
        "ignorePath",
        "allowPath",
    ] {
        mapping.insert(key.into(), profile.get(key).cloned().unwrap_or(Value::Null));
    }
    paths.push(store.join("config.yaml"));
    let config = dot_read_optional(&store.join("config.yaml"))?;
    let target = profile
        .get("target")
        .ok_or("dot_action_paths_unresolved: target")?;
    if matches!(
        request,
        DotSyncActionRequest::RunMirror { .. } | DotSyncActionRequest::RunPeer { .. }
    ) {
        match target.get("kind").and_then(Value::as_str) {
            Some("local") => paths.push(dot_local_path(
                target
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or("dot_action_paths_unresolved: target.path")?,
                "target.path",
            )?),
            Some("ssh")
                if target
                    .get("host")
                    .and_then(Value::as_str)
                    .is_some_and(|host| !host.trim().is_empty()) =>
            {
                paths.push(home.join(".ssh"));
            }
            _ => return Err("dot_action_paths_unresolved: target.kind".into()),
        }
    }
    if let DotSyncActionRequest::ConfigureMirror { target, .. } = request {
        if let Some(local) = target.trim().strip_prefix("local:") {
            let local = local
                .strip_prefix("~/")
                .map(|suffix| home.join(suffix))
                .unwrap_or_else(|| PathBuf::from(local));
            paths.push(dot_local_path(&local.to_string_lossy(), "request.target")?);
        } else if !target.trim().starts_with("ssh:") {
            return Err("dot_action_paths_unresolved: request.target scheme".into());
        }
    }
    if matches!(
        request,
        DotSyncActionRequest::PeerDoctor | DotSyncActionRequest::PeerDiff
    ) {
        paths.push(home.join(".ssh"));
    }
    let mut home_paths = None;
    if peer {
        let path = dot_local_path(
            status
                .get("homePathsPath")
                .and_then(Value::as_str)
                .ok_or("dot_action_paths_unresolved: homePathsPath")?,
            "homePathsPath",
        )?;
        mapping.insert(
            "homePathsPath".into(),
            Value::String(path.to_string_lossy().into_owned()),
        );
        paths.push(path.clone());
        home_paths = dot_read_optional(&path)?;
        if matches!(request, DotSyncActionRequest::RunPeer { .. }) {
            let content = std::str::from_utf8(home_paths.as_deref().unwrap_or_default())
                .map_err(|_| "dot_action_paths_unresolved: home-paths encoding")?;
            for line in content
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('#'))
            {
                let relative = Path::new(line);
                if relative
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
                    || line.contains(['*', '?', '[', ']', '\0'])
                {
                    return Err(
                        "dot_action_paths_unresolved: home-paths requires finite relative entries"
                            .into(),
                    );
                }
                paths.push(home.join(relative));
            }
            paths.push(home.join(".dot-peer-conflicts"));
        }
    }
    // helpers.go uses Go's home/cache resolution; no remote host is ever
    // interpreted as a local directory. Include profile lock sidecars.
    #[cfg(target_os = "macos")]
    let cache = home.join("Library/Caches");
    #[cfg(not(target_os = "macos"))]
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".cache"));
    paths.push(
        cache
            .join("dotfiles")
            .join(if peer { "peer.lock" } else { "sync.lock" }),
    );
    if matches!(
        request,
        DotSyncActionRequest::ConfigureMirror { .. }
            | DotSyncActionRequest::PauseMirror
            | DotSyncActionRequest::ResumeMirror
            | DotSyncActionRequest::ConfigurePeer { .. }
            | DotSyncActionRequest::DisablePeer
    ) {
        // Includes current/legacy scheduler units cleaned up by setup, and
        // immediate scheduler log creation. Later daemon runs are independent.
        paths.push(home.join("Library/LaunchAgents"));
        paths.push(home.join(".config/systemd/user"));
        paths.push(home.join(".local/log"));
    }
    paths.sort();
    paths.dedup();
    Ok(DotMutationPaths {
        paths,
        workspace,
        home,
        mapping: Value::Object(mapping),
        config,
        home_paths,
    })
}

fn run_dot_action(request: DotSyncActionRequest) -> Result<DotSyncActionResult, String> {
    validate_dot_action(&request)?;
    // Package-manager/self-update scripts can install dependencies and run
    // arbitrary hooks. Schema 1 does not declare that finite local effect set.
    if matches!(
        request,
        DotSyncActionRequest::InstallCli | DotSyncActionRequest::UpdateCli
    ) {
        return Err("dot_action_paths_unresolved: CLI installation/update does not declare finite local targets".into());
    }
    let (binary, version) = dot_binary().ok_or_else(|| "dot_not_installed".to_string())?;
    if !version_compatible(&version) {
        return Err("dot_action_paths_unresolved: unsupported CLI version".into());
    }
    if dot_read_only(&request) {
        return run_dot_action_in_transaction(request, &binary);
    }
    let selected = dot_mutation_paths(&binary, &request)?;
    let admission = crate::atomic_file::PathTransactionRequest::new(selected.paths.clone())?
        .require_parent(&selected.workspace)?
        .require_parent(&selected.home)?;
    crate::atomic_file::with_path_transactions(admission, |lease| {
        let _guard = crate::lock_recovery::recover_guard(
            DOT_ACTION_LOCK.get_or_init(|| Mutex::new(())).lock(),
            "dot_sync",
            "DOT_ACTION_LOCK",
        );
        let current = dot_mutation_paths(&binary, &request)?;
        if current != selected || dot_binary().as_ref() != Some(&(binary.clone(), version.clone()))
        {
            return Err(
                "dot_action_paths_changed: configuration or target changed before action".into(),
            );
        }
        lease.ensure_covered(current.paths)?;
        lease.before_effect()?;
        run_dot_action_in_transaction(request, &binary)
    })
}

fn run_dot_action_in_transaction(
    request: DotSyncActionRequest,
    binary: &Path,
) -> Result<DotSyncActionResult, String> {
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
            outputs.push(run_program(binary, &args, None)?);
        }
        DotSyncActionRequest::PauseMirror => {
            outputs.push(run_program(binary, &["sync".into(), "pause".into()], None)?)
        }
        DotSyncActionRequest::ResumeMirror => outputs.push(run_program(
            binary,
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
            outputs.push(run_program(binary, &args, None)?);
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
                binary,
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
                outputs.push(run_program(binary, &filter_args, Some(&allow_patterns))?);
            }
            if !home_paths.trim().is_empty() {
                outputs.push(run_program(
                    binary,
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
                    binary,
                    &[
                        "peer".into(),
                        "setup".into(),
                        format!("--interval={interval_seconds}s"),
                    ],
                    None,
                )?);
            } else {
                outputs.push(run_program(
                    binary,
                    &["peer".into(), "setup".into(), "--off".into()],
                    None,
                )?);
            }
        }
        DotSyncActionRequest::DisablePeer => outputs.push(run_program(
            binary,
            &["peer".into(), "setup".into(), "--off".into()],
            None,
        )?),
        DotSyncActionRequest::RunPeer { dry_run } => {
            let mut args = Vec::new();
            if dry_run {
                args.push("--dry-run".into());
            }
            args.extend(["peer".into(), "sync".into()]);
            outputs.push(run_program(binary, &args, None)?);
        }
        DotSyncActionRequest::PeerDoctor => outputs.push(run_program(
            binary,
            &["peer".into(), "doctor".into()],
            None,
        )?),
        DotSyncActionRequest::PeerDiff => {
            outputs.push(run_program(binary, &["peer".into(), "diff".into()], None)?)
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
            outputs.push(run_program(binary, &args, Some(&content))?);
        }
        DotSyncActionRequest::ReadFilter { profile, kind } => {
            if profile != "sync" && profile != "peer" {
                return Err("dot_profile_invalid".to_string());
            }
            if !["include", "exclude", "ignore", "allow"].contains(&kind.as_str()) {
                return Err("dot_filter_kind_invalid".to_string());
            }
            let output = run_program(
                binary,
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
            binary,
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
                binary,
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
                binary,
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
    #[cfg(test)]
    let fixture = phase08_05::capture();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        let _fixture = phase08_05::enter(fixture, "run");
        #[cfg(test)]
        if let Some(fixture) = phase08_05::capture() {
            // The fake program is installed before this actual worker stage;
            // even a boundary failure cannot fall through to a host executable.
            crate::atomic_file::PathTransactionLease::test_stage(
                std::slice::from_ref(&fixture.home),
                "worker:dot_sync_run",
            );
        }
        run_dot_action(request)
    })
    .await
    .map_err(|err| format!("dot_action_join_failed: {err}"))?
}

fn validate_dot_action(request: &DotSyncActionRequest) -> Result<(), String> {
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
            ..
        } => {
            validate_interval(*push_interval_seconds)?;
            validate_interval(*pull_interval_seconds)?;
            safe_token(target, "target")?;
            safe_token(owner, "owner")?;
            if filter_mode != "include" && filter_mode != "exclude" {
                return Err("dot_filter_mode_invalid".into());
            }
            if !(*create || *update || *delete) || (*delete && *max_delete == 0) {
                return Err("dot_propagation_invalid".into());
            }
        }
        DotSyncActionRequest::ConfigurePeer {
            host,
            remote_path,
            interval_seconds,
            allow_patterns,
            acknowledge_secrets,
            ..
        } => {
            validate_interval(*interval_seconds)?;
            safe_token(host, "peer_host")?;
            safe_token(remote_path, "peer_path")?;
            if !allow_patterns.trim().is_empty() && !acknowledge_secrets {
                return Err("peer_secret_ack_required".into());
            }
        }
        DotSyncActionRequest::SaveFilter { profile, kind, .. }
        | DotSyncActionRequest::ReadFilter { profile, kind } => {
            if profile != "sync" && profile != "peer" {
                return Err("dot_profile_invalid".into());
            }
            if !["include", "exclude", "ignore", "allow"].contains(&kind.as_str()) {
                return Err("dot_filter_kind_invalid".into());
            }
        }
        DotSyncActionRequest::ReadLog { profile } if profile != "sync" && profile != "peer" => {
            return Err("dot_profile_invalid".into());
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod phase08_05 {
    use super::*;
    use std::cell::RefCell;
    use std::future::Future;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    type Program =
        dyn Fn(&Path, &[String], Option<&str>) -> Result<CommandOutput, String> + Send + Sync;
    type Edge = dyn Fn(&str) + Send + Sync;
    pub(super) struct Fixture {
        pub program: Arc<Program>,
        pub edge: Arc<Edge>,
        pub home: PathBuf,
    }
    thread_local! { static FIXTURE: RefCell<Option<Arc<Fixture>>> = RefCell::new(None); }
    pub(super) fn capture() -> Option<Arc<Fixture>> {
        FIXTURE.with(|slot| slot.borrow().clone())
    }
    pub(super) struct Reset(Option<Arc<Fixture>>);
    impl Drop for Reset {
        fn drop(&mut self) {
            FIXTURE.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    pub(super) fn enter(fixture: Option<Arc<Fixture>>, edge: &str) -> Reset {
        let old = FIXTURE.with(|slot| slot.replace(fixture));
        let reset = Reset(old);
        if let Some(fixture) = capture() {
            (fixture.edge)(edge);
        }
        reset
    }
    pub(super) fn fixture_root() -> PathBuf {
        static ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
        ROOT.get_or_init(|| {
            tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
        })
        .path()
        .to_path_buf()
    }
    pub(super) fn status(root: &Path, peer: bool) -> Value {
        let store = root.join(if peer {
            ".dotfiles/peer"
        } else {
            ".dotfiles/sync"
        });
        let target = if peer {
            serde_json::json!({"kind":"ssh","spec":"ssh:fixture:/remote/workspace","host":"fixture","path":"/remote/workspace"})
        } else {
            serde_json::json!({"kind":"local","spec":"local:fixture","path":root.join("mirror")})
        };
        let profile = serde_json::json!({"schemaVersion":1,"kind":if peer {"peer-profile"} else {"mirror"},
            "workspacePath":root,"storeDir":store,"target":target,
            "logPath":store.join("log/sync.log"),"includePath":store.join("include.txt"),
            "excludePath":store.join("exclude.txt"),"ignorePath":store.join("ignore.txt"),"allowPath":store.join("allow.txt")});
        if peer {
            serde_json::json!({"schemaVersion":1,"kind":"peer","profile":profile,"homePathsPath":store.join("home-paths.txt")})
        } else {
            profile
        }
    }
    pub(super) fn output(args: &[String]) -> CommandOutput {
        let stdout = match args.first().map(String::as_str) {
            Some("--version") => "dot version 2.63.0".into(),
            Some("sync") if args.get(1).map(String::as_str) == Some("status") => {
                status(&fixture_root(), false).to_string()
            }
            Some("peer") if args.get(1).map(String::as_str) == Some("status") => {
                status(&fixture_root(), true).to_string()
            }
            _ => "fixture complete".into(),
        };
        CommandOutput {
            stdout,
            stderr: String::new(),
        }
    }
    #[test]
    fn dot_wrappers_hold_distinct_workers_and_same_task_yields() {
        for edge in ["overview", "run"] {
            let (tx, mut rx) = tauri::async_runtime::channel(1);
            let (release_tx, release_rx) = mpsc::channel();
            let release_rx = Mutex::new(release_rx);
            let fixture = Arc::new(Fixture {
                home: fixture_root(),
                program: Arc::new(|_, _, _| panic!("boundary test must not launch")),
                edge: Arc::new(move |name| {
                    if name == edge {
                        tx.blocking_send(std::thread::current().id()).unwrap();
                        release_rx
                            .lock()
                            .unwrap()
                            .recv_timeout(Duration::from_secs(5))
                            .unwrap();
                        panic!("fixture boundary panic");
                    }
                }),
            });
            tauri::async_runtime::block_on(tauri::async_runtime::spawn(async move {
                let caller = std::thread::current().id();
                let _reset = enter(Some(fixture), "caller");
                let mut future = Box::pin(async move {
                    if edge == "overview" {
                        dot_sync_overview().await.map(|_| ())
                    } else {
                        dot_sync_run(DotSyncActionRequest::PauseMirror)
                            .await
                            .map(|_| ())
                    }
                });
                assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(
                    future.as_mut().poll(cx)
                ))
                .await
                .is_pending());
                drop(_reset);
                assert_ne!(caller, rx.recv().await.unwrap());
                let mut yielded = false;
                std::future::poll_fn(|cx| {
                    if yielded {
                        std::task::Poll::Ready(())
                    } else {
                        yielded = true;
                        cx.waker().wake_by_ref();
                        std::task::Poll::Pending
                    }
                })
                .await;
                release_tx.send(()).unwrap();
                let error = future.await.unwrap_err();
                assert!(error.starts_with(if edge == "overview" {
                    "dot_status_join_failed:"
                } else {
                    "dot_action_join_failed:"
                }));
            }))
            .unwrap();
        }
    }
    #[test]
    fn injected_dot_preserves_fixed_argv_stdin_payload_and_denied_no_launch() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let record = calls.clone();
        let _reset = enter(
            Some(Arc::new(Fixture {
                home: fixture_root(),
                edge: Arc::new(|_| {}),
                program: Arc::new(move |program, args, stdin| {
                    assert_eq!(program, Path::new("fixture-dot"));
                    record
                        .lock()
                        .unwrap()
                        .push((args.to_vec(), stdin.map(str::to_owned)));
                    Ok(output(args))
                }),
            })),
            "caller",
        );
        let overview = tauri::async_runtime::block_on(dot_sync_overview()).unwrap();
        assert!(overview.cli.available && overview.cli.compatible);
        assert_eq!(overview.mirror.unwrap()["target"]["kind"], "local");
        calls.lock().unwrap().clear();
        let error =
            tauri::async_runtime::block_on(dot_sync_run(DotSyncActionRequest::ConfigurePeer {
                host: "fixture".into(),
                remote_path: "/fixture".into(),
                interval_seconds: 60,
                allow_patterns: "*.key".into(),
                home_paths: String::new(),
                acknowledge_secrets: false,
            }))
            .unwrap_err();
        assert_eq!(error, "peer_secret_ack_required");
        assert!(calls.lock().unwrap().is_empty());
        let result =
            tauri::async_runtime::block_on(dot_sync_run(DotSyncActionRequest::RunMirror {
                direction: DotMirrorDirection::Push,
                mode: DotSyncMode::Clean,
                dry_run: true,
            }))
            .unwrap();
        assert_eq!(result.stdout, "fixture complete");
        assert_eq!(
            calls
                .lock()
                .unwrap()
                .iter()
                .find(|call| call.0.first().map(String::as_str) == Some("--dry-run"))
                .unwrap()
                .0,
            ["--dry-run", "sync", "push", "--mode", "clean"]
        );
        calls.lock().unwrap().clear();
        tauri::async_runtime::block_on(dot_sync_run(DotSyncActionRequest::SaveFilter {
            profile: "peer".into(),
            kind: "allow".into(),
            content: "safe fixture\n".into(),
            acknowledge_secrets: true,
        }))
        .unwrap();
        let calls = calls.lock().unwrap();
        let call = calls.iter().find(|call| call.1.is_some()).unwrap();
        assert_eq!(
            call.0,
            [
                "sync",
                "--profile=peer",
                "filters",
                "set",
                "allow",
                "--json",
                "--ack-secret-exposure"
            ]
        );
        assert_eq!(call.1.as_deref(), Some("safe fixture\n"));
    }
    #[test]
    fn dot_action_lock_holds_through_action_failure_then_releases() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let first = std::thread::spawn(move || {
            let _reset = enter(
                Some(Arc::new(Fixture {
                    home: fixture_root(),
                    edge: Arc::new(|_| {}),
                    program: Arc::new(move |_, args, _| {
                        if args == ["sync", "pause"] {
                            held_tx.send(()).unwrap();
                            release_rx
                                .lock()
                                .unwrap()
                                .recv_timeout(Duration::from_secs(5))
                                .unwrap();
                            return Err("dot_command_failed: fixture action".into());
                        }
                        Ok(output(args))
                    }),
                })),
                "caller",
            );
            tauri::async_runtime::block_on(dot_sync_run(DotSyncActionRequest::PauseMirror))
        });
        held_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (worker_tx, worker_rx) = mpsc::channel();
        let (process_tx, process_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            let _reset = enter(
                Some(Arc::new(Fixture {
                    home: fixture_root(),
                    edge: Arc::new(move |edge| {
                        if edge == "run" {
                            worker_tx.send(()).unwrap();
                        }
                    }),
                    program: Arc::new(move |_, args, _| {
                        if args == ["sync", "resume"] {
                            process_tx.send(()).unwrap();
                        }
                        Ok(output(args))
                    }),
                })),
                "caller",
            );
            tauri::async_runtime::block_on(dot_sync_run(DotSyncActionRequest::ResumeMirror))
        });
        worker_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(DOT_ACTION_LOCK.get().unwrap().try_lock().is_err());
        assert!(process_rx.try_recv().is_err());
        release_tx.send(()).unwrap();
        assert_eq!(
            first.join().unwrap().unwrap_err(),
            "dot_command_failed: fixture action"
        );
        assert_eq!(second.join().unwrap().unwrap().stdout, "fixture complete");
    }
}

#[cfg(test)]
mod phase08_29_dot {
    use super::*;
    use crate::atomic_file::phase08_06::{Held, Home};
    use crate::workspace_files::{ipc, phase08_06::TrashFixture, WorkspaceMutationStatus};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    fn fixture(
        root: PathBuf,
        home: PathBuf,
        effect: impl Fn() -> Result<(), String> + Send + Sync + 'static,
    ) -> Arc<phase08_05::Fixture> {
        Arc::new(phase08_05::Fixture {
            home,
            edge: Arc::new(|_| {}),
            program: Arc::new(move |_, args, _| {
                if args == ["--version"] {
                    return Ok(CommandOutput {
                        stdout: "dot version 2.63.0".into(),
                        stderr: String::new(),
                    });
                }
                if args.get(1).map(String::as_str) == Some("status") {
                    return Ok(CommandOutput {
                        stdout: phase08_05::status(&root, args[0] == "peer").to_string(),
                        stderr: String::new(),
                    });
                }
                effect()?;
                Ok(CommandOutput {
                    stdout: "fixture effect complete".into(),
                    stderr: String::new(),
                })
            }),
        })
    }
    fn start_dot(
        fixture: Arc<phase08_05::Fixture>,
        request: DotSyncActionRequest,
    ) -> mpsc::Receiver<Result<DotSyncActionResult, String>> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _fixture = phase08_05::enter(Some(fixture), "caller");
            let _ = tx.send(tauri::async_runtime::block_on(dot_sync_run(request)));
        });
        rx
    }
    fn start_parent(root: &Path, a: &Path, trash: bool) -> mpsc::Receiver<Result<(), String>> {
        let (tx, rx) = mpsc::channel();
        let root = root.to_string_lossy().into_owned();
        let a = a.to_string_lossy().into_owned();
        tauri::async_runtime::spawn(async move {
            let result = if trash {
                ipc::trash_workspace_entries(root, vec![a])
                    .await
                    .map(|rows| {
                        assert_eq!(rows[0].status, WorkspaceMutationStatus::Done);
                    })
            } else {
                ipc::rename_workspace_entry(root, a, "b".into())
                    .await
                    .map(|_| ())
            };
            let _ = tx.send(result);
        });
        rx
    }
    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(5))
            .expect("fixture completed")
    }
    fn action(kind: &str) -> DotSyncActionRequest {
        match kind {
            "peer" => DotSyncActionRequest::RunPeer { dry_run: false },
            _ => DotSyncActionRequest::RunMirror {
                direction: if kind == "pull" {
                    DotMirrorDirection::Pull
                } else {
                    DotMirrorDirection::Push
                },
                mode: DotSyncMode::Clean,
                dry_run: false,
            },
        }
    }

    #[test]
    fn phase08_29_dot_actual_wrapper_yields_on_the_polling_task() {
        use std::future::Future;
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let path = temp.path().to_path_buf();
        let fixture = Arc::new(phase08_05::Fixture {
            home: path.clone(),
            edge: Arc::new(|_| {}),
            program: Arc::new(|_, _, _| panic!("boundary fixture must not launch any program")),
        });
        crate::atomic_file::phase08_06::boundary(path, "dot_sync_run", async move {
            let mut future = Box::pin(dot_sync_run(DotSyncActionRequest::PauseMirror));
            let result = std::future::poll_fn(move |cx| {
                // Install per poll and restore before yielding: no thread-local
                // fixture guard crosses an await or a runtime thread change.
                let _fixture = phase08_05::enter(Some(fixture.clone()), "caller");
                future.as_mut().poll(cx)
            })
            .await;
            result.map_err(|error| {
                // Preserve and assert the existing public error, then adapt
                // only the test value to the shared boundary helper's spelling.
                assert!(error.starts_with("dot_action_join_failed:"));
                format!("dot_sync_run_task_failed: {error}")
            })
        });
    }

    #[test]
    fn phase08_29_dot_mirror_push_pull_peer_rename_trash_both_orders_and_aliases() {
        let _home = Home::new();
        for kind in ["push", "pull", "peer"] {
            for trash in [false, true] {
                for child_first in [false, true] {
                    for alias in [false, true] {
                        let temp =
                            tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap())
                                .unwrap();
                        let root = temp.path();
                        let a = root.join("a");
                        let b = root.join("b");
                        let physical = a.join("workspace");
                        let home = root.join("home");
                        std::fs::create_dir_all(&physical).unwrap();
                        std::fs::create_dir(&home).unwrap();
                        std::fs::write(physical.join("note.md"), "preserved bytes").unwrap();
                        let selected = if alias {
                            #[cfg(unix)]
                            {
                                std::os::unix::fs::symlink(&a, root.join("alias")).unwrap();
                                root.join("alias/workspace")
                            }
                            #[cfg(not(unix))]
                            {
                                physical.clone()
                            }
                        } else {
                            physical.clone()
                        };
                        let effect_root = selected.clone();
                        let fixture = fixture(selected.clone(), home, move || {
                            std::fs::write(effect_root.join("result.md"), "complete result")
                                .map_err(|error| error.to_string())
                        });
                        let _trash = TrashFixture::new(a.clone(), b.clone());
                        let first = Held::new(
                            if child_first {
                                selected.clone()
                            } else {
                                a.clone()
                            },
                            "pre-effect",
                        );
                        let waiting = Held::new(
                            if child_first {
                                a.clone()
                            } else {
                                selected.clone()
                            },
                            "before-admission",
                        );
                        let (parent, child) = if child_first {
                            let child = start_dot(fixture, action(kind));
                            first.wait();
                            let parent = start_parent(root, &a, trash);
                            waiting.wait();
                            waiting.release();
                            (parent, child)
                        } else {
                            let parent = start_parent(root, &a, trash);
                            first.wait();
                            let child = start_dot(fixture, action(kind));
                            waiting.wait();
                            waiting.release();
                            // Admission wait must not own the dot domain mutex.
                            assert!(!matches!(
                                DOT_ACTION_LOCK.get_or_init(|| Mutex::new(())).try_lock(),
                                Err(std::sync::TryLockError::WouldBlock)
                            ));
                            (parent, child)
                        };
                        assert!(!b.exists());
                        assert!(!physical.join("result.md").exists());
                        // A sibling outside the selected tree still progresses.
                        tauri::async_runtime::block_on(ipc::create_workspace_directory(
                            root.to_string_lossy().into_owned(),
                            root.to_string_lossy().into_owned(),
                            "unrelated".into(),
                        ))
                        .unwrap();
                        first.release();
                        done(parent).unwrap();
                        let result = done(child);
                        if child_first {
                            result.unwrap();
                            assert_eq!(
                                std::fs::read(b.join("workspace/result.md")).unwrap(),
                                b"complete result"
                            );
                        } else {
                            assert!(result.is_err());
                            assert!(!b.join("workspace/result.md").exists());
                        }
                        assert!(!a.exists());
                        assert_eq!(
                            std::fs::read(b.join("workspace/note.md")).unwrap(),
                            b"preserved bytes"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn phase08_29_dot_separate_local_target_waits_and_rejects_relocated_destination() {
        let _home = Home::new();
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = temp.path();
        let source = root.join("source");
        let destination = root.join("a");
        let home = root.join("home");
        for path in [&source, &destination, &home] {
            std::fs::create_dir(path).unwrap();
        }
        std::fs::write(destination.join("note.md"), "destination bytes").unwrap();
        let mut status = phase08_05::status(&source, false);
        status["target"] = serde_json::json!({"kind":"local", "spec":format!("local:{}",destination.display()),"path":destination});
        let destination_effect = destination.clone();
        let fixture = Arc::new(phase08_05::Fixture {
            home,
            edge: Arc::new(|_| {}),
            program: Arc::new(move |_, args, _| {
                let stdout = if args == ["--version"] {
                    "dot version 2.63.0".into()
                } else if args == ["sync", "status", "--json"] {
                    status.to_string()
                } else {
                    std::fs::write(destination_effect.join("result.md"), "effect").unwrap();
                    panic!("relocated target must reject before launch")
                };
                Ok(CommandOutput {
                    stdout,
                    stderr: String::new(),
                })
            }),
        });
        let held = Held::new(destination.clone(), "pre-effect");
        let waiting = Held::new(source, "before-admission");
        let parent = start_parent(root, &destination, false);
        held.wait();
        let child = start_dot(fixture, action("push"));
        waiting.wait();
        waiting.release();
        assert!(!destination.join("result.md").exists());
        held.release();
        done(parent).unwrap();
        assert!(done(child).is_err());
        assert!(!destination.exists());
        assert_eq!(
            std::fs::read(root.join("b/note.md")).unwrap(),
            b"destination bytes"
        );
        assert!(!root.join("b/result.md").exists());
    }

    #[test]
    fn phase08_29_dot_changed_config_parent_and_unknown_targets_fail_before_effect() {
        let _home = Home::new();
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let workspace = temp.path().join("workspace");
        let home = temp.path().join("home");
        std::fs::create_dir_all(workspace.join(".dotfiles/sync")).unwrap();
        std::fs::create_dir(&home).unwrap();
        let config = workspace.join(".dotfiles/sync/config.yaml");
        std::fs::write(&config, "target: original").unwrap();
        let effects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = effects.clone();
        let fixture = fixture(workspace.clone(), home.clone(), move || {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        });
        let admitted = Held::new(workspace.clone(), "admitted");
        let result = start_dot(fixture.clone(), action("push"));
        admitted.wait();
        std::fs::write(&config, "target: changed").unwrap();
        admitted.release();
        assert!(done(result)
            .unwrap_err()
            .contains("dot_action_paths_changed"));
        drop(admitted);
        let admitted = Held::new(workspace.clone(), "admitted");
        let result = start_dot(fixture.clone(), action("push"));
        admitted.wait();
        std::fs::rename(&workspace, temp.path().join("moved")).unwrap();
        std::fs::create_dir_all(workspace.join(".dotfiles/sync")).unwrap();
        std::fs::write(&config, "target: changed").unwrap();
        admitted.release();
        assert!(done(result).is_err());
        assert_eq!(effects.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(!workspace.join("result.md").exists());
        drop(admitted);
        let broken = Arc::new(phase08_05::Fixture {
            home,
            edge: Arc::new(|_| {}),
            program: Arc::new(|_, args, _| {
                if args == ["--version"] {
                    return Ok(CommandOutput {
                        stdout: "dot version 2.63.0".into(),
                        stderr: String::new(),
                    });
                }
                assert_eq!(args, ["sync", "status", "--json"]);
                Ok(CommandOutput { stdout: r#"{"schemaVersion":1,"kind":"mirror","target":{"kind":"ssh","host":"never-a-local-path"}}"#.into(), stderr: String::new() })
            }),
        });
        assert!(done(start_dot(broken.clone(), action("push")))
            .unwrap_err()
            .contains("dot_action_paths_unresolved"));
        for request in [
            DotSyncActionRequest::InstallCli,
            DotSyncActionRequest::UpdateCli,
        ] {
            assert!(done(start_dot(broken.clone(), request))
                .unwrap_err()
                .contains("finite local targets"));
        }
        done(start_dot(fixture, action("push"))).unwrap();
    }

    #[test]
    fn phase08_29_dot_failure_unwind_release_and_home_path_coverage() {
        let _home = Home::new();
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let workspace = temp.path().join("workspace");
        let home = temp.path().join("home");
        std::fs::create_dir_all(workspace.join(".dotfiles/peer")).unwrap();
        std::fs::create_dir(&home).unwrap();
        std::fs::write(
            workspace.join(".dotfiles/peer/home-paths.txt"),
            ".config/example\nnotes\n",
        )
        .unwrap();
        for panic in [false, true] {
            let failed = fixture(workspace.clone(), home.clone(), move || {
                assert!(DOT_ACTION_LOCK.get().unwrap().try_lock().is_err());
                if panic {
                    panic!("fixture dot child panic")
                }
                Err("dot_command_failed: fixture".into())
            });
            assert!(done(start_dot(failed, action("peer"))).is_err());
            let success = fixture(workspace.clone(), home.clone(), || Ok(()));
            let _fixture = phase08_05::enter(Some(success.clone()), "caller");
            let paths = dot_mutation_paths(Path::new("fixture-dot"), &action("peer")).unwrap();
            assert!(paths.paths.contains(&home.join("notes")));
            assert!(paths.paths.contains(&home.join(".dot-peer-conflicts")));
            assert!(paths.paths.contains(&home.join(".ssh")));
            assert!(!paths.paths.contains(&PathBuf::from("/remote/workspace")));
            done(start_dot(success, action("peer"))).unwrap();
        }
        std::fs::write(
            workspace.join(".dotfiles/peer/home-paths.txt"),
            "../escape\n",
        )
        .unwrap();
        let failed = fixture(workspace, home, || panic!("unresolved home path launched"));
        assert!(done(start_dot(failed, action("peer")))
            .unwrap_err()
            .contains("finite relative entries"));
    }

    #[test]
    fn phase08_29_dot_read_only_actions_do_not_wait_for_mutation_admission() {
        let _home = Home::new();
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = temp.path().to_path_buf();
        let _lease = crate::atomic_file::PathTransactionRequest::new(vec![root.clone()])
            .unwrap()
            .acquire()
            .unwrap();
        let fixture = Arc::new(phase08_05::Fixture {
            home: root.clone(),
            edge: Arc::new(|_| {}),
            program: Arc::new(move |_, args, _| {
                if args == ["--version"] {
                    return Ok(CommandOutput {
                        stdout: "dot version 2.63.0".into(),
                        stderr: String::new(),
                    });
                }
                let stdout = if args.get(1).map(String::as_str) == Some("status") {
                    phase08_05::status(&root, args[0] == "peer").to_string()
                } else {
                    assert!(args.iter().any(|arg| arg == "get" || arg == "log"));
                    r#"{"schemaVersion":1,"content":"read only bytes"}"#.into()
                };
                Ok(CommandOutput {
                    stdout,
                    stderr: String::new(),
                })
            }),
        });
        for action in [
            DotSyncActionRequest::ReadFilter {
                profile: "sync".into(),
                kind: "include".into(),
            },
            DotSyncActionRequest::ReadLog {
                profile: "peer".into(),
            },
            DotSyncActionRequest::ReadPeerHomePaths,
        ] {
            assert_eq!(
                done(start_dot(fixture.clone(), action)).unwrap().stdout,
                "read only bytes"
            );
        }
        assert!(!dot_read_only(&DotSyncActionRequest::PeerDiff));
        assert!(!dot_read_only(&DotSyncActionRequest::PeerDoctor));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_version_and_checks_minimum() {
        assert_eq!(
            parse_dot_version("dot version 2.63.0 (4ac6761)"),
            Some("2.63.0".to_string())
        );
        assert_eq!(
            parse_dot_version("dot v2.61.2 (5564167)"),
            Some("2.61.2".to_string())
        );
        assert_eq!(parse_dot_version("dot - graphviz version 12.2.1"), None);
        assert_eq!(parse_dot_version("other version 2.63.0"), None);
        assert!(!version_compatible("2.62.0"));
        assert!(version_compatible("2.63.0"));
        assert!(version_compatible("3.0.0"));
    }

    #[test]
    fn skips_invalid_dot_binary_candidates() {
        let selected = select_dot_binary(
            [PathBuf::from("dotfiles"), PathBuf::from("dot")],
            |binary| (binary == Path::new("dot")).then(|| "2.63.0".to_string()),
        );
        assert_eq!(selected, Some((PathBuf::from("dot"), "2.63.0".to_string())));
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
        assert!(parse_status_json(r#"{"schemaVersion":2,"kind":"mirror"}"#, "mirror").is_ok());
        let err =
            parse_status_json(r#"{"schemaVersion":3,"kind":"mirror"}"#, "mirror").unwrap_err();
        assert!(err.contains("dot_status_schema_unsupported: got 3 (supported: 1-2)"));
        let err = parse_status_json(r#"{"kind":"mirror"}"#, "mirror").unwrap_err();
        assert!(err.contains("dot_status_schema_unsupported: got missing (supported: 1-2)"));
    }
}
