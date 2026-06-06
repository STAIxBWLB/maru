// Phase 2 step 3: pure-Rust parser for the Korean date phrases the user
// actually writes ("내일", "다음 주 금요일", "3월 15일", "오늘 오후 3시").
// Standalone — no Tauri dependency, no runtime state. Surface is a single
// `parse_korean_date(input, now)` function returning `Option<DateTime>`.
// Defaults the time to 09:00 (the user's working day start) when the
// phrase has no time component.
//
// Source: rewrite of `tidy/app/electron/ipc-handlers.js:20-109`. The JS
// version was a chain of `if` guards + `Date` arithmetic; the Rust port
// keeps the same case set but routes through chrono so DST + month-end
// rollover are handled correctly.

use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDate, TimeZone, Weekday};
use regex::Regex;

/// Tauri-facing wrapper. Frontend passes `now_iso` (RFC3339 with offset) so
/// the parse anchors against the user's local clock without sneaking
/// system-time access into pure logic.
#[tauri::command]
pub fn parse_korean_date_cmd(input: String, now_iso: String) -> Result<Option<String>, String> {
    let now = DateTime::parse_from_rfc3339(&now_iso)
        .map_err(|err| format!("now_iso must be RFC3339: {err}"))?;
    Ok(parse_korean_date(&input, now).map(|dt| dt.to_rfc3339()))
}

/// Parse a Korean natural-language date phrase against an anchor `now`.
/// Returns `Some(dt)` on a recognised phrase, `None` otherwise. Time
/// defaults to 09:00 when omitted. Year defaults to `now.year()` for
/// month/day phrases that omit it.
pub fn parse_korean_date(input: &str, now: DateTime<FixedOffset>) -> Option<DateTime<FixedOffset>> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    let date = extract_date(trimmed, now)?;
    let (hour, minute) = extract_time(trimmed).unwrap_or((9, 0));

    now.timezone()
        .with_ymd_and_hms(date.year(), date.month(), date.day(), hour, minute, 0)
        .single()
}

fn extract_date(s: &str, now: DateTime<FixedOffset>) -> Option<NaiveDate> {
    let today = now.date_naive();

    // Bare relative — handled before regex so "내일 오후 3시" still matches.
    if s.contains("오늘") {
        return Some(today);
    }
    if s.contains("어제") {
        return Some(today - Duration::days(1));
    }
    if s.contains("내일") {
        return Some(today + Duration::days(1));
    }
    if s.contains("모레") {
        return Some(today + Duration::days(2));
    }
    if s.contains("글피") {
        return Some(today + Duration::days(3));
    }

    // 이번/다음/지난 주 X요일
    let re_qualified_weekday =
        Regex::new(r"(이번|다음|지난)\s*주\s*([월화수목금토일])요일").ok()?;
    if let Some(cap) = re_qualified_weekday.captures(s) {
        let weekday = korean_weekday(&cap[2])?;
        let offset_weeks: i64 = match &cap[1] {
            "이번" => 0,
            "다음" => 7,
            "지난" => -7,
            _ => 0,
        };
        let today_dow = today.weekday().num_days_from_monday() as i64;
        let target_dow = weekday.num_days_from_monday() as i64;
        let delta = target_dow - today_dow + offset_weeks;
        return Some(today + Duration::days(delta));
    }

    // YYYY년 M월 D일 / YY년 M월 D일 / M월 D일
    let re_ymd = Regex::new(r"(?:(\d{2,4})년\s*)?(\d{1,2})월\s*(\d{1,2})일").ok()?;
    if let Some(cap) = re_ymd.captures(s) {
        let year = cap
            .get(1)
            .and_then(|m| m.as_str().parse::<i32>().ok())
            .map(|y| if y < 100 { 2000 + y } else { y })
            .unwrap_or_else(|| today.year());
        let month: u32 = cap[2].parse().ok()?;
        let day: u32 = cap[3].parse().ok()?;
        return NaiveDate::from_ymd_opt(year, month, day);
    }

    // X요일 alone — upcoming occurrence (today excluded so "월요일" said on
    // a Monday means next Monday, matching how the user phrases it).
    let re_weekday = Regex::new(r"([월화수목금토일])요일").ok()?;
    if let Some(cap) = re_weekday.captures(s) {
        let weekday = korean_weekday(&cap[1])?;
        let today_dow = today.weekday().num_days_from_monday() as i64;
        let target_dow = weekday.num_days_from_monday() as i64;
        let mut delta = target_dow - today_dow;
        if delta <= 0 {
            delta += 7;
        }
        return Some(today + Duration::days(delta));
    }

    // N일/주 후|뒤
    let re_n_days = Regex::new(r"(\d+)\s*일\s*(?:후|뒤)").ok()?;
    if let Some(cap) = re_n_days.captures(s) {
        let n: i64 = cap[1].parse().ok()?;
        return Some(today + Duration::days(n));
    }
    let re_n_weeks = Regex::new(r"(\d+)\s*주\s*(?:후|뒤)").ok()?;
    if let Some(cap) = re_n_weeks.captures(s) {
        let n: i64 = cap[1].parse().ok()?;
        return Some(today + Duration::days(n * 7));
    }

    None
}

fn extract_time(s: &str) -> Option<(u32, u32)> {
    // 오전/오후 H시 (M분)?
    let re_korean = Regex::new(r"(오전|오후)?\s*(\d{1,2})시(?:\s*(\d{1,2})분)?").ok()?;
    if let Some(cap) = re_korean.captures(s) {
        let mut hour: u32 = cap[2].parse().ok()?;
        let minute: u32 = cap
            .get(3)
            .and_then(|m| m.as_str().parse::<u32>().ok())
            .unwrap_or(0);
        if let Some(period) = cap.get(1) {
            match period.as_str() {
                "오후" if hour < 12 => hour += 12,
                "오전" if hour == 12 => hour = 0,
                _ => {}
            }
        }
        if hour < 24 && minute < 60 {
            return Some((hour, minute));
        }
    }
    // H:MM
    let re_hhmm = Regex::new(r"\b(\d{1,2}):(\d{2})\b").ok()?;
    if let Some(cap) = re_hhmm.captures(s) {
        let hour: u32 = cap[1].parse().ok()?;
        let minute: u32 = cap[2].parse().ok()?;
        if hour < 24 && minute < 60 {
            return Some((hour, minute));
        }
    }
    None
}

fn korean_weekday(ch: &str) -> Option<Weekday> {
    Some(match ch {
        "월" => Weekday::Mon,
        "화" => Weekday::Tue,
        "수" => Weekday::Wed,
        "목" => Weekday::Thu,
        "금" => Weekday::Fri,
        "토" => Weekday::Sat,
        "일" => Weekday::Sun,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// 2026-04-28 (Tue) 09:00 KST — anchor's "now" for every test below.
    fn now() -> DateTime<FixedOffset> {
        FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 4, 28, 9, 0, 0)
            .single()
            .unwrap()
    }

    fn ymd_hms(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<FixedOffset> {
        FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .single()
            .unwrap()
    }

    #[test]
    fn empty_or_unknown_returns_none() {
        assert_eq!(parse_korean_date("", now()), None);
        assert_eq!(parse_korean_date("   ", now()), None);
        assert_eq!(parse_korean_date("랜덤한 텍스트", now()), None);
    }

    #[test]
    fn relative_day_words_default_to_nine_am() {
        assert_eq!(
            parse_korean_date("오늘", now()),
            Some(ymd_hms(2026, 4, 28, 9, 0))
        );
        assert_eq!(
            parse_korean_date("내일", now()),
            Some(ymd_hms(2026, 4, 29, 9, 0))
        );
        assert_eq!(
            parse_korean_date("어제", now()),
            Some(ymd_hms(2026, 4, 27, 9, 0))
        );
        assert_eq!(
            parse_korean_date("모레", now()),
            Some(ymd_hms(2026, 4, 30, 9, 0))
        );
        assert_eq!(
            parse_korean_date("글피", now()),
            Some(ymd_hms(2026, 5, 1, 9, 0))
        );
    }

    #[test]
    fn afternoon_time_combines_with_today() {
        assert_eq!(
            parse_korean_date("오늘 오후 3시", now()),
            Some(ymd_hms(2026, 4, 28, 15, 0)),
        );
        assert_eq!(
            parse_korean_date("내일 오전 9시 30분", now()),
            Some(ymd_hms(2026, 4, 29, 9, 30)),
        );
    }

    #[test]
    fn this_week_friday_is_three_days_after_today() {
        // Today Tue 2026-04-28. This Fri = today + (Fri − Tue) = +3 → 05-01.
        assert_eq!(
            parse_korean_date("이번 주 금요일", now()),
            Some(ymd_hms(2026, 5, 1, 9, 0)),
        );
    }

    #[test]
    fn next_week_friday_is_seven_days_after_this_friday() {
        // This Fri = 05-01 → next Fri = 05-08.
        assert_eq!(
            parse_korean_date("다음 주 금요일", now()),
            Some(ymd_hms(2026, 5, 8, 9, 0)),
        );
    }

    #[test]
    fn last_week_monday() {
        // Today Wed 04-28. Last Mon = 04-20 (today − 8).
        assert_eq!(
            parse_korean_date("지난 주 월요일", now()),
            Some(ymd_hms(2026, 4, 20, 9, 0)),
        );
    }

    #[test]
    fn month_day_uses_current_year() {
        assert_eq!(
            parse_korean_date("3월 15일", now()),
            Some(ymd_hms(2026, 3, 15, 9, 0)),
        );
    }

    #[test]
    fn month_day_with_explicit_year() {
        assert_eq!(
            parse_korean_date("2027년 1월 1일", now()),
            Some(ymd_hms(2027, 1, 1, 9, 0)),
        );
        assert_eq!(
            parse_korean_date("27년 1월 1일", now()),
            Some(ymd_hms(2027, 1, 1, 9, 0)),
        );
    }

    #[test]
    fn weekday_alone_means_next_occurrence() {
        // Today Tue 04-28. "금요일" = upcoming Fri 05-01 (delta=3).
        assert_eq!(
            parse_korean_date("금요일", now()),
            Some(ymd_hms(2026, 5, 1, 9, 0)),
        );
        // "수요일" = tomorrow Wed 04-29 (delta=1).
        assert_eq!(
            parse_korean_date("수요일", now()),
            Some(ymd_hms(2026, 4, 29, 9, 0)),
        );
        // Said on a Tuesday, "화요일" alone means next Tue (today excluded).
        assert_eq!(
            parse_korean_date("화요일", now()),
            Some(ymd_hms(2026, 5, 5, 9, 0)),
        );
    }

    #[test]
    fn n_days_and_weeks_after() {
        assert_eq!(
            parse_korean_date("3일 후", now()),
            Some(ymd_hms(2026, 5, 1, 9, 0)),
        );
        assert_eq!(
            parse_korean_date("2주 뒤", now()),
            Some(ymd_hms(2026, 5, 12, 9, 0)),
        );
    }

    #[test]
    fn hhmm_time_format() {
        assert_eq!(
            parse_korean_date("내일 14:30", now()),
            Some(ymd_hms(2026, 4, 29, 14, 30)),
        );
    }

    #[test]
    fn noon_and_midnight_period_handling() {
        // 오후 12시 = 12:00 (no shift), 오전 12시 = 00:00.
        assert_eq!(
            parse_korean_date("오늘 오후 12시", now()),
            Some(ymd_hms(2026, 4, 28, 12, 0)),
        );
        assert_eq!(
            parse_korean_date("오늘 오전 12시", now()),
            Some(ymd_hms(2026, 4, 28, 0, 0)),
        );
    }

    #[test]
    fn rejects_invalid_calendar_dates() {
        // Feb 30 doesn't exist — parser must return None rather than rolling.
        assert_eq!(parse_korean_date("2월 30일", now()), None);
    }
}
