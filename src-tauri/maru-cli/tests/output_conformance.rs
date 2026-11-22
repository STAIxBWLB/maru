//! CLI output standard v1 conformance against the real `maru-cli` binary
//! (maru#618): streams, exit codes, escapes and ASCII markers as a script or
//! an agent sees them on a pipe.

use std::process::{Command, Output};

fn maru(args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_maru-cli"));
    command
        .args(args)
        .current_dir(std::env::temp_dir())
        .env_remove("NO_COLOR")
        .env_remove("FORCE_COLOR")
        .env_remove("CLICOLOR_FORCE")
        .env_remove("CLICOLOR")
        .env_remove("COLUMNS")
        .env_remove("LC_ALL")
        .env_remove("LC_CTYPE")
        .env("LANG", "en_US.UTF-8");
    for (key, value) in env {
        command.env(key, value);
    }
    command.output().expect("spawn maru-cli")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn help_is_stdout_exit_0_and_fits_80_columns() {
    for args in [&["help"][..], &["--help"], &["-h"], &["help", "skills"]] {
        let out = maru(args, &[]);
        assert_eq!(out.status.code(), Some(0), "{args:?}");
        assert!(out.stderr.is_empty(), "{args:?}");
        let stdout = text(&out.stdout);
        assert!(stdout.contains("\u{25b8} Usage"), "{stdout}");
        for line in stdout.lines() {
            assert!(line.chars().count() <= 80, "{line}");
        }
    }
}

#[test]
fn usage_errors_exit_2_on_stderr_with_the_tool_prefix() {
    let out = maru(&["doctor", "--bogus"], &[]);
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    let stderr = text(&out.stderr);
    assert!(
        stderr.starts_with("maru: unknown option: --bogus\nUsage: maru doctor"),
        "{stderr}"
    );
    assert!(
        stderr.contains("Run 'maru help doctor' for details."),
        "{stderr}"
    );
}

#[test]
fn failures_exit_1_with_the_tool_prefix_and_a_next_step() {
    let out = maru(&["jobs", "status", "no-such-job-618"], &[]);
    assert_eq!(out.status.code(), Some(1), "{}", text(&out.stderr));
    let stderr = text(&out.stderr);
    assert!(stderr.starts_with("maru: "), "{stderr}");
    let exec = maru(&["jobs", "exec", "no-such-job-618"], &[]);
    assert_eq!(exec.status.code(), Some(1));
    assert!(
        text(&exec.stderr).starts_with("maru: jobs exec: "),
        "{}",
        text(&exec.stderr)
    );
}

#[test]
fn no_color_and_pipes_emit_no_escape_and_force_color_does() {
    let plain = maru(&["help"], &[]);
    assert!(!plain.stdout.contains(&0x1b));
    let no_color = maru(&["help"], &[("NO_COLOR", "1"), ("FORCE_COLOR", "1")]);
    assert!(!no_color.stdout.contains(&0x1b));
    let forced = maru(&["help"], &[("FORCE_COLOR", "1")]);
    assert!(text(&forced.stdout).contains("\x1b[1;34mmaru\x1b[0m"));
    let always = maru(&["--color=always", "skills", "capabilities", "--json"], &[]);
    assert_eq!(always.status.code(), Some(0));
    assert!(
        !always.stdout.contains(&0x1b),
        "--json never carries an escape"
    );
}

#[test]
fn lang_c_prints_ascii_markers() {
    let out = maru(&["help"], &[("LANG", "C")]);
    let stdout = text(&out.stdout);
    assert!(stdout.contains("> Usage"), "{stdout}");
    assert!(stdout.is_ascii(), "{stdout}");
}

#[test]
fn usage_errors_name_the_actual_unknown_arguments() {
    let env = maru(&["skills", "env", "wrong"], &[]);
    assert_eq!(env.status.code(), Some(2));
    assert!(text(&env.stderr).contains("unknown subcommand: wrong"));
    let import = maru(&["skills", "import-unmanage", "name", "--bogus"], &[]);
    assert_eq!(import.status.code(), Some(2));
    assert!(text(&import.stderr).contains("unknown option: --bogus"));
}
