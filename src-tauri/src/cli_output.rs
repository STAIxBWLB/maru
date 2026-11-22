//! Human output for `maru-cli`, per the shared CLI output standard v1
//! (STAIxBWLB/agent-hub `docs/design/cli-output.md`, maru#618).
//!
//! This is the only module that knows ANSI codes and marker glyphs. Callers
//! name a [`Role`] or a [`Marker`]; color is decided per stream by
//! [`resolve_color`], glyphs fall back to ASCII by [`use_ascii`]. `--json`
//! output never goes through [`Style::paint`], so it never carries an escape.

use std::cell::RefCell;
use std::io::IsTerminal;

use unicode_width::UnicodeWidthStr;

pub(crate) const TOOL: &str = "maru";

/// `--color=auto|always|never`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ColorChoice {
    Auto,
    Always,
    Never,
}

impl ColorChoice {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "always" => Some(Self::Always),
            "never" => Some(Self::Never),
            _ => None,
        }
    }
}

/// The color precedence table of the standard, for one stream.
pub(crate) fn resolve_color(
    choice: ColorChoice,
    env: &dyn Fn(&str) -> Option<String>,
    is_tty: bool,
) -> bool {
    match choice {
        ColorChoice::Always => return true,
        ColorChoice::Never => return false,
        ColorChoice::Auto => {}
    }
    let set = |name: &str| env(name).filter(|value| !value.is_empty());
    if set("NO_COLOR").is_some() {
        return false;
    }
    let forced = |name: &str| set(name).is_some_and(|value| value != "0");
    if forced("FORCE_COLOR") || forced("CLICOLOR_FORCE") {
        return true;
    }
    if env("FORCE_COLOR").as_deref() == Some("0") || env("CLICOLOR").as_deref() == Some("0") {
        return false;
    }
    is_tty && env("TERM").as_deref() != Some("dumb")
}

/// ASCII markers when the locale is not UTF-8 (`LC_ALL`, then `LC_CTYPE`,
/// then `LANG`) or with `--ascii`.
pub(crate) fn use_ascii(flag: bool, env: &dyn Fn(&str) -> Option<String>) -> bool {
    if flag {
        return true;
    }
    let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
        .into_iter()
        .find_map(|name| env(name).filter(|value| !value.is_empty()));
    match locale {
        Some(value) => {
            let value = value.to_ascii_lowercase();
            !(value.contains("utf-8") || value.contains("utf8"))
        }
        None => true,
    }
}

/// Semantic roles; code names a role, never a raw color. The full table is
/// the contract even where maru does not paint every role yet.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role {
    Header,
    Section,
    Key,
    Value,
    Success,
    Warning,
    Error,
    Hint,
    Accent,
}

impl Role {
    fn sgr(self) -> Option<&'static str> {
        match self {
            Role::Header => Some("1;34"),
            Role::Section => Some("1;35"),
            Role::Key => Some("34"),
            Role::Value => None,
            Role::Success => Some("1;32"),
            Role::Warning => Some("1;33"),
            Role::Error => Some("1;31"),
            Role::Hint => Some("90"),
            Role::Accent => Some("36"),
        }
    }
}

/// The marker alphabet: glyph, ASCII form and role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum Marker {
    Ok,
    Fail,
    Warn,
    Absent,
    Unknown,
    Pending,
    Active,
    Next,
}

impl Marker {
    fn glyph(self, ascii: bool) -> &'static str {
        match (self, ascii) {
            (Marker::Ok, false) => "✓",
            (Marker::Ok, true) => "ok",
            (Marker::Fail, false) => "✗",
            (Marker::Fail, true) => "x",
            (Marker::Warn, false) => "⚠",
            (Marker::Warn, true) => "!",
            (Marker::Absent, _) => "-",
            (Marker::Unknown, _) => "?",
            (Marker::Pending, _) => "~",
            (Marker::Active, _) => "*",
            (Marker::Next, false) => "→",
            (Marker::Next, true) => "->",
        }
    }

    fn role(self) -> Role {
        match self {
            Marker::Ok | Marker::Active => Role::Success,
            Marker::Fail => Role::Error,
            Marker::Warn => Role::Warning,
            Marker::Absent | Marker::Unknown | Marker::Pending => Role::Hint,
            Marker::Next => Role::Accent,
        }
    }
}

/// Rendering settings for one stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Style {
    pub color: bool,
    pub ascii: bool,
    /// Wrap width; `None` means no wrapping (a pipe without `COLUMNS`).
    pub width: Option<usize>,
    pub tty: bool,
}

impl Style {
    #[cfg(test)]
    pub(crate) fn plain() -> Self {
        Self {
            color: false,
            ascii: false,
            width: None,
            tty: false,
        }
    }

    pub(crate) fn paint(&self, role: Role, text: &str) -> String {
        match role.sgr() {
            Some(code) if self.color && !text.is_empty() => format!("\x1b[{code}m{text}\x1b[0m"),
            _ => text.to_string(),
        }
    }

    /// The marker padded to its 2-cell column, colored by its role.
    pub(crate) fn marker(&self, marker: Marker) -> String {
        let glyph = marker.glyph(self.ascii);
        let pad = 2usize.saturating_sub(UnicodeWidthStr::width(glyph));
        format!("{}{}", self.paint(marker.role(), glyph), " ".repeat(pad))
    }

    /// `▸ <Name>` with an optional count in `hint`.
    pub(crate) fn section(&self, name: &str, count: Option<&str>) -> String {
        let arrow = if self.ascii { ">" } else { "▸" };
        let title = self.paint(
            Role::Section,
            &format!("{arrow} {}", sanitize_terminal_text(name)),
        );
        match count {
            Some(count) => format!("{title} {}", self.paint(Role::Hint, &format!("({count})"))),
            None => title,
        }
    }

    /// `  <marker> <text>`, wrapped at the width with a 5-cell hanging indent.
    pub(crate) fn bullet(&self, marker: Marker, text: &str) -> String {
        self.bullet_at(2, marker, text)
    }

    /// A next step under a bullet: `    →  <command>`.
    #[allow(dead_code)]
    pub(crate) fn next_step(&self, text: &str) -> String {
        let arrow = self.marker(Marker::Next);
        let safe = sanitize_terminal_text(text);
        let lines = wrap(&safe, self.width.map(|width| width.saturating_sub(7)));
        let mut output = format!("    {arrow} {}", self.paint(Role::Accent, &lines[0]));
        for line in &lines[1..] {
            output.push_str(&format!("\n       {}", self.paint(Role::Accent, line)));
        }
        output
    }

    fn bullet_at(&self, indent: usize, marker: Marker, text: &str) -> String {
        let lead = " ".repeat(indent);
        let hang = indent + 3;
        let safe = sanitize_terminal_text(text);
        let lines = wrap(&safe, self.width.map(|width| width.saturating_sub(hang)));
        let mut out = format!("{lead}{} {}", self.marker(marker), lines[0]);
        for line in &lines[1..] {
            out.push('\n');
            out.push_str(&" ".repeat(hang));
            out.push_str(line);
        }
        out
    }

    /// Summary line: `✗ 2 failed  ⚠ 3 warnings  ✓ 18 ok`, zero counts omitted.
    pub(crate) fn summary(&self, failed: usize, warnings: usize, ok: usize) -> String {
        let mut parts = Vec::new();
        let plural = |n: usize, one: &str, many: &str| {
            if n == 1 {
                one.to_string()
            } else {
                many.to_string()
            }
        };
        if failed > 0 {
            parts.push(format!(
                "{} {failed} failed",
                self.paint(Role::Error, Marker::Fail.glyph(self.ascii))
            ));
        }
        if warnings > 0 {
            parts.push(format!(
                "{} {warnings} {}",
                self.paint(Role::Warning, Marker::Warn.glyph(self.ascii)),
                plural(warnings, "warning", "warnings")
            ));
        }
        if ok > 0 {
            parts.push(format!(
                "{} {ok} ok",
                self.paint(Role::Success, Marker::Ok.glyph(self.ascii))
            ));
        }
        if parts.is_empty() {
            parts.push(format!(
                "{} no problems found",
                self.paint(Role::Success, Marker::Ok.glyph(self.ascii))
            ));
        }
        parts.join("  ")
    }

    /// `<tool>: <message>`, with the fail marker when the stream is a TTY.
    pub(crate) fn error_line(&self, message: &str) -> String {
        let message = sanitize_terminal_text(message);
        if self.tty {
            format!("{} {TOOL}: {message}", self.marker(Marker::Fail))
        } else {
            format!("{TOOL}: {message}")
        }
    }

    /// `✓ <what was done>`, the success confirmation.
    pub(crate) fn done_line(&self, message: &str) -> String {
        format!(
            "{} {}",
            self.marker(Marker::Ok),
            sanitize_terminal_text(message)
        )
    }

    /// Header line: ` <title>` in `header`, optional context in `hint`.
    pub(crate) fn header(&self, title: &str, context: Option<&str>) -> String {
        let title = self.paint(Role::Header, &sanitize_terminal_text(title));
        match context.filter(|context| !context.is_empty()) {
            Some(context) => format!(
                "{title} {}",
                self.paint(Role::Hint, &sanitize_terminal_text(context))
            ),
            None => title,
        }
    }

    /// Key/value rows at a two-space indent, keys padded to the widest one;
    /// an empty value is `(unset)` in `hint`.
    pub(crate) fn rows(&self, rows: &[(&str, String)]) -> String {
        let width = rows
            .iter()
            .map(|(key, _)| UnicodeWidthStr::width(*key) + 1)
            .max()
            .unwrap_or(0);
        rows.iter()
            .map(|(key, value)| {
                let label = format!("{key}:");
                let pad = " ".repeat(width - UnicodeWidthStr::width(label.as_str()));
                let value = if value.is_empty() {
                    self.paint(Role::Hint, "(unset)")
                } else {
                    sanitize_terminal_text(value)
                };
                format!("  {}{pad}  {value}", self.paint(Role::Key, &label))
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// A borderless table: uppercase headings in `key`, two-space gutter.
    /// Every column but the last is capped at 32 cells (paths shorten in the
    /// middle); the last, flexible column wraps at the width. Empty cells are
    /// `-` in `hint`.
    pub(crate) fn table(&self, headings: &[&str], rows: &[Vec<String>]) -> String {
        const CAP: usize = 32;
        let columns = headings.len();
        let cell = |row: &Vec<String>, index: usize| -> String {
            let value =
                sanitize_terminal_text(row.get(index).map(String::as_str).unwrap_or_default());
            if index + 1 < columns {
                shorten_middle(&value, CAP)
            } else {
                value
            }
        };
        let mut widths: Vec<usize> = headings.iter().map(|h| h.len()).collect();
        for row in rows {
            for (index, width) in widths.iter_mut().enumerate().take(columns - 1) {
                let value = cell(row, index);
                *width = (*width).max(UnicodeWidthStr::width(value.as_str()).max(1));
            }
        }
        // Reserve useful space for the flexible column. If the fixed columns
        // fill the terminal, shorten the widest ones toward their headings.
        if let Some(limit) = self.width {
            let flex_min = (limit / 3).clamp(2, 20);
            while 2 + widths[..columns - 1].iter().map(|w| w + 2).sum::<usize>() + flex_min > limit
            {
                let candidate = (0..columns - 1)
                    .filter(|&i| widths[i] > headings[i].len().max(3))
                    .max_by_key(|&i| widths[i]);
                let Some(i) = candidate else { break };
                widths[i] -= 1;
            }
        }
        let lead: usize = 2 + widths[..columns - 1].iter().map(|w| w + 2).sum::<usize>();
        let flex = self.width.map(|width| width.saturating_sub(lead));
        let render = |values: Vec<String>, heading: bool| -> String {
            let mut first = String::from("  ");
            for (index, value) in values.iter().enumerate().take(columns - 1) {
                let shown = if value.is_empty() {
                    "-"
                } else {
                    value.as_str()
                };
                let pad = " ".repeat(widths[index].saturating_sub(UnicodeWidthStr::width(shown)));
                let role = if heading {
                    Role::Key
                } else if value.is_empty() {
                    Role::Hint
                } else {
                    Role::Value
                };
                first.push_str(&format!("{}{pad}  ", self.paint(role, shown)));
            }
            let last = values.last().cloned().unwrap_or_default();
            let lines = wrap(if last.is_empty() { "-" } else { &last }, flex);
            let role = if heading { Role::Key } else { Role::Value };
            let mut out = format!("{first}{}", self.paint(role, &lines[0]));
            for line in &lines[1..] {
                out.push_str(&format!("\n{}{}", " ".repeat(lead), self.paint(role, line)));
            }
            out.trim_end().to_string()
        };
        let mut text = render(headings.iter().map(|h| h.to_uppercase()).collect(), true);
        for row in rows {
            text.push('\n');
            text.push_str(&render(
                (0..columns)
                    .map(|i| {
                        let value = cell(row, i);
                        if i + 1 < columns {
                            shorten_middle(&value, widths[i])
                        } else {
                            value
                        }
                    })
                    .collect(),
                false,
            ));
        }
        text
    }

    /// `  → <command>` under an error line.
    pub(crate) fn error_next(&self, command: &str) -> String {
        format!(
            "  {} {}",
            self.marker(Marker::Next),
            self.paint(Role::Accent, &sanitize_terminal_text(command))
        )
    }
}

/// Shorten text longer than `cap` cells in the middle: `~/Library/.../home`.
pub(crate) fn shorten_middle(text: &str, cap: usize) -> String {
    if UnicodeWidthStr::width(text) <= cap {
        return text.to_string();
    }
    if cap < 3 {
        return ".".repeat(cap);
    }
    let keep = cap - 3;
    let head_cells = keep / 2;
    let tail_cells = keep - head_cells;
    let mut head = String::new();
    let mut cells = 0;
    for ch in text.chars() {
        let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if cells + w > head_cells {
            break;
        }
        cells += w;
        head.push(ch);
    }
    let mut tail: Vec<char> = Vec::new();
    cells = 0;
    for ch in text.chars().rev() {
        let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if cells + w > tail_cells {
            break;
        }
        cells += w;
        tail.push(ch);
    }
    tail.reverse();
    let mut tail: String = tail.into_iter().collect();
    // Sequence presentation can be wider than the sum of its scalar widths.
    // Check the actual rendered string rather than relying on those sums.
    loop {
        let result = format!("{head}...{tail}");
        if UnicodeWidthStr::width(result.as_str()) <= cap {
            return result;
        }
        if head.pop().is_none() {
            if tail.is_empty() {
                return "...".to_string();
            }
            tail.remove(0);
        }
    }
}

/// Keep externally supplied text inert when printed on a terminal. Control
/// characters, including ESC, C1 controls and line breaks, cannot create
/// terminal commands or forge extra report lines. Stored and JSON data stay intact.
pub(crate) fn sanitize_terminal_text(text: &str) -> String {
    use unicode_bidi::format_chars::{FSI, LRE, LRI, LRO, PDF, PDI, RLE, RLI, RLO};
    text.chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, LRE | RLE | PDF | LRO | RLO | LRI | RLI | FSI | PDI)
            {
                ' '
            } else {
                ch
            }
        })
        .collect()
}

/// Greedy word wrap measured in terminal cells (ambiguous width narrow).
pub(crate) fn wrap(text: &str, width: Option<usize>) -> Vec<String> {
    let Some(width) = width.filter(|width| *width >= 2) else {
        return vec![text.to_string()];
    };
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split(' ') {
        let candidate = if line.is_empty() {
            word.to_string()
        } else {
            format!("{line} {word}")
        };
        if UnicodeWidthStr::width(candidate.as_str()) <= width || line.is_empty() {
            line = candidate;
        } else {
            lines.push(std::mem::take(&mut line));
            line = word.to_string();
        }
        while UnicodeWidthStr::width(line.as_str()) > width {
            let mut cut = 0;
            let mut cells = 0;
            for (index, ch) in line.char_indices() {
                let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
                if cells + w > width {
                    break;
                }
                cells += w;
                cut = index + ch.len_utf8();
            }
            // Some presentation sequences occupy more cells than the sum of
            // their scalar widths. Shrink the candidate to a fitting prefix.
            while cut > 0 && UnicodeWidthStr::width(&line[..cut]) > width {
                cut = line[..cut]
                    .char_indices()
                    .last()
                    .map_or(0, |(index, _)| index);
            }
            if cut == 0 {
                // Even an indivisible glyph wider than the width must advance.
                cut = line.chars().next().map_or(0, char::len_utf8);
            }
            let rest = line.split_off(cut);
            lines.push(std::mem::replace(&mut line, rest));
        }
    }
    lines.push(line);
    lines
}

/// Global flags taken before the command (`--color=<when>`, `--ascii`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OutputFlags {
    pub color: ColorChoice,
    pub ascii: bool,
}

impl Default for OutputFlags {
    fn default() -> Self {
        Self {
            color: ColorChoice::Auto,
            ascii: false,
        }
    }
}

thread_local! {
    static FLAGS: RefCell<OutputFlags> = RefCell::new(OutputFlags::default());
}

pub(crate) fn set_flags(flags: OutputFlags) {
    FLAGS.with(|cell| *cell.borrow_mut() = flags);
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// Which standard stream a style renders for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stream {
    Stdout,
    Stderr,
}

fn style_for(stream: Stream, is_tty: bool) -> Style {
    let flags = FLAGS.with(|cell| *cell.borrow());
    let columns = env_var("COLUMNS").and_then(|value| value.parse().ok());
    // On a TTY wrap to the real width (COLUMNS overrides); on a pipe only
    // when COLUMNS is set.
    let width = if is_tty {
        columns.or_else(|| terminal_width(stream)).or(Some(80))
    } else {
        columns
    };
    Style {
        color: resolve_color(flags.color, &env_var, is_tty),
        ascii: use_ascii(flags.ascii, &env_var),
        width,
        tty: is_tty,
    }
}

/// The terminal's column count, queried from the stream's TTY.
#[cfg(unix)]
fn terminal_width(stream: Stream) -> Option<usize> {
    fd_width(match stream {
        Stream::Stdout => libc::STDOUT_FILENO,
        Stream::Stderr => libc::STDERR_FILENO,
    })
}

#[cfg(unix)]
fn fd_width(fd: libc::c_int) -> Option<usize> {
    let mut size = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: TIOCGWINSZ writes one winsize into the pointed-to struct.
    let rc = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut size) };
    (rc == 0 && size.ws_col > 0).then_some(size.ws_col as usize)
}

/// The console's visible column count (window width, not buffer width).
#[cfg(windows)]
fn terminal_width(stream: Stream) -> Option<usize> {
    use windows_sys::Win32::System::Console::{
        GetConsoleScreenBufferInfo, GetStdHandle, CONSOLE_SCREEN_BUFFER_INFO, STD_ERROR_HANDLE,
        STD_OUTPUT_HANDLE,
    };
    let which = match stream {
        Stream::Stdout => STD_OUTPUT_HANDLE,
        Stream::Stderr => STD_ERROR_HANDLE,
    };
    // SAFETY: GetStdHandle has no preconditions; GetConsoleScreenBufferInfo
    // writes one CONSOLE_SCREEN_BUFFER_INFO and fails on a non-console handle.
    unsafe {
        let handle = GetStdHandle(which);
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
        if GetConsoleScreenBufferInfo(handle, &mut info) == 0 {
            return None;
        }
        let columns = i32::from(info.srWindow.Right) - i32::from(info.srWindow.Left) + 1;
        (columns > 0).then_some(columns as usize)
    }
}

#[cfg(not(any(unix, windows)))]
fn terminal_width(_stream: Stream) -> Option<usize> {
    None
}

pub(crate) fn stdout_style() -> Style {
    style_for(Stream::Stdout, std::io::stdout().is_terminal())
}

pub(crate) fn stderr_style() -> Style {
    style_for(Stream::Stderr, std::io::stderr().is_terminal())
}

/// Print `✓ <what was done>` to stdout.
pub(crate) fn done(message: &str) {
    println!("{}", stdout_style().done_line(message));
}

/// Print `maru: <message>` to stderr; returns 1, the failure exit.
pub(crate) fn fail(message: &str) -> i32 {
    eprintln!("{}", stderr_style().error_line(message));
    1
}

/// Print a failure with a copyable next step; returns 1.
pub(crate) fn fail_with_next(message: &str, next: &str) -> i32 {
    let style = stderr_style();
    eprintln!("{}", style.error_line(message));
    eprintln!("{}", style.error_next(next));
    1
}

/// Render a usage error (message, `Usage:` line, help pointer).
pub(crate) fn usage_error_text(style: &Style, message: &str, usage: &str, command: &str) -> String {
    let mut out = style.error_line(message);
    let mut lines = usage.lines();
    if let Some(first) = lines.next() {
        out.push_str(&format!("\nUsage: {first}"));
        for line in lines.take_while(|line| !line.is_empty()) {
            out.push_str(&format!("\n       {}", line.trim_start()));
        }
    }
    let pointer = if command.is_empty() {
        format!("Run '{TOOL} help' for details.")
    } else {
        format!("Run '{TOOL} help {command}' for details.")
    };
    out.push('\n');
    out.push_str(&pointer);
    out
}

/// Print a usage error to stderr; returns 2.
pub(crate) fn usage_error(message: &str, usage: &str, command: &str) -> i32 {
    eprintln!(
        "{}",
        usage_error_text(&stderr_style(), message, usage, command)
    );
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn color_precedence_follows_the_table() {
        let auto = ColorChoice::Auto;
        assert!(resolve_color(
            ColorChoice::Always,
            &env_of(&[("NO_COLOR", "1")]),
            false
        ));
        assert!(!resolve_color(
            ColorChoice::Never,
            &env_of(&[("FORCE_COLOR", "1")]),
            true
        ));
        assert!(!resolve_color(
            auto,
            &env_of(&[("NO_COLOR", "1"), ("FORCE_COLOR", "1")]),
            true
        ));
        assert!(resolve_color(auto, &env_of(&[("NO_COLOR", "")]), true));
        assert!(resolve_color(auto, &env_of(&[("FORCE_COLOR", "1")]), false));
        assert!(resolve_color(
            auto,
            &env_of(&[("CLICOLOR_FORCE", "1")]),
            false
        ));
        assert!(!resolve_color(auto, &env_of(&[("FORCE_COLOR", "0")]), true));
        assert!(!resolve_color(auto, &env_of(&[("CLICOLOR", "0")]), true));
        assert!(resolve_color(auto, &env_of(&[]), true));
        assert!(!resolve_color(auto, &env_of(&[("TERM", "dumb")]), true));
        assert!(!resolve_color(auto, &env_of(&[]), false));
    }

    #[test]
    fn ascii_follows_the_locale() {
        assert!(use_ascii(false, &env_of(&[("LANG", "C")])));
        assert!(!use_ascii(false, &env_of(&[("LANG", "ko_KR.UTF-8")])));
        assert!(use_ascii(
            false,
            &env_of(&[("LC_ALL", "C"), ("LANG", "en_US.UTF-8")])
        ));
        assert!(!use_ascii(
            false,
            &env_of(&[("LC_CTYPE", "UTF-8"), ("LANG", "C")])
        ));
        assert!(use_ascii(true, &env_of(&[("LANG", "en_US.UTF-8")])));
    }

    #[test]
    fn roles_map_to_the_normative_ansi_codes() {
        let style = Style {
            color: true,
            ..Style::plain()
        };
        assert_eq!(style.paint(Role::Header, "h"), "\x1b[1;34mh\x1b[0m");
        assert_eq!(style.paint(Role::Section, "s"), "\x1b[1;35ms\x1b[0m");
        assert_eq!(style.paint(Role::Key, "k"), "\x1b[34mk\x1b[0m");
        assert_eq!(style.paint(Role::Value, "v"), "v");
        assert_eq!(style.paint(Role::Success, "o"), "\x1b[1;32mo\x1b[0m");
        assert_eq!(style.paint(Role::Warning, "w"), "\x1b[1;33mw\x1b[0m");
        assert_eq!(style.paint(Role::Error, "e"), "\x1b[1;31me\x1b[0m");
        assert_eq!(style.paint(Role::Hint, "h"), "\x1b[90mh\x1b[0m");
        assert_eq!(style.paint(Role::Accent, "a"), "\x1b[36ma\x1b[0m");
        assert_eq!(Style::plain().paint(Role::Error, "e"), "e");
    }

    #[test]
    fn markers_fill_a_two_cell_column_in_both_alphabets() {
        let unicode = Style::plain();
        let ascii = Style {
            ascii: true,
            ..Style::plain()
        };
        assert_eq!(unicode.marker(Marker::Ok), "✓ ");
        assert_eq!(ascii.marker(Marker::Ok), "ok");
        assert_eq!(ascii.marker(Marker::Fail), "x ");
        assert_eq!(ascii.marker(Marker::Next), "->");
        assert_eq!(unicode.bullet(Marker::Warn, "w"), "  ⚠  w");
    }

    #[test]
    fn error_lines_keep_the_plain_tool_prefix_on_a_pipe() {
        assert_eq!(Style::plain().error_line("x: y"), "maru: x: y");
        let tty = Style {
            tty: true,
            ..Style::plain()
        };
        assert_eq!(tty.error_line("x: y"), "✗  maru: x: y");
    }

    #[test]
    fn usage_errors_name_the_usage_and_the_help_command() {
        let text = usage_error_text(
            &Style::plain(),
            "unknown option: --x",
            "maru doctor [--json] [--quiet]",
            "doctor",
        );
        assert_eq!(
            text,
            "maru: unknown option: --x\nUsage: maru doctor [--json] [--quiet]\nRun 'maru help doctor' for details."
        );
    }

    #[test]
    fn tables_cap_columns_and_wrap_the_flexible_one() {
        let style = Style {
            width: Some(80),
            ..Style::plain()
        };
        let rows = vec![
            vec![
                "insert".to_string(),
                "/Users/someone/Library/Application Support/very/long/path".to_string(),
                "word ".repeat(30),
            ],
            vec!["patch".to_string(), String::new(), "short".to_string()],
        ];
        let text = style.table(&["action", "path", "note"], &rows);
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[0].starts_with("  ACTION  PATH"), "{text}");
        assert!(text.contains("..."), "{text}");
        assert!(text.contains("  patch   -  "), "{text}");
        for line in &lines {
            assert!(UnicodeWidthStr::width(*line) <= 80, "{line}");
        }
        assert_eq!(
            UnicodeWidthStr::width(shorten_middle(&"x".repeat(50), 32).as_str()),
            32
        );
    }

    #[test]
    fn narrow_table_columns_wrap_and_external_text_is_safe() {
        use unicode_bidi::format_chars::{FSI, LRE, LRI, LRO, PDF, PDI, RLE, RLI, RLO};
        let style = Style {
            width: Some(80),
            ..Style::plain()
        };
        let bidi = [LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI]
            .into_iter()
            .collect::<String>();
        let raw = format!("label{bidi}\rforged");
        let rows = vec![vec![
            "n".repeat(25),
            "s".repeat(25),
            "tier".into(),
            format!("{} {raw}", "p".repeat(60)),
        ]];
        let output = style.table(&["name", "source", "tier", "path"], &rows);
        for line in output.lines() {
            assert!(UnicodeWidthStr::width(line) <= 80, "{line}");
            assert!(
                !line.chars().any(|c| c.is_control() || bidi.contains(c)),
                "{line:?}"
            );
        }
        assert!(output.contains("forged"));
        assert_eq!(rows[0][3], format!("{} {raw}", "p".repeat(60)));
        let error = style.error_line(&raw);
        assert!(!error.chars().any(|c| c.is_control() || bidi.contains(c)));
        let section = style.section(&raw, None);
        assert!(!section.chars().any(|c| c.is_control() || bidi.contains(c)));
    }

    #[test]
    fn wide_emoji_cells_shrink_without_overflow_and_leave_room_for_paths() {
        let style = Style {
            width: Some(56),
            ..Style::plain()
        };
        for prefix in ["❤️", "#️"] {
            let name = format!("{prefix}{}", "a".repeat(29));
            let rows = vec![vec![
                name,
                "source-id".into(),
                "managed".into(),
                "p".repeat(60),
            ]];
            let report = style.table(&["name", "source", "tier", "path"], &rows);
            for line in report.lines() {
                assert!(UnicodeWidthStr::width(line) <= 56, "{line:?}");
            }
            assert!(report.lines().count() <= 7, "{report}");
        }
        // Three wide fixed columns force the shrink loop even at 80 cells.
        let wide = Style {
            width: Some(80),
            ..Style::plain()
        };
        let rows = vec![vec![
            "n".repeat(31),
            "s".repeat(31),
            "t".repeat(31),
            "p".repeat(60),
        ]];
        let report = wide.table(&["name", "source", "tier", "path"], &rows);
        assert!(
            report
                .lines()
                .all(|line| UnicodeWidthStr::width(line) <= 80),
            "{report}"
        );
        assert!(
            report.contains("..."),
            "the fixed columns must shrink: {report}"
        );
        assert!(report.lines().count() <= 6, "{report}");
        for cap in 3..=32 {
            let value = format!("❤️{}#️", "a".repeat(40));
            let result = shorten_middle(&value, cap);
            assert!(
                UnicodeWidthStr::width(result.as_str()) <= cap,
                "{cap}: {result:?}"
            );
        }
        let wrapped = wrap("❤️❤️", Some(2));
        assert!(
            wrapped
                .iter()
                .all(|line| UnicodeWidthStr::width(line.as_str()) <= 2),
            "{wrapped:?}"
        );
        assert_eq!(wrapped.concat(), "❤️❤️");
    }

    #[test]
    fn rows_pad_keys_and_mark_unset_values() {
        let text = Style::plain().rows(&[("Id", "a".into()), ("Label", String::new())]);
        assert_eq!(text, "  Id:     a\n  Label:  (unset)");
    }

    #[cfg(unix)]
    #[test]
    fn a_non_tty_fd_has_no_terminal_width() {
        use std::os::fd::AsRawFd;
        let dev_null = std::fs::File::open("/dev/null").unwrap();
        assert_eq!(fd_width(dev_null.as_raw_fd()), None);
    }

    #[test]
    fn wrap_fits_the_width_and_keeps_long_words_whole_lines() {
        let lines = wrap(&"word ".repeat(40), Some(30));
        assert!(lines
            .iter()
            .all(|line| UnicodeWidthStr::width(line.as_str()) <= 30));
        let long = wrap(&"x".repeat(70), Some(30));
        assert_eq!(long.len(), 3);
        assert_eq!(
            wrap("한국어 텍스트", None),
            vec!["한국어 텍스트".to_string()]
        );
    }
}
