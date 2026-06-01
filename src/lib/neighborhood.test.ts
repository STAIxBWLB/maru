import { describe, expect, it } from "vitest";
import { buildBacklinks, buildNeighborhood } from "./neighborhood";
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

describe("buildBacklinks", () => {
  it("finds notes whose links resolve to the open document, by title or path", () => {
    const current = document({ path: "/vault/projects/alpha.md", relPath: "projects/alpha.md" });
    const entries = [
      entry({
        path: "/vault/projects/alpha.md",
        relPath: "projects/alpha.md",
        title: "Project Alpha",
      }),
      // Links by title.
      entry({
        path: "/vault/meetings/a.md",
        relPath: "meetings/a.md",
        title: "Meeting A",
        updatedAt: "2026-04-27T00:00:00Z",
        links: ["Project Alpha"],
      }),
      // Links by relative path (no extension).
      entry({
        path: "/vault/meetings/b.md",
        relPath: "meetings/b.md",
        title: "Meeting B",
        updatedAt: "2026-04-28T00:00:00Z",
        links: ["projects/alpha"],
      }),
      // Links elsewhere — must not appear.
      entry({
        path: "/vault/meetings/c.md",
        relPath: "meetings/c.md",
        title: "Meeting C",
        links: ["Some Other Note"],
      }),
      // No links at all.
      entry({ path: "/vault/notes/d.md", relPath: "notes/d.md", title: "Note D" }),
    ];

    const backlinks = buildBacklinks(current, entries);

    // Newest first; self excluded; only resolving links included.
    expect(backlinks.map((b) => b.title)).toEqual(["Meeting B", "Meeting A"]);
  });

  it("returns nothing when no note links here", () => {
    const current = document({ path: "/vault/lonely.md", relPath: "lonely.md" });
    const entries = [
      entry({ path: "/vault/lonely.md", relPath: "lonely.md", title: "Lonely" }),
      entry({ path: "/vault/other.md", relPath: "other.md", title: "Other", links: ["Nope"] }),
    ];
    expect(buildBacklinks(current, entries)).toEqual([]);
  });
});
