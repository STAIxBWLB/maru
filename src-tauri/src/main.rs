#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

fn main() {
    let mut args = std::env::args().skip(1);
    if matches!(args.next().as_deref(), Some("--maru-cli")) {
        std::process::exit(maru_lib::run_cli(args.collect()));
    }
    maru_lib::run()
}
