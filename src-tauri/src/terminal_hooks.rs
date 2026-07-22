// Agent status hooks (Phase D): a file-based event channel that lets external
// CLI agents (Claude Code, Codex) report lifecycle transitions back to Maru
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

/// Canonical claude hook events → status token. The installer translates each
/// agent's native lifecycle event into one of our tokens, so the frontend
/// mapping stays version-robust.
const CLAUDE_HOOK_EVENTS: &[(&str, &str)] = &[
    ("UserPromptSubmit", "running"),
    ("Notification", "needs-input"),
    ("Stop", "done"),
];

/// Substring marking an Maru-managed hook command (for idempotency + removal).
const HOOK_MARKER: &str = "terminal-hook";

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
    let value: Value = serde_json::from_str(&buf).ok()?;
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
// Installer: Claude Code settings.json hooks (project or global scope)
// ---------------------------------------------------------------------------

/// Resolve an absolute path to the bundled `maru-cli`, falling back to the
/// bare name (relying on PATH) when the sibling binary cannot be located.
fn resolve_maru_cli() -> String {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("maru-cli");
            if candidate.exists() {
                return candidate.to_string_lossy().to_string();
            }
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

fn read_json_object(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHooksStatus {
    pub scope: String,
    pub claude_path: String,
    pub claude_installed: bool,
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
    let path = claude_settings_path(work_path.as_deref(), &scope)?;
    let root = read_json_object(&path);
    let installed = root
        .get("hooks")
        .and_then(Value::as_object)
        .map(|hooks| {
            hooks
                .values()
                .filter_map(Value::as_array)
                .any(|array| array.iter().any(group_has_maru_command))
        })
        .unwrap_or(false);
    Ok(TerminalHooksStatus {
        scope,
        claude_path: path.to_string_lossy().to_string(),
        claude_installed: installed,
        codex_hint: codex_hint(),
    })
}

#[tauri::command]
pub fn terminal_hooks_install(
    work_path: Option<String>,
    scope: String,
) -> Result<TerminalHooksStatus, String> {
    let path = claude_settings_path(work_path.as_deref(), &scope)?;
    let mut root = read_json_object(&path);
    let cli = resolve_maru_cli();
    if merge_claude_hooks(&mut root, &cli) {
        write_json_pretty(&path, &root)?;
    }
    terminal_hooks_status(work_path, scope)
}

#[tauri::command]
pub fn terminal_hooks_uninstall(
    work_path: Option<String>,
    scope: String,
) -> Result<TerminalHooksStatus, String> {
    let path = claude_settings_path(work_path.as_deref(), &scope)?;
    if path.exists() {
        let mut root = read_json_object(&path);
        if remove_claude_hooks(&mut root) {
            write_json_pretty(&path, &root)?;
        }
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
fn upsert_marked_block(content: &str, block: &str) -> String {
    if let (Some(start), Some(end)) = (content.find(HINT_START), content.find(HINT_END)) {
        let end = end + HINT_END.len();
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
fn remove_marked_block(content: &str) -> String {
    let (Some(start), Some(end)) = (content.find(HINT_START), content.find(HINT_END)) else {
        return content.to_string();
    };
    let end = end + HINT_END.len();
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
        let next = upsert_marked_block(&existing, &block);
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
        let next = remove_marked_block(&existing);
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
    fn merge_claude_hooks_is_idempotent() {
        let mut root = json!({});
        assert!(merge_claude_hooks(&mut root, "/bin/maru-cli"));
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
    fn upsert_hint_is_idempotent_and_preserves_content() {
        let block = agent_context_hint_block();
        let original = "# My Project\n\nSome rules.\n";
        let once = upsert_marked_block(original, &block);
        assert!(once.starts_with("# My Project"));
        assert!(once.contains(HINT_START));
        assert!(once.contains("MARU_ACTIVE_DOC"));
        assert!(once.contains("MARU_SCRATCHPAD"));
        assert!(once.contains("$MARU_TEMP/<provider>/<task>/"));
        // Re-applying replaces in place (no duplicate markers).
        let twice = upsert_marked_block(&once, &block);
        assert_eq!(once.matches(HINT_START).count(), 1);
        assert_eq!(twice.matches(HINT_START).count(), 1);
    }

    #[test]
    fn remove_hint_restores_surrounding_content() {
        let block = agent_context_hint_block();
        let original = "# My Project\n\nSome rules.\n";
        let with = upsert_marked_block(original, &block);
        let removed = remove_marked_block(&with);
        assert!(!removed.contains(HINT_START));
        assert_eq!(removed, original);
        // Removing when absent is a no-op.
        assert_eq!(remove_marked_block(original), original);
    }
}
