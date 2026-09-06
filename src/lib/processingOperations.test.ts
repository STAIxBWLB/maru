import { beforeEach, describe, expect, it, vi } from "vitest";
import "./i18n/testing";

const mocks = vi.hoisted(() => ({ notice: vi.fn() }));
vi.mock("./errorStore", () => ({ publishOperationNotice: mocks.notice }));

import {
  getProcessingOperation,
  getProcessingOperationsSnapshot,
  runProcessingOperation,
  subscribeProcessingOperations,
  type ProcessingCompletion,
} from "./processingOperations";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const success: ProcessingCompletion = {
  status: "all-success",
  succeeded: ["out/a", "out/b"],
  failed: [],
};
const partial: ProcessingCompletion = {
  status: "partial-success",
  succeeded: ["out/a"],
  failed: [{ label: "b", reason: "disk full" }],
};
const failed: ProcessingCompletion = {
  status: "all-failed",
  succeeded: [],
  failed: [{ label: "a", reason: "permission denied" }],
};

function setup<T>(classifyResult: (result: T) => ProcessingCompletion | null = () => success) {
  const task = deferred<T>();
  const run = vi.fn(() => task.promise);
  const context = {
    operationId: `op-${Math.random().toString(36).slice(2)}`,
    workspace: "/workspace",
    labelKey: "processing.label.pasteWorkspaceEntries",
  };
  return { ...task, run, context, classifyResult };
}

beforeEach(() => {
  mocks.notice.mockReset();
});

describe("runProcessingOperation ownership", () => {
  it("classifies fulfilled results exactly once per classification and keeps payload identity", async () => {
    const task = setup<string>();
    const off = subscribeProcessingOperations(vi.fn());
    const promise = runProcessingOperation(task.context, task.run, task.classifyResult);
    off();
    task.resolve("original-payload");
    await expect(promise).resolves.toBe("original-payload");
    expect(task.run).toHaveBeenCalledTimes(1);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0]).toMatchObject({
      operationId: task.context.operationId,
      kind: "success",
    });
    expect(mocks.notice.mock.calls[0][0].message).toContain("/workspace");
    const record = getProcessingOperation(task.context.operationId);
    expect(record?.status).toBe("settled");
    expect(record?.completion).toEqual(success);
  });

  it.each([
    ["all-success", success, "success"],
    ["partial-success", partial, "info"],
    ["all-failed", failed, "error"],
    ["empty", { status: "empty", succeeded: [], failed: [] }, "info"],
    ["manual", { status: "manual", succeeded: [], failed: [], detail: "needs hands" }, "info"],
  ] as const)("%s maps to one %s notice", async (_name, completion, kind) => {
    const task = setup<string>(() => completion);
    const promise = runProcessingOperation(task.context, task.run, task.classifyResult);
    task.resolve("payload");
    await promise;
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0].kind).toBe(kind);
  });

  it("partial notice carries counts and the actionable reason while retaining successes", async () => {
    const task = setup<string>(() => partial);
    const promise = runProcessingOperation(task.context, task.run, task.classifyResult);
    task.resolve("payload");
    await promise;
    const message = mocks.notice.mock.calls[0][0].message as string;
    expect(message).toContain("disk full");
    expect(getProcessingOperation(task.context.operationId)?.completion?.succeeded).toEqual([
      "out/a",
    ]);
  });

  it("rejection publishes one error notice and rethrows the original error", async () => {
    const task = setup<string>(() => success);
    const original = Object.assign(new Error("ipc rejected"), { code: "workspace_denied" });
    const promise = runProcessingOperation(task.context, task.run, task.classifyResult);
    task.reject(original);
    await expect(promise).rejects.toBe(original);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0]).toMatchObject({ kind: "error" });
    expect(mocks.notice.mock.calls[0][0].message).toContain("ipc rejected");
    expect(task.run).toHaveBeenCalledTimes(1);
  });

  it("non-Error rejection is reported with String(reason) and rethrown unchanged", async () => {
    const task = setup<string>(() => success);
    const promise = runProcessingOperation(task.context, task.run, task.classifyResult);
    task.reject("plain string failure");
    await expect(promise).rejects.toBe("plain string failure");
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0].message).toContain("plain string failure");
  });

  it("settles exactly once when the classifier throws after fulfillment", async () => {
    const task = setup<string>(() => {
      throw new Error("classifier bug");
    });
    const promise = runProcessingOperation(task.context, task.run, task.classifyResult);
    task.resolve("payload");
    await expect(promise).rejects.toThrow("classifier bug");
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0].kind).toBe("error");
    expect(getProcessingOperation(task.context.operationId)?.status).toBe("settled");
  });

  it("A -> B -> A navigation cannot discard the terminal notice or the record", async () => {
    const task = setup<string>(() => failed);
    const first = subscribeProcessingOperations(vi.fn());
    first();
    const promise = runProcessingOperation(task.context, task.run, task.classifyResult);
    const second = subscribeProcessingOperations(vi.fn());
    second();
    task.resolve("payload");
    await promise;
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(getProcessingOperation(task.context.operationId)?.completion).toEqual(failed);
    expect(
      getProcessingOperationsSnapshot().filter(
        (record) => record.operationId === task.context.operationId,
      ),
    ).toHaveLength(1);
  });

  it("late subscribers read the settled record without a republish callback", async () => {
    const task = setup<string>();
    const promise = runProcessingOperation(task.context, task.run, task.classifyResult);
    task.resolve("payload");
    await promise;
    const listener = vi.fn();
    const off = subscribeProcessingOperations(listener);
    off();
    expect(listener).not.toHaveBeenCalled();
    expect(getProcessingOperation(task.context.operationId)?.status).toBe("settled");
    expect(mocks.notice).toHaveBeenCalledTimes(1);
  });

  it("null classifier is a rejection-only contract: fulfillment stays silent", async () => {
    const task = setup<string>(() => null);
    const promise = runProcessingOperation(task.context, task.run, task.classifyResult);
    task.resolve("payload");
    await expect(promise).resolves.toBe("payload");
    expect(mocks.notice).not.toHaveBeenCalled();
    expect(getProcessingOperation(task.context.operationId)?.completion).toBeNull();
  });

  it("rejection-only contract still reports the rejection exactly once", async () => {
    const task = setup<string>(() => null);
    const promise = runProcessingOperation(task.context, task.run, task.classifyResult);
    task.reject(new Error("apply failed"));
    await expect(promise).rejects.toThrow("apply failed");
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0].kind).toBe("error");
  });

  it("outerOperationId suppresses the inner notice but keeps the classified record", async () => {
    const task = setup<string>(() => partial);
    const promise = runProcessingOperation(
      { ...task.context, outerOperationId: "studio-flow-1" },
      task.run,
      task.classifyResult,
    );
    task.resolve("payload");
    await promise;
    expect(mocks.notice).not.toHaveBeenCalled();
    expect(getProcessingOperation(task.context.operationId)?.completion).toEqual(partial);
  });

  it("Studio aggregation: suppressed inner plus one outer notice, inner record still readable", async () => {
    const inner = setup<string>(() => partial);
    const innerPromise = runProcessingOperation(
      { ...inner.context, outerOperationId: "studio-flow-2" },
      inner.run,
      inner.classifyResult,
    );
    inner.resolve("inner-payload");
    await innerPromise;
    expect(mocks.notice).not.toHaveBeenCalled();

    const outer = setup<string>(() => success);
    const outerPromise = runProcessingOperation(outer.context, outer.run, outer.classifyResult);
    outer.resolve("outer-payload");
    await outerPromise;
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0].operationId).toBe(outer.context.operationId);

    const innerRecord = getProcessingOperation(inner.context.operationId);
    expect(innerRecord?.status).toBe("settled");
    expect(innerRecord?.completion).toEqual(partial);
  });
});
