import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri-backed API surface so the classifier routing can be asserted
// without a real subprocess. `buildInboxClassificationPrompt` and
// `parseInboxClassification` normally invoke Rust; here they are stubs.
const startAgentCliInvocation = vi.fn(async (..._args: unknown[]) => "inv-1");
vi.mock("./api", () => ({
  buildInboxClassificationPrompt: vi.fn(async () => "PROMPT"),
  parseInboxClassification: vi.fn(async () => ({
    category: "task",
    summary: "요약",
    suggestedFolder: null,
    extractedDate: null,
  })),
  startAgentCliInvocation: (...args: unknown[]) => startAgentCliInvocation(...args),
}));

// Capture event listeners so the test can drive the run to completion.
const handlers = new Map<string, (evt: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: (evt: { payload: unknown }) => void) => {
    handlers.set(event, cb);
    return Promise.resolve(() => handlers.delete(event));
  },
}));

import { classifyInboxItem } from "./aiInvoke";
import type { InboxDropItem } from "./types";

const item = { id: "drop-1", relPath: "inbox/drop/a.txt", title: "a.txt" } as unknown as InboxDropItem;

describe("classifyInboxItem runtime routing", () => {
  beforeEach(() => {
    startAgentCliInvocation.mockClear();
    handlers.clear();
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {},
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("routes the configured runtime to the generic agent bridge", async () => {
    const pending = classifyInboxItem(item, "codex");
    // Wait until the run registered its event listeners (executor has run).
    await vi.waitFor(() => expect(handlers.has("ai://done")).toBe(true));
    expect(startAgentCliInvocation).toHaveBeenCalledWith("codex", "PROMPT", null);

    // Drive the run to completion so the promise settles cleanly.
    handlers.get("ai://output")?.({
      payload: { invocationId: "inv-1", stream: "stdout", line: "{}" },
    });
    handlers.get("ai://done")?.({
      payload: { invocationId: "inv-1", success: true, exitCode: 0 },
    });
    const result = await pending;
    expect(result.category).toBe("task");
  });

  it("defaults to claude when no runtime is given", async () => {
    const pending = classifyInboxItem(item);
    await vi.waitFor(() => expect(handlers.has("ai://done")).toBe(true));
    expect(startAgentCliInvocation).toHaveBeenCalledWith("claude", "PROMPT", null);
    handlers.get("ai://done")?.({
      payload: { invocationId: "inv-1", success: true, exitCode: 0 },
    });
    await pending;
  });
});
