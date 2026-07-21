import { describe, expect, it } from "vitest";

import {
  resolveLaunchRoute,
  resolveNewDayNotice,
  resolveRouteForDayState,
  TODAY_LAST_AUTO_OPEN_KEY,
  type LaunchRouteInput,
} from "./todayRouting";

const BASE: LaunchRouteInput = {
  enabled: true,
  autoOpen: true,
  lastAutoOpenDay: null,
  logicalDay: "2026-07-21",
  dayState: "unstarted",
  explicitMode: false,
};

describe("resolveLaunchRoute", () => {
  it("returns null when Today is disabled", () => {
    expect(resolveLaunchRoute({ ...BASE, enabled: false })).toBeNull();
  });

  it("returns null when auto-open is disabled", () => {
    expect(resolveLaunchRoute({ ...BASE, autoOpen: false })).toBeNull();
  });

  it("returns null when Today already auto-opened for this logical day", () => {
    expect(
      resolveLaunchRoute({ ...BASE, lastAutoOpenDay: "2026-07-21" }),
    ).toBeNull();
  });

  it("auto-opens again on a new logical day", () => {
    const decision = resolveLaunchRoute({ ...BASE, lastAutoOpenDay: "2026-07-20" });
    expect(decision).not.toBeNull();
    expect(decision?.markAutoOpen).toBe(true);
  });

  it("explicit boot mode (deep link / flag) wins over auto-open", () => {
    expect(resolveLaunchRoute({ ...BASE, explicitMode: true })).toBeNull();
  });

  it("routes to prepare when setup is unfinished", () => {
    expect(resolveLaunchRoute({ ...BASE, dayState: "unstarted" })?.route).toBe("prepare");
    expect(resolveLaunchRoute({ ...BASE, dayState: "preparing" })?.route).toBe("prepare");
  });

  it("routes to execute once setup finished", () => {
    for (const dayState of ["planned", "skipped", "executing", "reviewed"] as const) {
      expect(resolveLaunchRoute({ ...BASE, dayState })?.route).toBe("execute");
    }
  });

  it("targets the tasks mode", () => {
    expect(resolveLaunchRoute(BASE)?.mode).toBe("tasks");
  });
});

describe("resolveRouteForDayState", () => {
  it("maps finished setup states to execute", () => {
    expect(resolveRouteForDayState("planned")).toBe("execute");
    expect(resolveRouteForDayState("skipped")).toBe("execute");
    expect(resolveRouteForDayState("executing")).toBe("execute");
    expect(resolveRouteForDayState("reviewed")).toBe("execute");
  });

  it("maps unfinished setup states to prepare", () => {
    expect(resolveRouteForDayState("unstarted")).toBe("prepare");
    expect(resolveRouteForDayState("preparing")).toBe("prepare");
  });
});

describe("resolveNewDayNotice", () => {
  it("stays silent when notifications are disabled", () => {
    expect(resolveNewDayNotice({ notificationEnabled: false, sent: false })).toBe("none");
    expect(resolveNewDayNotice({ notificationEnabled: false, sent: true })).toBe("none");
  });

  it("uses the native notification when it was sent", () => {
    expect(resolveNewDayNotice({ notificationEnabled: true, sent: true })).toBe("notify");
  });

  it("falls back to the in-app banner when sending failed or was denied", () => {
    expect(resolveNewDayNotice({ notificationEnabled: true, sent: false })).toBe("banner");
  });
});

describe("TODAY_LAST_AUTO_OPEN_KEY", () => {
  it("is the versioned auto-open marker key", () => {
    expect(TODAY_LAST_AUTO_OPEN_KEY).toBe("maru:today:lastAutoOpenDay:v1");
  });
});
