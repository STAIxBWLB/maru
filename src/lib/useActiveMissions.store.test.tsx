// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { MissionRecord } from "./types";

vi.mock("./api", () => ({
  isTauri: () => false,
  listAiMissions: vi.fn(async (): Promise<MissionRecord[]> => [
    {
      id: "listed-done",
      kind: "skill",
      startedAt: "2026-08-01T00:00:00Z",
      lastOutputAt: "2026-08-01T00:00:00Z",
      status: "done",
      exitCode: 0,
      outputLogPath: null,
    },
  ]),
}));

import {
  ingestMissionUpdate,
  missionStoreLoadStamp,
  useTrackedMissions,
} from "./useActiveMissions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function Probe({ onValue }: { onValue: (missions: MissionRecord[]) => void }) {
  onValue(useTrackedMissions());
  return null;
}

describe("mission store load stamp", () => {
  it("bumps on each listAiMissions ingest but not on event ingests", async () => {
    const seen: MissionRecord[][] = [];
    const container = document.createElement("div");
    let root: Root | null = null;
    const stampBefore = missionStoreLoadStamp();

    await act(async () => {
      root = createRoot(container);
      root.render(<Probe onValue={(missions) => seen.push(missions)} />);
    });

    // The initial snapshot ingest bumps the stamp exactly once, so diff-based
    // consumers (App's mission-completion effect) reset their baseline instead
    // of replaying side effects for every listed record.
    expect(missionStoreLoadStamp()).toBe(stampBefore + 1);
    expect(seen.at(-1)?.map((mission) => mission.id)).toEqual(["listed-done"]);

    await act(async () => {
      ingestMissionUpdate({
        id: "event-mission",
        kind: "skill",
        startedAt: "2026-08-02T00:00:00Z",
        lastOutputAt: "2026-08-02T00:00:00Z",
        status: "running",
        exitCode: null,
        outputLogPath: null,
      });
    });
    expect(missionStoreLoadStamp()).toBe(stampBefore + 1);

    // Re-subscribing after the last consumer unmounts refetches the list and
    // bumps the stamp again (webview reload / StrictMode remount shape).
    await act(async () => {
      root?.unmount();
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<Probe onValue={(missions) => seen.push(missions)} />);
    });
    expect(missionStoreLoadStamp()).toBe(stampBefore + 2);
  });
});
