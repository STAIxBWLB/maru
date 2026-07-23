import { describe, expect, it } from "vitest";
import { resolveTaskProject, resolveTaskProjects } from "./taskProjectLabels";
import type { ProjectPickerEntry } from "./types";

const projects: ProjectPickerEntry[] = [
  {
    id: "collabs-saltlux",
    name: "솔트룩스 협력",
    path: "projects/collabs-saltlux",
    status: "active",
    vaultNote: "agentic-ai-education-platform-with-saltlux-luxia",
  },
  {
    id: "rise",
    name: "RISE 사업",
    path: "projects/rise",
    status: "active",
    vaultNote: "rise",
  },
];

describe("task project labels", () => {
  it("uses explicit aliases without changing registry identity", () => {
    expect(resolveTaskProject("[[rise|지역혁신]]", projects)).toEqual({
      raw: "[[rise|지역혁신]]",
      key: "registry:rise",
      label: "지역혁신",
      resolution: "alias",
    });
  });

  it("resolves registry ids and unique vault-note aliases", () => {
    expect(resolveTaskProject("rise", projects)).toMatchObject({
      key: "registry:rise",
      label: "RISE 사업",
    });
    expect(
      resolveTaskProject("[[agentic-ai-education-platform-with-saltlux-luxia]]", projects),
    ).toMatchObject({
      key: "registry:collabs-saltlux",
      label: "솔트룩스 협력",
    });
  });

  it("does not choose an ambiguous vault-note alias", () => {
    const ambiguous = [
      {
        id: "project-one",
        name: "Project One",
        path: "projects/one",
        status: "active",
        vaultNote: "shared-note",
      },
      {
        id: "project-two",
        name: "Project Two",
        path: "projects/two",
        status: "archived",
        vaultNote: "shared-note",
      },
    ];
    expect(resolveTaskProject("[[shared-note]]", ambiguous)).toMatchObject({
      key: "raw:shared-note",
      label: "Shared note",
      resolution: "fallback",
    });
  });

  it("humanizes unresolved values and deduplicates equivalent references", () => {
    expect(resolveTaskProject("[[admin-ai-innovation]]")).toMatchObject({
      key: "raw:admin-ai-innovation",
      label: "Admin AI innovation",
    });
    expect(resolveTaskProjects(["rise", "[[rise]]"])).toHaveLength(1);
  });
});
