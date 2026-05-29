import { describe, expect, it } from "vitest";
import { documentDisplayName, labelFileStem, resolveDisplayLabel } from "./document";

describe("documentDisplayName", () => {
  it("uses title by default", () => {
    expect(documentDisplayName({ title: "Project plan", relPath: "plans/project.md" }, "title")).toBe(
      "Project plan",
    );
  });

  it("uses the file name stem (without .md) in filename mode", () => {
    expect(
      documentDisplayName({ title: "Project plan", relPath: "plans/project.md" }, "filename"),
    ).toBe("project");
  });

  it("returns the title (primary) in both mode", () => {
    expect(
      documentDisplayName({ title: "Project plan", relPath: "plans/project.md" }, "both"),
    ).toBe("Project plan");
  });
});

describe("labelFileStem", () => {
  it("returns the last path segment without a trailing .md", () => {
    expect(labelFileStem("tasks/calendar/260527-1100-robotis.md")).toBe("260527-1100-robotis");
    expect(labelFileStem("260527-1100-robotis.md")).toBe("260527-1100-robotis");
  });

  it("keeps non-md extensions", () => {
    expect(labelFileStem("diagrams/flow.canvas")).toBe("flow.canvas");
  });
});

describe("resolveDisplayLabel", () => {
  const title = "RISE Y2 수정사업계획";
  const fileName = "260529-1530-rise-y2.md";

  it("title mode shows the title only", () => {
    expect(resolveDisplayLabel(title, fileName, "title")).toEqual({
      primary: title,
      secondary: null,
    });
  });

  it("filename mode shows the stem only", () => {
    expect(resolveDisplayLabel(title, fileName, "filename")).toEqual({
      primary: "260529-1530-rise-y2",
      secondary: null,
    });
  });

  it("both mode shows the title primary and filename stem secondary", () => {
    expect(resolveDisplayLabel(title, fileName, "both")).toEqual({
      primary: title,
      secondary: "260529-1530-rise-y2",
    });
  });

  it("falls back to the filename stem when the title is empty", () => {
    expect(resolveDisplayLabel("", fileName, "title")).toEqual({
      primary: "260529-1530-rise-y2",
      secondary: null,
    });
    // No duplicate secondary when primary already equals the stem.
    expect(resolveDisplayLabel("", fileName, "both")).toEqual({
      primary: "260529-1530-rise-y2",
      secondary: null,
    });
  });
});
