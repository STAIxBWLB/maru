use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use serde::Serialize;
use std::collections::HashMap;

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

#[derive(Clone, Debug, Serialize, PartialEq, Eq, Hash)]
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
pub struct TerminalSelectionSpan {
    pub row: usize,
    pub start: usize,
    pub end: usize,
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
    pub selection_spans: Vec<TerminalSelectionSpan>,
    pub wrapped_rows: Vec<bool>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCellStyle {
    pub fg: TerminalColor,
    pub bg: TerminalColor,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct TerminalWireCell(pub String, pub u8, pub u32);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWireFrame {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
    pub cursor: TerminalCursor,
    pub palette: Vec<TerminalCellStyle>,
    pub lines: Vec<Vec<TerminalWireCell>>,
    pub scrollback_len: usize,
    pub title: Option<String>,
    pub dirty_rows: Option<Vec<usize>>,
    pub display_offset: usize,
    pub mouse: TerminalMouseFlags,
    pub alt_screen: bool,
    pub selection_spans: Vec<TerminalSelectionSpan>,
    pub wrapped_rows: Vec<bool>,
}

impl From<TerminalFrame> for TerminalWireFrame {
    fn from(frame: TerminalFrame) -> Self {
        let mut palette: Vec<TerminalCellStyle> = Vec::new();
        let mut palette_indexes: HashMap<TerminalCellStyle, u32> = HashMap::new();
        let lines = frame
            .lines
            .into_iter()
            .map(|line| {
                line.into_iter()
                    .map(|cell| {
                        let style = TerminalCellStyle {
                            fg: cell.fg,
                            bg: cell.bg,
                            bold: cell.bold,
                            italic: cell.italic,
                            underline: cell.underline,
                            inverse: cell.inverse,
                        };
                        let style_index = match palette_indexes.get(&style) {
                            Some(index) => *index,
                            None => {
                                let index = palette.len() as u32;
                                palette.push(style.clone());
                                palette_indexes.insert(style, index);
                                index
                            }
                        };
                        TerminalWireCell(cell.ch, cell.width, style_index)
                    })
                    .collect()
            })
            .collect();
        Self {
            session_id: frame.session_id,
            cols: frame.cols,
            rows: frame.rows,
            cursor: frame.cursor,
            palette,
            lines,
            scrollback_len: frame.scrollback_len,
            title: frame.title,
            dirty_rows: frame.dirty_rows,
            display_offset: frame.display_offset,
            mouse: frame.mouse,
            alt_screen: frame.alt_screen,
            selection_spans: frame.selection_spans,
            wrapped_rows: frame.wrapped_rows,
        }
    }
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
    let is_wrapped = |visible_row: usize| -> bool {
        let line = &grid[Line(visible_row as i32 - display_offset as i32)];
        cols > 0 && line[Column(cols - 1)].flags.contains(Flags::WRAPLINE)
    };

    let (lines, dirty_rows, wrapped_rows) = match dirty {
        Some(indices) => {
            let lines = indices
                .iter()
                .filter(|&&row| row < rows)
                .map(|&row| read_row(row))
                .collect();
            let kept = indices.iter().copied().filter(|&row| row < rows).collect();
            let wrapped = indices
                .iter()
                .copied()
                .filter(|&row| row < rows)
                .map(is_wrapped)
                .collect();
            (lines, Some(kept), wrapped)
        }
        None => {
            let mut lines = Vec::with_capacity(rows);
            for row in 0..rows {
                lines.push(read_row(row));
            }
            let wrapped = (0..rows).map(is_wrapped).collect();
            (lines, None, wrapped)
        }
    };

    let selection_range = term
        .selection
        .as_ref()
        .and_then(|selection| selection.to_range(term));
    let mut selection_spans = Vec::new();
    if let Some(range) = selection_range {
        for row in 0..rows {
            let line = Line(row as i32 - display_offset as i32);
            let mut start = None;
            let mut end = None;
            for col in 0..cols {
                if range.contains(alacritty_terminal::index::Point::new(line, Column(col))) {
                    start.get_or_insert(col);
                    end = Some(col);
                }
            }
            if let (Some(start), Some(end)) = (start, end) {
                selection_spans.push(TerminalSelectionSpan { row, start, end });
            }
        }
    }

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
        selection_spans,
        wrapped_rows,
    }
}

pub fn terminal_indexed_lines(term: &Term<TerminalEventProxy>) -> Vec<(i32, String)> {
    let grid = term.grid();
    let history = grid.history_size() as i32;
    let rows = grid.screen_lines() as i32;
    let mut lines = Vec::with_capacity((history + rows).max(0) as usize);
    for line_index in -history..rows {
        lines.push((line_index, terminal_line_text(term, line_index)));
    }
    lines
}

pub fn terminal_text(term: &Term<TerminalEventProxy>) -> String {
    let lines: Vec<String> = terminal_indexed_lines(term)
        .into_iter()
        .map(|(_, text)| text)
        .collect();
    let start = lines
        .iter()
        .position(|line| !line.is_empty())
        .unwrap_or(lines.len());
    let end = lines
        .iter()
        .rposition(|line| !line.is_empty())
        .map(|index| index + 1)
        .unwrap_or(start);
    lines[start..end].join("\n")
}

fn terminal_line_text(term: &Term<TerminalEventProxy>, line_index: i32) -> String {
    let grid = term.grid();
    let cols = grid.columns();
    let line = &grid[Line(line_index)];
    let mut text = String::with_capacity(cols);
    for col in 0..cols {
        let cell = &line[Column(col)];
        if cell
            .flags
            .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
        {
            continue;
        }
        if cell.flags.contains(Flags::HIDDEN) {
            text.push(' ');
            continue;
        }
        text.push(cell.c);
        if let Some(chars) = cell.zerowidth() {
            for c in chars {
                text.push(*c);
            }
        }
    }
    text.trim_end().to_string()
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
    use super::TerminalWireFrame;
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
    fn palette_wire_frame_meets_terminal_payload_budget() {
        let mut model = TerminalModel::new(120, 30, super::super::model::NullTerminalWriter);
        model.advance(b"colored \x1b[31mterminal\x1b[0m output");

        let full = TerminalWireFrame::from(model.snapshot("term-1"));
        let full_size = serde_json::to_vec(&full).unwrap().len();
        assert!(full_size <= 100 * 1024, "full frame was {full_size} bytes");

        let patch = TerminalWireFrame::from(model.snapshot_dirty("term-1", &[0]));
        let patch_size = serde_json::to_vec(&patch).unwrap().len();
        assert!(patch_size <= 4 * 1024, "row patch was {patch_size} bytes");
    }

    #[test]
    fn snapshot_carries_wrap_metadata() {
        let mut model = TerminalModel::new(5, 3, super::super::model::NullTerminalWriter);
        model.advance(b"abcdefgh");
        let frame = model.snapshot("term-1");
        assert_eq!(frame.wrapped_rows, vec![true, false, false]);
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
