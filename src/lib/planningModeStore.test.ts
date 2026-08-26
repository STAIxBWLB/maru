import { describe, expect, it, vi } from "vitest";

import { createPlanningModeController } from "./planningModeStore";

describe("planningModeStore", () => {
  it("consumes a requested meeting view once while preserving later explicit requests", () => {
    const controller = createPlanningModeController();

    controller.requestMeetingsView("transcript");
    const first = controller.getMeetingsSlice();
    expect(first.requestedView).toBe("transcript");

    controller.consumeMeetingsView(first.requestEpoch);
    expect(controller.getMeetingsSlice().requestedView).toBeNull();

    controller.requestMeetingsView("transcript");
    const second = controller.getMeetingsSlice();
    expect(second.requestedView).toBe("transcript");
    expect(second.requestEpoch).toBeGreaterThan(first.requestEpoch);
  });

  it("publishes Meetings independently from the other planning domains", () => {
    const controller = createPlanningModeController();
    const meetings = vi.fn();
    const today = vi.fn();
    const unsubscribeMeetings = controller.subscribe("meetings", meetings);
    const unsubscribeToday = controller.subscribe("today", today);

    controller.requestMeetingsView("external");

    expect(meetings).toHaveBeenCalledTimes(1);
    expect(today).not.toHaveBeenCalled();
    unsubscribeMeetings();
    unsubscribeToday();
  });

  it("keeps Today route, logical-day, and refresh intents in one isolated slice", () => {
    const controller = createPlanningModeController();
    const today = vi.fn();
    const tasks = vi.fn();
    const stopToday = controller.subscribe("today", today);
    const stopTasks = controller.subscribe("tasks", tasks);

    controller.setTodayRoute("prepare");
    controller.setLogicalDay("2026-08-27");
    controller.requestTodayRollover();
    controller.requestTodayRefresh();

    expect(controller.getTodaySlice()).toMatchObject({
      route: "prepare",
      logicalDay: "2026-08-27",
      rolloverEpoch: 1,
      refreshRequestEpoch: 1,
    });
    expect(today).toHaveBeenCalledTimes(4);
    expect(tasks).not.toHaveBeenCalled();
    stopToday();
    stopTasks();
  });
});
