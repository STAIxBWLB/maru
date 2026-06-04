//! Cross-platform console-window suppression for spawned subprocesses.
//!
//! Tauri GUI builds on Windows otherwise flash a transient console window each
//! time we shell out (git, AI CLIs, mail connectors, etc.). Applying the
//! `CREATE_NO_WINDOW` (0x0800_0000) process-creation flag suppresses that.
//!
//! `NoWindow` is a chainable extension trait so it composes with the existing
//! builder style: it takes `&mut self` and returns `&mut Self`, exactly like
//! `Command::arg`/`current_dir`/`stdout`. That makes it a drop-in in both
//! inline-chain (`.no_window().output()`) and stored-mut (`cmd.no_window();`)
//! call sites, and it can be passed straight into helpers that take
//! `&mut Command`.
//!
//! On non-Windows targets it is a no-op that returns `self` unchanged, so the
//! same source compiles and behaves identically on macOS/Linux.

use std::process::Command;

/// Windows `CREATE_NO_WINDOW` process-creation flag.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Chainable helper that suppresses the console window for a spawned process
/// on Windows and is a no-op elsewhere.
pub trait NoWindow {
    /// Suppress the transient console window on Windows; no-op on other OSes.
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for Command {
    #[cfg(windows)]
    fn no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }

    #[cfg(not(windows))]
    fn no_window(&mut self) -> &mut Self {
        self
    }
}
