import { beforeEach, describe, expect, it, vi } from "vitest";

const idle: Array<() => void> = [];
const loads: string[] = [];
const failing = new Set<string>();
const unavailable = new Set<string>();

vi.mock("./startupProfile", () => ({
  scheduleStartupIdle: (work: () => void) => {
    idle.push(work);
    return () => {
      const index = idle.indexOf(work);
      if (index >= 0) idle.splice(index, 1);
    };
  },
}));

vi.mock("./modeRegistry", () => ({
  getRegisteredModeIds: () => ["a", "b", "c"],
  getModeDescriptor: (id: string) =>
    id
      ? {
          isAvailable: () => !unavailable.has(id),
          load: () => {
            loads.push(id);
            return failing.has(id) ? Promise.reject(new Error(id)) : Promise.resolve({});
          },
        }
      : null,
}));

const { scheduleModePreload } = await import("./modePreload");

/** Fire the pending idle callback and let its load settle. */
async function runIdle() {
  idle.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  idle.length = 0;
  loads.length = 0;
  failing.clear();
  unavailable.clear();
});

describe("scheduleModePreload", () => {
  it("warms one mode per idle callback, in registry order", async () => {
    scheduleModePreload();
    expect(loads).toEqual([]);
    await runIdle();
    expect(loads).toEqual(["a"]);
    expect(idle).toHaveLength(1);
    await runIdle();
    await runIdle();
    expect(loads).toEqual(["a", "b", "c"]);
    expect(idle).toHaveLength(0);
  });

  it("skips unavailable modes and keeps going after a failed load", async () => {
    unavailable.add("a");
    failing.add("b");
    scheduleModePreload();
    await runIdle();
    await runIdle();
    await runIdle();
    expect(loads).toEqual(["b", "c"]);
    expect(idle).toHaveLength(0);
  });

  it("cancel stops the remaining queue, including after an in-flight load", async () => {
    const cancel = scheduleModePreload();
    idle.shift()?.();
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loads).toEqual(["a"]);
    expect(idle).toHaveLength(0);
  });
});
