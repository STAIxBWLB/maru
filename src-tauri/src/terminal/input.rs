use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum TerminalInputCommand {
    Text {
        text: String,
    },
    Paste {
        text: String,
    },
    LineBreak,
    Key {
        key: String,
        #[serde(default)]
        code: Option<String>,
        #[serde(default)]
        shift_key: bool,
        #[serde(default)]
        alt_key: bool,
        #[serde(default)]
        ctrl_key: bool,
        #[serde(default)]
        meta_key: bool,
    },
    /// A mouse button event addressed to a cell. `button` is the semantic
    /// button (0=left, 1=middle, 2=right, 3=none/motion). Encoding is gated by
    /// the active mouse modes in `mod.rs` so it is a no-op for plain shells.
    Mouse {
        button: u8,
        col: u16,
        row: u16,
        action: MouseAction,
        #[serde(default)]
        shift_key: bool,
        #[serde(default)]
        alt_key: bool,
        #[serde(default)]
        ctrl_key: bool,
    },
    /// A scroll-wheel tick over a cell. `up` selects wheel-up vs wheel-down.
    Wheel {
        up: bool,
        col: u16,
        row: u16,
        #[serde(default)]
        shift_key: bool,
        #[serde(default)]
        alt_key: bool,
        #[serde(default)]
        ctrl_key: bool,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MouseAction {
    Press,
    Release,
    Move,
}

pub fn encode_terminal_input(
    kind: &str,
    command: &TerminalInputCommand,
    kitty_keyboard_active: bool,
    bracketed_paste_active: bool,
) -> Option<String> {
    match command {
        TerminalInputCommand::Text { text } => {
            if text.is_empty() {
                None
            } else {
                Some(text.clone())
            }
        }
        TerminalInputCommand::Paste { text } => {
            if bracketed_paste_active {
                Some(format!("\x1b[200~{text}\x1b[201~"))
            } else {
                Some(text.clone())
            }
        }
        TerminalInputCommand::LineBreak => {
            encode_line_break(kind, kitty_keyboard_active, bracketed_paste_active)
        }
        TerminalInputCommand::Key {
            key,
            shift_key,
            alt_key,
            ctrl_key,
            meta_key,
            ..
        } => encode_key(
            kind,
            key,
            *shift_key,
            *alt_key,
            *ctrl_key,
            *meta_key,
            kitty_keyboard_active,
            bracketed_paste_active,
        ),
        // Mouse/Wheel are routed through `encode_mouse_input`, which needs the
        // terminal's active mouse modes; keyboard-path callers ignore them.
        TerminalInputCommand::Mouse { .. } | TerminalInputCommand::Wheel { .. } => None,
    }
}

/// Active mouse-reporting modes pulled from the alacritty `TermMode`. The
/// frontend only forwards mouse events when one of these is set, but the
/// backend re-checks so a stale frame can never inject mouse bytes into a
/// plain shell.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MouseModes {
    pub click: bool,
    pub motion: bool,
    pub drag: bool,
    pub sgr: bool,
}

impl MouseModes {
    fn any(&self) -> bool {
        self.click || self.motion || self.drag
    }
}

/// Encode a `Mouse`/`Wheel` command into a terminal mouse report, honoring the
/// active modes. Returns `None` when the app has not requested mouse reporting,
/// or when a motion event arrives without a mode that wants motion. Returns raw
/// wire bytes: legacy X10 fields are single bytes that are not valid UTF-8
/// above 127, so this must not round-trip through `String`.
pub fn encode_mouse_input(command: &TerminalInputCommand, modes: MouseModes) -> Option<Vec<u8>> {
    if !modes.any() {
        return None;
    }
    match command {
        TerminalInputCommand::Mouse {
            button,
            col,
            row,
            action,
            shift_key,
            alt_key,
            ctrl_key,
        } => {
            let motion = *action == MouseAction::Move;
            if motion && !modes.motion && !modes.drag {
                return None;
            }
            let release = *action == MouseAction::Release;
            Some(encode_mouse_report(
                *button as u32,
                *col,
                *row,
                motion,
                release,
                *shift_key,
                *alt_key,
                *ctrl_key,
                modes.sgr,
            ))
        }
        TerminalInputCommand::Wheel {
            up,
            col,
            row,
            shift_key,
            alt_key,
            ctrl_key,
        } => {
            // Wheel buttons (64 up / 65 down) are reported as a press; there is
            // no matching release in either protocol.
            let button = if *up { 64 } else { 65 };
            Some(encode_mouse_report(
                button, *col, *row, false, false, *shift_key, *alt_key, *ctrl_key, modes.sgr,
            ))
        }
        _ => None,
    }
}

/// Build a single SGR (1006) or legacy X10 mouse report. Coordinates are
/// 0-based cells; both protocols are 1-based on the wire.
fn encode_mouse_report(
    base_button: u32,
    col: u16,
    row: u16,
    motion: bool,
    release: bool,
    shift: bool,
    alt: bool,
    ctrl: bool,
    sgr: bool,
) -> Vec<u8> {
    let mut cb = base_button;
    if motion {
        cb += 32;
    }
    if shift {
        cb += 4;
    }
    if alt {
        cb += 8;
    }
    if ctrl {
        cb += 16;
    }
    let x = col as u32 + 1;
    let y = row as u32 + 1;
    if sgr {
        let suffix = if release { 'm' } else { 'M' };
        format!("\x1b[<{cb};{x};{y}{suffix}").into_bytes()
    } else {
        // Legacy X10: ESC [ M Cb Cx Cy, every field a single raw byte offset
        // by 32 (NOT UTF-8 — values 128-255 must stay one byte on the wire).
        // Release is reported as button 3; coordinates clamp at 223 (255-32).
        let cb_x10 = if release { (cb & !0b11) | 0b11 } else { cb };
        let encode = |value: u32| -> u8 { (value + 32).min(255) as u8 };
        let mut out = b"\x1b[M".to_vec();
        out.push(encode(cb_x10));
        out.push(encode(x));
        out.push(encode(y));
        out
    }
}

fn encode_key(
    kind: &str,
    key: &str,
    shift: bool,
    alt: bool,
    ctrl: bool,
    meta: bool,
    kitty_keyboard_active: bool,
    bracketed_paste_active: bool,
) -> Option<String> {
    if key == "Enter" && shift && !alt && !ctrl && !meta {
        return encode_line_break(kind, kitty_keyboard_active, bracketed_paste_active);
    }

    let mut encoded = match key {
        "Enter" => "\r".to_string(),
        "Backspace" => "\x7f".to_string(),
        "Tab" if shift => "\x1b[Z".to_string(),
        "Tab" => "\t".to_string(),
        "Escape" => "\x1b".to_string(),
        "ArrowUp" => "\x1b[A".to_string(),
        "ArrowDown" => "\x1b[B".to_string(),
        "ArrowRight" => "\x1b[C".to_string(),
        "ArrowLeft" => "\x1b[D".to_string(),
        "Home" => "\x1b[H".to_string(),
        "End" => "\x1b[F".to_string(),
        "PageUp" => "\x1b[5~".to_string(),
        "PageDown" => "\x1b[6~".to_string(),
        "Delete" => "\x1b[3~".to_string(),
        value if ctrl && value.chars().count() == 1 => ctrl_encoded(value)?,
        value if !ctrl && !meta && value.chars().count() == 1 => value.to_string(),
        _ => return None,
    };

    if alt && !encoded.starts_with('\x1b') {
        encoded.insert(0, '\x1b');
    }
    Some(encoded)
}

fn encode_line_break(
    kind: &str,
    kitty_keyboard_active: bool,
    bracketed_paste_active: bool,
) -> Option<String> {
    // In Claude/Codex TUIs, bracketed-paste newline is the most stable way to
    // express "insert a line break" because it does not depend on the app's
    // enhanced-keyboard detection path. Shell sessions still use CSI-u once the
    // foreground program explicitly enables the kitty keyboard protocol.
    let ai_kind = kind == "claude" || kind == "codex";
    if ai_kind && bracketed_paste_active {
        return Some("\x1b[200~\n\x1b[201~".to_string());
    }
    if ai_kind || kitty_keyboard_active {
        return Some("\x1b[13;2u".to_string());
    }
    Some("\r".to_string())
}

fn ctrl_encoded(value: &str) -> Option<String> {
    let ch = value.chars().next()?.to_ascii_lowercase();
    if ('a'..='z').contains(&ch) {
        let byte = (ch as u8) - b'a' + 1;
        return Some((byte as char).to_string());
    }
    match ch {
        '[' => Some("\x1b".to_string()),
        '\\' => Some("\x1c".to_string()),
        ']' => Some("\x1d".to_string()),
        '^' => Some("\x1e".to_string()),
        '_' => Some("\x1f".to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(key: &str, shift: bool) -> TerminalInputCommand {
        TerminalInputCommand::Key {
            key: key.to_string(),
            code: None,
            shift_key: shift,
            alt_key: false,
            ctrl_key: false,
            meta_key: false,
        }
    }

    fn modified_key(key: &str, alt: bool, ctrl: bool) -> TerminalInputCommand {
        TerminalInputCommand::Key {
            key: key.to_string(),
            code: None,
            shift_key: false,
            alt_key: alt,
            ctrl_key: ctrl,
            meta_key: false,
        }
    }

    fn line_break() -> TerminalInputCommand {
        TerminalInputCommand::LineBreak
    }

    #[test]
    fn line_break_deserializes_from_ipc_shape() {
        let command: TerminalInputCommand =
            serde_json::from_str(r#"{"type":"lineBreak"}"#).unwrap();
        assert_eq!(command, TerminalInputCommand::LineBreak);
    }

    #[test]
    fn key_modifiers_deserialize_from_ipc_shape() {
        let command: TerminalInputCommand = serde_json::from_str(
            r#"{"type":"key","key":"Enter","code":"Enter","shiftKey":true,"altKey":true,"ctrlKey":true,"metaKey":true}"#,
        )
        .unwrap();
        assert_eq!(
            command,
            TerminalInputCommand::Key {
                key: "Enter".to_string(),
                code: Some("Enter".to_string()),
                shift_key: true,
                alt_key: true,
                ctrl_key: true,
                meta_key: true,
            }
        );
    }

    #[test]
    fn line_break_ai_uses_bracketed_paste_when_active() {
        assert_eq!(
            encode_terminal_input("claude", &line_break(), false, true),
            Some("\x1b[200~\n\x1b[201~".to_string())
        );
        assert_eq!(
            encode_terminal_input("codex", &line_break(), true, true),
            Some("\x1b[200~\n\x1b[201~".to_string())
        );
    }

    #[test]
    fn line_break_ai_falls_back_to_csi_u() {
        assert_eq!(
            encode_terminal_input("claude", &line_break(), false, false),
            Some("\x1b[13;2u".to_string())
        );
        assert_eq!(
            encode_terminal_input("codex", &line_break(), true, false),
            Some("\x1b[13;2u".to_string())
        );
    }

    #[test]
    fn line_break_shell_without_kitty_stays_enter() {
        assert_eq!(
            encode_terminal_input("shell", &line_break(), false, false),
            Some("\r".to_string())
        );
    }

    #[test]
    fn line_break_shell_with_kitty_uses_csi_u() {
        assert_eq!(
            encode_terminal_input("shell", &line_break(), true, false),
            Some("\x1b[13;2u".to_string())
        );
    }

    #[test]
    fn shift_enter_ai_uses_csi_u_without_observed_kitty_mode() {
        assert_eq!(
            encode_terminal_input("claude", &key("Enter", true), false, false),
            Some("\x1b[13;2u".to_string())
        );
        assert_eq!(
            encode_terminal_input("codex", &key("Enter", true), false, false),
            Some("\x1b[13;2u".to_string())
        );
    }

    #[test]
    fn shift_enter_ai_uses_bracketed_paste_newline_when_active() {
        assert_eq!(
            encode_terminal_input("claude", &key("Enter", true), false, true),
            Some("\x1b[200~\n\x1b[201~".to_string())
        );
        assert_eq!(
            encode_terminal_input("codex", &key("Enter", true), true, true),
            Some("\x1b[200~\n\x1b[201~".to_string())
        );
    }

    #[test]
    fn shift_enter_ai_uses_csi_u_when_kitty_active() {
        assert_eq!(
            encode_terminal_input("claude", &key("Enter", true), true, false),
            Some("\x1b[13;2u".to_string())
        );
    }

    #[test]
    fn shift_enter_shell_without_kitty_stays_enter() {
        assert_eq!(
            encode_terminal_input("shell", &key("Enter", true), false, false),
            Some("\r".to_string())
        );
    }

    #[test]
    fn shift_enter_shell_uses_csi_u_when_kitty_active() {
        // Running `claude`/`codex` directly from a shell session: they enable the
        // kitty keyboard protocol, so Shift+Enter must insert a newline.
        assert_eq!(
            encode_terminal_input("shell", &key("Enter", true), true, false),
            Some("\x1b[13;2u".to_string())
        );
        assert_eq!(
            encode_terminal_input("shell", &key("Enter", true), true, true),
            Some("\x1b[13;2u".to_string())
        );
    }

    #[test]
    fn paste_honors_bracketed_paste_mode() {
        assert_eq!(
            encode_terminal_input(
                "shell",
                &TerminalInputCommand::Paste {
                    text: "hello".to_string()
                },
                false,
                true
            ),
            Some("\x1b[200~hello\x1b[201~".to_string())
        );
    }

    #[test]
    fn text_preserves_composed_hangul() {
        assert_eq!(
            encode_terminal_input(
                "claude",
                &TerminalInputCommand::Text {
                    text: "한글 입력".to_string(),
                },
                false,
                false,
            ),
            Some("한글 입력".to_string())
        );
    }

    #[test]
    fn ctrl_letters_encode_control_bytes() {
        assert_eq!(
            encode_terminal_input("shell", &modified_key("j", false, true), false, false),
            Some("\n".to_string())
        );
    }

    fn mouse(button: u8, col: u16, row: u16, action: MouseAction) -> TerminalInputCommand {
        TerminalInputCommand::Mouse {
            button,
            col,
            row,
            action,
            shift_key: false,
            alt_key: false,
            ctrl_key: false,
        }
    }

    #[test]
    fn mouse_reports_require_an_active_mode() {
        let off = MouseModes::default();
        assert_eq!(
            encode_mouse_input(&mouse(0, 4, 9, MouseAction::Press), off),
            None
        );
    }

    #[test]
    fn mouse_press_release_use_sgr_when_active() {
        let modes = MouseModes {
            click: true,
            motion: false,
            drag: false,
            sgr: true,
        };
        // cols/rows are 0-based in, 1-based out.
        assert_eq!(
            encode_mouse_input(&mouse(0, 4, 9, MouseAction::Press), modes),
            Some(b"\x1b[<0;5;10M".to_vec())
        );
        assert_eq!(
            encode_mouse_input(&mouse(0, 4, 9, MouseAction::Release), modes),
            Some(b"\x1b[<0;5;10m".to_vec())
        );
    }

    #[test]
    fn mouse_motion_only_reports_when_motion_or_drag_mode() {
        let click_only = MouseModes {
            click: true,
            motion: false,
            drag: false,
            sgr: true,
        };
        assert_eq!(
            encode_mouse_input(&mouse(3, 1, 1, MouseAction::Move), click_only),
            None
        );
        let any_motion = MouseModes {
            click: true,
            motion: true,
            drag: false,
            sgr: true,
        };
        // motion adds 32 to the button code.
        assert_eq!(
            encode_mouse_input(&mouse(3, 1, 1, MouseAction::Move), any_motion),
            Some(b"\x1b[<35;2;2M".to_vec())
        );
    }

    #[test]
    fn wheel_reports_buttons_64_and_65() {
        let modes = MouseModes {
            click: true,
            motion: false,
            drag: false,
            sgr: true,
        };
        let up = TerminalInputCommand::Wheel {
            up: true,
            col: 0,
            row: 0,
            shift_key: false,
            alt_key: false,
            ctrl_key: false,
        };
        let down = TerminalInputCommand::Wheel {
            up: false,
            col: 0,
            row: 0,
            shift_key: false,
            alt_key: false,
            ctrl_key: false,
        };
        assert_eq!(
            encode_mouse_input(&up, modes),
            Some(b"\x1b[<64;1;1M".to_vec())
        );
        assert_eq!(
            encode_mouse_input(&down, modes),
            Some(b"\x1b[<65;1;1M".to_vec())
        );
    }

    #[test]
    fn mouse_legacy_x10_when_sgr_inactive() {
        let modes = MouseModes {
            click: true,
            motion: false,
            drag: false,
            sgr: false,
        };
        // left press at (0,0): ESC [ M space ! ! (32, 33, 33).
        assert_eq!(
            encode_mouse_input(&mouse(0, 0, 0, MouseAction::Press), modes),
            Some(b"\x1b[M\x20\x21\x21".to_vec())
        );
    }

    #[test]
    fn mouse_legacy_x10_high_coordinates_stay_single_byte() {
        let modes = MouseModes {
            click: true,
            motion: false,
            drag: false,
            sgr: false,
        };
        // col 150 (0-based) -> 151 + 32 = 183: must be ONE raw byte, not the
        // two-byte UTF-8 encoding of U+00B7.
        assert_eq!(
            encode_mouse_input(&mouse(0, 150, 9, MouseAction::Press), modes),
            Some(vec![0x1b, b'[', b'M', 32, 183, 42])
        );
        // Coordinates clamp at 255 (223 + offset 32) instead of wrapping.
        assert_eq!(
            encode_mouse_input(&mouse(0, 400, 400, MouseAction::Press), modes),
            Some(vec![0x1b, b'[', b'M', 32, 255, 255])
        );
    }

    #[test]
    fn alt_printable_keys_are_esc_prefixed() {
        assert_eq!(
            encode_terminal_input("shell", &modified_key("f", true, false), false, false),
            Some("\x1bf".to_string())
        );
        assert_eq!(
            encode_terminal_input("shell", &modified_key("b", true, false), false, false),
            Some("\x1bb".to_string())
        );
    }
}
