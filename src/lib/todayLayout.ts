export const TODAY_LAYOUT_LIMITS = {
  todaySidebarWidth: { defaultValue: 240, min: 200, max: 360 },
  tasksSidebarWidth: { defaultValue: 240, min: 180, max: 360 },
  calendarAgendaWidth: { defaultValue: 280, min: 200, max: 420 },
  taskDetailsWidth: { defaultValue: 400, min: 320, max: 520 },
} as const;

export type TodayLayoutWidthKey = keyof typeof TODAY_LAYOUT_LIMITS;

export function clampTodayLayoutWidth(key: TodayLayoutWidthKey, value: number): number {
  const limits = TODAY_LAYOUT_LIMITS[key];
  if (!Number.isFinite(value)) return limits.defaultValue;
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}
