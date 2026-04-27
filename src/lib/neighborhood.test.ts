import { describe, expect, it } from "vitest";
import { buildNeighborhood } from "./neighborhood";
import type { DocumentPayload, VaultEntry } from "./types";

function entry(overrides: Partial<VaultEntry>): VaultEntry {
  return {
    path: `/vault/${overrides.relPath ?? "note.md"}`,
    relPath: "note.md",
    title: "Untitled",
    frontmatter: {},
    updatedAt: null,
    wordCount: 0,
    snippet: "",
    fileKind: "md",
    versionCount: 0,
    ...overrides,
  };
}

function document(overrides: Partial<DocumentPayload>): DocumentPayload {
  return {
    path: "/vault/current.md",
    relPath: "current.md",
    title: "Current",
    content: "",
    body: "",
    meta: {},
    fileKind: "md",
    ...overrides,
  };
}

describe("buildNeighborhood", () => {
  it("collects frontmatter wikilinks, body mentions, unresolved targets, and peers", () => {
    const current = document({
      meta: {
        type: "meeting",
        project: "[[Project Alpha]]",
        related: ["[[Person Lee]]", { nested: "[[Missing Person]]" }],
      },
    });
    const entries = [
      entry({ relPath: "current.md", title: "Current", frontmatter: { type: "meeting" } }),
      entry({
        relPath: "projects/alpha.md",
        title: "Project Alpha",
        frontmatter: { type: "project" },
      }),
      entry({ relPath: "people/lee.md", title: "Person Lee", frontmatter: { type: "person" } }),
      entry({
        relPath: "meetings/a.md",
        title: "Meeting A",
        frontmatter: { type: "meeting", project: "[[Project Alpha]]" },
        updatedAt: "2026-04-27T00:00:00Z",
      }),
      entry({
        relPath: "meetings/b.md",
        title: "Meeting B",
        frontmatter: { type: "meeting" },
        updatedAt: "2026-04-28T00:00:00Z",
      }),
    ];
    const draft =
      "---\ntype: meeting\n---\nDiscuss [[Person Lee]] and [[Missing Topic]]. [[Person Lee]]";

    const neighborhood = buildNeighborhood(current, draft, entries);

    expect(neighborhood.upward.map((field) => field.field)).toEqual(["project", "related"]);
    expect(neighborhood.upward[0].targets[0]).toMatchObject({
      title: "Project Alpha",
      relPath: "projects/alpha.md",
      target: "Project Alpha",
    });
    expect(neighborhood.upward[1].targets.map((target) => target.title)).toEqual([
      "Person Lee",
      "Missing Person",
    ]);
    expect(neighborhood.mentions.map((target) => target.title)).toEqual([
      "Person Lee",
      "Missing Topic",
    ]);
    expect(neighborhood.peers.map((peer) => peer.title)).toEqual(["Meeting A", "Meeting B"]);
  });
});
