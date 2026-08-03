import { describe, expect, it } from "vitest";

import type { MissionRecord, MissionStatus } from "./types";
import {
  activeMissionSnapshot,
  nextActiveMissionSnapshot,
} from "./useActiveMissions";

function mission(
  id: string,
  status: MissionStatus,
  startedAt = "2026-08-03T00:00:00Z",
): MissionRecord {
  return {
    id,
    kind: "skill",
    startedAt,
    lastOutputAt: startedAt,
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
