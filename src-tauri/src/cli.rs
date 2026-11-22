use std::env;

use crate::cli_output::{
    self as out, fail, fail_with_next, usage_error, ColorChoice, Marker, OutputFlags,
};

use crate::secrets::{secrets_doctor, secrets_migrate, secrets_scan};
// The CLI shares synchronous transactions; async scheduling belongs to desktop IPC.
use crate::skill_host::{
    skills_apply_bundle_update_headless, skills_check_bundle_update, skills_doctor,
    skills_env_repair_headless, skills_import_external, skills_import_unmanage, skills_list_dirty,
    skills_reconcile_skill, skills_sync_tools,
};

pub fn run_cli(args: Vec<String>) -> i32 {
    // The standalone CLI receives argv verbatim; plists invoke both binaries
    // with a leading `--maru-cli`, which the desktop binary consumes before
    // dispatch and the CLI must skip here.
    let args = if args.first().map(String::as_str) == Some("--maru-cli") {
        args[1..].to_vec()
    } else {
        args
    };
    let (flags, args) = match take_output_flags(args) {
        Ok(parsed) => parsed,
        Err(code) => return code,
    };
    out::set_flags(flags);
    let Some(command) = args.first().map(String::as_str) else {
        return usage_error("no command given", USAGE, "");
    };
    match command {
        "--help" | "-h" | "help" => run_help(&args[1..]),
        "--version" | "-V" | "version" => {
            println!("maru {}", env!("CARGO_PKG_VERSION"));
            0
        }
        "doctor" => run_doctor(&args[1..]),
        "secrets" => run_secrets(&args[1..]),
        "skills" => run_skills(&args[1..]),
        "jobs" => run_jobs(&args[1..]),
        "calendar-sync" => crate::calendar_sync::run_calendar_sync(&args[1..]),
        "terminal-hook" => crate::terminal_hooks::run_terminal_hook(&args[1..]),
        other => usage_error(&format!("unknown command: {other}"), USAGE, ""),
    }
}

/// Options that take the next argument as their value. Their value is never
/// read as an output flag, so `--message --ascii` keeps `--ascii` as the
/// message, as before the output flags existed.
const VALUE_OPTIONS: &[&str] = &[
    "--select",
    "--tools",
    "--skills",
    "--message",
    "--name",
    "--work",
    "--destination",
    "--gws",
    "--event",
    "--agent",
    "--session-id",
];

/// Strip the global output flags (`--color=<when>`, `--color <when>`,
/// `--ascii`) wherever they appear as options; every command accepts them.
fn take_output_flags(args: Vec<String>) -> Result<(OutputFlags, Vec<String>), i32> {
    let mut flags = OutputFlags::default();
    let mut rest = Vec::with_capacity(args.len());
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if VALUE_OPTIONS.contains(&arg.as_str()) {
            rest.push(arg);
            if let Some(value) = iter.next() {
                rest.push(value);
            }
            continue;
        }
        let value = if arg == "--color" {
            Some(iter.next().unwrap_or_default())
        } else {
            arg.strip_prefix("--color=").map(str::to_string)
        };
        if let Some(value) = value {
            let Some(choice) = ColorChoice::parse(&value) else {
                return Err(usage_error(
                    &format!("invalid --color value: {value:?}: use auto, always or never"),
                    USAGE,
                    "",
                ));
            };
            flags.color = choice;
        } else if arg == "--ascii" {
            flags.ascii = true;
        } else {
            rest.push(arg);
        }
    }
    Ok((flags, rest))
}

/// The command overview: name, one-line summary, and the usage forms that
/// `maru help <command>` prints.
const COMMANDS: &[(&str, &str, &str)] = &[
    (
        "doctor",
        "Check the skills store and installs",
        DOCTOR_USAGE,
    ),
    (
        "secrets",
        "Scan, check and migrate workspace secrets",
        SECRETS_USAGE,
    ),
    (
        "skills",
        "List, sync, update and repair skills",
        SKILLS_USAGE,
    ),
    ("jobs", "Manage the workspace's launchd jobs", JOBS_USAGE),
    (
        "calendar-sync",
        "Sync tasks to calendars (the daily job)",
        crate::calendar_sync::CALENDAR_SYNC_USAGE,
    ),
    (
        "terminal-hook",
        "Agent terminal hook entry point (internal)",
        "maru terminal-hook --event <name> [--agent <name>] [--session-id <id>]",
    ),
    ("help", "Show help for a command", "maru help [<command>]"),
    ("version", "Print the version", "maru version"),
];

/// One line per flag of each command, as `maru help <command>` shows it:
/// (command, the flag with its value shape, what it is for).
const FLAG_DESCRIPTIONS: &[(&str, &str, &str)] = &[
    (
        "doctor",
        "--json",
        "Print the report as JSON (stable schema)",
    ),
    ("doctor", "--quiet", "Print nothing when every check passes"),
    (
        "secrets",
        "--json",
        "Print the report as JSON (stable schema)",
    ),
    (
        "secrets",
        "--quiet",
        "doctor: print nothing when every check passes",
    ),
    (
        "secrets",
        "--dry-run",
        "migrate: plan the moves without writing",
    ),
    ("secrets", "--apply", "migrate: perform the planned moves"),
    (
        "secrets",
        "--select <relpath>",
        "migrate: limit to one workspace path",
    ),
    (
        "skills",
        "--json",
        "Print the result as JSON (stable schema)",
    ),
    ("skills", "--check", "sync/update: report what would change"),
    ("skills", "--apply", "sync/update: make the change"),
    (
        "skills",
        "--tools <csv>",
        "sync: agent targets to install into",
    ),
    (
        "skills",
        "--skills <names-or-ids>",
        "sync: limit to these skills",
    ),
    (
        "skills",
        "--retarget",
        "sync --apply: move installs to new targets",
    ),
    (
        "skills",
        "--repair-env",
        "update: also repair the skills env",
    ),
    ("skills", "--force", "env repair: rebuild even when healthy"),
    ("skills", "--accept", "reconcile: keep the local edits"),
    (
        "skills",
        "--discard",
        "reconcile: restore the bundled version",
    ),
    (
        "skills",
        "--message <m>",
        "reconcile --accept: note for the change",
    ),
    (
        "skills",
        "--dry-run",
        "reconcile: show the outcome, change nothing",
    ),
    (
        "skills",
        "--name <name>",
        "import: name for the imported skill",
    ),
    ("skills", "--copy", "import: copy the source into the store"),
    ("skills", "--link", "import: link to the source in place"),
    (
        "skills",
        "--delete-files",
        "import-unmanage: also delete its files",
    ),
    ("jobs", "--json", "Print job status as JSON (stable schema)"),
    (
        "jobs",
        "--if-missed",
        "exec: run only if the last fire was missed",
    ),
    (
        "calendar-sync",
        "--work <path>",
        "Workspace to sync (default: cwd)",
    ),
    (
        "calendar-sync",
        "--destination <key-or-id>",
        "Calendar to write to",
    ),
    ("calendar-sync", "--gws <path>", "Path to the gws binary"),
    (
        "calendar-sync",
        "--dry-run",
        "Plan the changes without writing",
    ),
    (
        "calendar-sync",
        "--json",
        "Print the outcome as JSON (stable schema)",
    ),
    (
        "terminal-hook",
        "--event <name>",
        "The agent hook event to record",
    ),
    (
        "terminal-hook",
        "--agent <name>",
        "The agent that fired the hook",
    ),
    (
        "terminal-hook",
        "--session-id <id>",
        "The agent's own session id",
    ),
];

/// One or two complete examples per command that takes arguments.
const EXAMPLES: &[(&str, &str)] = &[
    ("doctor", "maru doctor --quiet"),
    ("secrets", "maru secrets migrate --dry-run"),
    ("skills", "maru skills update --check"),
    ("skills", "maru skills sync --check --tools claude,codex"),
    ("jobs", "maru jobs status"),
    ("calendar-sync", "maru calendar-sync --dry-run"),
    ("help", "maru help skills"),
];

fn help_overview(style: &out::Style) -> String {
    let width = COMMANDS
        .iter()
        .map(|(name, _, _)| name.len())
        .max()
        .unwrap_or(0);
    let mut text = format!(
        "{} {}\n\n{}\n  maru [--color=auto|always|never] [--ascii] <command> [args]\n\n{}",
        style.paint(out::Role::Header, "maru"),
        style.paint(out::Role::Hint, env!("CARGO_PKG_VERSION")),
        style.section("Usage", None),
        style.section("Commands", None),
    );
    for (name, summary, _) in COMMANDS {
        text.push_str(&format!(
            "\n  {}  {summary}",
            style.paint(out::Role::Accent, &format!("{name:width$}"))
        ));
    }
    text.push_str("\n\nRun 'maru help <command>' for a command's forms and flags.");
    text
}

fn help_command(style: &out::Style, name: &str) -> Option<String> {
    let (_, summary, usage) = COMMANDS.iter().find(|(command, _, _)| *command == name)?;
    let details: Vec<&str> = usage
        .lines()
        .skip_while(|line| !line.is_empty())
        .skip(1)
        .collect();
    let mut text = style.section("Usage", None);
    for line in usage.lines() {
        if line.is_empty() {
            break;
        }
        text.push_str(&help_lines(line.trim_start(), 6));
    }
    text.push_str(&format!(
        "\n\n{}\n  {summary}",
        style.section("Description", None)
    ));
    let flags: Vec<&(&str, &str, &str)> = FLAG_DESCRIPTIONS
        .iter()
        .filter(|(command, _, _)| *command == name)
        .collect();
    if !flags.is_empty() {
        let count = flags.len().to_string();
        text.push_str(&format!("\n\n{}", style.section("Flags", Some(&count))));
        let width = flags
            .iter()
            .map(|(_, flag, _)| flag.len())
            .max()
            .unwrap_or(0);
        for (_, flag, description) in flags {
            text.push_str(&format!(
                "\n  {}  {description}",
                style.paint(out::Role::Accent, &format!("{flag:width$}"))
            ));
        }
    }
    let examples: Vec<&str> = EXAMPLES
        .iter()
        .filter(|(command, _)| *command == name)
        .map(|(_, example)| *example)
        .collect();
    if !examples.is_empty() {
        text.push_str(&format!("\n\n{}", style.section("Examples", None)));
        for example in examples {
            text.push_str(&format!("\n  {}", style.paint(out::Role::Accent, example)));
        }
    }
    if !details.is_empty() {
        text.push_str(&format!("\n\n{}", style.section("Details", None)));
        for line in details {
            text.push_str(&help_lines(line, 2));
        }
    }
    Some(text)
}

/// One help line at a two-space indent, wrapped within 80 columns (help
/// always fits 80, on a TTY or a pipe); continuations hang at `hang`.
fn help_lines(line: &str, hang: usize) -> String {
    let lines = out::wrap(line, Some(80 - hang));
    let mut text = format!("\n  {}", lines[0]);
    for rest in &lines[1..] {
        text.push_str(&format!("\n{}{rest}", " ".repeat(hang)));
    }
    text
}

/// `maru help [<command>]`, `-h`, `--help`: stdout, exit 0.
fn run_help(args: &[String]) -> i32 {
    match args.first() {
        None => {
            println!("{}", help_overview(&out::stdout_style()));
            0
        }
        Some(name) => match help_command(&out::stdout_style(), name) {
            Some(text) => {
                println!("{text}");
                0
            }
            None => usage_error(&format!("unknown command: {name}"), USAGE, ""),
        },
    }
}

fn run_secrets(args: &[String]) -> i32 {
    let Some(subcommand) = args.first().map(String::as_str) else {
        return usage_error("secrets: subcommand required", SECRETS_USAGE, "secrets");
    };
    match subcommand {
        "scan" => run_secrets_scan(&args[1..]),
        "doctor" => run_secrets_doctor(&args[1..]),
        "migrate" => run_secrets_migrate(&args[1..]),
        other => usage_error(
            &format!("secrets: unknown subcommand: {other}"),
            SECRETS_USAGE,
            "secrets",
        ),
    }
}

fn run_secrets_scan(args: &[String]) -> i32 {
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            other => {
                return usage_error(
                    &format!("unknown option: {other}"),
                    SECRETS_USAGE,
                    "secrets",
                );
            }
        }
    }
    match secrets_scan(current_work_path().unwrap_or_else(|| ".".to_string())) {
        Ok(report) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).unwrap_or_default()
                );
            } else {
                let findings: Vec<Finding> = report
                    .issues
                    .iter()
                    .map(|issue| Finding {
                        severity: issue.severity.clone(),
                        code: issue.code.clone(),
                        message: issue.message.clone(),
                        subject: issue.path.clone(),
                    })
                    .collect();
                let facts = [
                    ("Managed", report.managed.len().to_string()),
                    ("Candidates", report.candidates.len().to_string()),
                    ("Legacy symlinks", report.legacy_symlinks.len().to_string()),
                ];
                println!(
                    "{}",
                    render_check_report(
                        &out::stdout_style(),
                        "Secrets scan",
                        &facts,
                        &findings,
                        (0, "")
                    )
                );
            }
            if report.ok {
                0
            } else {
                1
            }
        }
        Err(err) => fail(&format!("secrets scan: {err}")),
    }
}

fn run_secrets_doctor(args: &[String]) -> i32 {
    let mut json = false;
    let mut quiet = false;
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            "--quiet" => quiet = true,
            other => {
                return usage_error(
                    &format!("unknown option: {other}"),
                    SECRETS_USAGE,
                    "secrets",
                );
            }
        }
    }
    match secrets_doctor(current_work_path().unwrap_or_else(|| ".".to_string())) {
        Ok(report) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).unwrap_or_default()
                );
            } else if !quiet || !report.ok {
                let findings: Vec<Finding> = report
                    .issues
                    .iter()
                    .filter(|issue| issue.severity == "error" || !quiet)
                    .map(|issue| Finding {
                        severity: issue.severity.clone(),
                        code: issue.code.clone(),
                        message: issue.message.clone(),
                        subject: issue.path.clone(),
                    })
                    .collect();
                let facts = [
                    ("Managed", report.managed.len().to_string()),
                    ("Candidates", report.candidates.len().to_string()),
                ];
                println!(
                    "{}",
                    render_check_report(
                        &out::stdout_style(),
                        "Secrets doctor",
                        &facts,
                        &findings,
                        (report.issues.len() - findings.len(), "maru secrets doctor"),
                    )
                );
            }
            if report.ok {
                0
            } else {
                1
            }
        }
        Err(err) => fail(&format!("secrets doctor: {err}")),
    }
}

fn run_secrets_migrate(args: &[String]) -> i32 {
    let mut json = false;
    let mut dry_run: Option<bool> = None;
    let mut selected = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => json = true,
            "--dry-run" => {
                if dry_run == Some(false) {
                    return usage_error(
                        "conflicting options: --dry-run and --apply",
                        SECRETS_USAGE,
                        "secrets",
                    );
                }
                dry_run = Some(true);
            }
            "--apply" => {
                if dry_run == Some(true) {
                    return usage_error(
                        "conflicting options: --dry-run and --apply",
                        SECRETS_USAGE,
                        "secrets",
                    );
                }
                dry_run = Some(false);
            }
            "--select" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    return usage_error(
                        "--select requires a workspace-relative path",
                        SECRETS_USAGE,
                        "secrets",
                    );
                };
                selected.push(value.clone());
            }
            other => {
                return usage_error(
                    &format!("unknown option: {other}"),
                    SECRETS_USAGE,
                    "secrets",
                );
            }
        }
        index += 1;
    }
    let Some(dry_run) = dry_run else {
        return usage_error("--dry-run or --apply required", SECRETS_USAGE, "secrets");
    };
    match secrets_migrate(
        current_work_path().unwrap_or_else(|| ".".to_string()),
        Some(dry_run),
        Some(selected),
    ) {
        Ok(report) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).unwrap_or_default()
                );
            } else {
                let rows: Vec<Vec<String>> = report
                    .actions
                    .iter()
                    .map(|action| {
                        vec![
                            action.action.clone(),
                            action.status.clone(),
                            action.rel_path.clone().unwrap_or_default(),
                        ]
                    })
                    .collect();
                let verb = if report.applied { "applied" } else { "planned" };
                println!(
                    "{}",
                    render_action_report(
                        &out::stdout_style(),
                        &format!("secrets migrate: {} action(s) {verb}", report.actions.len()),
                        &["action", "status", "path"],
                        &rows,
                    )
                );
            }
            if report.ok {
                0
            } else {
                1
            }
        }
        Err(err) => fail(&format!("secrets migrate: {err}")),
    }
}

fn run_doctor(args: &[String]) -> i32 {
    let mut json = false;
    let mut quiet = false;
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            "--quiet" => quiet = true,
            other => {
                return usage_error(&format!("unknown option: {other}"), DOCTOR_USAGE, "doctor");
            }
        }
    }
    match skills_doctor(current_work_path()) {
        Ok(report) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).unwrap_or_default()
                );
            } else if !quiet || !report.ok {
                let findings: Vec<Finding> = report
                    .issues
                    .iter()
                    .filter(|issue| issue.severity == "error" || issue.code == "env_incomplete")
                    .map(|issue| Finding {
                        severity: issue.severity.clone(),
                        code: issue.code.clone(),
                        message: issue.message.clone(),
                        subject: issue.skill_name.clone(),
                    })
                    .collect();
                let facts = [
                    ("Sources", report.sources.to_string()),
                    ("Skills", report.skills.to_string()),
                    ("Installs", report.installs.to_string()),
                ];
                println!(
                    "{}",
                    render_check_report(
                        &out::stdout_style(),
                        "Skills doctor",
                        &facts,
                        &findings,
                        (report.issues.len() - findings.len(), "maru doctor --json"),
                    )
                );
            }
            if report.ok {
                0
            } else {
                1
            }
        }
        Err(err) => fail(&format!("doctor: {err}")),
    }
}

/// A mutating command's human report: the summary as a `✓` line, then its
/// actions as a table.
fn render_action_report(
    style: &out::Style,
    summary: &str,
    headings: &[&str],
    rows: &[Vec<String>],
) -> String {
    let mut text = style.done_line(summary);
    if !rows.is_empty() {
        text.push_str("\n\n");
        text.push_str(&style.table(headings, rows));
    }
    text
}

/// One finding of a check report, independent of the report type.
struct Finding {
    severity: String,
    code: String,
    message: String,
    subject: Option<String>,
}

/// A check command's human report: header, problems first under
/// `Attention`, the facts, then the summary line (cli-output v1 layout).
fn render_check_report(
    style: &out::Style,
    title: &str,
    facts: &[(&str, String)],
    findings: &[Finding],
    hidden: (usize, &str),
) -> String {
    let mut text = format!(
        "{} {}",
        style.paint(out::Role::Header, &format!("maru {title}")),
        style.paint(out::Role::Hint, env!("CARGO_PKG_VERSION"))
    );
    let mut ordered: Vec<&Finding> = findings.iter().collect();
    ordered.sort_by_key(|finding| finding.severity != "error");
    if !ordered.is_empty() {
        let count = ordered.len().to_string();
        text.push_str(&format!("\n\n{}", style.section("Attention", Some(&count))));
        for finding in &ordered {
            let marker = if finding.severity == "error" {
                Marker::Fail
            } else {
                Marker::Warn
            };
            let subject = finding
                .subject
                .as_ref()
                .map(|subject| format!(" ({subject})"))
                .unwrap_or_default();
            text.push('\n');
            text.push_str(&style.bullet(
                marker,
                &format!("{}: {}{subject}", finding.code, finding.message),
            ));
        }
    }
    let (hidden_warnings, full_command) = hidden;
    if hidden_warnings > 0 {
        text.push_str(&format!(
            "\n  {}",
            style.paint(
                out::Role::Hint,
                &format!("{hidden_warnings} more warnings not shown; `{full_command}` lists them")
            )
        ));
    }
    text.push_str(&format!("\n\n{}", style.section("Checked", None)));
    let width = facts
        .iter()
        .map(|(key, _)| key.len() + 1)
        .max()
        .unwrap_or(0);
    for (key, value) in facts {
        let label = format!("{key}:");
        text.push_str(&format!(
            "\n  {}  {value}",
            style.paint(out::Role::Key, &format!("{label:width$}"))
        ));
    }
    let failed = findings.iter().filter(|f| f.severity == "error").count();
    let warnings = findings.len() - failed + hidden_warnings;
    text.push_str(&format!("\n\n{}", style.summary(failed, warnings, 0)));
    text
}

fn run_skills(args: &[String]) -> i32 {
    let Some(subcommand) = args.first().map(String::as_str) else {
        return usage_error("skills: subcommand required", SKILLS_USAGE, "skills");
    };
    match subcommand {
        "capabilities" | "list" => {
            if args[1..] != ["--json"] {
                return usage_error("--json required", SKILLS_USAGE, "skills");
            }
            if subcommand == "capabilities" {
                println!("{}", skills_capabilities_json());
                0
            } else {
                match crate::skill_host::store::skills_list_readonly() {
                    Ok(skills) => {
                        println!("{}", serde_json::to_string(&skills).unwrap_or_default());
                        0
                    }
                    Err(error) => fail(&format!("skills: {error}")),
                }
            }
        }
        "sync" => run_skills_sync(&args[1..]),
        "update" => run_skills_update(&args[1..]),
        "env" => run_skills_env(&args[1..]),
        "rollback" => run_skills_rollback(&args[1..]),
        "dirty" => run_skills_dirty(&args[1..]),
        "reconcile" => run_skills_reconcile(&args[1..]),
        "import" => run_skills_import(&args[1..]),
        "import-unmanage" => run_skills_import_unmanage(&args[1..]),
        other => usage_error(
            &format!("skills: unknown subcommand: {other}"),
            SKILLS_USAGE,
            "skills",
        ),
    }
}

fn run_skills_env(args: &[String]) -> i32 {
    if args.first().map(String::as_str) != Some("repair") {
        return usage_error(
            "skills env repair: subcommand required",
            SKILLS_USAGE,
            "skills",
        );
    }
    let mut json = false;
    let mut force = false;
    for arg in &args[1..] {
        match arg.as_str() {
            "--json" => json = true,
            "--force" => force = true,
            other => {
                return usage_error(&format!("unknown option: {other}"), SKILLS_USAGE, "skills");
            }
        }
    }
    // Setup output goes to stderr so `--json` keeps stdout machine-readable.
    let sink: crate::skill_host::EnvOutputSink =
        std::sync::Arc::new(|_stream, line| eprintln!("{line}"));
    match skills_env_repair_headless(current_work_path(), force, sink) {
        Ok(outcome) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&outcome).unwrap_or_default()
                );
            } else if outcome.success {
                out::done(&format!("skills env repaired: {}", outcome.root));
            }
            if outcome.success {
                0
            } else {
                // setup_error is the cause; completion_error says whether the
                // prior env was restored (or where its bytes remain).
                let cause = [
                    outcome.setup_error.as_deref(),
                    outcome.completion_error.as_deref(),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("; ");
                let cause = if cause.is_empty() {
                    "env setup failed".to_string()
                } else {
                    cause
                };
                fail_with_next(
                    &format!(
                        "skills env repair failed at {}: {cause}. Fix the cause shown in the setup output above",
                        outcome.root
                    ),
                    "maru skills env repair",
                )
            }
        }
        Err(err) if err.starts_with(crate::skill_host::ENV_REPAIR_NOT_NEEDED) => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "repaired": false, "reason": err })
                );
            } else {
                out::done(&err);
            }
            0
        }
        Err(err) => fail(&env_repair_preflight_error(&err)),
    }
}

/// Preflight failures (before setup runs) leave the env untouched; name that
/// and the next step, since this line is the only signal of the exit.
fn env_repair_preflight_error(err: &str) -> String {
    if err.contains("maru skills env repair") || err.contains("maru skills update") {
        return format!("skills env repair did not start: {err}");
    }
    format!(
        "skills env repair did not start, so the env is unchanged: {err}. Fix the cause above (for a parse error, repair that file or run from a directory without a broken workspace.config.yaml), then rerun `maru skills env repair`"
    )
}

fn run_skills_rollback(args: &[String]) -> i32 {
    let json = match args {
        [] => false,
        [flag] if flag == "--json" => true,
        _ => {
            return usage_error(
                "skills rollback: missing or invalid arguments",
                SKILLS_USAGE,
                "skills",
            );
        }
    };
    match crate::skill_host::store::skills_rollback_bundle() {
        Ok(outcome) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&outcome).unwrap_or_default()
                );
            } else {
                out::done(&format!(
                    "skills bundle rolled back to {} (r{})",
                    outcome.current.display_version, outcome.current.revision
                ));
            }
            0
        }
        Err(error) => fail(&format!("skills rollback: {error}")),
    }
}

pub(crate) fn skills_update_check_text(
    status: &crate::skill_host::store::SkillBundleStatus,
) -> String {
    if !status.update_available {
        return "up to date".to_string();
    }
    if status.auto_applicable {
        return "update available: run `maru skills update --apply`".to_string();
    }
    let mut blockers = Vec::new();
    if !status.dirty_skills.is_empty() {
        blockers.push(format!("local edits: {}", status.dirty_skills.join(", ")));
    }
    if status.env_update_required {
        blockers.push("env update required (--repair-env)".to_string());
    }
    if !status.unmet_requires.is_empty() {
        blockers.push(format!(
            "tools too old: {}",
            status.unmet_requires.join(", ")
        ));
    }
    if !status.min_app_ok {
        blockers.push(format!(
            "app too old (needs {})",
            status
                .available
                .as_ref()
                .map(|available| available.min_app_version.as_str())
                .unwrap_or("newer app")
        ));
    }
    format!("update available but blocked: {}", blockers.join("; "))
}

fn run_skills_update(args: &[String]) -> i32 {
    let mut check: Option<bool> = None;
    let mut repair_env = false;
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--check" => {
                if check == Some(false) {
                    return usage_error(
                        "conflicting options: --check and --apply",
                        SKILLS_USAGE,
                        "skills",
                    );
                }
                check = Some(true);
            }
            "--apply" => {
                if check == Some(true) {
                    return usage_error(
                        "conflicting options: --check and --apply",
                        SKILLS_USAGE,
                        "skills",
                    );
                }
                check = Some(false);
            }
            "--repair-env" => repair_env = true,
            "--json" => json = true,
            other => {
                return usage_error(&format!("unknown option: {other}"), SKILLS_USAGE, "skills");
            }
        }
    }
    let Some(check) = check else {
        return usage_error("--check or --apply required", SKILLS_USAGE, "skills");
    };
    if check {
        match skills_check_bundle_update(None) {
            Ok(status) => {
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&status).unwrap_or_default()
                    );
                } else {
                    let active = status
                        .active
                        .as_ref()
                        .map(|active| format!("{} (r{})", active.display_version, active.revision))
                        .unwrap_or_else(|| "none".to_string());
                    let channel = status
                        .available
                        .as_ref()
                        .map(|available| {
                            format!("{} (r{})", available.display_version, available.revision)
                        })
                        .unwrap_or_else(|| "none published".to_string());
                    let style = out::stdout_style();
                    let verdict = skills_update_check_text(&status);
                    let marker = if !status.update_available {
                        Marker::Ok
                    } else if status.auto_applicable {
                        Marker::Pending
                    } else {
                        Marker::Warn
                    };
                    let mut text = format!(
                        "{}\n{}\n\n{}",
                        style.header("maru skills update", Some("check")),
                        style.rows(&[("Active", active), ("Channel", channel)]),
                        style.bullet(marker, &verdict),
                    );
                    if let Some(hint) = &status.env_repair_hint {
                        text.push('\n');
                        text.push_str(&style.bullet(Marker::Warn, hint));
                    }
                    println!("{text}");
                }
                0
            }
            Err(err) => fail(&format!("skills update: {err}")),
        }
    } else {
        match skills_apply_bundle_update_headless(None, repair_env) {
            Ok(outcome) => {
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&outcome).unwrap_or_default()
                    );
                } else {
                    out::done(&format!(
                        "skills bundle {} applied: {} added, {} updated, {} removed",
                        outcome.current.display_version,
                        outcome.added_skills.len(),
                        outcome.updated_skills.len(),
                        outcome.removed_skills.len()
                    ));
                    if !outcome.stale_copy_installs.is_empty() {
                        println!(
                            "{}",
                            out::stdout_style().bullet(
                                Marker::Warn,
                                &format!(
                                    "stale copy installs (reinstall to refresh): {}",
                                    outcome.stale_copy_installs.join(", ")
                                ),
                            )
                        );
                    }
                }
                0
            }
            Err(err)
                if err.starts_with("bundle_not_newer") || err == "bundle_update_not_available" =>
            {
                if json {
                    println!("{}", serde_json::json!({ "updated": false, "reason": err }));
                } else {
                    out::done(&format!("up to date ({err})"));
                }
                0
            }
            Err(err) => fail(&format!("skills update: {err}")),
        }
    }
}

fn run_skills_sync(args: &[String]) -> i32 {
    let mut apply: Option<bool> = None;
    let mut tools: Option<Vec<String>> = None;
    let mut skills: Option<Vec<String>> = None;
    let mut retarget = false;
    let mut json = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--check" => {
                if apply == Some(true) {
                    return usage_error(
                        "conflicting options: --check and --apply",
                        SKILLS_USAGE,
                        "skills",
                    );
                }
                apply = Some(false);
            }
            "--apply" => {
                if apply == Some(false) {
                    return usage_error(
                        "conflicting options: --check and --apply",
                        SKILLS_USAGE,
                        "skills",
                    );
                }
                apply = Some(true);
            }
            "--retarget" => retarget = true,
            "--tools" | "--skills" => {
                let option = args[index].clone();
                index += 1;
                let Some(value) = args.get(index) else {
                    return usage_error(
                        &format!("{option} requires a comma-separated value"),
                        SKILLS_USAGE,
                        "skills",
                    );
                };
                let parsed: Vec<String> = value
                    .split(',')
                    .map(str::trim)
                    .map(ToString::to_string)
                    .collect();
                if parsed.is_empty() || parsed.iter().any(String::is_empty) {
                    return usage_error(
                        &format!("{option} requires nonempty comma-separated selectors"),
                        SKILLS_USAGE,
                        "skills",
                    );
                }
                if option == "--skills" {
                    skills = Some(parsed);
                } else {
                    tools = Some(parsed);
                }
            }
            "--json" => json = true,
            other => {
                return usage_error(&format!("unknown option: {other}"), SKILLS_USAGE, "skills");
            }
        }
        index += 1;
    }
    let Some(apply) = apply else {
        return usage_error("--check or --apply required", SKILLS_USAGE, "skills");
    };
    if retarget && !apply {
        return usage_error("--retarget requires --apply", SKILLS_USAGE, "skills");
    }
    let Some(tools) = tools else {
        return usage_error("--tools required", SKILLS_USAGE, "skills");
    };
    let result = match skills {
        Some(selection) => crate::skill_host::store::skills_sync_selected_tools(
            current_work_path(),
            tools,
            Some(selection),
            apply,
            retarget,
        ),
        None => skills_sync_tools(current_work_path(), tools, apply, retarget),
    };
    match result {
        Ok(report) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).unwrap_or_default()
                );
            } else {
                let rows: Vec<Vec<String>> = report
                    .actions
                    .iter()
                    .map(|action| {
                        vec![
                            action.action.clone(),
                            action.target.clone().unwrap_or_else(|| "maru".to_string()),
                            action.skill_name.clone(),
                            action.path.clone(),
                        ]
                    })
                    .collect();
                let verb = if report.applied { "applied" } else { "planned" };
                println!(
                    "{}",
                    render_action_report(
                        &out::stdout_style(),
                        &format!(
                            "skills sync: {} skill(s), {} install(s), {} action(s) {verb}",
                            report.desired_skills,
                            report.desired_installs,
                            report.actions.len()
                        ),
                        &["action", "target", "skill", "path"],
                        &rows,
                    )
                );
            }
            if !apply && !report.actions.is_empty() {
                1
            } else {
                0
            }
        }
        Err(err) => fail(&format!("skills sync: {err}")),
    }
}

fn run_skills_dirty(args: &[String]) -> i32 {
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            other => {
                return usage_error(&format!("unknown option: {other}"), SKILLS_USAGE, "skills");
            }
        }
    }
    match skills_list_dirty(current_work_path()) {
        Ok(records) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&records).unwrap_or_default()
                );
            } else {
                let rows: Vec<Vec<String>> = records
                    .iter()
                    .map(|record| {
                        vec![
                            record.name.clone(),
                            record.source_id.clone(),
                            record.tier.clone(),
                            record.abs_path.clone(),
                        ]
                    })
                    .collect();
                if rows.is_empty() {
                    out::done("no skills with local edits");
                } else {
                    println!(
                        "{}",
                        out::stdout_style().table(&["name", "source", "tier", "path"], &rows)
                    );
                }
            }
            0
        }
        Err(err) => fail(&format!("skills dirty: {err}")),
    }
}

fn run_skills_reconcile(args: &[String]) -> i32 {
    let Some(skill) = args.first() else {
        return usage_error("skill required", SKILLS_USAGE, "skills");
    };
    let mut action: Option<String> = None;
    let mut message: Option<String> = None;
    let mut dry_run = false;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--accept" => {
                if action.as_deref().is_some_and(|value| value != "accept") {
                    return usage_error(
                        "conflicting options: --accept and --discard",
                        SKILLS_USAGE,
                        "skills",
                    );
                }
                action = Some("accept".to_string());
            }
            "--discard" => {
                if action.as_deref().is_some_and(|value| value != "discard") {
                    return usage_error(
                        "conflicting options: --accept and --discard",
                        SKILLS_USAGE,
                        "skills",
                    );
                }
                action = Some("discard".to_string());
            }
            "--message" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    return usage_error("--message requires a value", SKILLS_USAGE, "skills");
                };
                message = Some(value.clone());
            }
            "--dry-run" => dry_run = true,
            other => {
                return usage_error(&format!("unknown option: {other}"), SKILLS_USAGE, "skills");
            }
        }
        index += 1;
    }
    let Some(action) = action else {
        return usage_error("--accept or --discard required", SKILLS_USAGE, "skills");
    };
    match skills_reconcile_skill(
        current_work_path(),
        skill.clone(),
        action,
        message,
        Some(dry_run),
    ) {
        Ok(outcome) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&outcome).unwrap_or_default()
            );
            0
        }
        Err(err) => fail(&format!("skills reconcile: {err}")),
    }
}

fn run_skills_import(args: &[String]) -> i32 {
    let Some(source_path) = args.first() else {
        return usage_error("source path required", SKILLS_USAGE, "skills");
    };
    let mut name: Option<String> = None;
    let mut mode: Option<String> = None;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--name" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    return usage_error("--name requires a value", SKILLS_USAGE, "skills");
                };
                name = Some(value.clone());
            }
            "--copy" => {
                if mode.as_deref().is_some_and(|value| value != "copy") {
                    return usage_error(
                        "conflicting options: --copy and --link",
                        SKILLS_USAGE,
                        "skills",
                    );
                }
                mode = Some("copy".to_string());
            }
            "--link" => {
                if mode.as_deref().is_some_and(|value| value != "link") {
                    return usage_error(
                        "conflicting options: --copy and --link",
                        SKILLS_USAGE,
                        "skills",
                    );
                }
                mode = Some("link".to_string());
            }
            other => {
                return usage_error(&format!("unknown option: {other}"), SKILLS_USAGE, "skills");
            }
        }
        index += 1;
    }
    match skills_import_external(current_work_path(), source_path.clone(), name, mode) {
        Ok(outcome) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&outcome).unwrap_or_default()
            );
            0
        }
        Err(err) => fail(&format!("skills import: {err}")),
    }
}

fn run_skills_import_unmanage(args: &[String]) -> i32 {
    let Some(name) = args.first() else {
        return usage_error("skill name required", SKILLS_USAGE, "skills");
    };
    let delete_files = args.iter().skip(1).any(|arg| arg == "--delete-files");
    if args
        .iter()
        .skip(1)
        .any(|arg| arg.as_str() != "--delete-files")
    {
        return usage_error("unknown option", SKILLS_USAGE, "skills");
    }
    match skills_import_unmanage(current_work_path(), name.clone(), Some(delete_files)) {
        Ok(outcome) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&outcome).unwrap_or_default()
            );
            0
        }
        Err(err) => fail(&format!("skills import-unmanage: {err}")),
    }
}

/// The workspace as the current directory, or the failure to print: the
/// cause from the OS and how to recover.
fn work_dir_or_fail() -> Result<String, i32> {
    env::current_dir()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|err| {
            out::fail_with_next(
                &format!("cannot read the current directory: {err}"),
                "cd <workspace folder> and rerun the command",
            )
        })
}

fn current_work_path() -> Option<String> {
    env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
}

fn run_jobs(args: &[String]) -> i32 {
    let Some(subcommand) = args.first().map(String::as_str) else {
        return usage_error("jobs: subcommand required", JOBS_USAGE, "jobs");
    };
    match subcommand {
        "list" | "status" => run_jobs_list(&args[1..]),
        "install" => run_jobs_action("install", &args[1..]),
        "uninstall" => run_jobs_action("uninstall", &args[1..]),
        "start" => run_jobs_action("start", &args[1..]),
        "stop" => run_jobs_action("stop", &args[1..]),
        "run" => run_jobs_action("run", &args[1..]),
        "exec" => run_jobs_exec(&args[1..]),
        other => usage_error(
            &format!("jobs: unknown subcommand: {other}"),
            JOBS_USAGE,
            "jobs",
        ),
    }
}

/// `maru jobs exec [--if-missed] <id>`: the launchd wrapper entry point for
/// missed-fire jobs. Runs the job program and records the run in
/// `.maru/jobs-state/`; `--if-missed` (the guard agent) skips the run when the
/// recorded success already covers the most recent scheduled fire. The exit
/// code is the job's own.
fn run_jobs_exec(args: &[String]) -> i32 {
    let mut id: Option<String> = None;
    let mut if_missed = false;
    for arg in args {
        match arg.as_str() {
            "--if-missed" => if_missed = true,
            other if other.starts_with('-') => {
                return usage_error(&format!("unknown option: {other}"), JOBS_USAGE, "jobs");
            }
            other => {
                if id.is_some() {
                    return usage_error(
                        &format!("unexpected argument: {other}"),
                        JOBS_USAGE,
                        "jobs",
                    );
                }
                id = Some(other.to_string());
            }
        }
    }
    let Some(id) = id else {
        return usage_error(
            "jobs exec: missing or invalid arguments",
            JOBS_USAGE,
            "jobs",
        );
    };
    let work = match work_dir_or_fail() {
        Ok(work) => work,
        Err(code) => return code,
    };
    match crate::jobs::jobs_exec_result_in(std::path::Path::new(&work), &id, if_missed) {
        Ok(code) => code,
        Err(err) => fail(&format!("jobs exec: jobs_exec_failed: {err}")),
    }
}

/// Parse `[<id>] [--json]` following the run_skills manual-parsing pattern.
fn parse_jobs_args(args: &[String]) -> Result<(Option<String>, bool), i32> {
    let mut id: Option<String> = None;
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            other if other.starts_with('-') => {
                return Err(usage_error(
                    &format!("unknown option: {other}"),
                    JOBS_USAGE,
                    "jobs",
                ));
            }
            other => {
                if id.is_some() {
                    return Err(usage_error(
                        &format!("unexpected argument: {other}"),
                        JOBS_USAGE,
                        "jobs",
                    ));
                }
                id = Some(other.to_string());
            }
        }
    }
    Ok((id, json))
}

fn resolve_jobs_id(work_path: &std::path::Path, id: Option<String>) -> Result<String, i32> {
    if let Some(id) = id {
        return Ok(id);
    }
    let jobs = match crate::jobs::load_jobs(work_path) {
        Ok(jobs) => jobs,
        Err(err) => return Err(fail(&format!("jobs: {err}"))),
    };
    if jobs.jobs.len() == 1 {
        return Ok(jobs.jobs[0].id.clone());
    }
    let message = if jobs.jobs.is_empty() {
        "no jobs declared in <cwd>/.maru/jobs.json"
    } else {
        "multiple jobs declared; pass <id>"
    };
    Err(usage_error(message, JOBS_USAGE, "jobs"))
}

fn run_jobs_list(args: &[String]) -> i32 {
    let (id, json) = match parse_jobs_args(args) {
        Ok(parsed) => parsed,
        Err(code) => return code,
    };
    let work = match work_dir_or_fail() {
        Ok(work) => work,
        Err(code) => return code,
    };
    let work_path = std::path::Path::new(&work);
    match crate::jobs::jobs_list_in(work_path) {
        Ok(mut statuses) => {
            if let Some(id) = id {
                statuses.retain(|status| status.id == id);
                if statuses.is_empty() {
                    return out::fail_with_next(
                        &format!(
                            "jobs status: job_not_found: no job {id:?} in {work}/.maru/jobs.json"
                        ),
                        "maru jobs list",
                    );
                }
            }
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&statuses).unwrap_or_default()
                );
            } else {
                print_jobs_table(&statuses);
            }
            0
        }
        Err(err) => fail(&format!("jobs list: {err}")),
    }
}

fn run_jobs_action(verb: &str, args: &[String]) -> i32 {
    let (id, json) = match parse_jobs_args(args) {
        Ok(parsed) => parsed,
        Err(code) => return code,
    };
    let work = match work_dir_or_fail() {
        Ok(work) => work,
        Err(code) => return code,
    };
    let work_path = std::path::Path::new(&work);
    let id = match resolve_jobs_id(work_path, id) {
        Ok(id) => id,
        Err(code) => return code,
    };
    let action: fn(&std::path::Path, &str) -> Result<crate::jobs::JobStatus, String> = match verb {
        "install" => crate::jobs::jobs_install_in,
        "uninstall" => crate::jobs::jobs_uninstall_in,
        "start" => crate::jobs::jobs_start_in,
        "stop" => crate::jobs::jobs_stop_in,
        "run" => crate::jobs::jobs_run_now_in,
        _ => unreachable!("run_jobs dispatch guards verbs"),
    };
    match action(work_path, &id) {
        Ok(status) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&status).unwrap_or_default()
                );
            } else {
                print_jobs_table(std::slice::from_ref(&status));
            }
            0
        }
        Err(err) => fail(&format!("jobs: {err}")),
    }
}

fn print_jobs_table(statuses: &[crate::jobs::JobStatus]) {
    println!("{}", render_jobs(&out::stdout_style(), statuses));
}

/// Job status as a header-less list: one `▸ <id>` section per job with
/// its state rows.
fn render_jobs(style: &out::Style, statuses: &[crate::jobs::JobStatus]) -> String {
    let mut sections = Vec::new();
    for status in statuses {
        let last_exit = status
            .last_exit_code
            .map(|code| code.to_string())
            .unwrap_or_default();
        let title = if status.title.is_empty() {
            status.id.clone()
        } else {
            format!("{} {}", status.id, status.title)
        };
        let rows = [
            ("Installed", yes_no(status.installed).to_string()),
            ("Loaded", yes_no(status.loaded).to_string()),
            ("Enabled", yes_no(status.enabled).to_string()),
            ("Last exit", last_exit),
            ("Label", status.label.clone()),
            ("Plist", status.plist_path.clone()),
        ];
        sections.push(format!(
            "{}\n{}",
            style.section(&title, None),
            style.rows(&rows)
        ));
    }
    if sections.is_empty() {
        return style.bullet(Marker::Absent, "no jobs declared in .maru/jobs.json");
    }
    sections.join("\n\n")
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

/// The additive federation contract dotfiles discovers first (issue #396).
/// Keys and target order are contractual; extend only additively.
fn skills_capabilities_json() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "targets": crate::skill_host::store::INSTALL_TARGETS,
        "selectedSync": true,
        "list": true,
    })
}

const DOCTOR_USAGE: &str = "maru doctor [--json] [--quiet]";

const SECRETS_USAGE: &str = "maru secrets scan [--json]
maru secrets doctor [--json] [--quiet]
maru secrets migrate --dry-run|--apply [--select <relpath>] [--json]";

const SKILLS_USAGE: &str = "maru skills capabilities|list --json
maru skills sync --check|--apply --tools <csv> [--skills <names-or-ids>] [--retarget] [--json]
maru skills update --check|--apply [--repair-env] [--json]
maru skills env repair [--force] [--json]
maru skills rollback [--json]
maru skills dirty [--json]
maru skills reconcile <name-or-id> (--accept|--discard) [--message <m>] [--dry-run]
maru skills import <source-path> [--name <name>] [--copy|--link]
maru skills import-unmanage <name> [--delete-files]";

const JOBS_USAGE: &str = "maru jobs list|status [<id>] [--json]
maru jobs install|uninstall|start|stop|run [<id>] [--json]
maru jobs exec [--if-missed] <id>

The workspace is the current directory (jobs are read from <cwd>/.maru/jobs.json).
Action verbs require <id> unless exactly one job is declared.
exec is the launchd wrapper entry point for missed-fire recovery jobs.";

const USAGE: &str = "maru [--color=auto|always|never] [--ascii] <command> [args]";

#[cfg(test)]
mod tests {

    #[test]
    fn env_repair_preflight_error_names_the_next_step() {
        let message = env_repair_preflight_error("Cannot parse /w/workspace.config.yaml: bad");
        assert!(message.contains("env is unchanged"), "{message}");
        assert!(message.contains("Cannot parse /w/workspace.config.yaml: bad"));
        assert!(message.contains("workspace.config.yaml"));
        assert!(
            message.ends_with("then rerun `maru skills env repair`"),
            "{message}"
        );
        let hinted = env_repair_preflight_error(
            "skills_env_setup_missing: x; then retry `maru skills env repair`",
        );
        assert!(!hinted.contains("Fix the cause above"), "{hinted}");
    }

    use super::{env_repair_preflight_error, run_cli, skills_capabilities_json};
    use super::{help_command, help_overview, render_check_report, take_output_flags, Finding};
    use super::{COMMANDS, USAGE};
    use crate::cli_output::{ColorChoice, Style};
    use unicode_width::UnicodeWidthStr;

    fn style(color: bool, ascii: bool) -> Style {
        Style {
            color,
            ascii,
            width: Some(80),
            tty: false,
        }
    }

    fn findings() -> Vec<Finding> {
        vec![
            Finding {
                severity: "warn".into(),
                code: "env_incomplete".into(),
                message: "the skills env is missing python".into(),
                subject: None,
            },
            Finding {
                severity: "error".into(),
                code: "install_broken".into(),
                message: "link target is gone".into(),
                subject: Some("vault-lint".into()),
            },
        ]
    }

    fn facts() -> Vec<(&'static str, String)> {
        vec![("Sources", "2".into()), ("Skills", "38".into())]
    }

    // Conformance 1: golden report with color off.
    #[test]
    fn check_report_golden_color_off() {
        let text = render_check_report(
            &style(false, false),
            "Skills doctor",
            &facts(),
            &findings(),
            (0, ""),
        );
        let expected = format!(
            "maru Skills doctor {}\n\n\u{25b8} Attention (2)\n  \u{2717}  install_broken: link target is gone (vault-lint)\n  \u{26a0}  env_incomplete: the skills env is missing python\n\n\u{25b8} Checked\n  Sources:  2\n  Skills:   38\n\n\u{2717} 1 failed  \u{26a0} 1 warning",
            env!("CARGO_PKG_VERSION")
        );
        assert_eq!(text, expected);
    }

    // Conformance 1: --color=always maps roles to the normative ANSI codes.
    #[test]
    fn check_report_golden_color_on_uses_role_codes() {
        let text = render_check_report(
            &style(true, false),
            "Skills doctor",
            &facts(),
            &findings(),
            (0, ""),
        );
        assert!(
            text.starts_with("\x1b[1;34mmaru Skills doctor\x1b[0m \x1b[90m"),
            "{text:?}"
        );
        assert!(text.contains("\x1b[1;35m\u{25b8} Attention\x1b[0m \x1b[90m(2)\x1b[0m"));
        assert!(text.contains("\x1b[1;31m\u{2717}\x1b[0m "));
        assert!(text.contains("\x1b[1;33m\u{26a0}\x1b[0m "));
        assert!(text.contains("\x1b[34mSources:\x1b[0m"));
    }

    // Conformance 2: color off emits no ESC; --json never contains ESC.
    #[test]
    fn color_off_and_json_carry_no_escape() {
        let plain = render_check_report(
            &style(false, false),
            "Skills doctor",
            &facts(),
            &findings(),
            (0, ""),
        );
        assert!(!plain.contains('\x1b'));
        assert!(!help_overview(&style(false, false)).contains('\x1b'));
        assert!(!skills_capabilities_json().to_string().contains('\x1b'));
    }

    // Conformance 3: at 80 columns no line exceeds 80 cells.
    #[test]
    fn help_and_reports_fit_80_columns() {
        let long = vec![Finding {
            severity: "error".into(),
            code: "install_broken".into(),
            message: "word ".repeat(60),
            subject: None,
        }];
        let mut texts = vec![
            help_overview(&style(false, false)),
            render_check_report(
                &style(false, false),
                "Skills doctor",
                &facts(),
                &long,
                (3, "maru doctor --json"),
            ),
        ];
        for (name, _, _) in COMMANDS {
            texts.push(help_command(&style(false, false), name).unwrap());
        }
        for text in texts {
            for line in text.lines() {
                assert!(UnicodeWidthStr::width(line) <= 80, "{line}");
            }
        }
    }

    // Conformance 4: help exits 0, a usage error exits 2, a failure exits 1.
    #[test]
    fn help_usage_and_failure_exit_codes() {
        assert_eq!(run_cli(vec!["--help".into()]), 0);
        assert_eq!(run_cli(vec!["help".into(), "skills".into()]), 0);
        assert_eq!(run_cli(vec!["help".into(), "nope".into()]), 2);
        assert_eq!(run_cli(vec![]), 2);
        assert_eq!(
            run_cli(vec!["--color=sometimes".into(), "doctor".into()]),
            2
        );
        assert_eq!(
            run_cli(vec![
                "jobs".into(),
                "status".into(),
                "no-such-job-618".into()
            ]),
            1
        );
    }

    // Conformance 5: ASCII markers (as LANG=C selects).
    #[test]
    fn ascii_markers_replace_glyphs() {
        let text = render_check_report(
            &style(false, true),
            "Skills doctor",
            &facts(),
            &findings(),
            (0, ""),
        );
        assert!(text.contains("> Attention (2)"));
        assert!(text.contains("  x  install_broken"));
        assert!(text.contains("  !  env_incomplete"));
        assert!(text.ends_with("x 1 failed  ! 1 warning"));
        assert!(!text.chars().any(|ch| !ch.is_ascii()));
    }

    #[test]
    fn global_output_flags_are_taken_anywhere() {
        let (flags, rest) = take_output_flags(vec![
            "doctor".into(),
            "--color".into(),
            "never".into(),
            "--ascii".into(),
            "--json".into(),
        ])
        .unwrap();
        assert_eq!(flags.color, ColorChoice::Never);
        assert!(flags.ascii);
        assert_eq!(rest, vec!["doctor".to_string(), "--json".to_string()]);
    }

    // Review T142-1: an option's value is never taken as an output flag, so
    // `--message --ascii` keeps --ascii as the message and the conflicting
    // actions are refused (exit 2) before any effect.
    #[test]
    fn option_values_are_not_taken_as_output_flags() {
        let (flags, rest) = take_output_flags(
            [
                "skills",
                "reconcile",
                "NAME",
                "--message",
                "--ascii",
                "--accept",
                "--discard",
            ]
            .map(String::from)
            .to_vec(),
        )
        .unwrap();
        assert!(!flags.ascii);
        assert_eq!(
            rest,
            [
                "skills",
                "reconcile",
                "NAME",
                "--message",
                "--ascii",
                "--accept",
                "--discard"
            ]
            .map(String::from)
            .to_vec()
        );
        assert_eq!(
            run_cli(
                [
                    "skills",
                    "reconcile",
                    "NAME",
                    "--message",
                    "--ascii",
                    "--accept",
                    "--discard"
                ]
                .map(String::from)
                .to_vec()
            ),
            2
        );
        let (_, rest) = take_output_flags(
            ["calendar-sync", "--work", "--color", "--dry-run"]
                .map(String::from)
                .to_vec(),
        )
        .unwrap();
        assert_eq!(rest.len(), 4);
    }

    #[test]
    fn command_help_lists_flags_and_examples_for_every_flag_it_names() {
        for (name, _, usage) in COMMANDS {
            let text = help_command(&style(false, false), name).unwrap();
            let flags: Vec<&str> = usage
                .split(|ch: char| ch.is_whitespace() || "[]()|<>".contains(ch))
                .filter(|token| token.starts_with("--"))
                .collect();
            for flag in flags {
                assert!(
                    super::FLAG_DESCRIPTIONS
                        .iter()
                        .any(|(command, label, _)| command == name
                            && label.split(' ').next() == Some(flag)),
                    "{name}: {flag} has no description"
                );
            }
            if usage.contains("--") {
                assert!(text.contains("\u{25b8} Flags ("), "{name}: {text}");
            }
        }
        for (command, example) in super::EXAMPLES {
            assert!(example.starts_with(&format!("maru {command}")), "{example}");
            assert!(help_command(&style(false, false), command)
                .unwrap()
                .contains(example));
        }
    }

    fn job(id: &str) -> crate::jobs::JobStatus {
        crate::jobs::JobStatus {
            id: id.into(),
            title: "Daily sync".into(),
            description: String::new(),
            installed: true,
            loaded: false,
            enabled: true,
            plist_path: "/Users/me/Library/LaunchAgents/x.plist".into(),
            label: "com.maru.x".into(),
            schedule: crate::jobs::JobSchedule {
                hour: 7,
                minute: 0,
                recovery_interval_seconds: 0,
                recovery_mode: Default::default(),
                run_at_load: false,
            },
            last_exit_code: None,
            last_run_at: None,
            receipts: Vec::new(),
        }
    }

    #[test]
    fn jobs_render_as_sections_and_rows() {
        let text = super::render_jobs(&style(false, false), &[job("daily")]);
        assert!(
            text.starts_with("\u{25b8} daily Daily sync\n  Installed:"),
            "{text}"
        );
        assert!(text.contains("  Last exit:  (unset)"), "{text}");
        let ascii = super::render_jobs(&style(false, true), &[]);
        assert_eq!(ascii, "  -  no jobs declared in .maru/jobs.json");
    }

    #[test]
    fn calendar_sync_report_follows_the_layout_in_both_alphabets() {
        let outcome = crate::calendar_sync::CalendarSyncOutcome {
            destination: "primary".into(),
            dry_run: true,
            scanned: 3,
            inserts: 1,
            failed: 1,
            changes: vec![crate::calendar_sync::CalendarSyncChange {
                rel_path: "Today/2026-11-22.md".into(),
                action: "insert".into(),
                event_id: None,
            }],
            ..Default::default()
        };
        let plain = crate::calendar_sync::render_calendar_sync(&style(false, false), &outcome);
        assert!(
            plain.starts_with("maru calendar-sync primary dry run\n\n\u{25b8} Changes (1)"),
            "{plain}"
        );
        assert!(
            plain.contains("  ACTION  EVENT  NOTE\n  insert  -      Today/2026-11-22.md"),
            "{plain}"
        );
        assert!(plain.contains("\u{2717} 1 failed"), "{plain}");
        let ascii = crate::calendar_sync::render_calendar_sync(&style(false, true), &outcome);
        assert!(ascii.is_ascii(), "{ascii}");
        assert!(ascii.contains("x 1 failed"), "{ascii}");
        let colored = crate::calendar_sync::render_calendar_sync(&style(true, false), &outcome);
        assert!(
            colored.contains("\x1b[1;34mmaru calendar-sync primary\x1b[0m"),
            "{colored}"
        );
        for line in plain.lines() {
            assert!(UnicodeWidthStr::width(line) <= 80, "{line}");
        }
    }

    #[test]
    fn usage_names_the_installed_binary() {
        assert!(USAGE.starts_with("maru "));
        for (_, _, usage) in COMMANDS {
            assert!(usage.starts_with("maru "), "{usage}");
        }
    }

    #[test]
    fn capabilities_json_matches_the_federation_contract_exactly() {
        let value = skills_capabilities_json();
        let object = value.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["list", "schemaVersion", "selectedSync", "targets"]);
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["selectedSync"], true);
        assert_eq!(value["list"], true);
        assert_eq!(
            value["targets"],
            serde_json::json!(["claude", "codex", "kimi", "qwen", "grok", "opencode"])
        );
    }

    #[test]
    fn version_command_returns_success() {
        assert_eq!(run_cli(vec!["--version".to_string()]), 0);
    }

    #[test]
    fn leading_maru_cli_flag_is_skipped() {
        // Plists invoke both binaries as `<exe> --maru-cli jobs exec ...`; the
        // desktop binary consumes the flag, the standalone CLI skips it here.
        assert_eq!(
            run_cli(vec!["--maru-cli".to_string(), "--version".to_string()]),
            0
        );
    }

    #[test]
    fn jobs_exec_requires_an_id() {
        assert_eq!(run_cli(vec!["jobs".to_string(), "exec".to_string()]), 2);
    }

    #[test]
    fn unknown_cli_command_is_error() {
        assert_eq!(run_cli(vec!["not-a-command".to_string()]), 2);
    }

    #[test]
    fn missing_skills_subcommand_is_cli_error() {
        assert_eq!(run_cli(vec!["skills".to_string()]), 2);
    }

    #[test]
    fn skills_update_requires_explicit_mode() {
        assert_eq!(run_cli(vec!["skills".to_string(), "update".to_string()]), 2);
    }

    #[test]
    fn skills_update_rejects_unknown_option() {
        assert_eq!(
            run_cli(vec![
                "skills".to_string(),
                "update".to_string(),
                "--bogus".to_string(),
            ]),
            2
        );
    }

    #[test]
    fn skills_update_rejects_conflicting_modes() {
        assert_eq!(
            run_cli(vec![
                "skills".to_string(),
                "update".to_string(),
                "--check".to_string(),
                "--apply".to_string(),
            ]),
            2
        );
    }

    #[test]
    fn missing_secrets_subcommand_is_cli_error() {
        assert_eq!(run_cli(vec!["secrets".to_string()]), 2);
    }

    #[test]
    fn secrets_migrate_requires_explicit_mode() {
        assert_eq!(
            run_cli(vec!["secrets".to_string(), "migrate".to_string()]),
            2
        );
    }

    #[test]
    fn conflicting_reconcile_actions_are_cli_error() {
        assert_eq!(
            run_cli(vec![
                "skills".to_string(),
                "reconcile".to_string(),
                "example".to_string(),
                "--accept".to_string(),
                "--discard".to_string(),
            ]),
            2
        );
    }

    #[test]
    fn conflicting_import_modes_are_cli_error() {
        assert_eq!(
            run_cli(vec![
                "skills".to_string(),
                "import".to_string(),
                "/tmp/example".to_string(),
                "--copy".to_string(),
                "--link".to_string(),
            ]),
            2
        );
    }

    #[test]
    fn selected_skills_require_nonempty_selectors() {
        for value in ["", "one,", ",one"] {
            assert_eq!(
                run_cli(vec![
                    "skills".into(),
                    "sync".into(),
                    "--check".into(),
                    "--tools".into(),
                    "claude".into(),
                    "--skills".into(),
                    value.into()
                ]),
                2
            );
        }
        assert_eq!(
            run_cli(vec![
                "skills".into(),
                "capabilities".into(),
                "--json".into()
            ]),
            0
        );
    }

    #[test]
    fn skills_sync_requires_explicit_mode_and_tools() {
        assert_eq!(run_cli(vec!["skills".to_string(), "sync".to_string()]), 2);
        assert_eq!(
            run_cli(vec![
                "skills".to_string(),
                "sync".to_string(),
                "--check".to_string(),
            ]),
            2
        );
    }

    #[test]
    fn skills_sync_rejects_conflicting_modes() {
        assert_eq!(
            run_cli(vec![
                "skills".to_string(),
                "sync".to_string(),
                "--check".to_string(),
                "--apply".to_string(),
                "--tools".to_string(),
                "claude,codex".to_string(),
            ]),
            2
        );
    }
}
