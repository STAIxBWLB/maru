//! Deterministic line wrapping for mixed Korean and English labels.
//!
//! Wrapping is measured with the same pinned Noto tables emission uses, so a
//! line that fits here keeps every painted glyph inside the box the layout
//! admission check measures (`maru#552` T6, `maru#560`). Break opportunities
//! are the ones the plan names: a space first, then the boundary between two
//! Hangul syllables, and a Latin word is split only when it alone overflows the
//! line.

use super::{measure_text, overflow};
use crate::layout::fixed::Coord;
use crate::Diagnostic;

/// Scalars a Hangul line may break between: precomposed syllables, the
/// conjoining jamo around them and the compatibility jamo block.
fn is_hangul(scalar: char) -> bool {
    matches!(
        scalar as u32,
        0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xAC00..=0xD7A3
    )
}

/// Width a measured line paints. Only ink counts, so the bound is the span the
/// emission's own admission check measures: a trailing space, or an advance
/// past the last glyph's ink, never pushes a line into a break on its own.
fn painted_width(text: &str, weight: u16, size: Coord) -> Result<i64, Diagnostic> {
    let metrics = measure_text(text, weight, size)?;
    let right = metrics.ink.right().map_err(|_| overflow())?;
    let left = metrics.ink.x.min(0);
    Ok(i64::from(right) - i64::from(left))
}

fn prefix(chars: &[char], length: usize) -> String {
    chars[..length].iter().collect()
}

/// Wrap `text` so no line paints wider than `max_width`.
///
/// Authored line breaks are kept and wrapped independently. A line that already
/// fits is returned unchanged, so a source that needs no wrap keeps its exact
/// bytes.
pub fn wrap_label_lines(
    text: &str,
    weight: u16,
    size: Coord,
    max_width: Coord,
) -> Result<Vec<String>, Diagnostic> {
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        wrap_paragraph(paragraph, weight, size, i64::from(max_width), &mut lines)?;
    }
    Ok(lines)
}

fn wrap_paragraph(
    paragraph: &str,
    weight: u16,
    size: Coord,
    max_width: i64,
    lines: &mut Vec<String>,
) -> Result<(), Diagnostic> {
    let fits = |candidate: &str| -> Result<bool, Diagnostic> {
        Ok(painted_width(candidate, weight, size)? <= max_width)
    };
    let mut rest = paragraph;
    let mut emitted = false;
    loop {
        if rest.is_empty() {
            if !emitted {
                lines.push(String::new());
            }
            return Ok(());
        }
        if emitted {
            // The break swallowed one space; a continuation line never starts
            // with the space it replaced.
            rest = rest.trim_start_matches(' ');
            if rest.is_empty() {
                return Ok(());
            }
        }
        if fits(rest)? {
            lines.push(rest.to_owned());
            return Ok(());
        }
        let chars: Vec<char> = rest.chars().collect();
        let mut filled = 0;
        let mut space_break = None;
        let mut hangul_break = None;
        for length in 1..=chars.len() {
            if !fits(&prefix(&chars, length))? {
                break;
            }
            filled = length;
            if length == chars.len() {
                break;
            }
            let previous = chars[length - 1];
            if previous == ' ' {
                // The space stays out of both lines; the break replaces it.
                space_break = Some(length - 1);
            } else if is_hangul(previous) && is_hangul(chars[length]) {
                hangul_break = Some(length);
            }
        }
        // A word earns its own line only when nothing else fits; a line that
        // cannot hold a single scalar still emits one so wrapping terminates.
        let consumed = space_break
            .or(hangul_break)
            .filter(|break_at| *break_at > 0)
            .unwrap_or(filled.max(1));
        lines.push(prefix(&chars, consumed));
        emitted = true;
        rest = &rest[rest
            .char_indices()
            .nth(consumed)
            .map_or(rest.len(), |(offset, _)| offset)..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LABEL: Coord = 13 * 64;
    const BODY: u16 = 400;

    fn wrap(text: &str, width: i32) -> Vec<String> {
        wrap_label_lines(text, BODY, LABEL, width * 64).expect("wrapping measures the pinned face")
    }

    #[test]
    fn a_line_that_fits_is_returned_unchanged() {
        assert_eq!(wrap("Short", 400), vec!["Short"]);
        assert_eq!(wrap("", 400), vec![""]);
        assert_eq!(
            wrap("주문 처리 Order flow", 400),
            vec!["주문 처리 Order flow"],
            "a fitting mixed line keeps one line"
        );
    }

    #[test]
    fn authored_breaks_are_kept_and_wrapped_independently() {
        let lines = wrap("First line\nSecond line", 400);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "First line");
        assert_eq!(lines[1], "Second line");
    }

    #[test]
    fn a_space_is_the_first_break_opportunity() {
        let lines = wrap("apt, systemd, /etc, homes", 60);
        assert!(lines.len() > 1);
        assert!(
            lines.iter().all(|line| !line.ends_with(' ')),
            "the break replaces the space instead of leaving it painted: {lines:?}"
        );
        assert!(lines
            .iter()
            .all(|line| { painted_width(line, BODY, LABEL).expect("pinned face") <= 60 * 64 }));
        assert_eq!(
            lines.join(" "),
            "apt, systemd, /etc, homes",
            "wrapping only moves the breaks, never the words"
        );
    }

    #[test]
    fn a_space_break_wins_over_a_later_hangul_break() {
        // The space keeps both Korean words whole even though a syllable break
        // inside `처리` would have filled the line further.
        let lines = wrap("주문 처리 Order flow", 60);
        assert!(lines.len() > 1);
        assert_eq!(
            lines[0], "주문 처리",
            "a Korean word is not split at a syllable"
        );
    }

    #[test]
    fn hangul_syllables_break_a_word_that_has_no_space() {
        let lines = wrap("주문처리완료알림", 40);
        assert!(lines.len() > 1);
        assert_eq!(lines.concat(), "주문처리완료알림");
        for line in &lines {
            assert!(!line.is_empty());
            assert!(
                painted_width(line, BODY, LABEL).expect("pinned face") <= 40 * 64,
                "line {line:?} paints wider than the box"
            );
        }
    }

    #[test]
    fn a_latin_word_is_not_split_unless_it_alone_overflows() {
        let lines = wrap("Deploy the service", 70);
        assert_eq!(
            lines.join(" "),
            "Deploy the service",
            "only the break moves: {lines:?}"
        );
        for line in &lines {
            assert!(
                ["Deploy", "the", "service", "Deploy the"].contains(&line.as_str()),
                "words stay whole: {lines:?}"
            );
        }
        let long = wrap("supercalifragilistic", 70);
        assert!(long.len() > 1, "a word longer than the box is split");
        assert_eq!(long.concat(), "supercalifragilistic");
    }

    #[test]
    fn wrapping_is_deterministic_and_terminates_on_a_zero_width_box() {
        let once = wrap("주문 처리 Order flow", 60);
        assert_eq!(once, wrap("주문 처리 Order flow", 60));
        let squeezed = wrap("주문 처리", 1);
        assert_eq!(squeezed.concat().replace(' ', ""), "주문처리");
        assert!(squeezed.iter().all(|line| line.chars().count() == 1));
    }
}
