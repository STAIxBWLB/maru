use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::Line;
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::Term;
use alacritty_terminal::vte::ansi::Color;
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

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalFrame {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
    pub cursor: TerminalCursor,
    pub lines: Vec<Vec<TerminalCell>>,
    pub scrollback_len: usize,
    pub title: Option<String>,
    pub dirty_rows: Option<Vec<usize>>,
}

pub fn snapshot_term(
    session_id: &str,
    term: &Term<TerminalEventProxy>,
    title: Option<String>,
) -> TerminalFrame {
    let grid = term.grid();
    let cols = grid.columns();
    let rows = grid.screen_lines();
    let mut lines = Vec::with_capacity(rows);

    for row in 0..rows {
        let line = &grid[Line(row as i32)];
        let mut cells = Vec::with_capacity(cols);
        for col in 0..cols {
            cells.push(snapshot_cell(&line[alacritty_terminal::index::Column(col)]));
        }
        lines.push(cells);
    }

    let point = grid.cursor.point;
    TerminalFrame {
        session_id: session_id.to_string(),
        cols: cols as u16,
        rows: rows as u16,
        cursor: TerminalCursor {
            row: point.line.0.max(0) as usize,
            col: point.column.0,
            visible: term
                .mode()
                .contains(alacritty_terminal::term::TermMode::SHOW_CURSOR),
        },
        lines,
        scrollback_len: grid.history_size(),
        title,
        dirty_rows: Some((0..rows).collect()),
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
            name: format!("{name:?}"),
        },
        Color::Indexed(index) => TerminalColor::Indexed { index },
        Color::Spec(rgb) => TerminalColor::Rgb {
            r: rgb.r,
            g: rgb.g,
            b: rgb.b,
        },
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
    }
}
