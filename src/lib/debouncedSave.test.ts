import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createContextualDebouncedSaver,
  createDebouncedSaver,
  createSaveQueue,
} from "./debouncedSave";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createDebouncedSaver", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces scheduled saves to the last value", async () => {
    vi.useFakeTimers();
    const saved: number[] = [];
    const saver = createDebouncedSaver<number>((value) => {
      saved.push(value);
    }, 250);

    saver.schedule(1);
    saver.schedule(2);
    saver.schedule(3);
    await vi.advanceTimersByTimeAsync(249);
    expect(saved).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toEqual([3]);
  });

  it("flushes pending work immediately", async () => {
    vi.useFakeTimers();
    const saved: string[] = [];
    const saver = createDebouncedSaver<string>((value) => {
      saved.push(value);
    }, 250);

    saver.schedule("tree");
    await saver.flush();

    expect(saved).toEqual(["tree"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(saved).toEqual(["tree"]);
  });

  it("reports save failures without throwing from flush", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const saver = createDebouncedSaver<string>(
      () => {
        throw new Error("save failed");
      },
      250,
      (error) => errors.push(error),
    );

    saver.schedule("x");
    await saver.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it("recovers after a rejected save even when error reporting throws", async () => {
    vi.useFakeTimers();
    const saved: number[] = [];
    const saver = createDebouncedSaver<number>(
      async (value) => {
        saved.push(value);
        if (value === 1) {
          throw new Error("save failed");
        }
      },
      250,
      () => {
        throw new Error("report failed");
      },
    );

    saver.schedule(1);
    await expect(saver.flush()).resolves.toBeUndefined();
    saver.schedule(2);
    await expect(saver.flush()).resolves.toBeUndefined();
    expect(saved).toEqual([1, 2]);
  });

  it("serializes in-flight saves and keeps only the latest pending value", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const second = deferred<void>();
    const started: number[] = [];
    const saver = createDebouncedSaver<number>((value) => {
      started.push(value);
      return value === 1 ? first.promise : second.promise;
    }, 250);

    saver.schedule(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(started).toEqual([1]);

    saver.schedule(2);
    saver.schedule(3);
    await vi.advanceTimersByTimeAsync(250);
    expect(started).toEqual([1]);

    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([1, 3]);

    second.resolve();
    await saver.flush();
  });

  it("flushes through the current save and a pending save", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const second = deferred<void>();
    const started: string[] = [];
    const saver = createDebouncedSaver<string>((value) => {
      started.push(value);
      return value === "first" ? first.promise : second.promise;
    }, 250);

    saver.schedule("first");
    await vi.advanceTimersByTimeAsync(250);
    saver.schedule("second");
    const flush = saver.flush();

    expect(started).toEqual(["first"]);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["first", "second"]);

    let settled = false;
    void flush.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    second.resolve();
    await flush;
    expect(settled).toBe(true);
  });

  it("cancels a pending value without interrupting the active save", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const saved: string[] = [];
    const saver = createDebouncedSaver<string>((value) => {
      saved.push(value);
      return first.promise;
    }, 250);

    saver.schedule("active");
    await vi.advanceTimersByTimeAsync(250);
    saver.schedule("cancelled");
    saver.cancel();
    await vi.advanceTimersByTimeAsync(250);
    expect(saved).toEqual(["active"]);

    first.resolve();
    await saver.flush();
    expect(saved).toEqual(["active"]);
  });

  it("keeps the first schedule context while coalescing the latest value", async () => {
    vi.useFakeTimers();
    const saves: Array<{ value: number; context: { workPath: string; base: number } }> = [];
    const saver = createContextualDebouncedSaver(
      (value: number, context: { workPath: string; base: number }) => {
        saves.push({ value, context });
      },
      250,
    );

    saver.schedule(1, { workPath: "/first", base: 10 });
    saver.schedule(2, { workPath: "/second", base: 20 });
    await saver.flush();

    expect(saves).toEqual([{ value: 2, context: { workPath: "/first", base: 10 } }]);
  });

  it("serializes actual saves across saver instances", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const started: string[] = [];
    const queue = createSaveQueue();
    const firstSaver = createContextualDebouncedSaver(
      (value: string) => {
        started.push(value);
        return first.promise;
      },
      250,
      undefined,
      queue,
    );
    const secondSaver = createContextualDebouncedSaver(
      (value: string) => {
        started.push(value);
      },
      250,
      undefined,
      queue,
    );

    firstSaver.schedule("first", { id: 1 });
    const firstFlush = firstSaver.flush();
    await vi.advanceTimersByTimeAsync(0);
    secondSaver.schedule("second", { id: 2 });
    const secondFlush = secondSaver.flush();
    expect(started).toEqual(["first"]);

    first.resolve();
    await firstFlush;
    await secondFlush;
    expect(started).toEqual(["first", "second"]);
  });

  it("waits for shared queue work when a replacement saver has no pending work", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const started: string[] = [];
    const queue = createSaveQueue();
    const oldSaver = createContextualDebouncedSaver(
      (value: string, _context: { id: string }) => {
        started.push(value);
        return first.promise;
      },
      250,
      undefined,
      queue,
    );
    const replacementSaver = createContextualDebouncedSaver(
      (value: string, _context: { id: string }) => {
        started.push(value);
      },
      250,
      undefined,
      queue,
    );

    oldSaver.schedule("old", { id: "old" });
    const oldFlush = oldSaver.flush();
    const replacementFlush = replacementSaver.flush();
    let replacementSettled = false;
    void replacementFlush.then(() => {
      replacementSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["old"]);
    expect(replacementSettled).toBe(false);

    first.resolve();
    await oldFlush;
    await replacementFlush;
    expect(replacementSettled).toBe(true);
  });
});

describe("createDebouncedSaver settlement", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushSettled resolves clean on a fresh saver and calls save zero times", async () => {
    const save = vi.fn();
    const saver = createDebouncedSaver<string>(save, 250);

    await expect(saver.flushSettled()).resolves.toEqual({ status: "clean" });
    expect(save).not.toHaveBeenCalled();
  });

  it("flushSettled resolves saved after a resolving scheduled save", async () => {
    vi.useFakeTimers();
    const saver = createDebouncedSaver<string>(() => undefined, 250);

    saver.schedule("a");
    await expect(saver.flushSettled()).resolves.toEqual({ status: "saved" });
  });

  it("flushSettled resolves failed and retains the value for the next flush, without re-arming the timer", async () => {
    vi.useFakeTimers();
    const error = new Error("disk full");
    const save = vi.fn(() => {
      throw error;
    });
    const saver = createDebouncedSaver<string>(save, 250);

    saver.schedule("a");
    await expect(saver.flushSettled()).resolves.toEqual({ status: "failed", value: "a", error });
    expect(save).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledTimes(1);

    await saver.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("a");
  });

  it("keeps the newer value scheduled while a failing save is in flight, not the failed one", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const calls: string[] = [];
    const saver = createDebouncedSaver<string>((value) => {
      calls.push(value);
      return value === "a" ? first.promise : undefined;
    }, 250);

    saver.schedule("a");
    const flushA = saver.flushSettled();
    saver.schedule("b");
    first.reject(new Error("boom"));

    const settlementA = await flushA;
    expect(settlementA.status).toBe("failed");

    await saver.flush();
    expect(calls).toEqual(["a", "b"]);
  });

  it("performs exactly one save for two back-to-back flushSettled calls with one pending value", async () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const saver = createDebouncedSaver<string>(save, 250);

    saver.schedule("a");
    const [first, second] = await Promise.all([saver.flushSettled(), saver.flushSettled()]);

    expect(save).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ status: "saved" });
    expect(second).toEqual({ status: "saved" });
  });

  it("does not resurrect a failed save's stale value over an already-drained newer save on teardown flush (review finding #1)", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    let diskContent: string | null = null;
    let attemptsForA = 0;
    const saver = createDebouncedSaver<string>((value) => {
      if (value === "A") {
        attemptsForA += 1;
        // The first attempt is the one this test fails; a retry (driven by
        // the buggy resurrection this test targets) would succeed and must
        // never be allowed to land, since a newer save (B) already did.
        if (attemptsForA === 1) return first.promise;
        diskContent = value;
        return undefined;
      }
      diskContent = value;
      return undefined;
    }, 250);

    // A is scheduled and its debounce timer drains it while its save is
    // in flight (first.promise not yet settled).
    saver.schedule("A");
    await vi.advanceTimersByTimeAsync(250);
    expect(attemptsForA).toBe(1);

    // B is scheduled after A started saving; B's own debounce timer fires
    // and drains it too, queuing it behind A in the shared save queue —
    // B is no longer "pending" once this happens.
    saver.schedule("B");
    await vi.advanceTimersByTimeAsync(250);

    // A's in-flight save now fails.
    first.reject(new Error("disk full"));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // B's queued save landed once A settled.
    expect(diskContent).toBe("B");

    // A teardown/quit flush must not resurrect A's stale, already-failed
    // value and overwrite B's already-saved content.
    await saver.flushSettled();
    expect(diskContent).toBe("B");
  });

  it("settles an in-flight save then a newly-pending one in order on unmount-driven settle", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const second = deferred<void>();
    const started: string[] = [];
    const saver = createDebouncedSaver<string>((value) => {
      started.push(value);
      return value === "a" ? first.promise : second.promise;
    }, 250);

    saver.schedule("a");
    const flushA = saver.flush();
    await Promise.resolve();
    expect(started).toEqual(["a"]);
    saver.schedule("b");
    const settle = saver.flushSettled();

    first.resolve();
    await flushA;
    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);

    second.resolve();
    await expect(settle).resolves.toEqual({ status: "saved" });
  });
});
