import { describe, expect, it, vi } from "vitest";
import { canSwitchTaskDetails, taskRuntimeFallbackOrder } from "./TasksPane";

describe("TasksPane detail selection guard", () => {
  it("switches immediately when the detail drawer is clean", () => {
    const confirmDiscard = vi.fn(() => false);

    expect(canSwitchTaskDetails(false, confirmDiscard)).toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("requires confirmation before switching away from dirty details", () => {
    const reject = vi.fn(() => false);
    const accept = vi.fn(() => true);

    expect(canSwitchTaskDetails(true, reject)).toBe(false);
    expect(canSwitchTaskDetails(true, accept)).toBe(true);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
  });
});

describe("TasksPane runtime selection", () => {
  it("tries the configured Kimi or Kiro runtime before fallbacks", () => {
    expect(taskRuntimeFallbackOrder("kimi")).toEqual([
      "kimi",
      "claude",
      "codex",
      "kiro",
    ]);
    expect(taskRuntimeFallbackOrder("kiro")).toEqual([
      "kiro",
      "claude",
      "codex",
      "kimi",
    ]);
  });
});
