import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri-backed API surface so host behavior can be asserted without
// a real subprocess, mirroring aiInvoke.test.ts.
const startAgentCliInvocation = vi.fn(async (..._args: unknown[]) => "inv-1");
const stopAiMission = vi.fn(async (_invocationId: string) => ({}));
const validateEngineCandidate = vi.fn(async (_diagramType: string, _spec: unknown) => ({
  ok: true,
  errors: [] as string[],
  warnings: [] as string[],
  candidateSha256: "abc",
}));

vi.mock("../api", () => ({
  startAgentCliInvocation: (...args: unknown[]) => startAgentCliInvocation(...args),
  stopAiMission: (invocationId: string) => stopAiMission(invocationId),
}));

vi.mock("./engine", () => ({
  validateEngineCandidate: (diagramType: string, spec: unknown) => validateEngineCandidate(diagramType, spec),
  renderEngineCandidate: vi.fn(),
}));
vi.mock("./engineCandidate", () => ({ renderEngineCandidate: vi.fn() }));

const handlers = new Map<string, (evt: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: (evt: { payload: unknown }) => void) => {
    handlers.set(event, cb);
    return Promise.resolve(() => handlers.delete(event));
  },
}));

import { createGenerationHost } from "./generationHost";

function emitDone(payload: { invocationId: string; success: boolean; exitCode: number | null }) {
  handlers.get("ai://done")?.({ payload });
}

describe("createGenerationHost", () => {
  beforeEach(() => {
    startAgentCliInvocation.mockReset();
    startAgentCliInvocation.mockResolvedValue("inv-1");
    stopAiMission.mockClear();
    validateEngineCandidate.mockClear();
    handlers.clear();
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {},
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.useRealTimers();
  });

  it("accumulates stdout lines and resolves on ai://done", async () => {
    const host = createGenerationHost({ workPath: "/tmp/work" });
    const pending = host.runAgent("PROMPT");
    await vi.waitFor(() => expect(handlers.has("ai://done")).toBe(true));
    expect(startAgentCliInvocation).toHaveBeenCalledWith(
      "claude",
      "PROMPT",
      "/tmp/work",
      null,
      null,
      null,
      null,
      { origin: "diagram-generation" },
    );
    handlers.get("ai://output")?.({
      payload: { invocationId: "inv-1", stream: "stdout", line: "{\"a\":" },
    });
    // Stderr and other invocations are ignored.
    handlers.get("ai://output")?.({
      payload: { invocationId: "inv-1", stream: "stderr", line: "noise" },
    });
    handlers.get("ai://output")?.({
      payload: { invocationId: "other", stream: "stdout", line: "noise" },
    });
    handlers.get("ai://output")?.({
      payload: { invocationId: "inv-1", stream: "stdout", line: "1}" },
    });
    emitDone({ invocationId: "inv-1", success: true, exitCode: 0 });
    await expect(pending).resolves.toBe('{"a":\n1}\n');
  });

  it("captures output and done emitted before the invocation ID resolves", async () => {
    startAgentCliInvocation.mockImplementationOnce(async () => {
      expect(handlers.has("ai://output")).toBe(true);
      expect(handlers.has("ai://done")).toBe(true);
      expect(handlers.has("ai://error")).toBe(true);
      handlers.get("ai://output")?.({ payload: { invocationId: "other", stream: "stdout", line: "noise" } });
      handlers.get("ai://output")?.({ payload: { invocationId: "inv-1", stream: "stdout", line: '{"fast":true}' } });
      emitDone({ invocationId: "other", success: false, exitCode: 1 });
      emitDone({ invocationId: "inv-1", success: true, exitCode: 0 });
      return "inv-1";
    });
    await expect(createGenerationHost({ workPath: "/tmp/work" }).runAgent("PROMPT")).resolves.toBe('{"fast":true}\n');
    expect(handlers.size).toBe(0);
  });

  it("cleans listeners when invocation startup fails", async () => {
    startAgentCliInvocation.mockRejectedValueOnce(new Error("startup failed"));
    await expect(createGenerationHost({ workPath: "/tmp/work" }).runAgent("PROMPT")).rejects.toThrow("startup failed");
    expect(handlers.size).toBe(0);
  });

  it("rejects on ai://error and on a non-success exit", async () => {
    const host = createGenerationHost({ workPath: "/tmp/work" });
    const failed = host.runAgent("PROMPT");
    await vi.waitFor(() => expect(handlers.has("ai://error")).toBe(true));
    handlers.get("ai://error")?.({
      payload: { invocationId: "inv-1", kind: "spawn", message: "no such binary" },
    });
    await expect(failed).rejects.toThrow("spawn: no such binary");

    const exited = host.runAgent("PROMPT");
    await vi.waitFor(() => expect(handlers.has("ai://done")).toBe(true));
    emitDone({ invocationId: "inv-1", success: false, exitCode: 2 });
    await expect(exited).rejects.toThrow("exited with code 2");
  });

  it("rejects on the client-side hard timeout and stops the mission", async () => {
    vi.useFakeTimers();
    const host = createGenerationHost({ workPath: "/tmp/work", timeoutMs: 1_000 });
    const pending = host.runAgent("PROMPT");
    const expectation = expect(pending).rejects.toThrow(/timed out after 1000ms/);
    await vi.advanceTimersByTimeAsync(1_100);
    await expectation;
    expect(stopAiMission).toHaveBeenCalledWith("inv-1");
  });

  it("cancel() stops the mission and rejects the pending run", async () => {
    const host = createGenerationHost({ workPath: "/tmp/work" });
    const pending = host.runAgent("PROMPT");
    await vi.waitFor(() => expect(startAgentCliInvocation).toHaveBeenCalled());
    host.cancel();
    await expect(pending).rejects.toThrow("cancelled");
    expect(stopAiMission).toHaveBeenCalledWith("inv-1");
  });

  it("rejects runAgent outside the Tauri shell", async () => {
    delete (globalThis as { window?: unknown }).window;
    const host = createGenerationHost({ workPath: "/tmp/work" });
    await expect(host.runAgent("PROMPT")).rejects.toThrow(/Tauri shell/);
  });

  it("validateCandidate forwards the source spec to SDK validation", async () => {
    const host = createGenerationHost({ workPath: "/tmp/work" });
    const spec = { schema_version: 1, diagram_type: "architecture", components: [] };
    const receipt = await host.validateCandidate("architecture", spec);
    expect(validateEngineCandidate).toHaveBeenCalledWith("architecture", spec);
    expect(receipt.ok).toBe(true);
  });

  it("keeps validation available without a workspace while render requires one", async () => {
    const host = createGenerationHost({ workPath: null });
    await expect(host.validateCandidate("architecture", {})).resolves.toMatchObject({ ok: true });
    expect(validateEngineCandidate).toHaveBeenCalledTimes(1);
    await expect(host.renderCandidate?.("architecture", "{}")).rejects.toThrow(/workspace/);
  });
});
