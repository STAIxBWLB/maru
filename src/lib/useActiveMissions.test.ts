import { describe, expect, it } from "vitest";

import type { MissionRecord, MissionStatus } from "./types";
import {
  activeMissionSnapshot,
  nextActiveMissionSnapshot,
  nextTrackedMissionSnapshot,
  trackedMissionSnapshot,
} from "./useActiveMissions";

function mission(
  id: string,
  status: MissionStatus,
  startedAt = "2026-08-03T00:00:00Z",
  lastOutputAt = startedAt,
  kind = "skill",
): MissionRecord {
  return {
    id,
    kind,
    startedAt,
    lastOutputAt,
    status,
    exitCode: null,
    outputLogPath: null,
  };
}

describe("activeMissionSnapshot", () => {
  it("keeps only active missions, newest first, capped at twenty", () => {
    const records = Array.from({ length: 24 }, (_, index) =>
      mission(
        `mission-${index}`,
        index % 2 === 0 ? "running" : "idle",
        `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      ),
    );
    records.push(mission("done", "done", "2026-09-01T00:00:00Z"));

    const snapshot = activeMissionSnapshot(records);

    expect(snapshot).toHaveLength(20);
    expect(snapshot[0].id).toBe("mission-23");
    expect(snapshot.every((record) => record.status === "idle" || record.status === "running"))
      .toBe(true);
  });

  it("uses the latest record for a repeated mission id", () => {
    expect(
      activeMissionSnapshot([
        mission("same", "running", "2026-08-01T00:00:00Z"),
        mission("same", "idle", "2026-08-02T00:00:00Z"),
      ]),
    ).toEqual([mission("same", "idle", "2026-08-02T00:00:00Z")]);
  });
});

describe("nextActiveMissionSnapshot", () => {
  it("updates an active mission and removes it after completion", () => {
    const current = [mission("one", "idle"), mission("two", "running")];
    const running = nextActiveMissionSnapshot(current, mission("one", "running"));
    expect(running.find((record) => record.id === "one")?.status).toBe("running");

    const completed = nextActiveMissionSnapshot(running, mission("one", "done"));
    expect(completed.map((record) => record.id)).toEqual(["two"]);
  });
});

describe("trackedMissionSnapshot", () => {
  it("keeps only tracked agent missions, newest output first, capped at eighty", () => {
    const records = Array.from({ length: 84 }, (_, index) =>
      mission(
        `mission-${index}`,
        "running",
        "2026-08-01T00:00:00Z",
        `2026-08-${String((index % 28) + 1).padStart(2, "0")}T${String(
          Math.floor(index / 28),
        ).padStart(2, "0")}:00:00Z`,
      ),
    );
    records.push(mission("untracked", "running", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", "process"));

    const snapshot = trackedMissionSnapshot(records);

    expect(snapshot).toHaveLength(80);
    expect(snapshot[0].id).toBe("mission-83");
    expect(snapshot.some((record) => record.id === "untracked")).toBe(false);
  });

  it("sorts by lastOutputAt and breaks ties on startedAt, both descending", () => {
    const snapshot = trackedMissionSnapshot([
      mission("older-start", "running", "2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z"),
      mission("newer-start", "running", "2026-08-02T00:00:00Z", "2026-08-02T00:00:00Z"),
      mission("newer-output", "running", "2026-08-01T00:00:00Z", "2026-08-03T00:00:00Z"),
    ]);

    expect(snapshot.map((record) => record.id)).toEqual([
      "newer-output",
      "newer-start",
      "older-start",
    ]);
  });

  it("keeps structured-loop missions regardless of kind", () => {
    const structured: MissionRecord = {
      ...mission("structured", "running", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z", "process"),
      metadata: { origin: "structuredLoop" },
    };

    expect(trackedMissionSnapshot([structured]).map((record) => record.id)).toEqual(["structured"]);
  });
});

describe("nextTrackedMissionSnapshot", () => {
  it("dedupes by id and unshifts the update before re-sorting", () => {
    const current = [
      mission("one", "running", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"),
      mission("two", "running", "2026-08-02T00:00:00Z", "2026-08-02T00:00:00Z"),
    ];

    const snapshot = nextTrackedMissionSnapshot(
      current,
      mission("one", "done", "2026-08-01T00:00:00Z", "2026-08-03T00:00:00Z"),
    );

    expect(snapshot.map((record) => record.id)).toEqual(["one", "two"]);
    expect(snapshot[0].status).toBe("done");
  });

  it("caps the merged list at eighty records", () => {
    const current = Array.from({ length: 80 }, (_, index) =>
      mission(
        `mission-${index}`,
        "running",
        "2026-08-01T00:00:00Z",
        `2026-08-02T00:${String(index).padStart(2, "0")}:00Z`,
      ),
    );

    const snapshot = nextTrackedMissionSnapshot(
      current,
      mission("newest", "running", "2026-08-03T00:00:00Z", "2026-08-03T00:00:00Z"),
    );

    expect(snapshot).toHaveLength(80);
    expect(snapshot[0].id).toBe("newest");
  });

  it("drops the record when the update is not a tracked agent mission", () => {
    const snapshot = nextTrackedMissionSnapshot(
      [mission("one", "running")],
      mission("one", "done", "2026-08-03T00:00:00Z", "2026-08-03T00:00:00Z", "process"),
    );

    expect(snapshot).toEqual([]);
  });
});

describe("mission store slices", () => {
  it("derive active and tracked views independently from one snapshot", () => {
    const records = [
      mission("active-skill", "running", "2026-08-01T00:00:00Z"),
      mission("done-skill", "done", "2026-08-02T00:00:00Z"),
      mission("active-other", "running", "2026-08-03T00:00:00Z", "2026-08-03T00:00:00Z", "process"),
    ];

    expect(activeMissionSnapshot(records).map((record) => record.id)).toEqual([
      "active-other",
      "active-skill",
    ]);
    expect(trackedMissionSnapshot(records).map((record) => record.id)).toEqual([
      "done-skill",
      "active-skill",
    ]);
  });
});
