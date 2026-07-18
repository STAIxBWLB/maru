// Korean natural-language date parsing — thin wrapper over the Rust
// `parse_korean_date_cmd` (src-tauri/src/korean_date.rs), the single SSOT for
// phrases like "내일", "다음 주 금요일", "3월 15일 오후 3시".

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./api";

/// Current local time as RFC3339 with the local numeric offset. The Rust
/// parser anchors relative phrases ("오늘", "내일") against the passed `now`,
/// so it must receive local wall-clock time, not `Date#toISOString()` (UTC).
export function localNowIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offset}`
  );
}

/// Parse a Korean date phrase. Returns an RFC3339 datetime, or null when the
/// phrase is not recognized (or the Tauri shell is unavailable, e.g. browser
/// dev). Time defaults to 09:00 local when the phrase has no time component.
export async function parseKoreanDate(
  input: string,
  nowIso: string = localNowIso(),
): Promise<string | null> {
  if (!isTauri()) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return invoke<string | null>("parse_korean_date_cmd", { input: trimmed, nowIso });
}
