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

use crate::atomic_file::write_atomic_private;

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
    dirs::home_dir()
        .map(|home| home.join(".maru"))
        .ok_or_else(|| "Could not determine home directory".to_string())
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

    let mut watcher = recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else {
            return;
        };
        if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
            return;
        }
        for path in event.paths {
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
        let already = array.iter().any(|group| group_has_maru_command(group));
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
        Ok(dirs::home_dir()
            .ok_or_else(|| "Could not determine home directory".to_string())?
            .join(".claude")
            .join("settings.json"))
    }
}

fn kimi_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
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

#[tauri::command]
pub fn terminal_hooks_status(
    work_path: Option<String>,
    scope: String,
) -> Result<TerminalHooksStatus, String> {
    let claude_path = claude_settings_path(work_path.as_deref(), &scope)?;
    let claude_root = read_json_object(&claude_path)?;
    let claude_installed = claude_hooks_installed(&claude_root);
    let kimi_path = kimi_config_path()?;
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

#[tauri::command]
pub fn terminal_hooks_install(
    work_path: Option<String>,
    scope: String,
) -> Result<TerminalHooksStatus, String> {
    let claude_path = claude_settings_path(work_path.as_deref(), &scope)?;
    let kimi_path = kimi_config_path()?;
    let mut claude_root = read_json_object(&claude_path)?;
    let kimi_content = read_text_or_empty(&kimi_path)?;
    let cli = resolve_maru_cli();
    let claude_changed = merge_claude_hooks(&mut claude_root, &cli);
    let next_kimi = upsert_kimi_hooks(&kimi_content, &cli);
    if next_kimi != kimi_content {
        write_kimi_config(&kimi_path, &next_kimi)?;
    }
    if claude_changed {
        write_json_pretty(&claude_path, &claude_root)?;
    }
    terminal_hooks_status(work_path, scope)
}

#[tauri::command]
pub fn terminal_hooks_uninstall(
    work_path: Option<String>,
    scope: String,
) -> Result<TerminalHooksStatus, String> {
    let claude_path = claude_settings_path(work_path.as_deref(), &scope)?;
    let kimi_path = kimi_config_path()?;
    let mut claude_root = read_json_object(&claude_path)?;
    let kimi_content = read_text_or_empty(&kimi_path)?;
    let next_kimi = remove_kimi_hooks(&kimi_content);
    if next_kimi != kimi_content {
        write_kimi_config(&kimi_path, &next_kimi)?;
    }
    if remove_claude_hooks(&mut claude_root) {
        write_json_pretty(&claude_path, &claude_root)?;
    }
    terminal_hooks_status(work_path, scope)
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

#[tauri::command]
pub fn write_agent_context_hint(
    work_path: String,
    targets: Vec<String>,
) -> Result<Vec<String>, String> {
    let work = PathBuf::from(&work_path);
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

#[tauri::command]
pub fn remove_agent_context_hint(
    work_path: String,
    targets: Vec<String>,
) -> Result<Vec<String>, String> {
    let work = PathBuf::from(&work_path);
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
