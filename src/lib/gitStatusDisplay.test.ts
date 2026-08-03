import { describe, expect, it } from "vitest";
import { buildGitDecorations, formatGitStatusDisplay } from "./gitStatusDisplay";
import type { GitFileChange, GitStatus } from "./types";

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

describe("buildGitDecorations", () => {
  it("maps supported worktree states and normalizes path separators", () => {
    const changes: GitFileChange[] = [
      {
        path: "src\\App.tsx",
        indexStatus: " ",
        worktreeStatus: "M",
        staged: false,
        untracked: false,
      },
      {
        path: "new.md",
        indexStatus: "?",
        worktreeStatus: "?",
        staged: false,
        untracked: true,
      },
      {
        path: "renamed.md",
        indexStatus: "R",
        worktreeStatus: " ",
        staged: true,
        untracked: false,
      },
      {
        path: "ignored.md",
        indexStatus: "C",
        worktreeStatus: " ",
        staged: true,
        untracked: false,
      },
    ];

    expect(Array.from(buildGitDecorations(changes))).toEqual([
      ["src/App.tsx", "M"],
      ["new.md", "U"],
      ["renamed.md", "R"],
    ]);
  });

  it("prefers a worktree state over an index state", () => {
    expect(
      buildGitDecorations([
        {
          path: "mixed.md",
          indexStatus: "A",
          worktreeStatus: "D",
          staged: true,
          untracked: false,
        },
      ]).get("mixed.md"),
    ).toBe("D");
  });
});
