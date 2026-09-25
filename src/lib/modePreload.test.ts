import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const idle: Array<() => void> = [];
const timeouts: number[] = [];
const loads: string[] = [];
const failing = new Set<string>();
const unavailable = new Set<string>();

vi.mock("./startupProfile", () => ({
  scheduleStartupIdle: (work: () => void, timeout: number) => {
    idle.push(work);
    timeouts.push(timeout);
    return () => {
      const index = idle.indexOf(work);
      if (index >= 0) idle.splice(index, 1);
    };
  },
}));

vi.mock("./modeRegistry", () => ({
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

const { PRELOAD_MODE_IDS, scheduleModePreload } = await import("./modePreload");
const ids = ["a", "b", "c"];

/** Fire the pending idle callback and let its load settle. */
async function runIdle() {
  idle.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  idle.length = 0;
  timeouts.length = 0;
  loads.length = 0;
  failing.clear();
  unavailable.clear();
});

describe("scheduleModePreload", () => {
  it("defaults to the six split modes only (D-03 as amended in #340)", async () => {
    expect(PRELOAD_MODE_IDS).toEqual(["today", "tasks", "meetings", "drafts", "gap", "agents"]);
    scheduleModePreload();
    for (let i = 0; i < PRELOAD_MODE_IDS.length; i += 1) await runIdle();
    expect(loads).toEqual([...PRELOAD_MODE_IDS]);
    expect(idle).toHaveLength(0);
  });

  it("warms one mode per idle callback, in list order", async () => {
    scheduleModePreload(ids);
    expect(loads).toEqual([]);
    await runIdle();
    expect(loads).toEqual(["a"]);
    expect(idle).toHaveLength(1);
    await runIdle();
    await runIdle();
    expect(loads).toEqual(["a", "b", "c"]);
    expect(idle).toHaveLength(0);
    // No requestIdleCallback here (the WKWebView case): later steps stay short.
    expect(timeouts).toEqual([2000, 250, 250]);
  });

  it("keeps the 2000ms idle cap between steps where requestIdleCallback exists", async () => {
    vi.stubGlobal("window", { requestIdleCallback: () => 0 });
    scheduleModePreload(ids);
    await runIdle();
    await runIdle();
    await runIdle();
    expect(timeouts).toEqual([2000, 2000, 2000]);
  });

  it("skips unavailable modes and keeps going after a failed load", async () => {
    unavailable.add("a");
    failing.add("b");
    scheduleModePreload(ids);
    await runIdle();
    await runIdle();
    await runIdle();
    expect(loads).toEqual(["b", "c"]);
    expect(idle).toHaveLength(0);
  });

  it("cancel stops the remaining queue, including after an in-flight load", async () => {
    const cancel = scheduleModePreload(ids);
    idle.shift()?.();
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loads).toEqual(["a"]);
    expect(idle).toHaveLength(0);
  });
});
