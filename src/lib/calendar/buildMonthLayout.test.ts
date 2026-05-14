import { describe, expect, it } from "vitest";
import { buildMonthLayout } from "./buildMonthLayout";
import type { UnifiedCalendarEvent } from "./types";

function evt(
  id: string,
  start: string,
  end: string,
  options: { allDay?: boolean; category?: string } = {},
): UnifiedCalendarEvent {
  return {
    id,
    title: id,
    start: new Date(start),
    end: new Date(end),
    allDay: options.allDay ?? true,
    category: options.category ?? "priority-medium",
    source: "task",
    resource: {},
  };
}

describe("buildMonthLayout", () => {
  const viewMonth = new Date("2026-05-01T00:00:00");
  const today = new Date("2026-05-14T00:00:00");

  it("produces six week rows × seven cells", () => {
    const weeks = buildMonthLayout(viewMonth, [], { weekStartsOn: 0, today });
    expect(weeks).toHaveLength(6);
    weeks.forEach((week) => expect(week.cells).toHaveLength(7));
  });

  it("marks today and current-month cells correctly", () => {
    const weeks = buildMonthLayout(viewMonth, [], { weekStartsOn: 0, today });
    const allCells = weeks.flatMap((w) => w.cells);
    const todayCell = allCells.find((c) => c.isToday);
    expect(todayCell).toBeDefined();
    expect(todayCell!.date.getDate()).toBe(14);
    expect(todayCell!.date.getMonth()).toBe(4);
    const inMonth = allCells.filter((c) => c.inCurrentMonth);
    expect(inMonth).toHaveLength(31);
  });

  it("respects weekStartsOn: 0 (Sunday) vs 1 (Monday)", () => {
    const sun = buildMonthLayout(viewMonth, [], { weekStartsOn: 0, today });
    const mon = buildMonthLayout(viewMonth, [], { weekStartsOn: 1, today });
    expect(sun[0].cells[0].date.getDay()).toBe(0);
    expect(mon[0].cells[0].date.getDay()).toBe(1);
  });

  it("places a single-day all-day event as a bar spanning one column", () => {
    const event = evt("a", "2026-05-14T00:00:00", "2026-05-15T00:00:00");
    const weeks = buildMonthLayout(viewMonth, [event], { weekStartsOn: 0, today });
    const segments = weeks.flatMap((w) => w.lanes.flat());
    expect(segments).toHaveLength(1);
    const seg = segments[0];
    expect(seg.startColumn).toBe(seg.endColumn);
    expect(seg.openLeft).toBe(false);
    expect(seg.openRight).toBe(false);
  });

  it("splits a multi-week event into two segments with open flags", () => {
    const event = evt("ml", "2026-05-13T00:00:00", "2026-05-21T00:00:00");
    const weeks = buildMonthLayout(viewMonth, [event], { weekStartsOn: 0, today });
    const segs = weeks
      .map((w) => w.lanes.flat().find((s) => s.event.id === "ml"))
      .filter(Boolean);
    expect(segs).toHaveLength(2);
    const [first, second] = segs as Array<NonNullable<(typeof segs)[number]>>;
    expect(first.openLeft).toBe(false);
    expect(first.openRight).toBe(true);
    expect(second.openLeft).toBe(true);
    expect(second.openRight).toBe(false);
  });

  it("assigns non-overlapping segments to the same lane (first-fit)", () => {
    const a = evt("a", "2026-05-04T00:00:00", "2026-05-06T00:00:00");
    const b = evt("b", "2026-05-07T00:00:00", "2026-05-09T00:00:00");
    const weeks = buildMonthLayout(viewMonth, [a, b], { weekStartsOn: 0, today });
    const week = weeks.find((w) => w.lanes.flat().some((s) => s.event.id === "a"));
    expect(week).toBeDefined();
    expect(week!.lanes[0].some((s) => s.event.id === "a")).toBe(true);
    expect(week!.lanes[0].some((s) => s.event.id === "b")).toBe(true);
  });

  it("stacks overlapping segments into separate lanes", () => {
    const a = evt("a", "2026-05-04T00:00:00", "2026-05-08T00:00:00");
    const b = evt("b", "2026-05-05T00:00:00", "2026-05-07T00:00:00");
    const weeks = buildMonthLayout(viewMonth, [a, b], { weekStartsOn: 0, today });
    const week = weeks.find((w) => w.lanes.flat().some((s) => s.event.id === "a"));
    expect(week).toBeDefined();
    const aLane = week!.lanes.findIndex((lane) => lane.some((s) => s.event.id === "a"));
    const bLane = week!.lanes.findIndex((lane) => lane.some((s) => s.event.id === "b"));
    expect(aLane).not.toBe(bLane);
  });

  it("pushes overflow when exceeding maxLanes", () => {
    const events = Array.from({ length: 6 }, (_, i) =>
      evt(`e-${i}`, "2026-05-14T00:00:00", "2026-05-15T00:00:00"),
    );
    const weeks = buildMonthLayout(viewMonth, events, {
      weekStartsOn: 0,
      today,
      maxLanes: 3,
    });
    const week = weeks.find((w) => w.lanes.flat().some((s) => s.event.id === "e-0"));
    expect(week).toBeDefined();
    expect(week!.lanes.flat()).toHaveLength(3);
    expect(week!.overflowPerCell.some((n) => n >= 3)).toBe(true);
  });

  it("places single-day timed events in timedByColumn (not bar)", () => {
    const event = evt("timed", "2026-05-14T15:30:00", "2026-05-14T16:30:00", {
      allDay: false,
    });
    const weeks = buildMonthLayout(viewMonth, [event], { weekStartsOn: 0, today });
    const allSegments = weeks.flatMap((w) => w.lanes.flat());
    expect(allSegments).toHaveLength(0);
    const week = weeks.find((w) => w.timedByColumn.flat().some((c) => c.event.id === "timed"));
    expect(week).toBeDefined();
    const chip = week!.timedByColumn.flat()[0];
    expect(chip.event.id).toBe("timed");
  });

  it("overflows timed chips beyond maxTimedPerCell", () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      evt(`t-${i}`, "2026-05-14T15:00:00", "2026-05-14T16:00:00", { allDay: false }),
    );
    const weeks = buildMonthLayout(viewMonth, events, {
      weekStartsOn: 0,
      today,
      maxTimedPerCell: 2,
    });
    const week = weeks.find((w) => w.timedByColumn.flat().some((c) => c.event.id === "t-0"));
    expect(week).toBeDefined();
    expect(week!.timedByColumn.flat()).toHaveLength(2);
    expect(week!.overflowPerCell.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("keeps month display bounded with two all-day lanes and two timed rows", () => {
    const allDayEvents = Array.from({ length: 4 }, (_, i) =>
      evt(`a-${i}`, "2026-05-14T00:00:00", "2026-05-15T00:00:00"),
    );
    const timedEvents = Array.from({ length: 4 }, (_, i) =>
      evt(`t-${i}`, `2026-05-14T1${i}:00:00`, `2026-05-14T1${i}:30:00`, {
        allDay: false,
      }),
    );
    const weeks = buildMonthLayout(viewMonth, [...allDayEvents, ...timedEvents], {
      weekStartsOn: 0,
      today,
      maxLanes: 2,
      maxTimedPerCell: 2,
    });

    const week = weeks.find((w) => w.cells.some((cell) => cell.date.getDate() === 14));
    expect(week).toBeDefined();
    expect(week!.lanes).toHaveLength(2);
    expect(week!.timedByColumn.flat()).toHaveLength(2);
    expect(week!.overflowPerCell.reduce((sum, value) => sum + value, 0)).toBe(4);
  });
});
