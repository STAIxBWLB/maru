import { describe, expect, it } from "vitest";
import { documentDisplayName } from "./document";

describe("documentDisplayName", () => {
  it("uses title by default", () => {
    expect(documentDisplayName({ title: "Project plan", relPath: "plans/project.md" }, "title")).toBe(
      "Project plan",
    );
  });

  it("can use the file name with extension", () => {
    expect(
      documentDisplayName({ title: "Project plan", relPath: "plans/project.md" }, "filename"),
    ).toBe("project.md");
  });
});
