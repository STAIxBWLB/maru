// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  DIAGRAM_EXPORT_FOLDER_STORAGE_KEY,
  chooseExportDefaultPath,
  exportFolderOf,
  joinPath,
  readLastExportFolder,
  rememberExportFolder,
} from "./exportFolder";

const base = {
  workspace: "/work/repo",
  fileName: "Weekly-chart.svg",
  lastFolder: null,
  diagramsInUse: false,
  downloadsDir: null,
};

describe("chooseExportDefaultPath", () => {
  it("uses the folder the user last saved into, ahead of every fallback", () => {
    expect(
      chooseExportDefaultPath({
        ...base,
        lastFolder: "/work/repo/exports",
        diagramsInUse: true,
        downloadsDir: "/Users/me/Downloads",
      }),
    ).toBe("/work/repo/exports/Weekly-chart.svg");
  });

  it("uses <workspace>/diagrams while that folder holds saved diagrams", () => {
    expect(
      chooseExportDefaultPath({ ...base, diagramsInUse: true, downloadsDir: "/Users/me/Downloads" }),
    ).toBe("/work/repo/diagrams/Weekly-chart.svg");
  });

  it("uses the Downloads folder when nothing else is known", () => {
    expect(chooseExportDefaultPath({ ...base, downloadsDir: "/Users/me/Downloads" })).toBe(
      "/Users/me/Downloads/Weekly-chart.svg",
    );
  });

  it("passes no directory hint when no folder is known, never a missing one", () => {
    expect(chooseExportDefaultPath(base)).toBeNull();
  });

  it("keeps a Windows folder's separator style", () => {
    expect(
      chooseExportDefaultPath({
        ...base,
        workspace: "C:\\work\\repo",
        diagramsInUse: true,
      }),
    ).toBe("C:\\work\\repo\\diagrams\\Weekly-chart.svg");
    expect(chooseExportDefaultPath({ ...base, downloadsDir: "C:\\Users\\me\\Downloads" })).toBe(
      "C:\\Users\\me\\Downloads\\Weekly-chart.svg",
    );
  });
});

describe("joinPath", () => {
  it("does not duplicate a trailing separator", () => {
    expect(joinPath("/work/repo/", "a.svg")).toBe("/work/repo/a.svg");
    expect(joinPath("C:\\work\\repo\\", "a.svg")).toBe("C:\\work\\repo\\a.svg");
  });

  it("keeps a bare root separator", () => {
    expect(joinPath("/", "a.svg")).toBe("/a.svg");
  });

  it("returns the name alone for an empty folder", () => {
    expect(joinPath("", "a.svg")).toBe("a.svg");
  });
});

describe("exportFolderOf", () => {
  it("reads the folder of a POSIX path", () => {
    expect(exportFolderOf("/work/repo/exports/a.svg")).toBe("/work/repo/exports");
    expect(exportFolderOf("/a.svg")).toBe("/");
  });

  it("reads the folder of a Windows path", () => {
    expect(exportFolderOf("C:\\work\\repo\\a.svg")).toBe("C:\\work\\repo");
  });

  it("returns null when the path has no folder", () => {
    expect(exportFolderOf("a.svg")).toBeNull();
  });
});

describe("rememberExportFolder", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("remembers the confirmed folder per workspace", () => {
    rememberExportFolder("/work/a", "/elsewhere/exports/first.svg");
    expect(readLastExportFolder("/work/a")).toBe("/elsewhere/exports");
    expect(readLastExportFolder("/work/b")).toBeNull();
  });

  it("replaces the remembered folder with the next confirmed one", () => {
    rememberExportFolder("/work/a", "/work/a/diagrams/first.svg");
    rememberExportFolder("/work/a", "/Users/me/Downloads/second.svg");
    expect(readLastExportFolder("/work/a")).toBe("/Users/me/Downloads");
  });

  it("records nothing for a path without a folder or without a workspace", () => {
    rememberExportFolder("/work/a", "first.svg");
    rememberExportFolder("  ", "/elsewhere/exports/first.svg");
    expect(window.localStorage.getItem(`${DIAGRAM_EXPORT_FOLDER_STORAGE_KEY}:/work/a`)).toBeNull();
  });

  it("returns null without a workspace", () => {
    expect(readLastExportFolder(null)).toBeNull();
    expect(readLastExportFolder("   ")).toBeNull();
  });
});
