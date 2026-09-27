import { describe, expect, it, vi } from "vitest";
import { canSwitchTaskDetails } from "./TasksPane";

describe("TasksPane detail selection guard", () => {
  it("switches immediately when the detail drawer is clean", async () => {
    const confirmDiscard = vi.fn(async () => false);

    await expect(canSwitchTaskDetails(false, confirmDiscard)).resolves.toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("requires confirmation before switching away from dirty details", async () => {
    const reject = vi.fn(async () => false);
    const accept = vi.fn(async () => true);

    await expect(canSwitchTaskDetails(true, reject)).resolves.toBe(false);
    await expect(canSwitchTaskDetails(true, accept)).resolves.toBe(true);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
  });
});
