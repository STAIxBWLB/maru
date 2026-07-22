use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::{Config, Term, TermDamage, TermMode};
use alacritty_terminal::vte::ansi::{self, ClearMode, Handler};
use std::io::Write;
use std::sync::{Arc, Mutex};
use unicode_width::UnicodeWidthStr;

use super::input::MouseModes;
use super::snapshot::{snapshot_term, terminal_indexed_lines, terminal_text, TerminalFrame};

#[derive(Clone)]
pub struct TerminalEventProxy {
    writer: SharedTerminalWriter,
    title: Arc<Mutex<Option<String>>>,
    window_size: Arc<Mutex<WindowSize>>,
}

impl TerminalEventProxy {
    pub fn new(
        writer: SharedTerminalWriter,
        title: Arc<Mutex<Option<String>>>,
        window_size: Arc<Mutex<WindowSize>>,
    ) -> Self {
        Self {
            writer,
            title,
            window_size,
        }
    }
}

impl EventListener for TerminalEventProxy {
    fn send_event(&self, event: Event) {
        match event {
            Event::PtyWrite(text) => {
                let _ = write_shared(&self.writer, text.as_bytes());
            }
            Event::Title(title) => {
                if let Ok(mut guard) = self.title.lock() {
                    *guard = Some(title);
                }
            }
            Event::ResetTitle => {
                if let Ok(mut guard) = self.title.lock() {
                    *guard = None;
                }
            }
            Event::TextAreaSizeRequest(formatter) => {
                let size = self
                    .window_size
                    .lock()
                    .map(|guard| *guard)
                    .unwrap_or(WindowSize {
                        num_lines: 30,
                        num_cols: 120,
                        cell_width: 0,
                        cell_height: 0,
                    });
                let text = formatter(size);
                let _ = write_shared(&self.writer, text.as_bytes());
            }
            _ => {}
        }
    }
}

pub type SharedTerminalWriter = Arc<Mutex<Box<dyn Write + Send>>>;

#[cfg(test)]
#[derive(Clone)]
pub struct NullTerminalWriter;

#[cfg(test)]
impl Write for NullTerminalWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct TerminalSize {
    cols: usize,
    rows: usize,
}

impl Dimensions for TerminalSize {
    fn total_lines(&self) -> usize {
        self.rows
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn columns(&self) -> usize {
        self.cols
    }
}

pub struct TerminalModel {
    term: Term<TerminalEventProxy>,
    parser: ansi::Processor,
    title: Arc<Mutex<Option<String>>>,
    window_size: Arc<Mutex<WindowSize>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchDirection {
    Next,
    Previous,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalSearchHit {
    pub row: usize,
    pub col: usize,
    pub length: usize,
    pub display_offset: usize,
}

impl TerminalModel {
    #[cfg(test)]
    pub fn new<W>(cols: u16, rows: u16, writer: W) -> Self
    where
        W: Write + Send + 'static,
    {
        Self::with_shared_writer_size(Arc::new(Mutex::new(Box::new(writer))), cols, rows)
    }

    pub fn with_shared_writer_size(writer: SharedTerminalWriter, cols: u16, rows: u16) -> Self {
        let title = Arc::new(Mutex::new(None));
        let cols = cols.max(2);
        let rows = rows.max(1);
        let window_size = Arc::new(Mutex::new(WindowSize {
            num_lines: rows,
            num_cols: cols,
            cell_width: 0,
            cell_height: 0,
        }));
        let proxy = TerminalEventProxy::new(writer, title.clone(), window_size.clone());
        let size = TerminalSize {
            cols: cols as usize,
            rows: rows as usize,
        };
        let mut config = Config::default();
        config.kitty_keyboard = true;
        config.scrolling_history = 5000;
        let term = Term::new(config, &size, proxy);
        Self {
            term,
            parser: ansi::Processor::default(),
            title,
            window_size,
        }
    }

    pub fn advance(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let cols = cols.max(2) as usize;
        let rows = rows.max(1) as usize;
        self.term.resize(TerminalSize { cols, rows });
        if let Ok(mut guard) = self.window_size.lock() {
            guard.num_cols = cols as u16;
            guard.num_lines = rows as u16;
        }
    }

    pub fn snapshot(&self, session_id: &str) -> TerminalFrame {
        let title = self.title.lock().ok().and_then(|guard| guard.clone());
        snapshot_term(session_id, &self.term, title, None)
    }

    pub fn snapshot_dirty(&self, session_id: &str, dirty: &[usize]) -> TerminalFrame {
        let title = self.title.lock().ok().and_then(|guard| guard.clone());
        snapshot_term(session_id, &self.term, title, Some(dirty))
    }

    /// Drain alacritty's accumulated damage into a list of changed screen rows,
    /// resetting the damage state. Returns `None` to request a full repaint —
    /// either the whole screen is damaged, or the user is viewing scrollback
    /// (`display_offset != 0`), where partial damage line numbers are relative
    /// to the live screen rather than the displayed view.
    pub fn take_damage(&mut self) -> Option<Vec<usize>> {
        if self.term.grid().display_offset() != 0 {
            self.term.reset_damage();
            return None;
        }
        let rows = match self.term.damage() {
            TermDamage::Full => None,
            TermDamage::Partial(iter) => {
                let mut rows: Vec<usize> = iter.map(|bounds| bounds.line).collect();
                rows.sort_unstable();
                rows.dedup();
                Some(rows)
            }
        };
        self.term.reset_damage();
        rows
    }

    pub fn reset_damage(&mut self) {
        self.term.reset_damage();
    }

    pub fn scroll(&mut self, delta: i32) {
        self.term.scroll_display(Scroll::Delta(delta));
    }

    pub fn scroll_bottom(&mut self) {
        if self.term.grid().display_offset() != 0 {
            self.term.scroll_display(Scroll::Bottom);
        }
    }

    pub fn display_offset(&self) -> usize {
        self.term.grid().display_offset()
    }

    fn visible_point(&self, row: u16, col: u16) -> Point {
        let grid = self.term.grid();
        let row = usize::from(row).min(grid.screen_lines().saturating_sub(1));
        let col = usize::from(col).min(grid.columns().saturating_sub(1));
        Point::new(Line(row as i32 - grid.display_offset() as i32), Column(col))
    }

    pub fn selection_start(&mut self, row: u16, col: u16, side: Side, kind: SelectionType) {
        self.term.selection = Some(Selection::new(kind, self.visible_point(row, col), side));
    }

    pub fn selection_update(&mut self, row: u16, col: u16, side: Side) {
        let point = self.visible_point(row, col);
        if let Some(selection) = self.term.selection.as_mut() {
            selection.update(point, side);
        }
    }

    pub fn selection_clear(&mut self) {
        self.term.selection = None;
    }

    pub fn selection_finish(&mut self) {
        if let Some(selection) = self.term.selection.as_mut() {
            selection.include_all();
        }
    }

    pub fn selection_select_all(&mut self) {
        let grid = self.term.grid();
        let start = Point::new(Line(-(grid.history_size() as i32)), Column(0));
        let end = Point::new(
            Line(grid.screen_lines().saturating_sub(1) as i32),
            Column(grid.columns().saturating_sub(1)),
        );
        let mut selection = Selection::new(SelectionType::Simple, start, Side::Left);
        selection.update(end, Side::Right);
        self.term.selection = Some(selection);
    }

    pub fn selection_text(&self) -> String {
        self.term.selection_to_string().unwrap_or_default()
    }

    /// Clear the visible screen and scrollback history (Cmd+K, iTerm2-style).
    /// Returns false without touching state while the alternate screen is
    /// active (vim, TUIs) — alt screens have no scrollback and would stay
    /// blank until the app's next full repaint.
    pub fn clear(&mut self) -> bool {
        if self.term.mode().contains(TermMode::ALT_SCREEN) {
            return false;
        }
        self.term.scroll_display(Scroll::Bottom);
        self.term.clear_screen(ClearMode::All);
        self.term.clear_screen(ClearMode::Saved);
        true
    }

    pub fn text(&self) -> String {
        terminal_text(&self.term)
    }

    pub fn search(
        &mut self,
        query: &str,
        direction: SearchDirection,
        case_sensitive: bool,
    ) -> Option<TerminalSearchHit> {
        if query.is_empty() {
            return None;
        }
        let lines = terminal_indexed_lines(&self.term);
        let iter: Box<dyn Iterator<Item = &(i32, String)> + '_> = match direction {
            SearchDirection::Next => Box::new(lines.iter()),
            SearchDirection::Previous => Box::new(lines.iter().rev()),
        };
        let (line_index, col) = iter
            .filter_map(|(line_index, text)| {
                search_column(text, query, case_sensitive).map(|col| (*line_index, col))
            })
            .next()?;
        let current_offset = self.term.grid().display_offset() as i32;
        let target_offset = if line_index < 0 { -line_index } else { 0 };
        self.term
            .scroll_display(Scroll::Delta(target_offset - current_offset));
        let display_offset = self.term.grid().display_offset();
        let rows = self.term.grid().screen_lines();
        let row =
            (line_index + display_offset as i32).clamp(0, rows.saturating_sub(1) as i32) as usize;
        Some(TerminalSearchHit {
            row,
            col,
            length: UnicodeWidthStr::width(query),
            display_offset,
        })
    }

    pub fn kitty_keyboard_active(&self) -> bool {
        self.term
            .mode()
            .intersects(TermMode::KITTY_KEYBOARD_PROTOCOL)
    }

    pub fn bracketed_paste_active(&self) -> bool {
        self.term.mode().contains(TermMode::BRACKETED_PASTE)
    }

    pub fn mouse_modes(&self) -> MouseModes {
        let mode = self.term.mode();
        MouseModes {
            click: mode.contains(TermMode::MOUSE_REPORT_CLICK),
            motion: mode.contains(TermMode::MOUSE_MOTION),
            drag: mode.contains(TermMode::MOUSE_DRAG),
            sgr: mode.contains(TermMode::SGR_MOUSE),
        }
    }
}

pub fn write_shared(writer: &SharedTerminalWriter, bytes: &[u8]) -> Result<(), String> {
    let mut guard = writer
        .lock()
        .map_err(|_| "terminal_writer_poisoned".to_string())?;
    guard
        .write_all(bytes)
        .and_then(|_| guard.flush())
        .map_err(|err| format!("terminal_write_failed: {err}"))
}

fn search_column(text: &str, query: &str, case_sensitive: bool) -> Option<usize> {
    if case_sensitive {
        return text
            .find(query)
            .map(|byte_col| UnicodeWidthStr::width(&text[..byte_col]));
    }
    let needle = query.to_lowercase();
    text.char_indices()
        .find(|(byte_col, _)| text[*byte_col..].to_lowercase().starts_with(&needle))
        .map(|(byte_col, _)| UnicodeWidthStr::width(&text[..byte_col]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct CaptureWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
    }

    impl CaptureWriter {
        fn new() -> Self {
            Self {
                bytes: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn output(&self) -> String {
            let bytes = self.bytes.lock().unwrap().clone();
            String::from_utf8(bytes).unwrap()
        }
    }

    impl Write for CaptureWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.bytes.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn model_parses_plain_text_and_ansi_color() {
        let mut model = TerminalModel::new(8, 2, NullTerminalWriter);
        model.resize(8, 2);
        model.advance(b"\x1b[31mred");
        let frame = model.snapshot("term-1");
        assert_eq!(frame.lines[0][0].ch, "r");
        assert!(frame.lines[0][0].fg != frame.lines[0][0].bg);
    }

    #[test]
    fn model_tracks_resize() {
        let mut model = TerminalModel::new(120, 30, NullTerminalWriter);
        model.resize(20, 5);
        let frame = model.snapshot("term-1");
        assert_eq!(frame.cols, 20);
        assert_eq!(frame.rows, 5);
        assert_eq!(frame.lines.len(), 5);
        assert_eq!(frame.lines[0].len(), 20);
    }

    #[test]
    fn take_damage_reports_full_then_partial_rows() {
        let mut model = TerminalModel::new(10, 4, NullTerminalWriter);
        model.advance(b"prep");
        // A fresh terminal starts fully damaged: the first drain requests a full
        // repaint (None) and resets the damage state — this is what the pump
        // wants for the initial frame.
        assert_eq!(model.take_damage(), None);
        // Subsequent writes report only the rows that changed.
        model.advance(b"\r\n\r\nthird");
        let dirty = model.take_damage().expect("partial damage");
        assert!(dirty.contains(&2), "row 2 should be damaged, got {dirty:?}");
    }

    #[test]
    fn model_tracks_kitty_keyboard_mode() {
        let mut model = TerminalModel::new(20, 5, NullTerminalWriter);
        model.advance(b"\x1b[>1u");
        assert!(model.kitty_keyboard_active());
        model.advance(b"\x1b[<1u");
        assert!(!model.kitty_keyboard_active());
    }

    #[test]
    fn model_reports_kitty_keyboard_mode_queries() {
        let writer = CaptureWriter::new();
        let mut model = TerminalModel::new(20, 5, writer.clone());

        model.advance(b"\x1b[?u");
        assert!(writer.output().contains("\x1b[?0u"));

        model.advance(b"\x1b[>7u");
        model.advance(b"\x1b[?u");
        assert!(writer.output().contains("\x1b[?7u"));
    }

    #[test]
    fn model_tracks_bracketed_paste_mode() {
        let mut model = TerminalModel::new(20, 5, NullTerminalWriter);
        model.advance(b"\x1b[?2004h");
        assert!(model.bracketed_paste_active());
        model.advance(b"\x1b[?2004l");
        assert!(!model.bracketed_paste_active());
    }

    #[test]
    fn model_extracts_scrollback_text_for_copy_all() {
        let mut model = TerminalModel::new(20, 2, NullTerminalWriter);
        model.advance(b"alpha\r\nbeta\r\ngamma");

        assert_eq!(model.text(), "alpha\nbeta\ngamma");
    }

    #[test]
    fn clear_wipes_screen_and_scrollback() {
        let mut model = TerminalModel::new(20, 2, NullTerminalWriter);
        model.advance(b"alpha\r\nbeta\r\ngamma");
        // View scrollback first: clear must snap back to the live view.
        model.scroll(1);

        assert!(model.clear());
        assert_eq!(model.text(), "");
        let frame = model.snapshot("term-1");
        assert_eq!(frame.display_offset, 0);
        assert_eq!(frame.scrollback_len, 0);
    }

    #[test]
    fn clear_is_noop_on_alt_screen() {
        let mut model = TerminalModel::new(20, 4, NullTerminalWriter);
        model.advance(b"\x1b[?1049htui");

        assert!(!model.clear());
        assert!(model.text().contains("tui"));
    }

    #[test]
    fn model_search_scrolls_to_scrollback_match() {
        let mut model = TerminalModel::new(20, 2, NullTerminalWriter);
        model.advance(b"alpha needle\r\nbeta\r\ngamma");

        let hit = model
            .search("needle", SearchDirection::Next, false)
            .expect("expected search hit");

        assert!(hit.display_offset > 0);
        assert_eq!(hit.col, 6);
        let frame = model.snapshot("term-1");
        assert_eq!(frame.display_offset, hit.display_offset);
        assert_eq!(frame.lines[hit.row][0].ch, "a");
    }

    #[test]
    fn model_search_handles_case_folded_utf8_offsets() {
        let mut model = TerminalModel::new(20, 2, NullTerminalWriter);
        model.advance("İNEEDLE\r\nbeta".as_bytes());

        let hit = model
            .search("needle", SearchDirection::Next, false)
            .expect("expected search hit");

        assert_eq!(hit.col, 1);
    }

    #[test]
    fn backend_selection_joins_soft_wrapped_lines() {
        let mut model = TerminalModel::new(5, 3, NullTerminalWriter);
        model.advance(b"abcdefgh");
        model.selection_start(0, 0, Side::Left, SelectionType::Simple);
        model.selection_update(1, 2, Side::Right);
        model.selection_finish();

        assert_eq!(model.selection_text(), "abcdefgh");
    }

    #[test]
    fn backend_selection_includes_wide_character_from_spacer_cell() {
        let mut model = TerminalModel::new(10, 2, NullTerminalWriter);
        model.advance("界x".as_bytes());
        model.selection_start(0, 1, Side::Left, SelectionType::Simple);
        model.selection_update(0, 1, Side::Right);
        model.selection_finish();

        assert_eq!(model.selection_text(), "界");
    }
}
