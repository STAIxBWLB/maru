import { describe, expect, it } from "vitest";

import { EMPTY_DOT_SYNC_OVERVIEW, type DotSyncOverview, type DotSyncProfileStatus } from "./api";
import { deriveDotSyncBadge } from "./dotSync";

function profile(patch: Partial<DotSyncProfileStatus> = {}): DotSyncProfileStatus {
  return {
    schemaVersion: 1,
    kind: "mirror",
    profile: "sync",
    configured: true,
    workspacePath: "/work",
    storeDir: "/store",
    target: { kind: "local", spec: "local:/mirror", path: "/mirror" },
    localExists: true,
    targetExists: true,
    paused: false,
    lockHeld: false,
    owner: "mac-a",
    canPush: true,
    machineNames: ["mac-a"],
    filterMode: "include",
    allowCount: 0,
    submoduleCount: 0,
    propagation: { create: true, update: true, delete: false },
    maxDelete: 25,
    lastPullAt: null,
    lastPushAt: null,
    lastIntakeAt: null,
    conflictCount: 0,
    logPath: "/log",
    includePath: "/include",
    excludePath: "/exclude",
    ignorePath: "/ignore",
    allowPath: "/allow",
    jobs: [],
    ...patch,
  };
}

function overview(mirror = profile()): DotSyncOverview {
  return {
    cli: { ...EMPTY_DOT_SYNC_OVERVIEW.cli, available: true, compatible: true, version: "2.63.0" },
    mirror,
    peer: null,
  };
}

describe("deriveDotSyncBadge", () => {
  it("requests setup when dot is missing", () => {
    expect(deriveDotSyncBadge(EMPTY_DOT_SYNC_OVERVIEW)).toEqual({ state: "setup", scheduledJobs: 0 });
  });

  it("reports a healthy scheduled mirror", () => {
    const result = deriveDotSyncBadge(overview(profile({
      jobs: [{ id: "push", action: "push", label: "push", intervalSeconds: 600, mode: "clean", state: "running", lastRunAt: null }],
    })));
    expect(result).toEqual({ state: "scheduled", scheduledJobs: 1 });
  });

  it("reports active locks as syncing", () => {
    expect(deriveDotSyncBadge(overview(profile({ lockHeld: true }))).state).toBe("syncing");
  });

  it("reports ownership, conflicts, missing targets, and stopped jobs", () => {
    for (const patch of [
      { canPush: false },
      { conflictCount: 1 },
      { targetExists: false },
      { jobs: [{ id: "push", action: "push", label: "push", intervalSeconds: 600, mode: "clean", state: "stopped", lastRunAt: null }] },
    ]) {
      expect(deriveDotSyncBadge(overview(profile(patch))).state).toBe("attention");
    }
  });

  it("distinguishes intentional pause and manual mode", () => {
    expect(deriveDotSyncBadge(overview(profile({ paused: true }))).state).toBe("paused");
    expect(deriveDotSyncBadge(overview()).state).toBe("manual");
  });
});
