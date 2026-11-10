//! Deterministic line wrapping for mixed Korean and English labels.
//!
//! Wrapping is measured with the same pinned Noto tables emission uses, so a
//! line that fits here keeps every painted glyph inside the box the layout
//! admission check measures (`maru#552` T6, `maru#560`). Break opportunities
//! are the ones the plan names: a space first, then the boundary between two
//! Hangul syllables, and a Latin word is split only when it alone overflows the
//! line.

use super::PaintedWidth;
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

/// Wrap `text` so no line paints wider than `max_width`.
///
/// Authored line breaks are kept and wrapped independently. A line that already
/// fits is returned unchanged, so a source that needs no wrap keeps its exact
/// bytes. When `allow_token_split` is false a single token wider than the box
/// keeps its own line and overflows instead of being cut, which lets the caller
/// try a bigger box or a smaller size before the word is broken.
pub fn wrap_label_lines(
    text: &str,
    weight: u16,
    size: Coord,
    max_width: Coord,
    allow_token_split: bool,
) -> Result<Vec<String>, Diagnostic> {
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        wrap_paragraph(
            paragraph,
            weight,
            size,
            i64::from(max_width),
            allow_token_split,
            &mut lines,
        )?;
    }
    Ok(lines)
}

fn wrap_paragraph(
    paragraph: &str,
    weight: u16,
    size: Coord,
    max_width: i64,
    allow_token_split: bool,
    lines: &mut Vec<String>,
) -> Result<(), Diagnostic> {
    let chars: Vec<char> = paragraph.chars().collect();
    let mut measure = PaintedWidth::new(weight, size)?;
    let mut start = 0;
    let mut emitted = false;
    loop {
        if start == chars.len() {
            if !emitted {
                lines.push(String::new());
            }
            return Ok(());
        }
        if emitted {
            // The break swallowed one space; a continuation line never starts
            // with the space it replaced.
            while start < chars.len() && chars[start] == ' ' {
                start += 1;
            }
            if start == chars.len() {
                return Ok(());
            }
        }
        let rest = &chars[start..];
        // One forward pass decides both whether the rest of the paragraph fits
        // and where the next break belongs, so a line is measured once and the
        // scan never revisits a scalar it already advanced past.
        measure.reset();
        let mut filled = 0;
        let mut space_break = None;
        let mut hangul_break = None;
        for (offset, scalar) in rest.iter().enumerate() {
            measure.push(*scalar)?;
            if measure.width() > max_width {
                break;
            }
            let length = offset + 1;
            filled = length;
            if length == rest.len() {
                break;
            }
            let previous = rest[offset];
            if previous == ' ' {
                // The space stays out of both lines; the break replaces it.
                space_break = Some(offset);
            } else if is_hangul(previous) && is_hangul(rest[length]) {
                hangul_break = Some(length);
            }
        }
        if filled == rest.len() {
            lines.push(rest.iter().collect());
            return Ok(());
        }
        // A word earns its own line only when nothing else fits. Cutting a word
        // is the caller's last resort, so without permission the whole token
        // overflows on its own line and a caller can still grow or shrink.
        let fitting = space_break
            .or(hangul_break)
            .filter(|break_at| *break_at > 0);
        let consumed = match (fitting, allow_token_split) {
            (Some(break_at), _) => break_at,
            (None, true) => filled.max(1),
            (None, false) => next_token_boundary(rest)
                .map(|boundary| {
                    if boundary > 1 && rest[boundary - 1] == ' ' {
                        boundary - 1
                    } else {
                        boundary
                    }
                })
                .unwrap_or(rest.len()),
        };
        lines.push(rest[..consumed].iter().collect());
        emitted = true;
        start += consumed;
    }
}

/// The first place after the first scalar where a new token could start.
fn next_token_boundary(chars: &[char]) -> Option<usize> {
    (1..chars.len()).find(|&index| {
        chars[index - 1] == ' ' || (is_hangul(chars[index - 1]) && is_hangul(chars[index]))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::painted_width;

    const LABEL: Coord = 13 * 64;
    const BODY: u16 = 400;

    fn wrap(text: &str, width: i32) -> Vec<String> {
        wrap_label_lines(text, BODY, LABEL, width * 64, true)
            .expect("wrapping measures the pinned face")
    }

    fn wrap_keeping_words(text: &str, width: i32) -> Vec<String> {
        wrap_label_lines(text, BODY, LABEL, width * 64, false)
            .expect("wrapping measures the pinned face")
    }

    #[test]
    fn a_token_wider_than_the_box_keeps_its_line_until_the_caller_allows_a_cut() {
        let kept = wrap_keeping_words("WWWWWWWWWWWW", 70);
        assert_eq!(kept, vec!["WWWWWWWWWWWW"], "a whole word on its own line");
        assert!(
            painted_width(&kept[0], BODY, LABEL).expect("pinned face") > 70 * 64,
            "the line still overflows, so the caller can grow or shrink first"
        );
        let cut = wrap("WWWWWWWWWWWW", 70);
        assert!(cut.len() > 1, "the last resort splits the word: {cut:?}");
        assert_eq!(cut.concat(), "WWWWWWWWWWWW");
    }

    #[test]
    fn keeping_words_still_uses_every_space_and_hangul_break() {
        let spaced = wrap_keeping_words("alpha beta gamma delta", 70);
        assert!(spaced.len() > 1);
        assert_eq!(spaced.join(" "), "alpha beta gamma delta");
        let hangul = wrap_keeping_words("주문처리완료알림", 40);
        assert!(hangul.len() > 1);
        assert_eq!(hangul.concat(), "주문처리완료알림");
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
    fn a_word_on_its_own_line_does_not_carry_the_space_it_replaced() {
        // Each Korean word fits this box whole; `Gateway` alone does not, so it
        // takes the whole-word line and must not keep the space after it.
        let lines = wrap_keeping_words("결제 Gateway 확인 처리 모듈", 36);
        assert!(lines.len() > 1, "{lines:?}");
        assert!(
            lines.iter().all(|line| !line.ends_with(' ')),
            "a break replaces the space instead of leaving it painted: {lines:?}"
        );
        assert_eq!(
            lines.join(" ").replace("  ", " "),
            "결제 Gateway 확인 처리 모듈"
        );
    }

    #[test]
    fn wrapping_is_deterministic_and_terminates_on_a_zero_width_box() {
        let once = wrap("주문 처리 Order flow", 60);
        assert_eq!(once, wrap("주문 처리 Order flow", 60));
        let squeezed = wrap("주문 처리", 1);
        assert_eq!(squeezed.concat().replace(' ', ""), "주문처리");
        assert!(squeezed.iter().all(|line| line.chars().count() == 1));
    }

    #[test]
    fn the_incremental_width_matches_a_full_measurement_at_every_prefix() {
        let label = "결제 Gateway 승인 처리 모듈 결제 Gateway 확인";
        let chars: Vec<char> = label.chars().collect();
        let mut measure = PaintedWidth::new(BODY, LABEL).expect("pinned face");
        for (index, scalar) in chars.iter().enumerate() {
            measure.push(*scalar).expect("pinned face");
            let prefix: String = chars[..=index].iter().collect();
            assert_eq!(
                measure.width(),
                painted_width(&prefix, BODY, LABEL).expect("pinned face"),
                "prefix of {index} scalars must measure exactly as measure_text does"
            );
        }
        measure.reset();
        assert_eq!(measure.width(), 0, "a reset measurer starts empty");
    }

    #[test]
    fn a_split_word_costs_one_scan_per_line_not_one_per_candidate_break() {
        // `W` has no space and no Hangul syllable, so every line takes the
        // last-resort cut and each scan runs exactly one scalar past the fill.
        let label = "W".repeat(600);
        let (lines, stats) = crate::work::capture(|| wrap(&label, 400));
        assert!(lines.len() > 10, "{lines:?}");
        assert_eq!(
            stats.text_scalar_measurements,
            (label.chars().count() + lines.len() - 1) as u64,
            "each line must measure its own scalars once: a per-prefix measurement would grow with the square of the fill"
        );
    }
}
