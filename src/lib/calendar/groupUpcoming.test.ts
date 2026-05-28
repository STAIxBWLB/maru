import { describe, expect, it } from "vitest";
import { groupCalendarRangeEvents, groupUpcomingEvents } from "./groupUpcoming";
import type { UnifiedCalendarEvent } from "./types";

function evt(id: string, start: string, allDay = true): UnifiedCalendarEvent {
  const startDate = new Date(start);
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 1);
  return {
    id,
    title: id,
    start: startDate,
    end: endDate,
    allDay,
    category: "priority-medium",
    source: "task",
    resource: {},
  };
}

describe("groupCalendarRangeEvents", () => {
  const today = new Date("2026-05-14T08:00:00");

  it("shows events in the visible month even when they are before today", () => {
    const groups = groupCalendarRangeEvents(
      [
        evt("april", "2026-04-01T00:00:00"),
        evt("may", "2026-05-01T00:00:00"),
      ],
      {
        view: "month",
        viewDate: new Date("2026-04-10T12:00:00"),
        weekStartsOn: 1,
        today,
        locale: "en",
      },
    );
    expect(groups.map((group) => group.events[0].id)).toEqual(["april"]);
    expect(groups[0].dateLabel).toBe("Apr 1, 2026");
  });

  it("emits TODAY / TOMORROW for visible range dates (en)", () => {
    const groups = groupCalendarRangeEvents(
      [
        evt("a", "2026-05-14T00:00:00"),
        evt("b", "2026-05-15T00:00:00"),
      ],
      {
        view: "week",
        viewDate: today,
        weekStartsOn: 1,
        today,
        locale: "en",
      },
    );
    expect(groups[0].label).toBe("TODAY");
    expect(groups[1].label).toBe("TOMORROW");
  });

  it("emits 오늘 / 내일 for ko locale", () => {
    const groups = groupCalendarRangeEvents(
      [
        evt("a", "2026-05-14T00:00:00"),
        evt("b", "2026-05-15T00:00:00"),
      ],
      {
        view: "week",
        viewDate: today,
        weekStartsOn: 1,
        today,
        locale: "ko",
      },
    );
    expect(groups[0].label).toBe("오늘");
    expect(groups[1].label).toBe("내일");
  });

  it("uses day-of-week labels for dates beyond tomorrow", () => {
    const groups = groupCalendarRangeEvents(
      [evt("z", "2026-05-21T00:00:00")],
      {
        view: "month",
        viewDate: today,
        weekStartsOn: 1,
        today,
        locale: "en",
      },
    );
    expect(groups[0].label).toBe("THU");
    expect(groups[0].dateLabel).toBe("May 21, 2026");
  });

  it("skips events outside the visible day", () => {
    const groups = groupCalendarRangeEvents(
      [
        evt("before", "2026-05-13T00:00:00"),
        evt("ok", "2026-05-14T00:00:00"),
        evt("after", "2026-05-15T00:00:00"),
      ],
      {
        view: "day",
        viewDate: today,
        weekStartsOn: 1,
        today,
        locale: "en",
      },
    );
    expect(groups.map((g) => g.events[0].id)).toEqual(["ok"]);
  });

  it("groups multiple events on the same day under one bucket", () => {
    const groups = groupCalendarRangeEvents(
      [
        evt("first", "2026-05-14T09:00:00", false),
        evt("second", "2026-05-14T15:00:00", false),
      ],
      {
        view: "day",
        viewDate: today,
        weekStartsOn: 1,
        today,
        locale: "en",
      },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].events.map((e) => e.id)).toEqual(["first", "second"]);
  });

  it("places overlapping multi-day events under the first visible range date", () => {
    const start = new Date("2026-03-30T00:00:00");
    const end = new Date("2026-04-03T00:00:00");
    const multi: UnifiedCalendarEvent = {
      id: "mlt",
      title: "Long event",
      start,
      end,
      allDay: true,
      category: "priority-high",
      source: "meeting",
      resource: {},
    };
    const groups = groupCalendarRangeEvents([multi], {
      view: "month",
      viewDate: new Date("2026-04-10T12:00:00"),
      weekStartsOn: 1,
      today,
      locale: "en",
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].dateISO).toBe("2026-04-01");
  });
});

describe("groupUpcomingEvents", () => {
  it("keeps the legacy rolling horizon helper", () => {
    const today = new Date("2026-05-14T08:00:00");
    const groups = groupUpcomingEvents(
      [
        evt("past", "2026-05-10T00:00:00"),
        evt("future", "2026-07-30T00:00:00"),
        evt("ok", "2026-05-20T00:00:00"),
      ],
      { today, locale: "en", horizonDays: 30 },
    );
    expect(groups.map((g) => g.events[0].id)).toEqual(["ok"]);
  });
});
