//! Deterministic line wrapping for mixed Korean and English labels.
//!
//! Wrapping is measured with the same pinned Noto tables emission uses, so a
//! line that fits here keeps every painted glyph inside the box the layout
//! admission check measures (`maru#552` T6, `maru#560`). Break opportunities
//! are the ones the plan names: a space first, then a Hangul syllable boundary
//! (between syllables or before a leading jamo, never inside a decomposed
//! syllable), and a Latin word is split only when it alone overflows the line.

use super::PaintedWidth;
use crate::layout::fixed::Coord;
use crate::Diagnostic;

/// What a scalar is inside a Hangul syllable, the way the Unicode line-breaking
/// rules see it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Hangul {
    /// A precomposed syllable (`AC00..=D7A3`) or a compatibility jamo
    /// (`3130..=318F`), which is a standalone letter rather than a piece.
    Syllable,
    /// A leading consonant, the first scalar of a decomposed syllable.
    Leading,
    /// A vowel, the middle scalar of a decomposed syllable.
    Vowel,
    /// A trailing consonant, the last scalar of a decomposed syllable.
    Trailing,
}

fn hangul(scalar: char) -> Option<Hangul> {
    match scalar as u32 {
        0xAC00..=0xD7A3 | 0x3130..=0x318F => Some(Hangul::Syllable),
        0x1100..=0x115F | 0xA960..=0xA97F => Some(Hangul::Leading),
        0x1160..=0x11A7 | 0xD7B0..=0xD7C6 => Some(Hangul::Vowel),
        0x11A8..=0x11FF | 0xD7CB..=0xD7FB => Some(Hangul::Trailing),
        _ => None,
    }
}

/// Whether a scalar can start a new line's syllable: a precomposed syllable, or
/// the leading jamo or vowel jamo a decomposed one begins with.
fn starts_a_syllable(scalar: char) -> bool {
    matches!(
        hangul(scalar),
        Some(Hangul::Syllable | Hangul::Leading | Hangul::Vowel)
    )
}

/// A precomposed syllable with no trailing consonant (`LV`), the form GB7 also
/// forbids a break after. Compatibility jamo are not conjoining, so they are not
/// decomposed this way.
fn is_lv_syllable(scalar: char) -> bool {
    let code = scalar as u32;
    (0xAC00..=0xD7A3).contains(&code) && (code - 0xAC00).is_multiple_of(28)
}

/// A Hangul break belongs only at a syllable boundary: between two syllables, or
/// before the leading or vowel jamo that starts the next one. A decomposed (NFD)
/// syllable is a leading, vowel and trailing run, and macOS filenames and some
/// pasted text arrive that way, so breaking before a vowel or a trailing jamo
/// that continues the same syllable would tear one visible syllable across two
/// lines.
///
/// The rule is UAX #29: GB6 forbids a break after a leading jamo, GB7 forbids one
/// after `LV` or `V` before a `V` or `T`, and GB8 forbids `T x T`. Nothing
/// forbids `LVT x V`, so a precomposed syllable that already carries its
/// trailing consonant ends there and the next vowel jamo may start a line.
fn is_hangul_break(before: char, after: char) -> bool {
    // A trailing jamo never starts a line's syllable, so GB8 (`LVT x T`,
    // `T x T`) is already answered here for every `before`.
    if !starts_a_syllable(after) {
        return false;
    }
    match hangul(before) {
        // GB6: a leading jamo is still one syllable with whatever follows.
        None | Some(Hangul::Leading) => false,
        // GB7 forbids `LV x V`. An `LVT` already carries its trailing consonant,
        // so nothing forbids `LVT x V` and the vowel may start a line.
        Some(Hangul::Syllable) => {
            !(is_lv_syllable(before) && matches!(hangul(after), Some(Hangul::Vowel)))
        }
        // GB7 `V x V`, and the trailing jamo that would continue a vowel.
        Some(Hangul::Vowel) => !matches!(hangul(after), Some(Hangul::Vowel)),
        Some(Hangul::Trailing) => true,
    }
}

/// Whether a cut between `at - 1` and `at` would split one decomposed syllable.
fn splits_syllable(chars: &[char], at: usize) -> bool {
    at > 0
        && at < chars.len()
        && hangul(chars[at - 1]).is_some()
        && hangul(chars[at]).is_some()
        && !is_hangul_break(chars[at - 1], chars[at])
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
            } else if is_hangul_break(previous, rest[length]) {
                hangul_break = Some(length);
            }
        }
        if filled == rest.len() {
            lines.push(rest.iter().collect());
            return Ok(());
        }
        // The paragraph has to wrap, so its leading spaces belong to no line:
        // they are not a word, and letting them form a line of their own would
        // add an empty line's height to the fit. A paragraph that fits keeps
        // its authored bytes, which the return above already handled.
        if rest[0] == ' ' {
            start += 1;
            continue;
        }
        // A word earns its own line only when nothing else fits. Cutting a word
        // is the caller's last resort, so without permission the whole token
        // overflows on its own line and a caller can still grow or shrink.
        let fitting = space_break
            .filter(|break_at| *break_at > 0)
            .or(hangul_break);
        let consumed = match (fitting, allow_token_split) {
            (Some(break_at), _) => break_at,
            (None, true) => {
                // A cut is the last resort and it still never lands inside a
                // decomposed syllable: when the cut would tear one, the whole
                // token keeps its overflowing line so the caller steps the sizes
                // down and refuses instead of drawing half a syllable.
                let cut = filled.max(1);
                if splits_syllable(rest, cut) {
                    whole_token(rest)
                } else {
                    cut
                }
            }
            (None, false) => whole_token(rest),
        };
        lines.push(rest[..consumed].iter().collect());
        emitted = true;
        start += consumed;
    }
}

/// The whole token on one line, so the caller can step the size down instead of
/// having the word cut. A break replaces the space it lands on.
fn whole_token(chars: &[char]) -> usize {
    next_token_boundary(chars)
        .map(|boundary| {
            if boundary > 1 && chars[boundary - 1] == ' ' {
                boundary - 1
            } else {
                boundary
            }
        })
        .unwrap_or(chars.len())
}

/// The first place after the first scalar where a new token could start.
fn next_token_boundary(chars: &[char]) -> Option<usize> {
    (1..chars.len())
        .find(|&index| chars[index - 1] == ' ' || is_hangul_break(chars[index - 1], chars[index]))
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
    fn a_paragraphs_leading_space_does_not_become_its_own_line() {
        // A source may indent a label with a space. It is not a word, so it may
        // not take a line of its own: that would add a line's height to the fit
        // for no glyph, and it used to hide a later Hangul break as well.
        let korean = wrap("  주문처리완료알림", 40);
        assert!(korean.len() > 1, "the label still wraps: {korean:?}");
        assert!(
            korean.iter().all(|line| !line.trim().is_empty()),
            "no line is a bare run of spaces: {korean:?}"
        );
        assert_eq!(korean.concat(), "주문처리완료알림");
        // The same in Latin text, where the whole token is the last resort.
        let latin = wrap(" WWWWWWWWWWWW", 70);
        assert!(
            !latin[0].starts_with(' '),
            "the leading space took no line: {latin:?}"
        );
    }

    #[test]
    fn a_paragraph_that_fits_keeps_its_leading_space() {
        // Nothing wraps, so the authored bytes come back exactly as written.
        assert_eq!(wrap("  주문", 400), vec!["  주문"]);
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
    fn a_decomposed_syllable_is_never_split_between_its_jamo() {
        // macOS filenames and some pasted text carry NFD Hangul: one visible
        // syllable is a leading, vowel and trailing scalar, so a break before a
        // vowel or a trailing jamo would tear that syllable across two lines.
        let label = "한한한";
        let scalars: Vec<char> = label.chars().collect();
        assert_eq!(scalars.len(), 9, "the fixture must stay decomposed");
        // Wide enough for one syllable and the leading jamo of the next, which
        // is exactly where a break between any two Hangul scalars would land
        // inside a syllable.
        let box_width: String = scalars[..4].iter().collect();
        let width = i32::try_from(painted_width(&box_width, BODY, LABEL).expect("pinned face"))
            .expect("a syllable measures inside the coordinate range");
        let lines = wrap_label_lines(label, BODY, LABEL, width, true).expect("pinned face");
        assert_eq!(lines.len(), 3, "one syllable per line: {lines:?}");
        assert_eq!(lines.concat(), label, "wrapping never reorders scalars");
        // Checked against the scalar classes, not against the break rule that
        // produced the lines: a line may end a syllable with its trailing jamo,
        // never inside one.
        for line in &lines[..lines.len() - 1] {
            let last = line.chars().last().expect("no empty line");
            assert!(
                matches!(hangul(last), Some(Hangul::Syllable | Hangul::Trailing)),
                "line {line:?} ends before syllable {last:?} is finished: {lines:?}"
            );
        }
    }

    #[test]
    fn a_hangul_break_needs_a_finished_syllable_and_a_new_one_after() {
        // The decomposed form of one syllable: a leading, vowel and trailing
        // jamo, three scalars for one visible syllable.
        let decomposed: Vec<char> = "한".chars().collect();
        assert_eq!(decomposed.len(), 3, "the fixture must stay decomposed");
        let (leading, vowel, trailing) = (decomposed[0], decomposed[1], decomposed[2]);
        assert!(is_hangul_break('한', '국'), "between two syllables");
        assert!(
            is_hangul_break(trailing, leading),
            "before the leading jamo that starts the next syllable"
        );
        assert!(
            is_hangul_break(vowel, '한'),
            "a vowel closes an open syllable"
        );
        // UAX #29 GB6: a leading jamo is still one syllable with whatever
        // follows, so nothing breaks after it.
        assert!(!is_hangul_break(leading, leading));
        assert!(!is_hangul_break(leading, '한'));
        assert!(!is_hangul_break(leading, vowel));
        assert!(!is_hangul_break(leading, trailing));
        // GB7 is about LV, not LVT: `가` (U+AC00) carries no trailing consonant,
        // so a vowel jamo that follows still belongs to it; `한` (U+D55C) already
        // has its trailing consonant, so nothing forbids LVT x V and the vowel
        // starts a new line.
        assert!(
            !is_hangul_break('가', vowel),
            "GB7: an LV syllable does not break before a vowel jamo"
        );
        assert!(
            is_hangul_break('한', vowel),
            "an LVT syllable is finished, so the next vowel jamo starts a line"
        );
        // GB7 and GB8: never before a vowel or a trailing jamo.
        assert!(!is_hangul_break('한', trailing));
        assert!(!is_hangul_break('가', trailing));
        assert!(!is_hangul_break(vowel, trailing));
        assert!(!is_hangul_break(trailing, trailing));
    }

    #[test]
    fn a_box_narrower_than_one_syllable_keeps_it_whole_instead_of_cutting_it() {
        // Two decomposed syllables in a box too narrow for even one: the last
        // resort may not cut inside a syllable, so each keeps its own
        // overflowing line and the caller is left to step the size down.
        let label = "한한";
        let lines = wrap_label_lines(label, BODY, LABEL, 1, true).expect("pinned face");
        assert_eq!(lines.concat(), label, "wrapping never reorders scalars");
        for line in &lines {
            assert_eq!(
                line.chars().count(),
                3,
                "one whole syllable per line: {lines:?}"
            );
            assert!(
                painted_width(line, BODY, LABEL).expect("pinned face") > 1,
                "the line overflows the box so the caller can step down: {lines:?}"
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
