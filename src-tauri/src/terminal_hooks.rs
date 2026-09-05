// Agent status hooks (Phase D): a file-based event channel that lets external
// CLI agents (Claude Code, Codex, Kimi) report lifecycle transitions back to Maru
// so the terminal sidebar can show precise running / needs-input / done status
// and capture a native session id for resume.
//
// Flow:
//   agent lifecycle event
//     → hook runs `maru-cli terminal-hook --event <token> --agent <a>`
//     → appends one JSON line to ~/.maru/runtime/terminal/<sessionId>/events.jsonl
//     → a `notify` watcher in the app picks up the new line
//     → emits `terminal://status` to the webview.
//
// Only status metadata is written to disk — never note bodies. The installer is
// opt-in, marker-based, and reversible, and never clobbers the user's own hooks.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::atomic_file::{
    with_path_transactions, write_atomic_private, PathTransactionLease, PathTransactionRequest,
};

/// Canonical claude hook events → status token. The installer translates each
/// agent's native lifecycle event into one of our tokens, so the frontend
/// mapping stays version-robust.
const CLAUDE_HOOK_EVENTS: &[(&str, &str)] = &[
    ("UserPromptSubmit", "running"),
    ("Notification", "needs-input"),
    ("Stop", "done"),
];

/// Kimi lifecycle events use the same canonical status tokens. SessionStart is
/// essential because its stdin carries Kimi's native session id for resume.
const KIMI_HOOK_EVENTS: &[(&str, &str)] = &[
    ("SessionStart", "running"),
    ("UserPromptSubmit", "running"),
    ("PermissionRequest", "needs-input"),
    ("PermissionResult", "running"),
    ("Stop", "done"),
    ("StopFailure", "done"),
    ("Interrupt", "done"),
    ("SessionEnd", "done"),
];

/// Substring marking an Maru-managed hook command (for idempotency + removal).
const HOOK_MARKER: &str = "terminal-hook";
const KIMI_HOOK_START: &str = "# maru:kimi-terminal-hooks v1 start";
const KIMI_HOOK_END: &str = "# maru:kimi-terminal-hooks v1 end";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn maru_home() -> Result<PathBuf, String> {
    crate::skill_host::fs::maru_home()
}

fn runtime_terminal_dir() -> Result<PathBuf, String> {
    Ok(maru_home()?.join("runtime").join("terminal"))
}

/// Accept only a safe leaf id (`term-<uuid>` shape). Rejects traversal.
fn sanitize_session_id(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return None;
    }
    if trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !trimmed.contains("..")
    {
        Some(trimmed.to_string())
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// CLI: `maru-cli terminal-hook --event <token> [--agent x] [--session-id id]`
// ---------------------------------------------------------------------------

/// Best-effort hook sink. Always returns 0 so a failure never blocks the agent.
pub fn run_terminal_hook(args: &[String]) -> i32 {
    let mut event: Option<String> = None;
    let mut agent: Option<String> = None;
    let mut session_id_arg: Option<String> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--event" => event = iter.next().cloned(),
            "--agent" => agent = iter.next().cloned(),
            "--session-id" => session_id_arg = iter.next().cloned(),
            _ => {}
        }
    }
    let Some(event) = event else {
        return 0;
    };
    let Some(session_id) = std::env::var("MARU_SESSION_ID")
        .ok()
        .and_then(|raw| sanitize_session_id(&raw))
    else {
        return 0;
    };

    // Native agent session id: explicit arg wins, else parse the hook stdin JSON.
    let agent_session_id = session_id_arg.or_else(read_agent_session_id_from_stdin);

    let dir = match runtime_terminal_dir() {
        Ok(base) => base.join(&session_id),
        Err(_) => return 0,
    };
    let _ = append_event_line(
        &dir,
        &session_id,
        &event,
        agent.as_deref(),
        agent_session_id.as_deref(),
    );
    0
}

fn read_agent_session_id_from_stdin() -> Option<String> {
    let mut buf = String::new();
    if std::io::stdin().read_to_string(&mut buf).is_err() || buf.trim().is_empty() {
        return None;
    }
    agent_session_id_from_hook_json(&buf)
}

fn agent_session_id_from_hook_json(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    for key in ["session_id", "sessionId", "conversation_id", "id"] {
        if let Some(found) = value.get(key).and_then(Value::as_str) {
            if !found.is_empty() {
                return Some(found.to_string());
            }
        }
    }
    None
}

/// Append one status line to `<dir>/events.jsonl`. Factored out for testing.
fn append_event_line(
    dir: &Path,
    session_id: &str,
    event: &str,
    agent: Option<&str>,
    agent_session_id: Option<&str>,
) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|err| format!("Cannot create hook dir: {err}"))?;
    let line = json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "sessionId": session_id,
        "status": event,
        "agent": agent,
        "agentSessionId": agent_session_id,
    });
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("events.jsonl"))
        .map_err(|err| format!("Cannot open events file: {err}"))?;
    writeln!(file, "{line}").map_err(|err| format!("Cannot append event: {err}"))
}

// ---------------------------------------------------------------------------
// Watcher: tail events.jsonl files → emit `terminal://status`
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStatusEvent {
    session_id: String,
    status: String,
    agent_session_id: Option<String>,
}

#[derive(Default)]
pub struct TerminalHookWatcherState(pub Mutex<Option<RecommendedWatcher>>);

/// Start watching `~/.maru/runtime/terminal/` for hook events. Idempotent:
/// replacing the watcher drops the previous one.
pub fn start_terminal_hook_watcher(app: &AppHandle) -> Result<(), String> {
    let dir = runtime_terminal_dir()?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("Cannot create runtime dir: {err}"))?;

    let offsets: Arc<Mutex<HashMap<PathBuf, u64>>> = Arc::new(Mutex::new(HashMap::new()));
    let app_handle = app.clone();
    let offsets_for_handler = offsets.clone();
    let dir_for_handler = dir.clone();

    let mut watcher = recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else {
            return;
        };
        if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
            return;
        }
        for path in event.paths {
            // PERF-04 prune runs on the watch-dir-relative path (WR-01): the
            // runtime dir can live under an ancestor named like a generated
            // dir (e.g. a home directory literally named `dist`), which must
            // not silence every hook event.
            if path
                .strip_prefix(&dir_for_handler)
                .map(crate::paths::is_under_generated_dir)
                .unwrap_or(true)
            {
                continue;
            }
            if path.file_name().and_then(|n| n.to_str()) != Some("events.jsonl") {
                continue;
            }
            emit_new_events(&app_handle, &offsets_for_handler, &path);
        }
    })
    .map_err(|err| format!("Cannot create hook watcher: {err}"))?;

    watcher
        .watch(&dir, RecursiveMode::Recursive)
        .map_err(|err| format!("Cannot watch hook dir: {err}"))?;

    let state: State<'_, TerminalHookWatcherState> = app.state();
    *state
        .0
        .lock()
        .map_err(|_| "watcher state poisoned".to_string())? = Some(watcher);
    Ok(())
}

fn emit_new_events(app: &AppHandle, offsets: &Arc<Mutex<HashMap<PathBuf, u64>>>, path: &Path) {
    let session_id = match path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
    {
        Some(id) => id.to_string(),
        None => return,
    };

    let Ok(mut file) = std::fs::File::open(path) else {
        return;
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);

    let mut guard = match offsets.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let mut start = *guard.get(path).unwrap_or(&0);
    if len < start {
        start = 0; // file truncated/rotated
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return;
    }
    // Only consume up to the last newline so a partially-written line is re-read.
    let consumed = buf.rfind('\n').map(|i| i + 1).unwrap_or(0);
    guard.insert(path.to_path_buf(), start + consumed as u64);
    drop(guard);

    for line in buf[..consumed].lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let status = value.get("status").and_then(Value::as_str).unwrap_or("");
        if status.is_empty() {
            continue;
        }
        let payload = TerminalStatusEvent {
            session_id: session_id.clone(),
            status: status.to_string(),
            agent_session_id: value
                .get("agentSessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
        };
        let _ = app.emit("terminal://status", payload);
    }
}

// ---------------------------------------------------------------------------
// Installer: Claude settings.json + Kimi config.toml hooks
// ---------------------------------------------------------------------------

fn bundled_maru_cli_for_exe(exe: &Path) -> Option<PathBuf> {
    let contents = exe.parent()?.parent()?;
    let candidate = contents.join("Resources").join("maru-cli");
    candidate.exists().then_some(candidate)
}

/// Resolve an absolute path to the bundled Resources wrapper, falling back to
/// the bare name (relying on PATH) when the app-bundle wrapper is unavailable.
fn resolve_maru_cli() -> String {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(candidate) = bundled_maru_cli_for_exe(&exe) {
            return candidate.to_string_lossy().to_string();
        }
    }
    "maru-cli".to_string()
}

fn claude_command(cli: &str, token: &str) -> String {
    format!("{cli} terminal-hook --event {token} --agent claude")
}

fn is_maru_hook_command(command: &str) -> bool {
    command.contains(HOOK_MARKER) && command.contains("--agent claude")
}

/// Merge Maru hook entries into a Claude settings document. Returns whether
/// anything changed (idempotent — re-running is a no-op).
fn merge_claude_hooks(root: &mut Value, cli: &str) -> bool {
    if !root.is_object() {
        *root = json!({});
    }
    let obj = root.as_object_mut().expect("object");
    let hooks = obj.entry("hooks".to_string()).or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks_obj = hooks.as_object_mut().expect("hooks object");
    let mut changed = false;
    for (event, token) in CLAUDE_HOOK_EVENTS {
        let command = claude_command(cli, token);
        let entry = hooks_obj
            .entry((*event).to_string())
            .or_insert_with(|| json!([]));
        if !entry.is_array() {
            *entry = json!([]);
        }
        let array = entry.as_array_mut().expect("event array");
        let already = array.iter().any(group_has_maru_command);
        if !already {
            array.push(json!({
                "hooks": [ { "type": "command", "command": command } ]
            }));
            changed = true;
        }
    }
    changed
}

fn group_has_maru_command(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(Value::as_str)
                    .map(is_maru_hook_command)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Remove all Maru-managed hook entries. Returns whether anything changed.
fn remove_claude_hooks(root: &mut Value) -> bool {
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return false;
    };
    let mut changed = false;
    for (_event, entry) in hooks.iter_mut() {
        if let Some(array) = entry.as_array_mut() {
            let before = array.len();
            array.retain(|group| !group_has_maru_command(group));
            if array.len() != before {
                changed = true;
            }
        }
    }
    changed
}

fn claude_hooks_installed(root: &Value) -> bool {
    let Some(hooks) = root.get("hooks").and_then(Value::as_object) else {
        return false;
    };
    CLAUDE_HOOK_EVENTS.iter().all(|(event, token)| {
        hooks
            .get(*event)
            .and_then(Value::as_array)
            .map(|groups| {
                groups.iter().any(|group| {
                    group
                        .get("hooks")
                        .and_then(Value::as_array)
                        .map(|entries| {
                            entries.iter().any(|entry| {
                                entry
                                    .get("command")
                                    .and_then(Value::as_str)
                                    .map(|command| {
                                        is_maru_hook_command(command)
                                            && command.contains(&format!("--event {token}"))
                                    })
                                    .unwrap_or(false)
                            })
                        })
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    })
}

fn claude_settings_path(work_path: Option<&str>, scope: &str) -> Result<PathBuf, String> {
    if scope == "project" {
        let work =
            work_path.ok_or_else(|| "workspace path required for project scope".to_string())?;
        Ok(PathBuf::from(work).join(".claude").join("settings.json"))
    } else {
        Ok(crate::skill_host::fs::install_root_base()?
            .join(".claude")
            .join("settings.json"))
    }
}

fn kimi_config_path() -> Result<PathBuf, String> {
    let home = crate::skill_host::fs::install_root_base()?;
    // Fixture/native homes must also override an inherited Kimi profile.
    #[cfg(any(test, feature = "native-e2e"))]
    if cfg!(feature = "native-e2e") || std::env::var_os("MARU_TEST_HOME").is_some() {
        return Ok(kimi_config_path_for(&home, None));
    }
    let configured_home = std::env::var_os("KIMI_CODE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    Ok(kimi_config_path_for(&home, configured_home))
}

fn kimi_config_path_for(home: &Path, configured_home: Option<PathBuf>) -> PathBuf {
    configured_home
        .unwrap_or_else(|| home.join(".kimi-code"))
        .join("config.toml")
}

fn read_text_or_empty(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(format!("Cannot read {}: {err}", path.display())),
    }
}

fn read_json_object(path: &Path) -> Result<Value, String> {
    let raw = read_text_or_empty(path)?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str::<Value>(&raw)
        .map_err(|err| format!("Cannot parse {}: {err}", path.display()))
        .and_then(|value| {
            if value.is_object() {
                Ok(value)
            } else {
                Err(format!("Expected a JSON object in {}", path.display()))
            }
        })
}

fn write_kimi_config(path: &Path, content: &str) -> Result<(), String> {
    let target = match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            std::fs::canonicalize(path).map_err(|err| {
                format!(
                    "Cannot resolve Kimi config symlink {}: {err}",
                    path.display()
                )
            })?
        }
        Ok(_) => path.to_path_buf(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => path.to_path_buf(),
        Err(err) => return Err(format!("Cannot inspect {}: {err}", path.display())),
    };
    write_atomic_private(&target, content.as_bytes())
}

fn write_json_pretty(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("Cannot create dir: {err}"))?;
    }
    let mut text =
        serde_json::to_string_pretty(value).map_err(|err| format!("Cannot serialize: {err}"))?;
    text.push('\n');
    std::fs::write(path, text).map_err(|err| format!("Cannot write {}: {err}", path.display()))
}

fn shell_quote_token(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-'))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn kimi_command(cli: &str, token: &str) -> String {
    format!(
        "{} terminal-hook --event {token} --agent kimi",
        shell_quote_token(cli)
    )
}

fn kimi_hook_block(cli: &str) -> String {
    let mut block = format!("{KIMI_HOOK_START}\n");
    for (event, token) in KIMI_HOOK_EVENTS {
        let command = serde_json::to_string(&kimi_command(cli, token))
            .expect("serializing a command string cannot fail");
        block.push_str(&format!(
            "[[hooks]]\nevent = \"{event}\"\ncommand = {command}\ntimeout = 5\n\n"
        ));
    }
    block.push_str(KIMI_HOOK_END);
    block.push('\n');
    block
}

fn marked_block_range(
    content: &str,
    start_marker: &str,
    end_marker: &str,
) -> Option<(usize, usize)> {
    let start = content.find(start_marker)?;
    let end_offset = content[start..].find(end_marker)?;
    Some((start, start + end_offset + end_marker.len()))
}

fn kimi_hooks_installed(content: &str) -> bool {
    let Some((start, end)) = marked_block_range(content, KIMI_HOOK_START, KIMI_HOOK_END) else {
        return false;
    };
    let block = &content[start..end];
    KIMI_HOOK_EVENTS.iter().all(|(event, token)| {
        block.contains(&format!("event = \"{event}\""))
            && block.contains(&format!("--event {token} --agent kimi"))
    })
}

fn upsert_kimi_hooks(content: &str, cli: &str) -> String {
    upsert_marked_block(
        content,
        KIMI_HOOK_START,
        KIMI_HOOK_END,
        &kimi_hook_block(cli),
    )
}

fn remove_kimi_hooks(content: &str) -> String {
    remove_marked_block(content, KIMI_HOOK_START, KIMI_HOOK_END)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHooksStatus {
    pub scope: String,
    pub claude_path: String,
    pub claude_installed: bool,
    pub kimi_path: String,
    pub kimi_installed: bool,
    pub codex_hint: String,
}

fn codex_hint() -> String {
    let cli = resolve_maru_cli();
    format!(
        "Add to ~/.codex/config.toml: notify = [\"{cli}\", \"terminal-hook\", \"--event\", \"done\", \"--agent\", \"codex\"]"
    )
}

pub fn terminal_hooks_status(
    work_path: Option<String>,
    scope: String,
) -> Result<TerminalHooksStatus, String> {
    let claude_path = claude_settings_path(work_path.as_deref(), &scope)?;
    let kimi_path = kimi_config_path()?;
    let request = PathTransactionRequest::new(vec![claude_path, kimi_path])?;
    with_path_transactions(request, |lease| {
        terminal_hooks_status_in_transaction(work_path, scope, lease)
    })
}

fn terminal_hooks_status_in_transaction(
    work_path: Option<String>,
    scope: String,
    lease: &PathTransactionLease,
) -> Result<TerminalHooksStatus, String> {
    let claude_path = claude_settings_path(work_path.as_deref(), &scope)?;
    let kimi_path = kimi_config_path()?;
    lease.ensure_covered(vec![claude_path.clone(), kimi_path.clone()])?;
    let claude_root = read_json_object(&claude_path)?;
    let claude_installed = claude_hooks_installed(&claude_root);
    let kimi_content = read_text_or_empty(&kimi_path)?;
    Ok(TerminalHooksStatus {
        scope,
        claude_path: claude_path.to_string_lossy().to_string(),
        claude_installed,
        kimi_path: kimi_path.to_string_lossy().to_string(),
        kimi_installed: kimi_hooks_installed(&kimi_content),
        codex_hint: codex_hint(),
    })
}

pub fn terminal_hooks_install(
    work_path: Option<String>,
    scope: String,
) -> Result<TerminalHooksStatus, String> {
    let claude_path = claude_settings_path(work_path.as_deref(), &scope)?;
    let kimi_path = kimi_config_path()?;
    // Reserve both configuration files and the Kimi atomic writer's sibling
    // directory, including physical symlink targets, before reading either file.
    let kimi_target = if kimi_path.is_symlink() {
        std::fs::canonicalize(&kimi_path)
            .map_err(|err| format!("Cannot resolve Kimi config: {err}"))?
    } else {
        kimi_path.clone()
    };
    let request = PathTransactionRequest::new(vec![
        claude_path.clone(),
        kimi_path.clone(),
        kimi_target
            .parent()
            .ok_or("Kimi config has no parent")?
            .to_path_buf(),
    ])?;
    with_path_transactions(request, |lease| {
        terminal_hooks_install_in_transaction(work_path, scope, &claude_path, &kimi_path, lease)
    })
}

fn terminal_hooks_install_in_transaction(
    work_path: Option<String>,
    scope: String,
    claude_path: &Path,
    kimi_path: &Path,
    lease: &PathTransactionLease,
) -> Result<TerminalHooksStatus, String> {
    lease.ensure_covered(vec![claude_path.to_path_buf(), kimi_path.to_path_buf()])?;
    lease.before_effect()?;
    let mut claude_root = read_json_object(claude_path)?;
    let kimi_content = read_text_or_empty(kimi_path)?;
    let cli = resolve_maru_cli();
    let claude_changed = merge_claude_hooks(&mut claude_root, &cli);
    let next_kimi = upsert_kimi_hooks(&kimi_content, &cli);
    if next_kimi != kimi_content {
        write_kimi_config(kimi_path, &next_kimi)?;
    }
    if claude_changed {
        write_json_pretty(claude_path, &claude_root)?;
    }
    terminal_hooks_status_in_transaction(work_path, scope, lease)
}

pub fn terminal_hooks_uninstall(
    work_path: Option<String>,
    scope: String,
) -> Result<TerminalHooksStatus, String> {
    let claude_path = claude_settings_path(work_path.as_deref(), &scope)?;
    let kimi_path = kimi_config_path()?;
    // Reserve both configuration files and the Kimi atomic writer's sibling
    // directory, including physical symlink targets, before reading either file.
    let kimi_target = if kimi_path.is_symlink() {
        std::fs::canonicalize(&kimi_path)
            .map_err(|err| format!("Cannot resolve Kimi config: {err}"))?
    } else {
        kimi_path.clone()
    };
    let request = PathTransactionRequest::new(vec![
        claude_path.clone(),
        kimi_path.clone(),
        kimi_target
            .parent()
            .ok_or("Kimi config has no parent")?
            .to_path_buf(),
    ])?;
    with_path_transactions(request, |lease| {
        terminal_hooks_uninstall_in_transaction(work_path, scope, &claude_path, &kimi_path, lease)
    })
}

fn terminal_hooks_uninstall_in_transaction(
    work_path: Option<String>,
    scope: String,
    claude_path: &Path,
    kimi_path: &Path,
    lease: &PathTransactionLease,
) -> Result<TerminalHooksStatus, String> {
    lease.ensure_covered(vec![claude_path.to_path_buf(), kimi_path.to_path_buf()])?;
    lease.before_effect()?;
    let mut claude_root = read_json_object(claude_path)?;
    let kimi_content = read_text_or_empty(kimi_path)?;
    let next_kimi = remove_kimi_hooks(&kimi_content);
    if next_kimi != kimi_content {
        write_kimi_config(kimi_path, &next_kimi)?;
    }
    if remove_claude_hooks(&mut claude_root) {
        write_json_pretty(claude_path, &claude_root)?;
    }
    terminal_hooks_status_in_transaction(work_path, scope, lease)
}

// ---------------------------------------------------------------------------
// Phase E: CLAUDE.md / AGENTS.md context-hint writer (opt-in, reversible)
// ---------------------------------------------------------------------------

const HINT_START: &str = "<!-- maru:context-hint v1 start -->";
const HINT_END: &str = "<!-- maru:context-hint v1 end -->";

fn agent_context_hint_block() -> String {
    format!(
        "{HINT_START}\n\
## Maru active context (auto-managed — edit outside these markers)\n\n\
When a session is launched from Maru, these environment variables expose the \
durable scratchpad contract and describe the user's currently-active window/item:\n\n\
- `MARU_SCRATCHPAD` — durable tracked root for `ideation/` and `memos/`\n\
- `MARU_DRAFTS` — resolved durable implementation-draft collection (use this instead of assuming `scratchpad/drafts/`)\n\
- `MARU_TEMP` — ephemeral AI artifacts under `$MARU_SCRATCHPAD/temp`\n\
- `CLAUDE_CODE_TMPDIR` — Claude runtime scratch under `$MARU_TEMP/runtime/claude`\n\
- `MARU_WORKSPACE` — current workspace root (also granted via `--add-dir`)\n\
- `MARU_WORKSPACE_VISIBILITY` — `private` or `public`\n\
- `MARU_APP_MODE` — active view (`pkm`, `inbox`, `meetings`, …)\n\
- `MARU_ACTIVE_DOC` / `MARU_ACTIVE_DOC_REL` — absolute / workspace-relative path of the open document\n\
- `MARU_ACTIVE_DOC_TITLE` / `MARU_ACTIVE_DOC_TYPE` — its title and frontmatter type\n\n\
Put explicitly-authored temporary artifacts in `$MARU_TEMP/<provider>/<task>/`; \
do not put final deliverables or secrets there. An unset active-item variable means \
there is no active item of that kind. When the user says \"this note\" or \
\"the current document\", prefer `$MARU_ACTIVE_DOC`.\n\
{HINT_END}\n"
    )
}

/// Insert or replace the marked hint block, leaving all other content intact.
fn upsert_marked_block(content: &str, start_marker: &str, end_marker: &str, block: &str) -> String {
    if let Some((start, end)) = marked_block_range(content, start_marker, end_marker) {
        let mut out = String::new();
        out.push_str(&content[..start]);
        out.push_str(block.trim_end());
        out.push_str(&content[end..]);
        out
    } else {
        let mut out = content.to_string();
        if !out.is_empty() {
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out.push('\n');
        }
        out.push_str(block);
        out
    }
}

/// Remove the marked hint block (and the blank lines that bracket it).
fn remove_marked_block(content: &str, start_marker: &str, end_marker: &str) -> String {
    let Some((start, end)) = marked_block_range(content, start_marker, end_marker) else {
        return content.to_string();
    };
    let head = content[..start].trim_end_matches('\n');
    let tail = content[end..].trim_start_matches('\n');
    let mut out = String::from(head);
    if !out.is_empty() && !tail.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(tail);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn hint_target_file(work: &Path, target: &str) -> Option<PathBuf> {
    match target {
        "claude" => Some(work.join("CLAUDE.md")),
        "agents" => Some(work.join("AGENTS.md")),
        _ => None,
    }
}

pub fn write_agent_context_hint(
    work_path: String,
    targets: Vec<String>,
) -> Result<Vec<String>, String> {
    let work = PathBuf::from(&work_path);
    if !work.is_dir() {
        return Err(format!("Workspace path is not a directory: {work_path}"));
    }
    let paths: Vec<_> = targets
        .iter()
        .filter_map(|target| hint_target_file(&work, target))
        .collect();
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let request = PathTransactionRequest::new(paths)?;
    with_path_transactions(request, |lease| {
        write_agent_context_hint_in_transaction(work_path, targets, lease)
    })
}

fn write_agent_context_hint_in_transaction(
    work_path: String,
    targets: Vec<String>,
    lease: &PathTransactionLease,
) -> Result<Vec<String>, String> {
    let work = PathBuf::from(&work_path);
    lease.ensure_covered(
        targets
            .iter()
            .filter_map(|target| hint_target_file(&work, target)),
    )?;
    lease.before_effect()?;
    if !work.is_dir() {
        return Err(format!("Workspace path is not a directory: {work_path}"));
    }
    let block = agent_context_hint_block();
    let mut written = Vec::new();
    for target in &targets {
        let Some(path) = hint_target_file(&work, target) else {
            continue;
        };
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let next = upsert_marked_block(&existing, HINT_START, HINT_END, &block);
        std::fs::write(&path, next)
            .map_err(|err| format!("Cannot write {}: {err}", path.display()))?;
        written.push(path.to_string_lossy().to_string());
    }
    Ok(written)
}

pub fn remove_agent_context_hint(
    work_path: String,
    targets: Vec<String>,
) -> Result<Vec<String>, String> {
    let work = PathBuf::from(&work_path);
    let paths: Vec<_> = targets
        .iter()
        .filter_map(|target| hint_target_file(&work, target))
        .collect();
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let request = PathTransactionRequest::new(paths)?;
    with_path_transactions(request, |lease| {
        remove_agent_context_hint_in_transaction(work_path, targets, lease)
    })
}

fn remove_agent_context_hint_in_transaction(
    work_path: String,
    targets: Vec<String>,
    lease: &PathTransactionLease,
) -> Result<Vec<String>, String> {
    let work = PathBuf::from(&work_path);
    lease.ensure_covered(
        targets
            .iter()
            .filter_map(|target| hint_target_file(&work, target)),
    )?;
    lease.before_effect()?;
    let mut removed = Vec::new();
    for target in &targets {
        let Some(path) = hint_target_file(&work, target) else {
            continue;
        };
        if !path.exists() {
            continue;
        }
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let next = remove_marked_block(&existing, HINT_START, HINT_END);
        if next != existing {
            std::fs::write(&path, next)
                .map_err(|err| format!("Cannot write {}: {err}", path.display()))?;
            removed.push(path.to_string_lossy().to_string());
        }
    }
    Ok(removed)
}

// Owned input command boundary. All filesystem reads, admission waits, and
// writes execute inside the blocking worker; synchronous CLI callers retain
// the same functions and use the same admission entry points.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn terminal_hooks_status(
        work_path: Option<String>,
        scope: String,
    ) -> Result<TerminalHooksStatus, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[work_path.as_ref().map(PathBuf::from).unwrap_or_else(|| {
                    crate::skill_host::fs::install_root_base().expect("fixture home")
                })],
                "worker:terminal_hooks_status",
            );
            super::terminal_hooks_status(work_path, scope)
        })
        .await
        .map_err(|error| format!("terminal_hooks_status_task_failed: {error}"))?
    }
    #[tauri::command]
    pub async fn terminal_hooks_install(
        work_path: Option<String>,
        scope: String,
    ) -> Result<TerminalHooksStatus, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[work_path.as_ref().map(PathBuf::from).unwrap_or_else(|| {
                    crate::skill_host::fs::install_root_base().expect("fixture home")
                })],
                "worker:terminal_hooks_install",
            );
            super::terminal_hooks_install(work_path, scope)
        })
        .await
        .map_err(|error| format!("terminal_hooks_install_task_failed: {error}"))?
    }
    #[tauri::command]
    pub async fn terminal_hooks_uninstall(
        work_path: Option<String>,
        scope: String,
    ) -> Result<TerminalHooksStatus, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[work_path.as_ref().map(PathBuf::from).unwrap_or_else(|| {
                    crate::skill_host::fs::install_root_base().expect("fixture home")
                })],
                "worker:terminal_hooks_uninstall",
            );
            super::terminal_hooks_uninstall(work_path, scope)
        })
        .await
        .map_err(|error| format!("terminal_hooks_uninstall_task_failed: {error}"))?
    }
    #[tauri::command]
    pub async fn write_agent_context_hint(
        work_path: String,
        targets: Vec<String>,
    ) -> Result<Vec<String>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:write_agent_context_hint",
            );
            super::write_agent_context_hint(work_path, targets)
        })
        .await
        .map_err(|error| format!("write_agent_context_hint_task_failed: {error}"))?
    }
    #[tauri::command]
    pub async fn remove_agent_context_hint(
        work_path: String,
        targets: Vec<String>,
    ) -> Result<Vec<String>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:remove_agent_context_hint",
            );
            super::remove_agent_context_hint(work_path, targets)
        })
        .await
        .map_err(|error| format!("remove_agent_context_hint_task_failed: {error}"))?
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn sanitize_rejects_traversal_and_accepts_session_ids() {
        assert_eq!(
            sanitize_session_id("term-abc_123").as_deref(),
            Some("term-abc_123")
        );
        assert!(sanitize_session_id("../etc").is_none());
        assert!(sanitize_session_id("a/b").is_none());
        assert!(sanitize_session_id("").is_none());
    }

    #[test]
    fn append_event_line_writes_jsonl() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("term-1");
        append_event_line(
            &dir,
            "term-1",
            "needs-input",
            Some("claude"),
            Some("sess-9"),
        )
        .unwrap();
        append_event_line(&dir, "term-1", "done", Some("claude"), None).unwrap();
        let content = std::fs::read_to_string(dir.join("events.jsonl")).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first.get("status").unwrap(), "needs-input");
        assert_eq!(first.get("agentSessionId").unwrap(), "sess-9");
    }

    #[test]
    fn parses_kimi_session_id_from_hook_stdin() {
        assert_eq!(
            agent_session_id_from_hook_json(
                r#"{"hook_event_name":"SessionStart","session_id":"kimi-session-42"}"#,
            )
            .as_deref(),
            Some("kimi-session-42")
        );
        assert!(agent_session_id_from_hook_json(r#"{"session_id":""}"#).is_none());
        assert!(agent_session_id_from_hook_json("not json").is_none());
    }

    #[test]
    fn kimi_config_path_honors_kimi_code_home() {
        assert_eq!(
            kimi_config_path_for(Path::new("/home/user"), None),
            PathBuf::from("/home/user/.kimi-code/config.toml")
        );
        assert_eq!(
            kimi_config_path_for(
                Path::new("/home/user"),
                Some(PathBuf::from("/tmp/custom-kimi")),
            ),
            PathBuf::from("/tmp/custom-kimi/config.toml")
        );
    }

    #[test]
    fn hook_watcher_callback_prunes_generated_dir_paths_via_shared_predicate() {
        // The per-path prune lives inside the notify callback closure, which
        // is not unit-testable without a refactor (out of scope); pin the
        // wiring with a source assertion instead. Split needles keep the
        // test's own text from matching the count.
        let source = include_str!("terminal_hooks.rs");
        let needle = concat!("is_under_generated_", "dir");
        assert_eq!(
            source.matches(needle).count(),
            1,
            "callback must reference the SSOT predicate exactly once"
        );
    }

    #[test]
    fn bundled_cli_resolves_from_contents_resources() {
        let tmp = TempDir::new().unwrap();
        let contents = tmp.path().join("Maru.app").join("Contents");
        let main = contents.join("MacOS").join("maru");
        let wrapper = contents.join("Resources").join("maru-cli");
        std::fs::create_dir_all(main.parent().unwrap()).unwrap();
        std::fs::create_dir_all(wrapper.parent().unwrap()).unwrap();
        std::fs::write(&main, b"main").unwrap();
        std::fs::write(&wrapper, b"#!/bin/sh\n").unwrap();

        assert_eq!(bundled_maru_cli_for_exe(&main), Some(wrapper));
    }

    #[cfg(unix)]
    #[test]
    fn kimi_config_write_preserves_symlink() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("managed-config.toml");
        let link = tmp.path().join("config.toml");
        std::fs::write(&target, "theme = \"dark\"\n").unwrap();
        symlink(&target, &link).unwrap();

        write_kimi_config(&link, "theme = \"light\"\n").unwrap();

        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "theme = \"light\"\n"
        );
    }

    #[test]
    fn merge_claude_hooks_is_idempotent() {
        let mut root = json!({});
        assert!(merge_claude_hooks(&mut root, "/bin/maru-cli"));
        assert!(claude_hooks_installed(&root));
        // Second merge changes nothing.
        assert!(!merge_claude_hooks(&mut root, "/bin/maru-cli"));
        let stop = root
            .pointer("/hooks/Stop")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(stop.len(), 1);
        let command = stop[0]
            .pointer("/hooks/0/command")
            .and_then(Value::as_str)
            .unwrap();
        assert!(command.contains("terminal-hook"));
        assert!(command.contains("--event done"));
    }

    #[test]
    fn merge_preserves_existing_user_hooks() {
        let mut root = json!({
            "hooks": {
                "Stop": [ { "hooks": [ { "type": "command", "command": "echo mine" } ] } ]
            }
        });
        merge_claude_hooks(&mut root, "/bin/maru-cli");
        let stop = root
            .pointer("/hooks/Stop")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(stop.len(), 2, "user hook preserved + ours appended");
    }

    #[test]
    fn partial_claude_hooks_are_not_reported_as_installed() {
        let mut root = json!({});
        merge_claude_hooks(&mut root, "/bin/maru-cli");
        root.get_mut("hooks")
            .and_then(Value::as_object_mut)
            .unwrap()
            .remove("Notification");

        assert!(!claude_hooks_installed(&root));
        assert!(merge_claude_hooks(&mut root, "/bin/maru-cli"));
        assert!(claude_hooks_installed(&root));
    }

    #[test]
    fn remove_claude_hooks_only_drops_maru_entries() {
        let mut root = json!({
            "hooks": {
                "Stop": [
                    { "hooks": [ { "type": "command", "command": "echo mine" } ] }
                ]
            }
        });
        merge_claude_hooks(&mut root, "/bin/maru-cli");
        assert!(remove_claude_hooks(&mut root));
        let stop = root
            .pointer("/hooks/Stop")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(stop.len(), 1);
        assert_eq!(
            stop[0].pointer("/hooks/0/command").and_then(Value::as_str),
            Some("echo mine")
        );
        // Idempotent removal.
        assert!(!remove_claude_hooks(&mut root));
    }

    #[test]
    fn kimi_hooks_are_idempotent_and_preserve_user_config() {
        let original = concat!(
            "default_model = \"kimi-for-coding\"\n",
            "# Keep this user comment and provider block byte-identical.\n",
            "[providers.kimi-for-coding]\n",
            "api_key = \"secret-placeholder\"\n\n",
            "[[hooks]]\n",
            "event = \"PostToolUse\"\n",
            "command = \"echo mine\"\n",
        );
        let once = upsert_kimi_hooks(original, "/Applications/Maru App/maru-cli");
        let twice = upsert_kimi_hooks(&once, "/Applications/Maru App/maru-cli");

        assert_eq!(once, twice);
        assert!(once.starts_with(original));
        assert_eq!(once.matches(KIMI_HOOK_START).count(), 1);
        assert!(once.contains("event = \"SessionStart\""));
        assert!(once.contains("event = \"PermissionRequest\""));
        assert!(once.contains("--event running --agent kimi"));
        assert!(once.contains("--event needs-input --agent kimi"));
        assert!(once.contains("--event done --agent kimi"));
        assert!(once.contains("'/Applications/Maru App/maru-cli'"));
        assert!(kimi_hooks_installed(&once));
        assert_eq!(remove_kimi_hooks(&once), original);
    }

    #[test]
    fn partial_kimi_marker_block_is_not_reported_as_installed() {
        let partial = format!(
            "{KIMI_HOOK_START}\n[[hooks]]\nevent = \"Stop\"\ncommand = \"maru-cli terminal-hook --event done --agent kimi\"\n{KIMI_HOOK_END}\n"
        );
        assert!(!kimi_hooks_installed(&partial));
        assert!(kimi_hooks_installed(&upsert_kimi_hooks(
            &partial,
            "/bin/maru-cli"
        )));
    }

    #[test]
    fn kimi_hook_reinstall_updates_only_the_managed_block() {
        let original = "theme = \"dark\"\n";
        let first = upsert_kimi_hooks(original, "/old/maru-cli");
        let updated = upsert_kimi_hooks(&first, "/new/maru-cli");

        assert!(!updated.contains("/old/maru-cli"));
        assert!(updated.contains("/new/maru-cli"));
        assert!(updated.starts_with(original));
        assert_eq!(remove_kimi_hooks(&updated), original);
    }

    #[test]
    fn upsert_hint_is_idempotent_and_preserves_content() {
        let block = agent_context_hint_block();
        let original = "# My Project\n\nSome rules.\n";
        let once = upsert_marked_block(original, HINT_START, HINT_END, &block);
        assert!(once.starts_with("# My Project"));
        assert!(once.contains(HINT_START));
        assert!(once.contains("MARU_ACTIVE_DOC"));
        assert!(once.contains("MARU_SCRATCHPAD"));
        assert!(once.contains("MARU_DRAFTS"));
        assert!(once.contains("$MARU_TEMP/<provider>/<task>/"));
        // Re-applying replaces in place (no duplicate markers).
        let twice = upsert_marked_block(&once, HINT_START, HINT_END, &block);
        assert_eq!(once.matches(HINT_START).count(), 1);
        assert_eq!(twice.matches(HINT_START).count(), 1);
    }

    #[test]
    fn remove_hint_restores_surrounding_content() {
        let block = agent_context_hint_block();
        let original = "# My Project\n\nSome rules.\n";
        let with = upsert_marked_block(original, HINT_START, HINT_END, &block);
        let removed = remove_marked_block(&with, HINT_START, HINT_END);
        assert!(!removed.contains(HINT_START));
        assert_eq!(removed, original);
        // Removing when absent is a no-op.
        assert_eq!(
            remove_marked_block(original, HINT_START, HINT_END),
            original
        );
    }
}

#[cfg(test)]
mod phase08_15 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use std::sync::mpsc;
    use std::time::Duration;

    fn start<F>(future: F) -> mpsc::Receiver<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }
    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(5))
            .expect("hook command completion")
    }
    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
    fn targets() -> Vec<String> {
        vec!["claude".into(), "agents".into()]
    }

    #[test]
    fn phase08_15_hooks_all_wrappers_return_real_fixtures_and_legacy_errors() {
        let home = Home::new();
        let root = home.root.path();
        let work = text(root);
        std::fs::create_dir(root.join(".claude")).unwrap();
        std::fs::write(
            root.join(".claude/settings.json"),
            r#"{"user":"preserved"}"#,
        )
        .unwrap();
        let initial = run(ipc::terminal_hooks_status(
            Some(work.clone()),
            "project".into(),
        ))
        .unwrap();
        assert_eq!(
            initial.claude_path,
            text(&root.join(".claude/settings.json"))
        );
        assert!(!initial.claude_installed);
        let installed = run(ipc::terminal_hooks_install(
            Some(work.clone()),
            "project".into(),
        ))
        .unwrap();
        assert!(installed.claude_installed && installed.kimi_installed);
        assert!(installed.kimi_path.starts_with(&work));
        assert_eq!(
            read_json_object(&root.join(".claude/settings.json")).unwrap()["user"],
            "preserved"
        );
        let written = run(ipc::write_agent_context_hint(work.clone(), targets())).unwrap();
        assert_eq!(written.len(), 2);
        assert!(std::fs::read_to_string(root.join("AGENTS.md"))
            .unwrap()
            .contains(HINT_START));
        assert_eq!(
            run(ipc::remove_agent_context_hint(work.clone(), targets()))
                .unwrap()
                .len(),
            2
        );
        let removed = run(ipc::terminal_hooks_uninstall(
            Some(work.clone()),
            "project".into(),
        ))
        .unwrap();
        assert!(!removed.claude_installed && !removed.kimi_installed);
        assert_eq!(
            run(ipc::terminal_hooks_status(None, "project".into()))
                .err()
                .unwrap(),
            terminal_hooks_status(None, "project".into()).err().unwrap()
        );
        for install in [true, false] {
            let error = if install {
                run(ipc::terminal_hooks_install(None, "project".into()))
            } else {
                run(ipc::terminal_hooks_uninstall(None, "project".into()))
            };
            assert_eq!(
                error.err().unwrap(),
                "workspace path required for project scope"
            );
        }
        let missing = text(&root.join("missing"));
        assert_eq!(
            run(ipc::write_agent_context_hint(missing.clone(), targets())).unwrap_err(),
            write_agent_context_hint(missing.clone(), targets()).unwrap_err()
        );
        assert!(run(ipc::remove_agent_context_hint(missing, targets()))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn phase08_15_hooks_every_wrapper_yields_and_reports_join_failure() {
        let home = Home::new();
        let path = home.root.path().to_path_buf();
        let work = text(&path);
        boundary(
            path.clone(),
            "terminal_hooks_status",
            ipc::terminal_hooks_status(Some(work.clone()), "project".into()),
        );
        boundary(
            path.clone(),
            "terminal_hooks_install",
            ipc::terminal_hooks_install(Some(work.clone()), "project".into()),
        );
        boundary(
            path.clone(),
            "terminal_hooks_uninstall",
            ipc::terminal_hooks_uninstall(Some(work.clone()), "project".into()),
        );
        boundary(
            path.clone(),
            "write_agent_context_hint",
            ipc::write_agent_context_hint(work.clone(), targets()),
        );
        boundary(
            path,
            "remove_agent_context_hint",
            ipc::remove_agent_context_hint(work, targets()),
        );
    }

    #[test]
    fn phase08_15_hooks_install_uninstall_same_target_both_orders() {
        let home = Home::new();
        for install_first in [true, false] {
            let work = text(home.root.path());
            let path = home.root.path().join(".claude/settings.json");
            let held = Held::new(path.clone(), "admitted");
            let first = if install_first {
                start(ipc::terminal_hooks_install(
                    Some(work.clone()),
                    "project".into(),
                ))
            } else {
                start(ipc::terminal_hooks_uninstall(
                    Some(work.clone()),
                    "project".into(),
                ))
            };
            held.wait();
            let wait = Held::new(path, "before-admission");
            let second = if install_first {
                start(ipc::terminal_hooks_uninstall(Some(work), "project".into()))
            } else {
                start(ipc::terminal_hooks_install(Some(work), "project".into()))
            };
            wait.wait();
            wait.release();
            assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
            held.release();
            done(first).unwrap();
            let final_status = done(second).unwrap();
            assert_eq!(final_status.claude_installed, !install_first);
            assert_eq!(final_status.kimi_installed, !install_first);
        }
    }

    #[test]
    fn phase08_15_hooks_hints_and_document_same_target_both_orders() {
        let home = Home::new();
        let root = home.root.path().to_path_buf();
        for hint_first in [true, false] {
            std::fs::write(root.join("CLAUDE.md"), "# original\n").unwrap();
            let held = Held::new(root.join("CLAUDE.md"), "admitted");
            let work = text(&root);
            if hint_first {
                let first = start(ipc::write_agent_context_hint(
                    work.clone(),
                    vec!["claude".into()],
                ));
                held.wait();
                let wait = Held::new(root.join("CLAUDE.md"), "before-admission");
                let second = start(crate::document::ipc::save_document(
                    work,
                    "CLAUDE.md".into(),
                    "# saved\n".into(),
                    None,
                ));
                wait.wait();
                wait.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                done(second).unwrap();
                assert_eq!(
                    std::fs::read_to_string(root.join("CLAUDE.md")).unwrap(),
                    "# saved\n"
                );
            } else {
                let first = start(crate::document::ipc::save_document(
                    work.clone(),
                    "CLAUDE.md".into(),
                    "# saved\n".into(),
                    None,
                ));
                held.wait();
                let wait = Held::new(root.join("CLAUDE.md"), "before-admission");
                let second = start(ipc::write_agent_context_hint(work, vec!["claude".into()]));
                wait.wait();
                wait.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                done(second).unwrap();
                let bytes = std::fs::read_to_string(root.join("CLAUDE.md")).unwrap();
                assert!(bytes.starts_with("# saved\n") && bytes.contains(HINT_START));
            }
        }
    }

    #[test]
    fn phase08_15_hooks_files_parent_rename_both_orders_no_recreation() {
        let home = Home::new();
        for hook_first in [true, false] {
            let vault = home
                .root
                .path()
                .join(if hook_first { "first" } else { "second" });
            let root = vault.join("old");
            std::fs::create_dir_all(&root).unwrap();
            let held = Held::new(
                if hook_first {
                    root.join("CLAUDE.md")
                } else {
                    root.clone()
                },
                "admitted",
            );
            if hook_first {
                let first = start(ipc::write_agent_context_hint(text(&root), targets()));
                held.wait();
                let wait = Held::new(root.clone(), "before-admission");
                let second = start(crate::workspace_files::ipc::rename_workspace_entry(
                    text(&vault),
                    "old".into(),
                    "new".into(),
                ));
                wait.wait();
                wait.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                done(second).unwrap();
                assert!(vault.join("new/CLAUDE.md").is_file());
            } else {
                let first = start(crate::workspace_files::ipc::rename_workspace_entry(
                    text(&vault),
                    "old".into(),
                    "new".into(),
                ));
                held.wait();
                let wait = Held::new(root.join("CLAUDE.md"), "before-admission");
                let second = start(ipc::write_agent_context_hint(text(&root), targets()));
                wait.wait();
                wait.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                assert!(done(second).unwrap_err().contains("parent"));
                assert!(!vault.join("new/CLAUDE.md").exists());
            }
            assert!(!root.exists());
        }
    }

    #[test]
    fn phase08_15_hooks_config_files_parent_rename_both_orders() {
        let home = Home::new();
        for install in [true, false] {
            for hook_first in [true, false] {
                let vault = home
                    .root
                    .path()
                    .join(format!("config-{install}-{hook_first}"));
                let root = vault.join("old");
                std::fs::create_dir_all(&root).unwrap();
                terminal_hooks_install(Some(text(&root)), "project".into()).unwrap();
                let config = root.join(".claude/settings.json");
                let held = Held::new(
                    if hook_first {
                        config.clone()
                    } else {
                        root.clone()
                    },
                    "admitted",
                );
                let hook = {
                    let work = text(&root);
                    async move {
                        if install {
                            ipc::terminal_hooks_install(Some(work), "project".into()).await
                        } else {
                            ipc::terminal_hooks_uninstall(Some(work), "project".into()).await
                        }
                    }
                };
                let rename = crate::workspace_files::ipc::rename_workspace_entry(
                    text(&vault),
                    "old".into(),
                    "new".into(),
                );
                if hook_first {
                    let first = start(hook);
                    held.wait();
                    let wait = Held::new(root.clone(), "before-admission");
                    let second = start(rename);
                    wait.wait();
                    wait.release();
                    assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                    held.release();
                    done(first).unwrap();
                    done(second).unwrap();
                    assert_eq!(
                        claude_hooks_installed(
                            &read_json_object(&vault.join("new/.claude/settings.json")).unwrap()
                        ),
                        install
                    );
                } else {
                    let first = start(rename);
                    held.wait();
                    let wait = Held::new(config, "before-admission");
                    let second = start(hook);
                    wait.wait();
                    wait.release();
                    assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                    held.release();
                    done(first).unwrap();
                    assert!(done(second).err().unwrap().contains("parent"));
                }
                assert!(!root.exists());
            }
        }
    }

    #[test]
    fn phase08_15_hooks_settings_error_and_unwind_release_admission() {
        let home = Home::new();
        let root = home.root.path();
        let work = text(root);
        let config = root.join(".claude/settings.json");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(&config, "invalid JSON").unwrap();
        assert!(run(ipc::terminal_hooks_install(
            Some(work.clone()),
            "project".into()
        ))
        .err()
        .unwrap()
        .contains("Cannot parse"));
        assert!(!root.join(".kimi-code").exists());
        std::fs::write(&config, "{}").unwrap();
        let panic =
            PathTransactionTestHook::new(config.clone(), "pre-effect", || panic!("fixture unwind"));
        assert!(run(ipc::terminal_hooks_install(
            Some(work.clone()),
            "project".into()
        ))
        .err()
        .unwrap()
        .starts_with("terminal_hooks_install_task_failed:"));
        drop(panic);
        assert!(
            run(ipc::terminal_hooks_install(Some(work), "project".into()))
                .unwrap()
                .claude_installed
        );
        let entries: Vec<_> = std::fs::read_dir(root.join(".kimi-code"))
            .unwrap()
            .collect();
        assert_eq!(entries.len(), 1, "atomic temporary siblings cleaned up");
    }

    #[cfg(unix)]
    #[test]
    fn phase08_15_hooks_symlink_aliases_preserve_targets_and_serialize() {
        use std::os::unix::fs::symlink;
        let home = Home::new();
        let root = home.root.path().join("real");
        let alias = home.root.path().join("alias");
        std::fs::create_dir(&root).unwrap();
        symlink(&root, &alias).unwrap();
        let held = Held::new(root.join("CLAUDE.md"), "admitted");
        let first = start(ipc::write_agent_context_hint(text(&root), targets()));
        held.wait();
        let wait = Held::new(alias.join("CLAUDE.md"), "before-admission");
        let second = start(ipc::remove_agent_context_hint(text(&alias), targets()));
        wait.wait();
        wait.release();
        assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
        held.release();
        done(first).unwrap();
        assert_eq!(done(second).unwrap().len(), 2);
        assert!(!std::fs::read_to_string(root.join("CLAUDE.md"))
            .unwrap()
            .contains(HINT_START));
        let config = home.root.path().join(".kimi-code/config.toml");
        std::fs::create_dir(config.parent().unwrap()).unwrap();
        let physical = root.join("config.toml");
        std::fs::write(&physical, "# user config\n").unwrap();
        symlink(&physical, &config).unwrap();
        run(ipc::terminal_hooks_install(
            Some(text(&root)),
            "project".into(),
        ))
        .unwrap();
        assert!(config.is_symlink());
        assert!(std::fs::read_to_string(&physical)
            .unwrap()
            .starts_with("# user config\n"));
    }
}
