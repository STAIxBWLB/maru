import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAutoSnapshotScheduler, formatSnapshotTs } from "./versionHistory";
import { createEmptyDoc } from "./types";

describe("formatSnapshotTs", () => {
  it("emits compact filesystem-safe stamp", () => {
    const ts = formatSnapshotTs(new Date("2026-05-26T20:49:00.000Z"));
    expect(ts).toBe("20260526T204900Z");
  });
});

describe("createAutoSnapshotScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fire when not dirty", () => {
    const onFire = vi.fn();
    const sched = createAutoSnapshotScheduler({
      enabled: true,
      intervalMs: 100,
      quietMs: 10,
      getDoc: () => createEmptyDoc("d", 1),
      onFire,
    });
    vi.advanceTimersByTime(500);
    expect(onFire).not.toHaveBeenCalled();
    sched.dispose();
  });

  it("fires after interval when dirty", () => {
    const onFire = vi.fn();
    const sched = createAutoSnapshotScheduler({
      enabled: true,
      intervalMs: 100,
      quietMs: 10,
      getDoc: () => createEmptyDoc("d", 1),
      onFire,
    });
    sched.markDirty();
    vi.advanceTimersByTime(120);
    expect(onFire).toHaveBeenCalledTimes(1);
    sched.dispose();
  });

  it("markClean cancels pending fire", () => {
    const onFire = vi.fn();
    const sched = createAutoSnapshotScheduler({
      enabled: true,
      intervalMs: 100,
      quietMs: 10,
      getDoc: () => createEmptyDoc("d", 1),
      onFire,
    });
    sched.markDirty();
    sched.markClean();
    vi.advanceTimersByTime(500);
    expect(onFire).not.toHaveBeenCalled();
    sched.dispose();
  });

  it("dispose stops further fires", () => {
    const onFire = vi.fn();
    const sched = createAutoSnapshotScheduler({
      enabled: true,
      intervalMs: 50,
      quietMs: 5,
      getDoc: () => createEmptyDoc("d", 1),
      onFire,
    });
    sched.markDirty();
    sched.dispose();
    vi.advanceTimersByTime(500);
    expect(onFire).not.toHaveBeenCalled();
  });
});
