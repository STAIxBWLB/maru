/**
 * Formatting helpers for agent usage quota displays.
 * Locale-unaware by design (compact "48m" / "2d 20h" tokens); callers compose
 * the surrounding copy through i18n.
 */

/**
 * Compact "reset in" text for a quota window, e.g. "48m", "3h 5m", "2d 20h".
 * Returns null when there is no reset time or the timestamp is unparseable;
 * past timestamps clamp to "0m".
 */
export function formatUsageResetIn(
  resetsAt: string | null,
  now: number = Date.now(),
): string | null {
  if (!resetsAt) return null;
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return null;
  const totalMinutes = Math.max(0, Math.ceil((target - now) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** One chip segment: "19% used 48m" (used suffix comes from i18n). */
export function formatUsageWindowSegment(
  window: { usedPercent: number; resetsAt: string | null },
  usedSuffix: string,
  now: number = Date.now(),
): string {
  const percent = Math.round(window.usedPercent);
  const resetIn = formatUsageResetIn(window.resetsAt, now);
  return resetIn ? `${percent}% ${usedSuffix} ${resetIn}` : `${percent}% ${usedSuffix}`;
}
