use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TerminalInputCommand {
    Text {
        text: String,
    },
    Paste {
        text: String,
    },
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
        ),
    }
}

fn encode_key(
    kind: &str,
    key: &str,
    shift: bool,
    alt: bool,
    ctrl: bool,
    meta: bool,
    _kitty_keyboard_active: bool,
) -> Option<String> {
    if key == "Enter" && shift && !alt && !ctrl && !meta && (kind == "claude" || kind == "codex") {
        return Some("\x1b[13;2u".to_string());
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
    fn shift_enter_ai_uses_csi_u_when_kitty_active() {
        assert_eq!(
            encode_terminal_input("claude", &key("Enter", true), true, false),
            Some("\x1b[13;2u".to_string())
        );
    }

    #[test]
    fn shift_enter_shell_stays_enter() {
        assert_eq!(
            encode_terminal_input("shell", &key("Enter", true), true, false),
            Some("\r".to_string())
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
