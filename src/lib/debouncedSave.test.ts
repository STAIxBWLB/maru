import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebouncedSaver } from "./debouncedSave";

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
});
