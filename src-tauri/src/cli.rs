use std::env;

use crate::skill_host::{
    skills_doctor, skills_import_external, skills_import_unmanage, skills_list_dirty,
    skills_reconcile_skill,
};

pub fn run_cli(args: Vec<String>) -> Option<i32> {
    let command = args.first()?.as_str();
    match command {
        "doctor" => Some(run_doctor(&args[1..])),
        "skills" => Some(run_skills(&args[1..])),
        _ => None,
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
                eprintln!("usage: anchor doctor [--json] [--quiet]");
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

fn run_skills_dirty(args: &[String]) -> i32 {
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            other => {
                eprintln!("unknown option: {other}");
                eprintln!("usage: anchor skills dirty [--json]");
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
            "--accept" => action = Some("accept".to_string()),
            "--discard" => action = Some("discard".to_string()),
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
            "--copy" => mode = Some("copy".to_string()),
            "--link" => mode = Some("link".to_string()),
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
    "usage: anchor skills dirty|reconcile|import|import-unmanage"
}

#[cfg(test)]
mod tests {
    use super::run_cli;

    #[test]
    fn unknown_cli_command_falls_through_to_tauri() {
        assert_eq!(run_cli(vec!["--version".to_string()]), None);
    }

    #[test]
    fn missing_skills_subcommand_is_cli_error() {
        assert_eq!(run_cli(vec!["skills".to_string()]), Some(2));
    }
}
