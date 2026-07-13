use std::env;

use crate::secrets::{secrets_doctor, secrets_migrate, secrets_scan};
use crate::skill_host::{
    skills_apply_bundle_update_headless, skills_check_bundle_update, skills_doctor,
    skills_import_external, skills_import_unmanage, skills_list_dirty, skills_reconcile_skill,
    skills_sync_tools,
};

pub fn run_cli(args: Vec<String>) -> i32 {
    let Some(command) = args.first().map(String::as_str) else {
        eprintln!("{}", usage());
        return 2;
    };
    match command {
        "--help" | "-h" | "help" => {
            println!("{}", usage());
            0
        }
        "--version" | "-V" | "version" => {
            println!("maru {}", env!("CARGO_PKG_VERSION"));
            0
        }
        "doctor" => run_doctor(&args[1..]),
        "secrets" => run_secrets(&args[1..]),
        "skills" => run_skills(&args[1..]),
        "terminal-hook" => crate::terminal_hooks::run_terminal_hook(&args[1..]),
        other => {
            eprintln!("unknown command: {other}");
            eprintln!("{}", usage());
            2
        }
    }
}

fn run_secrets(args: &[String]) -> i32 {
    let Some(subcommand) = args.first().map(String::as_str) else {
        eprintln!("{}", secrets_usage());
        return 2;
    };
    match subcommand {
        "scan" => run_secrets_scan(&args[1..]),
        "doctor" => run_secrets_doctor(&args[1..]),
        "migrate" => run_secrets_migrate(&args[1..]),
        _ => {
            eprintln!("{}", secrets_usage());
            2
        }
    }
}

fn run_secrets_scan(args: &[String]) -> i32 {
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            other => {
                eprintln!("unknown option: {other}");
                eprintln!("usage: maru secrets scan [--json]");
                return 2;
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
                println!(
                    "secrets: {} managed, {} candidate(s), {} legacy symlink(s), {} issue(s)",
                    report.managed.len(),
                    report.candidates.len(),
                    report.legacy_symlinks.len(),
                    report.issues.len()
                );
                for issue in &report.issues {
                    println!(
                        "{}: {}{}",
                        issue.code,
                        issue.message,
                        issue
                            .path
                            .as_ref()
                            .map(|path| format!(" ({path})"))
                            .unwrap_or_default()
                    );
                }
            }
            if report.ok {
                0
            } else {
                1
            }
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
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
                eprintln!("unknown option: {other}");
                eprintln!("usage: maru secrets doctor [--json] [--quiet]");
                return 2;
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
                let error_count = report
                    .issues
                    .iter()
                    .filter(|issue| issue.severity == "error")
                    .count();
                let warn_count = report
                    .issues
                    .iter()
                    .filter(|issue| issue.severity == "warn")
                    .count();
                println!(
                    "secrets doctor: {} managed, {} candidate(s), {error_count} error(s), {warn_count} warning(s)",
                    report.managed.len(),
                    report.candidates.len()
                );
                for issue in &report.issues {
                    if issue.severity == "error" || !quiet {
                        println!(
                            "{}: {}{}",
                            issue.code,
                            issue.message,
                            issue
                                .path
                                .as_ref()
                                .map(|path| format!(" ({path})"))
                                .unwrap_or_default()
                        );
                    }
                }
            }
            if report.ok {
                0
            } else {
                1
            }
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
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
                    eprintln!("conflicting options: --dry-run and --apply");
                    return 2;
                }
                dry_run = Some(true);
            }
            "--apply" => {
                if dry_run == Some(true) {
                    eprintln!("conflicting options: --dry-run and --apply");
                    return 2;
                }
                dry_run = Some(false);
            }
            "--select" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    eprintln!("--select requires a workspace-relative path");
                    return 2;
                };
                selected.push(value.clone());
            }
            other => {
                eprintln!("unknown option: {other}");
                eprintln!(
                    "usage: maru secrets migrate --dry-run|--apply [--select <relpath>] [--json]"
                );
                return 2;
            }
        }
        index += 1;
    }
    let Some(dry_run) = dry_run else {
        eprintln!("--dry-run or --apply required");
        return 2;
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
                println!(
                    "secrets migrate: {} action(s) {}",
                    report.actions.len(),
                    if report.applied { "applied" } else { "planned" }
                );
                for action in &report.actions {
                    println!(
                        "{}\t{}\t{}",
                        action.action,
                        action.status,
                        action.rel_path.clone().unwrap_or_default()
                    );
                }
            }
            if report.ok {
                0
            } else {
                1
            }
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
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
                eprintln!("unknown option: {other}");
                eprintln!("usage: maru doctor [--json] [--quiet]");
                return 2;
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
                let error_count = report
                    .issues
                    .iter()
                    .filter(|issue| issue.severity == "error")
                    .count();
                let warn_count = report
                    .issues
                    .iter()
                    .filter(|issue| issue.severity == "warn")
                    .count();
                let line = format!(
                    "skills doctor: {} source(s), {} skill(s), {} install(s), {error_count} error(s), {warn_count} warning(s)",
                    report.sources, report.skills, report.installs
                );
                if report.ok {
                    println!("{line}");
                } else {
                    eprintln!("{line}");
                    for issue in &report.issues {
                        if issue.severity == "error" {
                            eprintln!(
                                "{}: {}{}",
                                issue.code,
                                issue.message,
                                issue
                                    .skill_name
                                    .as_ref()
                                    .map(|name| format!(" ({name})"))
                                    .unwrap_or_default()
                            );
                        }
                    }
                }
            }
            if report.ok {
                0
            } else {
                1
            }
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn run_skills(args: &[String]) -> i32 {
    let Some(subcommand) = args.first().map(String::as_str) else {
        eprintln!("{}", skills_usage());
        return 2;
    };
    match subcommand {
        "sync" => run_skills_sync(&args[1..]),
        "update" => run_skills_update(&args[1..]),
        "dirty" => run_skills_dirty(&args[1..]),
        "reconcile" => run_skills_reconcile(&args[1..]),
        "import" => run_skills_import(&args[1..]),
        "import-unmanage" => run_skills_import_unmanage(&args[1..]),
        _ => {
            eprintln!("{}", skills_usage());
            2
        }
    }
}

fn run_skills_update(args: &[String]) -> i32 {
    let mut check: Option<bool> = None;
    let mut repair_env = false;
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--check" => {
                if check == Some(false) {
                    eprintln!("conflicting options: --check and --apply");
                    return 2;
                }
                check = Some(true);
            }
            "--apply" => {
                if check == Some(true) {
                    eprintln!("conflicting options: --check and --apply");
                    return 2;
                }
                check = Some(false);
            }
            "--repair-env" => repair_env = true,
            "--json" => json = true,
            other => {
                eprintln!("unknown option: {other}");
                eprintln!("usage: maru skills update --check|--apply [--repair-env] [--json]");
                return 2;
            }
        }
    }
    let Some(check) = check else {
        eprintln!("--check or --apply required");
        return 2;
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
                        .map(|active| {
                            format!("{} (r{})", active.display_version, active.revision)
                        })
                        .unwrap_or_else(|| "none".to_string());
                    let channel = status
                        .available
                        .as_ref()
                        .map(|available| {
                            format!("{} (r{})", available.display_version, available.revision)
                        })
                        .unwrap_or_else(|| "none published".to_string());
                    println!("skills bundle: active {active}; channel {channel}");
                    if status.update_available {
                        if status.auto_applicable {
                            println!("update available: run `maru skills update --apply`");
                        } else {
                            let mut blockers = Vec::new();
                            if !status.dirty_skills.is_empty() {
                                blockers
                                    .push(format!("local edits: {}", status.dirty_skills.join(", ")));
                            }
                            if status.env_update_required {
                                blockers.push("env update required (--repair-env)".to_string());
                            }
                            if !status.min_app_ok {
                                blockers.push(format!(
                                    "app too old (needs {})",
                                    status
                                        .available
                                        .as_ref()
                                        .map(|a| a.min_app_version.as_str())
                                        .unwrap_or("newer app")
                                ));
                            }
                            println!("update available but blocked: {}", blockers.join("; "));
                        }
                    } else {
                        println!("up to date");
                    }
                }
                0
            }
            Err(err) => {
                eprintln!("{err}");
                1
            }
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
                    println!(
                        "skills bundle {} applied: {} added, {} updated, {} removed",
                        outcome.current.display_version,
                        outcome.added_skills.len(),
                        outcome.updated_skills.len(),
                        outcome.removed_skills.len()
                    );
                    if !outcome.stale_copy_installs.is_empty() {
                        println!(
                            "stale copy installs (reinstall to refresh): {}",
                            outcome.stale_copy_installs.join(", ")
                        );
                    }
                }
                0
            }
            Err(err)
                if err.starts_with("bundle_not_newer")
                    || err == "bundle_update_not_available" =>
            {
                println!("up to date ({err})");
                0
            }
            Err(err) => {
                eprintln!("{err}");
                1
            }
        }
    }
}

fn run_skills_sync(args: &[String]) -> i32 {
    let mut apply: Option<bool> = None;
    let mut tools: Option<Vec<String>> = None;
    let mut json = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--check" => {
                if apply == Some(true) {
                    eprintln!("conflicting options: --check and --apply");
                    return 2;
                }
                apply = Some(false);
            }
            "--apply" => {
                if apply == Some(false) {
                    eprintln!("conflicting options: --check and --apply");
                    return 2;
                }
                apply = Some(true);
            }
            "--tools" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    eprintln!("--tools requires a comma-separated value");
                    return 2;
                };
                let parsed: Vec<String> = value
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .collect();
                if parsed.is_empty() {
                    eprintln!("--tools requires at least one tool");
                    return 2;
                }
                tools = Some(parsed);
            }
            "--json" => json = true,
            other => {
                eprintln!("unknown option: {other}");
                eprintln!("usage: maru skills sync --check|--apply --tools claude,codex [--json]");
                return 2;
            }
        }
        index += 1;
    }
    let Some(apply) = apply else {
        eprintln!("--check or --apply required");
        return 2;
    };
    let Some(tools) = tools else {
        eprintln!("--tools required");
        return 2;
    };
    match skills_sync_tools(current_work_path(), tools, apply) {
        Ok(report) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).unwrap_or_default()
                );
            } else {
                println!(
                    "skills sync: {} skill(s), {} install(s), {} action(s) {}",
                    report.desired_skills,
                    report.desired_installs,
                    report.actions.len(),
                    if report.applied { "applied" } else { "planned" }
                );
                for action in &report.actions {
                    println!(
                        "{}\t{}\t{}\t{}",
                        action.action,
                        action.target.as_deref().unwrap_or("maru"),
                        action.skill_name,
                        action.path
                    );
                }
            }
            if !apply && !report.actions.is_empty() {
                1
            } else {
                0
            }
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn run_skills_dirty(args: &[String]) -> i32 {
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            other => {
                eprintln!("unknown option: {other}");
                eprintln!("usage: maru skills dirty [--json]");
                return 2;
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
                for record in &records {
                    println!(
                        "{}\t{}\t{}\t{}",
                        record.name, record.source_id, record.tier, record.abs_path
                    );
                }
            }
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn run_skills_reconcile(args: &[String]) -> i32 {
    let Some(skill) = args.first() else {
        eprintln!("skill required");
        return 2;
    };
    let mut action: Option<String> = None;
    let mut message: Option<String> = None;
    let mut dry_run = false;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--accept" => {
                if action.as_deref().is_some_and(|value| value != "accept") {
                    eprintln!("conflicting options: --accept and --discard");
                    eprintln!(
                        "usage: maru skills reconcile <name-or-id> (--accept|--discard) [--message <m>] [--dry-run]"
                    );
                    return 2;
                }
                action = Some("accept".to_string());
            }
            "--discard" => {
                if action.as_deref().is_some_and(|value| value != "discard") {
                    eprintln!("conflicting options: --accept and --discard");
                    eprintln!(
                        "usage: maru skills reconcile <name-or-id> (--accept|--discard) [--message <m>] [--dry-run]"
                    );
                    return 2;
                }
                action = Some("discard".to_string());
            }
            "--message" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    eprintln!("--message requires a value");
                    return 2;
                };
                message = Some(value.clone());
            }
            "--dry-run" => dry_run = true,
            other => {
                eprintln!("unknown option: {other}");
                return 2;
            }
        }
        index += 1;
    }
    let Some(action) = action else {
        eprintln!("--accept or --discard required");
        return 2;
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
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn run_skills_import(args: &[String]) -> i32 {
    let Some(source_path) = args.first() else {
        eprintln!("source path required");
        return 2;
    };
    let mut name: Option<String> = None;
    let mut mode: Option<String> = None;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--name" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    eprintln!("--name requires a value");
                    return 2;
                };
                name = Some(value.clone());
            }
            "--copy" => {
                if mode.as_deref().is_some_and(|value| value != "copy") {
                    eprintln!("conflicting options: --copy and --link");
                    eprintln!(
                        "usage: maru skills import <source-path> [--name <name>] [--copy|--link]"
                    );
                    return 2;
                }
                mode = Some("copy".to_string());
            }
            "--link" => {
                if mode.as_deref().is_some_and(|value| value != "link") {
                    eprintln!("conflicting options: --copy and --link");
                    eprintln!(
                        "usage: maru skills import <source-path> [--name <name>] [--copy|--link]"
                    );
                    return 2;
                }
                mode = Some("link".to_string());
            }
            other => {
                eprintln!("unknown option: {other}");
                return 2;
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
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn run_skills_import_unmanage(args: &[String]) -> i32 {
    let Some(name) = args.first() else {
        eprintln!("skill name required");
        return 2;
    };
    let delete_files = args.iter().skip(1).any(|arg| arg == "--delete-files");
    if args
        .iter()
        .skip(1)
        .any(|arg| arg.as_str() != "--delete-files")
    {
        eprintln!("unknown option");
        return 2;
    }
    match skills_import_unmanage(current_work_path(), name.clone(), Some(delete_files)) {
        Ok(outcome) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&outcome).unwrap_or_default()
            );
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn current_work_path() -> Option<String> {
    env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
}

fn skills_usage() -> &'static str {
    "usage: maru skills sync|update|dirty|reconcile|import|import-unmanage"
}

fn secrets_usage() -> &'static str {
    "usage: maru secrets scan|doctor|migrate"
}

fn usage() -> &'static str {
    "usage: maru [--version] [--help] <command>\n\ncommands:\n  doctor [--json] [--quiet]\n  secrets scan [--json]\n  secrets doctor [--json] [--quiet]\n  secrets migrate --dry-run|--apply [--select <relpath>] [--json]\n  skills sync --check|--apply --tools claude,codex [--json]\n  skills update --check|--apply [--repair-env] [--json]\n  skills dirty [--json]\n  skills reconcile <name-or-id> (--accept|--discard) [--message <m>] [--dry-run]\n  skills import <source-path> [--name <name>] [--copy|--link]\n  skills import-unmanage <name> [--delete-files]"
}

#[cfg(test)]
mod tests {
    use super::run_cli;

    #[test]
    fn version_command_returns_success() {
        assert_eq!(run_cli(vec!["--version".to_string()]), 0);
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
        assert_eq!(
            run_cli(vec!["skills".to_string(), "update".to_string()]),
            2
        );
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
