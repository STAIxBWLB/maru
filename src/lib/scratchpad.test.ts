import { describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
  default: {
    sanitize: (html: string, config?: { FORBID_TAGS?: string[]; FORBID_ATTR?: string[] }) => {
      let result = html.replace(/<script[\s\S]*?<\/script>/gi, "");
      for (const tag of config?.FORBID_TAGS ?? []) {
        result = result.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
        result = result.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), "");
      }
      for (const attribute of config?.FORBID_ATTR ?? []) {
        result = result.replace(new RegExp(`\\s${attribute.replace(":", "\\:")}=(?:"[^"]*"|'[^']*')`, "gi"), "");
      }
      return result;
    },
  },
}));
import {
  filterScratchpadEntries,
  groupScratchpadEntries,
  renderScratchpadMarkdown,
  clearScratchpadDraft,
  newMemoRelativePath,
  readScratchpadDraft,
  scratchpadCopyPath,
  scratchpadPathForFormat,
  sortScratchpadEntries,
  writeScratchpadDraft,
} from "./scratchpad";
import type { ScratchpadEntry } from "./types";

function entry(patch: Partial<ScratchpadEntry>): ScratchpadEntry {
  return {
    collection: "memos",
    relativePath: "memo.md",
    name: "memo.md",
    source: "maru",
    format: "markdown",
    updatedAt: "2026-07-22T01:00:00Z",
    sizeBytes: 12,
    preview: "memo body",
    revision: "abc",
    stale: false,
    editable: true,
    ...patch,
  };
}

describe("scratchpad helpers", () => {
  it("groups collections in durable-first order and temp by provider", () => {
    const groups = groupScratchpadEntries([
      entry({ collection: "temp", source: "codex", relativePath: "codex/a.md" }),
      entry({ collection: "ideation", source: "manual", ideationStage: "proposal", relativePath: "proposals/a.md" }),
      entry({ collection: "memos", relativePath: "memo.md" }),
      entry({ collection: "ideation", source: "manual", ideationStage: "seed", relativePath: "seeds/b.md" }),
    ]);

    expect(groups.map((group) => group.collection)).toEqual(["ideation", "memos", "temp"]);
    expect(groups[0].groups.map((group) => group.id)).toEqual(["seed", "proposal"]);
    expect(groups[2].groups[0].id).toBe("codex");
  });

  it("searches path, preview, source, and stage", () => {
    const entries = [
      entry({ collection: "temp", source: "claude", relativePath: "claude/outline.md" }),
      entry({ collection: "ideation", source: "manual", ideationStage: "developing", preview: "agent memory" }),
    ];
    expect(filterScratchpadEntries(entries, "CLAUDE")).toHaveLength(1);
    expect(filterScratchpadEntries(entries, "developing")).toHaveLength(1);
    expect(filterScratchpadEntries(entries, "memory")).toHaveLength(1);
  });

  it("builds collision-safe copy names and normalized extensions", () => {
    const now = new Date("2026-07-22T06:44:01Z");
    expect(scratchpadCopyPath("seeds/idea.md", now)).toBe("seeds/idea-copy-20260722064401.md");
    expect(scratchpadPathForFormat("memo.markdown", "plain")).toBe("memo.txt");
    expect(newMemoRelativePath(now, "a1b2c3")).toBe("memo-20260722064401-a1b2c3.txt");
  });

  it("keeps top-level ideation entries out of the Seed lifecycle group", () => {
    const groups = groupScratchpadEntries([
      entry({ collection: "ideation", source: "manual", ideationStage: null, relativePath: "README.md" }),
    ]);
    expect(groups[0].groups[0].id).toBe("ungrouped");
  });

  it("persists and clears a workspace-scoped recovery draft", () => {
    const values = new Map<string, string>();
    const storage = {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    };
    const document = { ...entry({}), content: "saved" };
    writeScratchpadDraft(
      { workPath: "/work", document, content: "draft", savedAt: "2026-07-22T06:44:01Z" },
      storage,
    );
    expect(readScratchpadDraft("/work", storage)?.content).toBe("draft");
    clearScratchpadDraft("/work", storage);
    expect(readScratchpadDraft("/work", storage)).toBeNull();
  });

  it("removes remote-resource elements from markdown preview", () => {
    const html = renderScratchpadMarkdown(
      "# Note\n\n![remote](https://example.com/a.png)\n\n" +
        '<svg><image href="https://example.com/a.svg"/><use xlink:href="https://example.com/icons.svg#x"/></svg>\n\n' +
        '<a href="https://example.com">remote</a><script>alert(1)</script>',
    );
    expect(html).toContain("<h1>Note</h1>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<svg|<image|<use/i);
    expect(html).not.toMatch(/(?:href|xlink:href)=/i);
  });
});

describe("sortScratchpadEntries", () => {
  const idea = entry({
    collection: "ideation",
    relativePath: "seeds/idea.md",
    name: "idea.md",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const memo = entry({
    collection: "memos",
    relativePath: "memo.md",
    name: "memo.md",
    updatedAt: "2026-06-01T00:00:00Z",
  });
  const tmp = entry({
    collection: "temp",
    relativePath: "codex/run.md",
    name: "run.md",
    updatedAt: "2026-03-01T00:00:00Z",
  });

  it("flattens across collections in newest-first order", () => {
    expect(
      sortScratchpadEntries([idea, memo, tmp], "modifiedDesc").map((item) => item.name),
    ).toEqual(["memo.md", "run.md", "idea.md"]);
  });

  it("reverses for the oldest-first key", () => {
    expect(
      sortScratchpadEntries([memo, idea, tmp], "modifiedAsc").map((item) => item.name),
    ).toEqual(["idea.md", "run.md", "memo.md"]);
  });

  it("treats a missing timestamp as the oldest and breaks ties by name", () => {
    const undated = entry({ relativePath: "a-undated.md", name: "a-undated.md", updatedAt: null });
    const undatedLater = entry({
      relativePath: "z-undated.md",
      name: "z-undated.md",
      updatedAt: null,
    });
    expect(
      sortScratchpadEntries([undatedLater, memo, undated], "modifiedDesc").map((i) => i.name),
    ).toEqual(["memo.md", "a-undated.md", "z-undated.md"]);
  });

  it("does not mutate the input array", () => {
    const input = [idea, memo];
    sortScratchpadEntries(input, "modifiedDesc");
    expect(input).toEqual([idea, memo]);
  });
});
