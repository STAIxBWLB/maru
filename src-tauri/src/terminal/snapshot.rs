use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use serde::Serialize;

use super::model::TerminalEventProxy;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCursor {
    pub row: usize,
    pub col: usize,
    pub visible: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCell {
    pub ch: String,
    pub width: u8,
    pub fg: TerminalColor,
    pub bg: TerminalColor,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TerminalColor {
    Named { name: String },
    Indexed { index: u8 },
    Rgb { r: u8, g: u8, b: u8 },
}

/// Mouse-reporting modes the running program has requested. Rides every frame
/// so the frontend knows whether to forward mouse events without a separate
/// query (which would race the snapshot).
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMouseFlags {
    pub click: bool,
    pub motion: bool,
    pub drag: bool,
    pub sgr: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalFrame {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
    pub cursor: TerminalCursor,
    /// When `dirty_rows` is `None`, holds every visible row (a full repaint).
    /// When `dirty_rows` is `Some(idx)`, holds only those rows, aligned 1:1 to
    /// `idx` order, and the frontend patches them into its retained grid.
    pub lines: Vec<Vec<TerminalCell>>,
    pub scrollback_len: usize,
    pub title: Option<String>,
    pub dirty_rows: Option<Vec<usize>>,
    pub display_offset: usize,
    pub mouse: TerminalMouseFlags,
    pub alt_screen: bool,
}

/// Snapshot the terminal. `dirty` selects which rows to serialize: `None`
/// produces a full-grid frame (honoring scrollback `display_offset`), while
/// `Some(rows)` produces a partial patch. Partial snapshots are only requested
/// when `display_offset == 0` (see `TerminalModel::take_damage`), so this path
/// reads the live screen directly.
pub fn snapshot_term(
    session_id: &str,
    term: &Term<TerminalEventProxy>,
    title: Option<String>,
    dirty: Option<&[usize]>,
) -> TerminalFrame {
    let grid = term.grid();
    let cols = grid.columns();
    let rows = grid.screen_lines();
    let display_offset = grid.display_offset();
    let mode = term.mode();

    let read_row = |visible_row: usize| -> Vec<TerminalCell> {
        let line = &grid[Line(visible_row as i32 - display_offset as i32)];
        let mut cells = Vec::with_capacity(cols);
        for col in 0..cols {
            cells.push(snapshot_cell(&line[Column(col)]));
        }
        cells
    };

    let (lines, dirty_rows) = match dirty {
        Some(indices) => {
            let lines = indices
                .iter()
                .filter(|&&row| row < rows)
                .map(|&row| read_row(row))
                .collect();
            let kept = indices.iter().copied().filter(|&row| row < rows).collect();
            (lines, Some(kept))
        }
        None => {
            let mut lines = Vec::with_capacity(rows);
            for row in 0..rows {
                lines.push(read_row(row));
            }
            (lines, None)
        }
    };

    let point = grid.cursor.point;
    let cursor_visible = display_offset == 0 && mode.contains(TermMode::SHOW_CURSOR);
    TerminalFrame {
        session_id: session_id.to_string(),
        cols: cols as u16,
        rows: rows as u16,
        cursor: TerminalCursor {
            row: point.line.0.max(0) as usize,
            col: point.column.0,
            visible: cursor_visible,
        },
        lines,
        scrollback_len: grid.history_size(),
        title,
        dirty_rows,
        display_offset,
        mouse: TerminalMouseFlags {
            click: mode.contains(TermMode::MOUSE_REPORT_CLICK),
            motion: mode.contains(TermMode::MOUSE_MOTION),
            drag: mode.contains(TermMode::MOUSE_DRAG),
            sgr: mode.contains(TermMode::SGR_MOUSE),
        },
        alt_screen: mode.contains(TermMode::ALT_SCREEN),
    }
}

fn snapshot_cell(cell: &Cell) -> TerminalCell {
    let mut ch = String::new();
    let spacer = cell
        .flags
        .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER);
    if !spacer && !cell.flags.contains(Flags::HIDDEN) {
        ch.push(cell.c);
        if let Some(chars) = cell.zerowidth() {
            for c in chars {
                ch.push(*c);
            }
        }
    }

    TerminalCell {
        ch,
        width: if spacer {
            0
        } else if cell.flags.contains(Flags::WIDE_CHAR) {
            2
        } else {
            1
        },
        fg: color_to_snapshot(cell.fg),
        bg: color_to_snapshot(cell.bg),
        bold: cell.flags.contains(Flags::BOLD),
        italic: cell.flags.contains(Flags::ITALIC),
        underline: cell.flags.intersects(Flags::ALL_UNDERLINES),
        inverse: cell.flags.contains(Flags::INVERSE),
    }
}

fn color_to_snapshot(color: Color) -> TerminalColor {
    match color {
        Color::Named(name) => TerminalColor::Named {
            name: named_color_key(name).to_string(),
        },
        Color::Indexed(index) => TerminalColor::Indexed { index },
        Color::Spec(rgb) => TerminalColor::Rgb {
            r: rgb.r,
            g: rgb.g,
            b: rgb.b,
        },
    }
}

/// Map alacritty's `NamedColor` to a stable key the frontend palette knows.
/// Explicit (rather than `format!("{:?}")`) so a debug-format change in a
/// future alacritty release cannot silently desync the two color tables.
/// Dim variants collapse to their base hue; foreground-ish/cursor colors map
/// to the theme foreground.
fn named_color_key(name: NamedColor) -> &'static str {
    match name {
        NamedColor::Black => "Black",
        NamedColor::Red => "Red",
        NamedColor::Green => "Green",
        NamedColor::Yellow => "Yellow",
        NamedColor::Blue => "Blue",
        NamedColor::Magenta => "Magenta",
        NamedColor::Cyan => "Cyan",
        NamedColor::White => "White",
        NamedColor::BrightBlack => "BrightBlack",
        NamedColor::BrightRed => "BrightRed",
        NamedColor::BrightGreen => "BrightGreen",
        NamedColor::BrightYellow => "BrightYellow",
        NamedColor::BrightBlue => "BrightBlue",
        NamedColor::BrightMagenta => "BrightMagenta",
        NamedColor::BrightCyan => "BrightCyan",
        NamedColor::BrightWhite => "BrightWhite",
        NamedColor::DimBlack => "Black",
        NamedColor::DimRed => "Red",
        NamedColor::DimGreen => "Green",
        NamedColor::DimYellow => "Yellow",
        NamedColor::DimBlue => "Blue",
        NamedColor::DimMagenta => "Magenta",
        NamedColor::DimCyan => "Cyan",
        NamedColor::DimWhite => "White",
        NamedColor::Background => "Background",
        NamedColor::Foreground
        | NamedColor::Cursor
        | NamedColor::BrightForeground
        | NamedColor::DimForeground => "Foreground",
    }
}

#[cfg(test)]
mod tests {
    use crate::terminal::model::TerminalModel;

    #[test]
    fn frame_serializes_camelcase_shape() {
        let mut model = TerminalModel::new(10, 3, super::super::model::NullTerminalWriter);
        model.advance(b"hi");
        let frame = model.snapshot("term-1");
        let json = serde_json::to_value(&frame).unwrap();
        assert_eq!(json["sessionId"], "term-1");
        assert_eq!(json["cols"], 10);
        assert_eq!(json["rows"], 3);
        assert_eq!(json["lines"][0][0]["ch"], "h");
        assert_eq!(json["lines"][0][1]["ch"], "i");
        assert_eq!(json["dirtyRows"], serde_json::Value::Null);
        assert_eq!(json["displayOffset"], 0);
        assert_eq!(json["mouse"]["click"], false);
        assert_eq!(json["altScreen"], false);
    }

    #[test]
    fn dirty_snapshot_serializes_only_requested_rows() {
        let mut model = TerminalModel::new(10, 4, super::super::model::NullTerminalWriter);
        model.advance(b"row0\r\nrow1");
        let frame = model.snapshot_dirty("term-1", &[1]);
        assert_eq!(frame.dirty_rows.as_deref(), Some(&[1usize][..]));
        assert_eq!(frame.lines.len(), 1);
        assert_eq!(frame.lines[0][0].ch, "r");
        assert_eq!(frame.lines[0][3].ch, "1");
    }

    #[test]
    fn named_colors_map_to_stable_keys() {
        use super::named_color_key;
        use alacritty_terminal::vte::ansi::NamedColor;
        assert_eq!(named_color_key(NamedColor::Red), "Red");
        assert_eq!(named_color_key(NamedColor::BrightCyan), "BrightCyan");
        assert_eq!(named_color_key(NamedColor::DimRed), "Red");
        assert_eq!(named_color_key(NamedColor::Foreground), "Foreground");
        assert_eq!(named_color_key(NamedColor::Cursor), "Foreground");
        assert_eq!(named_color_key(NamedColor::Background), "Background");
    }
}
