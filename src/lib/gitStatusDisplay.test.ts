import { describe, expect, it } from "vitest";
import { formatGitStatusDisplay } from "./gitStatusDisplay";
import type { GitStatus } from "./types";

function status(overrides: Partial<GitStatus>): GitStatus {
  return {
    isRepo: true,
    modified: 0,
    staged: 0,
    untracked: 0,
    untrackedKnown: true,
    clean: true,
    branch: "main",
    ...overrides,
  };
}

describe("formatGitStatusDisplay", () => {
  it("shows a pending marker while fast status has not counted untracked files", () => {
    const display = formatGitStatusDisplay(
      status({
        modified: 4,
        untrackedKnown: false,
        clean: false,
      }),
    );

    expect(display.pendingUntracked).toBe(true);
    expect(display.total).toBe(4);
    expect(display.tooltip).toContain("4 modified");
    expect(display.tooltip).toContain("checking new files");
  });

  it("formats full dirty status with staged, modified, new, and total counts", () => {
    const display = formatGitStatusDisplay(
      status({
        modified: 4,
        untracked: 10,
        clean: false,
      }),
    );

    expect(display.staged).toBe(0);
    expect(display.modified).toBe(4);
    expect(display.untracked).toBe(10);
    expect(display.total).toBe(14);
    expect(display.tooltip).toBe(
      "main · 0 staged · 4 modified · 10 new (14 total) · click to commit",
    );
  });

  it("formats full clean status with branch and clean state", () => {
    const display = formatGitStatusDisplay(status({ clean: true }));

    expect(display.dirty).toBe(false);
    expect(display.total).toBe(0);
    expect(display.tooltip).toBe("main · tracked clean · 0 new");
  });
});
