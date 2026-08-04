//! Per-agent account and usage/quota status for the CLI agent providers
//! (claude, codex, kimi, kiro). Exposed to the frontend as the
//! `agents_account_status` / `agents_usage_status` Tauri commands.
//!
//! Security: credential material (OAuth tokens, refresh tokens) is read from
//! local stores only and is never returned, logged, or included in messages —
//! only derived account fields (email, organization, login method) leave here.

use base64::Engine;
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::agent_host::provider::{resolve_provider_binary, CliProviderKind};
use crate::cli_path::augmented_path;
use crate::win_process::NoWindow;

const USAGE_CACHE_TTL: Duration = Duration::from_secs(60);

/// How many bytes from the end of a codex rollout file to scan for
/// `token_count` events (they are always the most recent events).
const ROLLOUT_TAIL_BYTES: u64 = 256 * 1024;
/// Bound fallback work when the newest Codex sessions have no quota event.
const MAX_RECENT_ROLLOUTS: usize = 20;

const AGENTS: [CliProviderKind; 4] = [
    CliProviderKind::Claude,
    CliProviderKind::Codex,
    CliProviderKind::Kimi,
    CliProviderKind::Kiro,
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccountStatus {
    pub id: String,
    pub installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub auth_status: String,
    pub login_method: Option<String>,
    pub provider: Option<String>,
    pub organization: Option<String>,
    pub email: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageStatus {
    pub id: String,
    pub state: String,
    pub windows: Vec<UsageWindow>,
    pub updated_at: String,
    pub message: Option<String>,
}

// Plain sync commands: Tauri runs them on a blocking-safe thread. Do NOT
// mark them `command(async)` — the body would then run inline on an async
// runtime worker, and `reqwest::blocking` deadlocks in that context.
#[tauri::command]
pub fn agents_account_status(
    command_overrides: Option<HashMap<String, String>>,
) -> Vec<AgentAccountStatus> {
    AGENTS
        .iter()
        .map(|provider| account_status(*provider, command_overrides.as_ref()))
        .collect()
}

#[tauri::command]
pub fn agents_usage_status(
    command_overrides: Option<HashMap<String, String>>,
    force: Option<bool>,
) -> Vec<AgentUsageStatus> {
    let force = force.unwrap_or(false);
    AGENTS
        .iter()
        .map(|provider| usage_status(*provider, command_overrides.as_ref(), force))
        .collect()
}

fn account_status(
    provider: CliProviderKind,
    overrides: Option<&HashMap<String, String>>,
) -> AgentAccountStatus {
    let id = provider.id().to_string();
    let binary = resolve_provider_binary(provider, override_for(overrides, provider));
    let Some(binary) = binary else {
        return AgentAccountStatus {
            id,
            installed: false,
            binary_path: None,
            version: None,
            auth_status: "cli_missing".to_string(),
            login_method: None,
            provider: None,
            organization: None,
            email: None,
            message: Some(format!(
                "{} CLI not found in PATH or common install locations",
                provider.default_binary_name()
            )),
        };
    };
    let version = run_cli(&binary, &["--version"]).and_then(|output| {
        output
            .status
            .success()
            .then(|| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string()
            })
            .filter(|value| !value.is_empty())
    });
    let mut status = AgentAccountStatus {
        id,
        installed: true,
        binary_path: Some(binary.to_string_lossy().into_owned()),
        version,
        auth_status: "unknown".to_string(),
        login_method: None,
        provider: None,
        organization: None,
        email: None,
        message: None,
    };
    match provider {
        CliProviderKind::Claude => probe_claude_account(&binary, &mut status),
        CliProviderKind::Codex => probe_codex_account(&binary, &mut status),
        CliProviderKind::Kimi => probe_kimi_account(&mut status),
        CliProviderKind::Kiro => probe_kiro_account(&binary, &mut status),
    }
    status
}

fn probe_claude_account(binary: &Path, status: &mut AgentAccountStatus) {
    status.provider = Some("Anthropic".to_string());
    let Some(output) = run_cli(binary, &["auth", "status"]) else {
        status.message = Some("Failed to run `claude auth status`".to_string());
        return;
    };
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    match parse_claude_auth_status(&text) {
        Some(info) => {
            status.auth_status = if info.logged_in {
                "authenticated"
            } else {
                "unauthenticated"
            }
            .to_string();
            status.login_method = info.auth_method;
            status.provider = info.api_provider.or(status.provider.take());
            status.organization = info.org_name;
            status.email = info.email;
        }
        None => {
            status.auth_status = "unauthenticated".to_string();
            status.message = Some("Could not parse `claude auth status` output".to_string());
        }
    }
}

fn probe_codex_account(binary: &Path, status: &mut AgentAccountStatus) {
    status.provider = Some("OpenAI".to_string());
    let output = run_cli(binary, &["login", "status"]);
    let text = output
        .as_ref()
        .map(|output| {
            format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        })
        .unwrap_or_default();
    let success = output
        .map(|output| output.status.success())
        .unwrap_or(false);
    match parse_codex_login_status(success, &text) {
        Some(method) => {
            status.auth_status = "authenticated".to_string();
            status.login_method = Some(method);
            status.email = codex_auth_json()
                .as_deref()
                .and_then(|text| parse_codex_auth_email(text));
        }
        None => {
            status.auth_status = "unauthenticated".to_string();
            status.message = Some("Not logged in. Run `codex login`.".to_string());
        }
    }
}

fn probe_kimi_account(status: &mut AgentAccountStatus) {
    status.provider = Some("Kimi Code".to_string());
    status.login_method = Some("OAuth (device code)".to_string());
    let Some(text) = kimi_credentials_json() else {
        status.auth_status = "unauthenticated".to_string();
        status.message = Some("No credentials found. Run `kimi login`.".to_string());
        return;
    };
    match parse_kimi_credentials(&text, unix_now()) {
        Some(info) if info.valid => {
            status.auth_status = "authenticated".to_string();
            status.email = info.email;
        }
        Some(_) => {
            status.auth_status = "unauthenticated".to_string();
            status.message = Some("Credentials expired. Run `kimi login`.".to_string());
        }
        None => {
            status.auth_status = "unknown".to_string();
            status.message = Some("Could not parse kimi credentials file".to_string());
        }
    }
}

fn probe_kiro_account(binary: &Path, status: &mut AgentAccountStatus) {
    status.provider = Some("AWS".to_string());
    let Some(output) = run_cli(binary, &["whoami"]) else {
        status.message = Some("Failed to run `kiro-cli whoami`".to_string());
        return;
    };
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let info = parse_kiro_whoami(&text);
    if output.status.success() && info.email.is_some() {
        status.auth_status = "authenticated".to_string();
        status.login_method = info.login_method;
        status.email = info.email;
        status.organization = info.profile;
    } else {
        status.auth_status = "unauthenticated".to_string();
        status.message = Some("Not logged in. Run `kiro-cli login`.".to_string());
    }
}

// --- usage -----------------------------------------------------------------

fn usage_cache() -> &'static Mutex<HashMap<String, (Instant, AgentUsageStatus)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, AgentUsageStatus)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn usage_status(
    provider: CliProviderKind,
    overrides: Option<&HashMap<String, String>>,
    force: bool,
) -> AgentUsageStatus {
    let cache_key = usage_cache_key(provider, overrides);
    if !force {
        if let Some(cached) = usage_cache()
            .lock()
            .ok()
            .and_then(|cache| cache.get(&cache_key).cloned())
        {
            if cached.0.elapsed() < USAGE_CACHE_TTL {
                return cached.1;
            }
        }
    }
    let status = probe_usage(provider, overrides);
    if let Ok(mut cache) = usage_cache().lock() {
        cache.insert(cache_key, (Instant::now(), status.clone()));
    }
    status
}

fn usage_cache_key(
    provider: CliProviderKind,
    overrides: Option<&HashMap<String, String>>,
) -> String {
    format!(
        "{}\0{}",
        provider.id(),
        override_for(overrides, provider).unwrap_or_default()
    )
}

fn probe_usage(
    provider: CliProviderKind,
    overrides: Option<&HashMap<String, String>>,
) -> AgentUsageStatus {
    let id = provider.id().to_string();
    let updated_at = || chrono::Utc::now().to_rfc3339();
    let make = |state: &str, windows: Vec<UsageWindow>, message: Option<String>| AgentUsageStatus {
        id: id.clone(),
        state: state.to_string(),
        windows,
        updated_at: updated_at(),
        message,
    };
    if resolve_provider_binary(provider, override_for(overrides, provider)).is_none() {
        return make(
            "cli_missing",
            Vec::new(),
            Some(format!("{} CLI not found", provider.default_binary_name())),
        );
    }
    // Kept as an independent per-backend match rather than derived from
    // `capabilities().usage`: `cli_backends_real_smoke` asserts the two agree,
    // and that assertion is only worth running while they are two sources.
    match provider {
        CliProviderKind::Kimi => make(
            "unsupported",
            Vec::new(),
            Some("No usage API available; run `/usage` in the kimi CLI.".to_string()),
        ),
        CliProviderKind::Kiro => make(
            "unsupported",
            Vec::new(),
            Some("kiro-cli does not expose usage/quota information.".to_string()),
        ),
        CliProviderKind::Claude => match claude_usage_windows() {
            Ok(windows) => make("ok", windows, None),
            Err(UsageProbeError::Unauthenticated(message)) => {
                make("unauthenticated", Vec::new(), Some(message))
            }
            Err(UsageProbeError::Other(message)) => make("unavailable", Vec::new(), Some(message)),
        },
        CliProviderKind::Codex => match codex_usage_windows() {
            Ok(windows) => make("ok", windows, None),
            Err(UsageProbeError::Unauthenticated(message)) => {
                make("unauthenticated", Vec::new(), Some(message))
            }
            Err(UsageProbeError::Other(message)) => make("unavailable", Vec::new(), Some(message)),
        },
    }
}

enum UsageProbeError {
    Unauthenticated(String),
    Other(String),
}

fn claude_usage_windows() -> Result<Vec<UsageWindow>, UsageProbeError> {
    let token = claude_oauth_token().ok_or_else(|| {
        UsageProbeError::Unauthenticated(
            "No Claude OAuth credentials found; log in with `claude`.".to_string(),
        )
    })?;
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|err| UsageProbeError::Other(format!("usage request setup failed: {err}")))?
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .map_err(|err| UsageProbeError::Other(format!("usage request failed: {err}")))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err(UsageProbeError::Unauthenticated(
            "Claude OAuth token was rejected; log in again with `claude`.".to_string(),
        ));
    }
    let text = response
        .error_for_status()
        .map_err(|err| UsageProbeError::Other(format!("usage request failed: {err}")))?
        .text()
        .map_err(|err| UsageProbeError::Other(format!("usage response read failed: {err}")))?;
    parse_claude_usage_windows(&text)
        .ok_or_else(|| UsageProbeError::Other("Could not parse Claude usage response".to_string()))
}

fn codex_usage_windows() -> Result<Vec<UsageWindow>, UsageProbeError> {
    if codex_auth_json().is_none() {
        return Err(UsageProbeError::Unauthenticated(
            "No codex auth.json found; run `codex login`.".to_string(),
        ));
    }
    let sessions_root = dirs::home_dir()
        .ok_or_else(|| UsageProbeError::Other("home directory unavailable".to_string()))?
        .join(".codex")
        .join("sessions");
    let rollouts = recent_rollout_files(&sessions_root, MAX_RECENT_ROLLOUTS);
    if rollouts.is_empty() {
        return Err(UsageProbeError::Other(
            "No codex rollout session files found".to_string(),
        ));
    }
    codex_usage_from_rollouts(&rollouts).ok_or_else(|| {
        UsageProbeError::Other("No token_count data in recent codex rollouts".to_string())
    })
}

fn codex_usage_from_rollouts(rollouts: &[PathBuf]) -> Option<Vec<UsageWindow>> {
    rollouts.iter().find_map(|rollout| {
        // Rollouts can be multi-MB; token_count events sit near the end, so
        // read only the tail. A new session may not have emitted one yet;
        // keep searching older recent sessions instead of hiding valid quota.
        let text = read_file_tail(rollout, ROLLOUT_TAIL_BYTES).ok()?;
        parse_codex_rollout_usage(&text)
    })
}

// --- pure parsers (unit-tested without the CLIs) ----------------------------

struct ClaudeAuthInfo {
    logged_in: bool,
    auth_method: Option<String>,
    api_provider: Option<String>,
    org_name: Option<String>,
    email: Option<String>,
}

/// Whether `claude auth status` output says the user is logged in. Fails closed
/// on unparseable output, matching [`probe_claude_account`] — the skills gate
/// and the account probe must not disagree about the same machine.
pub(crate) fn claude_auth_logged_in(text: &str) -> bool {
    parse_claude_auth_status(text)
        .map(|info| info.logged_in)
        .unwrap_or(false)
}

fn parse_claude_auth_status(text: &str) -> Option<ClaudeAuthInfo> {
    let value: JsonValue = serde_json::from_str(text.trim()).ok()?;
    let str_field = |key: &str| {
        value
            .get(key)
            .and_then(JsonValue::as_str)
            .map(str::to_string)
            .filter(|value| !value.is_empty())
    };
    Some(ClaudeAuthInfo {
        logged_in: value.get("loggedIn").and_then(JsonValue::as_bool)?,
        auth_method: str_field("authMethod"),
        api_provider: str_field("apiProvider"),
        org_name: str_field("orgName"),
        email: str_field("email"),
    })
}

/// `codex login status` prints "Logged in using ChatGPT" on success. Returns
/// the login method text when authenticated.
fn parse_codex_login_status(success: bool, text: &str) -> Option<String> {
    if !success {
        return None;
    }
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| line.to_lowercase().starts_with("logged in"))?;
    let method = line
        .strip_prefix("Logged in using ")
        .or_else(|| line.strip_prefix("Logged in as "))
        .unwrap_or("ChatGPT")
        .trim()
        .to_string();
    Some(method)
}

/// base64url-decode a JWT payload segment and read its claims. No signature
/// verification — local display only.
fn decode_jwt_payload(token: &str) -> Option<JsonValue> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn parse_codex_auth_email(auth_json: &str) -> Option<String> {
    let value: JsonValue = serde_json::from_str(auth_json).ok()?;
    let id_token = value.get("tokens")?.get("id_token")?.as_str()?;
    let claims = decode_jwt_payload(id_token)?;
    claims
        .get("email")
        .and_then(JsonValue::as_str)
        .map(str::to_string)
}

struct KimiCredentialsInfo {
    valid: bool,
    email: Option<String>,
}

/// kimi-code credentials: `~/.kimi-code/credentials/kimi-code.json` with
/// `access_token` and optional `expires_at` (unix seconds or milliseconds).
/// Valid when an access token exists and the expiry is missing or future.
fn parse_kimi_credentials(text: &str, now_unix: i64) -> Option<KimiCredentialsInfo> {
    let value: JsonValue = serde_json::from_str(text.trim()).ok()?;
    let access_token = value.get("access_token")?.as_str()?;
    let expires_at = value
        .get("expires_at")
        .and_then(|expiry| {
            expiry
                .as_i64()
                .or_else(|| expiry.as_str().and_then(|raw| raw.parse::<i64>().ok()))
        })
        .map(|expiry| {
            if expiry > 1_000_000_000_000 {
                expiry / 1000
            } else {
                expiry
            }
        });
    let valid = expires_at.map(|expiry| expiry > now_unix).unwrap_or(true);
    let email = decode_jwt_payload(access_token).and_then(|claims| {
        claims
            .get("email")
            .or_else(|| claims.get("sub"))
            .and_then(JsonValue::as_str)
            .map(str::to_string)
    });
    Some(KimiCredentialsInfo { valid, email })
}

#[derive(Default)]
struct KiroWhoamiInfo {
    login_method: Option<String>,
    email: Option<String>,
    profile: Option<String>,
}

/// Parse `kiro-cli whoami` output:
/// `Logged in with IAM Identity Center (<url>)`, `Email: <email>`,
/// `Profile:\n<name>` (or `Profile: <name>`).
fn parse_kiro_whoami(text: &str) -> KiroWhoamiInfo {
    let mut info = KiroWhoamiInfo::default();
    let mut lines = text.lines().map(str::trim).peekable();
    while let Some(line) = lines.next() {
        if let Some(rest) = line.strip_prefix("Logged in with ") {
            let method = rest.split('(').next().unwrap_or(rest).trim();
            if !method.is_empty() {
                info.login_method = Some(method.to_string());
            }
        } else if let Some(email) = line.strip_prefix("Email:") {
            let email = email.trim();
            if !email.is_empty() {
                info.email = Some(email.to_string());
            }
        } else if let Some(profile) = line.strip_prefix("Profile:") {
            let profile = profile.trim();
            let value = if profile.is_empty() {
                lines.next().map(str::trim).unwrap_or("")
            } else {
                profile
            };
            if !value.is_empty() {
                info.profile = Some(value.to_string());
            }
        }
    }
    info
}

/// Map the Claude OAuth usage response to display windows: `five_hour` → "5h",
/// `seven_day` → "7d", plus each `weekly_scoped` limit carrying a model name.
fn parse_claude_usage_windows(text: &str) -> Option<Vec<UsageWindow>> {
    let value: JsonValue = serde_json::from_str(text.trim()).ok()?;
    let mut windows = Vec::new();
    for (key, label) in [("five_hour", "5h"), ("seven_day", "7d")] {
        if let Some(section) = value.get(key) {
            if let Some(used) = section.get("utilization").and_then(JsonValue::as_f64) {
                windows.push(UsageWindow {
                    label: label.to_string(),
                    used_percent: used,
                    resets_at: section
                        .get("resets_at")
                        .and_then(JsonValue::as_str)
                        .map(str::to_string),
                });
            }
        }
    }
    if let Some(limits) = value.get("limits").and_then(JsonValue::as_array) {
        for limit in limits {
            if limit.get("kind").and_then(JsonValue::as_str) != Some("weekly_scoped") {
                continue;
            }
            let Some(model) = limit
                .get("scope")
                .and_then(|scope| scope.get("model"))
                .and_then(|model| model.get("display_name"))
                .and_then(JsonValue::as_str)
            else {
                continue;
            };
            let Some(used) = limit.get("percent").and_then(JsonValue::as_f64) else {
                continue;
            };
            windows.push(UsageWindow {
                label: model.to_string(),
                used_percent: used,
                resets_at: limit
                    .get("resets_at")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
            });
        }
    }
    (!windows.is_empty()).then_some(windows)
}

/// Scan codex rollout JSONL from the end for a `token_count` event and map
/// `rate_limits.primary` → "5h", `rate_limits.secondary` → "7d".
fn parse_codex_rollout_usage(text: &str) -> Option<Vec<UsageWindow>> {
    for line in text.lines().rev() {
        let line = line.trim();
        if !line.contains("token_count") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<JsonValue>(line) else {
            continue;
        };
        if value.get("type").and_then(JsonValue::as_str) != Some("event_msg") {
            continue;
        }
        let Some(payload) = value.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(JsonValue::as_str) != Some("token_count") {
            continue;
        }
        let Some(rate_limits) = payload.get("rate_limits") else {
            continue;
        };
        let mut windows = Vec::new();
        for (key, label) in [("primary", "5h"), ("secondary", "7d")] {
            if let Some(window) = rate_limits.get(key) {
                if let Some(used) = window.get("used_percent").and_then(JsonValue::as_f64) {
                    windows.push(UsageWindow {
                        label: label.to_string(),
                        used_percent: used,
                        resets_at: window
                            .get("resets_at")
                            .and_then(JsonValue::as_i64)
                            .and_then(unix_to_rfc3339),
                    });
                }
            }
        }
        if !windows.is_empty() {
            return Some(windows);
        }
    }
    None
}

// --- local credential/config stores -----------------------------------------

/// Claude OAuth access token: macOS Keychain item "Claude Code-credentials",
/// falling back to `~/.claude/.credentials.json`. Never logged or returned.
fn claude_oauth_token() -> Option<String> {
    let json = keychain_claude_credentials()
        .or_else(|| home_file(&[".claude", ".credentials.json"]))
        .and_then(|text| serde_json::from_str::<JsonValue>(&text).ok())?;
    json.get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(str::to_string)
        .filter(|token| !token.is_empty())
}

#[cfg(target_os = "macos")]
fn keychain_claude_credentials() -> Option<String> {
    let output = run_cli(
        Path::new("/usr/bin/security"),
        &[
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ],
    )?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(not(target_os = "macos"))]
fn keychain_claude_credentials() -> Option<String> {
    None
}

fn codex_auth_json() -> Option<String> {
    home_file(&[".codex", "auth.json"])
}

fn kimi_credentials_json() -> Option<String> {
    home_file(&[".kimi-code", "credentials", "kimi-code.json"])
}

/// Whether the local kimi-code credentials file holds a usable access token.
/// Used by the skill runtime auth probe; never exposes the token itself.
pub(crate) fn kimi_credentials_valid() -> bool {
    kimi_credentials_json()
        .and_then(|text| parse_kimi_credentials(&text, unix_now()))
        .map(|info| info.valid)
        .unwrap_or(false)
}

fn home_file(segments: &[&str]) -> Option<String> {
    let mut path = dirs::home_dir()?;
    for segment in segments {
        path.push(segment);
    }
    std::fs::read_to_string(path).ok()
}

/// Recent `rollout-*.jsonl` files in newest-first order. Sessions live under
/// `YYYY/MM/DD`; descending date directories avoid an unbounded full-tree
/// walk, while spanning days lets a just-created rollout fall back to the
/// preceding session that already contains quota data.
fn recent_rollout_files(root: &Path, limit: usize) -> Vec<PathBuf> {
    fn child_dirs_desc(dir: &Path) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut paths = entries
            .flatten()
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        paths.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
        paths
    }

    let mut found = Vec::new();
    for year in child_dirs_desc(root) {
        for month in child_dirs_desc(&year) {
            for day in child_dirs_desc(&month) {
                let Ok(entries) = std::fs::read_dir(&day) else {
                    continue;
                };
                let mut rollouts = entries
                    .flatten()
                    .filter(|entry| {
                        entry
                            .file_type()
                            .map(|kind| kind.is_file())
                            .unwrap_or(false)
                            && entry
                                .file_name()
                                .to_str()
                                .map(|name| {
                                    name.starts_with("rollout-") && name.ends_with(".jsonl")
                                })
                                .unwrap_or(false)
                    })
                    .map(|entry| entry.path())
                    .collect::<Vec<_>>();
                rollouts.sort_by(|left, right| {
                    let modified = |path: &Path| {
                        path.metadata()
                            .and_then(|meta| meta.modified())
                            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
                    };
                    modified(right)
                        .cmp(&modified(left))
                        .then_with(|| right.file_name().cmp(&left.file_name()))
                });
                let remaining = limit.saturating_sub(found.len());
                found.extend(rollouts.into_iter().take(remaining));
                if found.len() >= limit {
                    return found;
                }
            }
        }
    }
    found
}

#[cfg(test)]
fn newest_rollout_file(root: &Path) -> Option<PathBuf> {
    recent_rollout_files(root, 1).into_iter().next()
}

/// Read the last `max_bytes` of a file as (lossy) UTF-8. The first line of a
/// tail chunk may be partial; JSONL scanners tolerate the truncated record.
fn read_file_tail(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(max_bytes)))?;
    let mut buf = Vec::new();
    file.take(max_bytes).read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

// --- small helpers -----------------------------------------------------------

fn override_for<'a>(
    overrides: Option<&'a HashMap<String, String>>,
    provider: CliProviderKind,
) -> Option<&'a str> {
    overrides
        .and_then(|map| map.get(provider.id()))
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// 8s in production. Tests tighten it to 500ms so the sleeping-fake-CLI test
/// stays fast — except under `MARU_CLI_SMOKE`, where the test drives the real
/// binaries and a real `--version` can take most of that 500ms on its own.
fn cli_probe_timeout() -> Duration {
    if cfg!(test) && std::env::var_os("MARU_CLI_SMOKE").is_none() {
        return Duration::from_millis(500);
    }
    Duration::from_secs(8)
}

fn run_cli(program: &Path, args: &[&str]) -> Option<std::process::Output> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env("PATH", augmented_path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .no_window();
    let mut child = crate::agent_host::provider::retry_etxtbsy(|| cmd.spawn()).ok()?;
    let deadline = Instant::now() + cli_probe_timeout();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                // Timed out (or try_wait failed): kill and reap the child.
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn unix_now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn unix_to_rfc3339(secs: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(secs, 0).map(|dt| dt.to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unsigned_jwt(payload: &str) -> String {
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!(
            "{}.{}.signature",
            engine.encode(br#"{"alg":"none"}"#),
            engine.encode(payload.as_bytes())
        )
    }

    #[test]
    fn parses_claude_auth_status_json() {
        let text = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
            "email":"dev@example.com","orgId":"org-1","orgName":"Example Org","subscriptionType":"max"}"#;
        let info = parse_claude_auth_status(text).unwrap();
        assert!(info.logged_in);
        assert_eq!(info.auth_method.as_deref(), Some("claude.ai"));
        assert_eq!(info.api_provider.as_deref(), Some("firstParty"));
        assert_eq!(info.org_name.as_deref(), Some("Example Org"));
        assert_eq!(info.email.as_deref(), Some("dev@example.com"));

        let logged_out = parse_claude_auth_status(r#"{"loggedIn":false}"#).unwrap();
        assert!(!logged_out.logged_in);
        assert!(parse_claude_auth_status("not json").is_none());
    }

    #[test]
    fn parses_codex_login_status_text() {
        assert_eq!(
            parse_codex_login_status(true, "Logged in using ChatGPT\n"),
            Some("ChatGPT".to_string())
        );
        assert!(parse_codex_login_status(false, "Not logged in").is_none());
        assert!(parse_codex_login_status(true, "some other output").is_none());
    }

    #[test]
    fn decodes_codex_auth_json_jwt_email() {
        let jwt = unsigned_jwt(r#"{"email":"dev@example.com","name":"Dev"}"#);
        let auth_json = format!(r#"{{"tokens":{{"id_token":"{jwt}"}}}}"#);
        assert_eq!(
            parse_codex_auth_email(&auth_json).as_deref(),
            Some("dev@example.com")
        );
        assert!(parse_codex_auth_email(r#"{"tokens":{"id_token":"not-a-jwt"}}"#).is_none());
        assert!(parse_codex_auth_email("{}").is_none());
    }

    #[test]
    fn parses_kimi_credentials_validity_and_email() {
        let jwt = unsigned_jwt(r#"{"sub":"user-123"}"#);
        let future = unix_now() + 3600;
        let text = format!(
            r#"{{"access_token":"{jwt}","refresh_token":"rt","expires_at":{future},"token_type":"Bearer"}}"#
        );
        let info = parse_kimi_credentials(&text, unix_now()).unwrap();
        assert!(info.valid);
        assert_eq!(info.email.as_deref(), Some("user-123"));

        let past = unix_now() - 3600;
        let expired = format!(r#"{{"access_token":"{jwt}","expires_at":{past}}}"#);
        assert!(!parse_kimi_credentials(&expired, unix_now()).unwrap().valid);

        let no_expiry = format!(r#"{{"access_token":"{jwt}"}}"#);
        assert!(
            parse_kimi_credentials(&no_expiry, unix_now())
                .unwrap()
                .valid
        );

        let millis = format!(
            r#"{{"access_token":"{jwt}","expires_at":{}}}"#,
            future * 1000
        );
        assert!(parse_kimi_credentials(&millis, unix_now()).unwrap().valid);
    }

    #[test]
    fn parses_kiro_whoami_text() {
        let text = "Logged in with IAM Identity Center (https://d-123.awsapps.com/start)\n\
                    Email: dev@example.com\n\
                    Profile:\n\
                    dev-profile\n";
        let info = parse_kiro_whoami(text);
        assert_eq!(info.login_method.as_deref(), Some("IAM Identity Center"));
        assert_eq!(info.email.as_deref(), Some("dev@example.com"));
        assert_eq!(info.profile.as_deref(), Some("dev-profile"));

        let inline =
            parse_kiro_whoami("Logged in with IAM Identity Center\nEmail: a@b.c\nProfile: work\n");
        assert_eq!(inline.profile.as_deref(), Some("work"));

        let logged_out = parse_kiro_whoami("Not logged in. Run `kiro-cli login`.\n");
        assert!(logged_out.email.is_none());
    }

    #[test]
    fn maps_claude_usage_response_to_windows() {
        let text = r#"{
            "five_hour":{"utilization":22.0,"resets_at":"2026-07-29T00:00:00.632699+00:00"},
            "seven_day":{"utilization":90.0,"resets_at":"2026-07-31T19:59:59.632719+00:00"},
            "limits":[
                {"kind":"session","percent":22,"resets_at":"2026-07-29T00:00:00Z"},
                {"kind":"weekly_all","percent":90,"resets_at":"2026-07-31T19:59:59Z"},
                {"kind":"weekly_scoped","percent":23,"resets_at":"2026-07-31T19:59:59Z",
                 "scope":{"model":{"display_name":"Fable"}}}
            ]
        }"#;
        let windows = parse_claude_usage_windows(text).unwrap();
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].label, "5h");
        assert_eq!(windows[0].used_percent, 22.0);
        assert_eq!(
            windows[0].resets_at.as_deref(),
            Some("2026-07-29T00:00:00.632699+00:00")
        );
        assert_eq!(windows[1].label, "7d");
        assert_eq!(windows[1].used_percent, 90.0);
        assert_eq!(windows[2].label, "Fable");
        assert_eq!(windows[2].used_percent, 23.0);

        assert!(parse_claude_usage_windows("{}").is_none());
        assert!(parse_claude_usage_windows("not json").is_none());
    }

    #[test]
    fn parses_codex_rollout_token_count_from_end() {
        let line = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "rate_limits": {
                    "primary": {"used_percent": 72.3, "resets_at": 1780000000},
                    "secondary": {"used_percent": 12.0, "resets_at": 1780500000}
                }
            }
        });
        let text = format!(
            "{{\"type\":\"response_item\"}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"other\"}}}}\n{line}\n{{\"type\":\"response_item\"}}\n"
        );
        let windows = parse_codex_rollout_usage(&text).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].label, "5h");
        assert_eq!(windows[0].used_percent, 72.3);
        assert!(windows[0].resets_at.is_some());
        assert_eq!(windows[1].label, "7d");
        assert_eq!(windows[1].used_percent, 12.0);

        assert!(parse_codex_rollout_usage("{\"type\":\"response_item\"}\n").is_none());
    }

    #[test]
    fn codex_rollout_skips_newer_quota_less_token_count_events() {
        let valid = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "rate_limits": {
                    "primary": {"used_percent": 37.0, "resets_at": 1780000000}
                }
            }
        });
        let no_limits = serde_json::json!({
            "type": "event_msg",
            "payload": {"type": "token_count"}
        });
        let empty_limits = serde_json::json!({
            "type": "event_msg",
            "payload": {"type": "token_count", "rate_limits": {"primary": null}}
        });
        let text = format!("{valid}\n{no_limits}\n{empty_limits}\n");

        let windows = parse_codex_rollout_usage(&text).unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].used_percent, 37.0);
    }

    #[test]
    fn newest_rollout_file_picks_latest_by_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let day = dir.path().join("2026/07/28");
        std::fs::create_dir_all(&day).unwrap();
        let older = day.join("rollout-1.jsonl");
        let newer = day.join("rollout-2.jsonl");
        std::fs::write(&older, "{}\n").unwrap();
        std::fs::write(day.join("notes.txt"), "x").unwrap();
        std::fs::write(&newer, "{}\n").unwrap();
        let found = newest_rollout_file(dir.path()).unwrap();
        assert_eq!(found, newer);
        assert!(newest_rollout_file(&dir.path().join("missing")).is_none());
    }

    #[test]
    fn newest_rollout_file_uses_newest_date_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let old_day = dir.path().join("2025/12/31");
        let new_day = dir.path().join("2026/01/02");
        std::fs::create_dir_all(&old_day).unwrap();
        std::fs::create_dir_all(&new_day).unwrap();
        std::fs::write(old_day.join("rollout-old.jsonl"), "{}\n").unwrap();
        let newest = new_day.join("rollout-new.jsonl");
        std::fs::write(&newest, "{}\n").unwrap();

        assert_eq!(newest_rollout_file(dir.path()), Some(newest));
        // A year dir without month/day dirs yields nothing.
        let empty = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(empty.path().join("2026")).unwrap();
        assert!(newest_rollout_file(empty.path()).is_none());
    }

    #[test]
    fn codex_usage_falls_back_to_an_older_recent_rollout() {
        let dir = tempfile::tempdir().unwrap();
        let old_day = dir.path().join("2026/07/31");
        let new_day = dir.path().join("2026/08/01");
        std::fs::create_dir_all(&old_day).unwrap();
        std::fs::create_dir_all(&new_day).unwrap();

        let older = old_day.join("rollout-with-usage.jsonl");
        let newer = new_day.join("rollout-startup-only.jsonl");
        let token_count = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "rate_limits": {
                    "primary": {"used_percent": 41.0, "resets_at": 1780000000}
                }
            }
        });
        std::fs::write(&older, format!("{token_count}\n")).unwrap();
        std::fs::write(&newer, "{\"type\":\"session_meta\"}\n").unwrap();

        let recent = recent_rollout_files(dir.path(), MAX_RECENT_ROLLOUTS);
        assert_eq!(recent, vec![newer, older]);
        let windows = codex_usage_from_rollouts(&recent).unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].label, "5h");
        assert_eq!(windows[0].used_percent, 41.0);
    }

    #[test]
    fn read_file_tail_reads_only_the_end() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout-x.jsonl");
        let head = "a".repeat(4 * 1024);
        let tail_line = r#"{"type":"event_msg","payload":{"type":"token_count"}}"#;
        std::fs::write(&path, format!("{head}\n{tail_line}\n")).unwrap();

        let text = read_file_tail(&path, 256).unwrap();
        assert!(text.len() <= 256 + 1);
        assert!(!text.starts_with(head.as_str()));
        assert!(text.contains("token_count"));

        // Small files are read whole.
        let small = dir.path().join("small.jsonl");
        std::fs::write(&small, "{}\n").unwrap();
        assert_eq!(read_file_tail(&small, 256).unwrap(), "{}\n");
    }

    #[cfg(unix)]
    #[test]
    fn run_cli_collects_output_for_fast_commands() {
        let output = run_cli(Path::new("/bin/sh"), &["-c", "echo ok"]).unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("ok"));
    }

    #[cfg(unix)]
    #[test]
    fn run_cli_times_out_on_sleeping_process() {
        // CLI_PROBE_TIMEOUT is 500ms under cfg(test); the sleeper must be
        // killed and reaped well before its own 30s sleep ends.
        let start = Instant::now();
        let output = run_cli(Path::new("/bin/sh"), &["-c", "sleep 30"]);
        assert!(output.is_none());
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn usage_cache_key_changes_with_command_override() {
        let mut first = HashMap::new();
        first.insert("codex".to_string(), "/opt/codex-a".to_string());
        let mut second = HashMap::new();
        second.insert("codex".to_string(), "/opt/codex-b".to_string());

        assert_ne!(
            usage_cache_key(CliProviderKind::Codex, Some(&first)),
            usage_cache_key(CliProviderKind::Codex, Some(&second))
        );
        assert_eq!(
            usage_cache_key(CliProviderKind::Claude, Some(&first)),
            usage_cache_key(CliProviderKind::Claude, Some(&second))
        );
    }

    #[cfg(unix)]
    #[test]
    fn newest_rollout_file_does_not_follow_symlink_cycles() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let day = dir.path().join("2026/07/29");
        std::fs::create_dir_all(&day).unwrap();
        let rollout = day.join("rollout-safe.jsonl");
        std::fs::write(&rollout, "{}\n").unwrap();
        symlink(dir.path(), day.join("cycle")).unwrap();

        assert_eq!(newest_rollout_file(dir.path()), Some(rollout));
    }

    /// Smoke the *real* installed AI CLIs. Every other provider test drives a
    /// fake shell script (provider.rs `write_fake_cli`), so nothing about the
    /// actual integration is covered by `make verify`. Run with:
    ///
    ///   make verify-integration
    ///   MARU_CLI_SMOKE_ROUNDTRIP=1 make verify-integration   # + one live prompt
    ///
    /// Backends that are not installed on this machine are skipped, not failed.
    #[test]
    #[ignore]
    fn cli_backends_real_smoke() {
        use crate::agent_host::contracts::{CompletionRequest, COMPLETION_REQUEST_SCHEMA_VERSION};
        use crate::agent_host::provider::{CliProviderAdapter, ProviderAdapter};

        if std::env::var("MARU_CLI_SMOKE").is_err() {
            eprintln!("skipped: set MARU_CLI_SMOKE=1 (see `make verify-integration`)");
            return;
        }
        // Not a tempdir: `codex exec` refuses to run outside a trusted (git)
        // directory unless --skip-git-repo-check is passed, and the product
        // never passes it (see aiInvoke.ts). The crate root is always a repo.
        let cwd = env!("CARGO_MANIFEST_DIR").to_string();
        let request = || CompletionRequest {
            schema_version: COMPLETION_REQUEST_SCHEMA_VERSION.to_string(),
            provider: "cli".to_string(),
            prompt: "Reply with OK.".to_string(),
            cwd: cwd.clone(),
            mode: "autonomous-loop".to_string(),
            metadata: None,
        };

        let mut checked = 0;
        for provider in AGENTS {
            let Some(binary) = resolve_provider_binary(provider, None) else {
                eprintln!("skip {}: not installed", provider.default_binary_name());
                continue;
            };
            checked += 1;
            let caps = provider.capabilities();
            let id = provider.id();

            // 1. the binary answers --version
            let account = account_status(provider, None);
            assert!(
                account.installed && account.version.is_some(),
                "{id}: `{} --version` produced no usable output",
                provider.default_binary_name()
            );

            // 2. auth classification is a known state, never empty or a panic
            assert!(
                matches!(
                    account.auth_status.as_str(),
                    "authenticated" | "unauthenticated" | "unknown"
                ),
                "{id}: unexpected auth_status {:?}",
                account.auth_status
            );

            // 3. the skills gate and the account probe agree about this machine
            let gate = crate::skill_host::dispatch::runtime_status(id.to_string(), None).unwrap();
            assert_eq!(
                gate.available,
                account.auth_status == "authenticated",
                "{id}: skills gate available={} but account probe says {:?}",
                gate.available,
                account.auth_status
            );

            // 4. the usage capability flag matches what the probe actually does
            assert_eq!(
                usage_status(provider, None, true).state == "unsupported",
                !caps.usage,
                "{id}: usage state contradicts capabilities()"
            );

            // 5. Ask the real resolved binary to parse both permission modes.
            // `--help` prevents a model call while still detecting removed or
            // renamed options in the installed provider version.
            for (mode, args, help_needle) in permission_probe_args(provider) {
                let output = run_cli(&binary, args)
                    .unwrap_or_else(|| panic!("{id} {mode}: permission probe timed out"));
                let text = format!(
                    "{}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                assert!(
                    output.status.success() && text.contains(help_needle),
                    "{id} {mode}: real CLI rejected {:?} or omitted {:?}: {}",
                    args,
                    help_needle,
                    text.lines()
                        .find(|line| !line.trim().is_empty())
                        .unwrap_or("")
                );
            }

            // 6. one trivial round trip — opt-in: it costs tokens and 10-60s
            if std::env::var("MARU_CLI_SMOKE_ROUNDTRIP").is_ok()
                && account.auth_status == "authenticated"
            {
                let mut adapter =
                    CliProviderAdapter::new(provider, Vec::new(), None, "plan".to_string());
                let response = adapter
                    .complete(request())
                    .unwrap_or_else(|err| panic!("{id}: round trip failed: {err}"));
                assert_eq!(response.provider, id);
                // Deliberately not asserting the model's words — that is flaky,
                // not a contract.
                assert!(
                    !response.content.trim().is_empty(),
                    "{id}: empty completion"
                );
            }

            eprintln!(
                "{id}: {} auth={} usage={}",
                account.version.as_deref().unwrap_or("?"),
                account.auth_status,
                caps.usage
            );
        }
        if checked == 0 {
            eprintln!("skipped: no installed AI CLI found; nothing to verify");
        }
    }

    type PermissionProbe = (&'static str, &'static [&'static str], &'static str);

    fn permission_probe_args(provider: CliProviderKind) -> [PermissionProbe; 2] {
        match provider {
            CliProviderKind::Claude => [
                (
                    "plan",
                    &["--permission-mode", "plan", "--help"],
                    "--permission-mode",
                ),
                (
                    "acceptEdits",
                    &["--permission-mode", "acceptEdits", "--help"],
                    "acceptEdits",
                ),
            ],
            CliProviderKind::Codex => [
                (
                    "plan",
                    &["exec", "--sandbox", "read-only", "--help"],
                    "--sandbox",
                ),
                (
                    "acceptEdits",
                    &["exec", "--sandbox", "workspace-write", "--help"],
                    "--sandbox",
                ),
            ],
            CliProviderKind::Kimi => [
                ("plan", &["--plan", "--help"], "--plan"),
                ("acceptEdits", &["-y", "--help"], "--yolo"),
            ],
            CliProviderKind::Kiro => [
                (
                    "plan",
                    &[
                        "chat",
                        "--no-interactive",
                        "--trust-tools=read,grep",
                        "--help",
                    ],
                    "--trust-tools",
                ),
                (
                    "acceptEdits",
                    &[
                        "chat",
                        "--no-interactive",
                        "--trust-tools=read,grep,write",
                        "--help",
                    ],
                    "--trust-tools",
                ),
            ],
        }
    }
}
