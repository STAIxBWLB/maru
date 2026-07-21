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

  it("fires quietMs after the last dirty mark even when the interval is long", () => {
    const onFire = vi.fn();
    const sched = createAutoSnapshotScheduler({
      enabled: true,
      intervalMs: 10_000,
      quietMs: 50,
      getDoc: () => createEmptyDoc("d", 1),
      onFire,
    });
    sched.markDirty();
    vi.advanceTimersByTime(49);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
    sched.dispose();
  });

  it("debounces a flurry of dirty marks into a single fire", () => {
    const onFire = vi.fn();
    const sched = createAutoSnapshotScheduler({
      enabled: true,
      intervalMs: 10_000,
      quietMs: 100,
      getDoc: () => createEmptyDoc("d", 1),
      onFire,
    });
    // Burst: a mark every 50 ms — each one resets the quiet timer.
    for (let i = 0; i < 5; i += 1) {
      sched.markDirty();
      vi.advanceTimersByTime(50);
      expect(onFire).not.toHaveBeenCalled();
    }
    vi.advanceTimersByTime(100);
    expect(onFire).toHaveBeenCalledTimes(1);
    sched.dispose();
  });

  it("re-arms after firing: a later dirty mark snapshots again", () => {
    const onFire = vi.fn();
    const sched = createAutoSnapshotScheduler({
      enabled: true,
      intervalMs: 10_000,
      quietMs: 100,
      getDoc: () => createEmptyDoc("d", 1),
      onFire,
    });
    sched.markDirty();
    vi.advanceTimersByTime(100);
    expect(onFire).toHaveBeenCalledTimes(1);
    sched.markDirty();
    vi.advanceTimersByTime(100);
    expect(onFire).toHaveBeenCalledTimes(2);
    sched.dispose();
  });

  it("interval still fires during non-stop editing (max-wait fallback)", () => {
    const onFire = vi.fn();
    const sched = createAutoSnapshotScheduler({
      enabled: true,
      intervalMs: 200,
      quietMs: 150,
      getDoc: () => createEmptyDoc("d", 1),
      onFire,
    });
    sched.markDirty();
    vi.advanceTimersByTime(100);
    sched.markDirty(); // resets quiet timer to t=250
    vi.advanceTimersByTime(100); // t=200 — interval fires first
    expect(onFire).toHaveBeenCalledTimes(1);
    sched.markDirty();
    vi.advanceTimersByTime(150); // quiet fire
    expect(onFire).toHaveBeenCalledTimes(2);
    sched.dispose();
  });
});
