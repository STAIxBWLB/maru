// Maru Today — pure launch-routing decisions for the app shell.
// All Tauri invokes live in App.tsx; these helpers stay side-effect free so
// the routing rules are unit-testable.

import type { MaruAppMode } from "./settings";
import type { DayState, TodayRoute } from "./today";

/** localStorage key remembering which logical day already auto-opened Today. */
export const TODAY_LAST_AUTO_OPEN_KEY = "maru:today:lastAutoOpenDay:v1";

export interface LaunchRouteInput {
  enabled: boolean;
  autoOpen: boolean;
  /** Value of TODAY_LAST_AUTO_OPEN_KEY (null when never auto-opened). */
  lastAutoOpenDay: string | null;
  logicalDay: string;
  dayState: DayState;
  /** True when the boot mode came from an explicit source (deep link, flag
   *  redirect, …). An explicit mode always wins over the Today auto-open. */
  explicitMode: boolean;
}

export interface LaunchRouteDecision {
  mode: MaruAppMode;
  route: TodayRoute;
  /** True when the caller should persist TODAY_LAST_AUTO_OPEN_KEY. */
  markAutoOpen: boolean;
}

/** First-eligible-launch decision: auto-open Today once per logical day.
 *  Returns null when the normal persisted-mode restore should proceed. */
export function resolveLaunchRoute(input: LaunchRouteInput): LaunchRouteDecision | null {
  if (!input.enabled || !input.autoOpen) return null;
  if (input.explicitMode) return null;
  if (input.lastAutoOpenDay === input.logicalDay) return null;
  return {
    mode: "tasks",
    route: resolveRouteForDayState(input.dayState),
    markAutoOpen: true,
  };
}

/** Setup finished (planned/skipped/executing/reviewed) → land on Execute;
 *  anything else (unstarted/preparing) still needs Prepare. */
export function resolveRouteForDayState(dayState: DayState): TodayRoute {
  switch (dayState) {
    case "planned":
    case "skipped":
    case "executing":
    case "reviewed":
      return "execute";
    default:
      return "prepare";
  }
}

export type NewDayNotice = "notify" | "banner" | "none";

/** How a logical-day boundary crossed while running should be surfaced.
 *  Native notification when granted; in-app banner otherwise; silent when
 *  notifications are disabled in settings. */
export function resolveNewDayNotice(args: {
  notificationEnabled: boolean;
  sent: boolean;
}): NewDayNotice {
  if (!args.notificationEnabled) return "none";
  return args.sent ? "notify" : "banner";
}
