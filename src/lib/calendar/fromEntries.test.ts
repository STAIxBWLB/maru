import { describe, expect, it } from "vitest";
import type { TaskEntry } from "../tasks";
import { toUnifiedTaskEvents } from "./fromEntries";

describe("toUnifiedTaskEvents", () => {
  it("converts due-only tasks to all-day events", () => {
    const [event] = toUnifiedTaskEvents([task({ due: "2026-05-14" })]);

    expect(event.allDay).toBe(true);
    expect(event.start.getFullYear()).toBe(2026);
    expect(event.start.getMonth()).toBe(4);
    expect(event.start.getDate()).toBe(14);
    expect(event.end.getDate()).toBe(15);
  });

  it("converts calendarStart/calendarEnd tasks to timed events", () => {
    const [event] = toUnifiedTaskEvents([
      task({
        calendarStart: "2026-05-14T15:00:00+09:00",
        calendarEnd: "2026-05-14T16:30:00+09:00",
      }),
    ]);

    expect(event.allDay).toBe(false);
    expect(event.start.toISOString()).toBe("2026-05-14T06:00:00.000Z");
    expect(event.end.toISOString()).toBe("2026-05-14T07:30:00.000Z");
  });
});

function task(overrides: Partial<TaskEntry>): TaskEntry {
  return {
    absPath: "/work/tasks/active/sample.md",
    relPath: "tasks/active/sample.md",
    fileName: "sample.md",
    bucket: "active",
    title: "Sample task",
    status: "active",
    priority: "medium",
    project: null,
    topics: [],
    due: null,
    calendarStart: null,
    calendarEnd: null,
    size: 1,
    modifiedAt: null,
    frontmatter: {},
    ...overrides,
  };
}
