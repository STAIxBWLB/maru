import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillProgressEvent, SkillRecord, SyncAllOutcome } from "./skills";
const mocks = vi.hoisted(() => ({ listen: vi.fn(), notice: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("./errorStore", () => ({ publishOperationNotice: mocks.notice }));
import { createSkillViewScope, getLatestSkillOperation, getSkillOperationsSnapshot, isSkillOperationActive, startSkillOperation, subscribeSkillOperations } from "./skillOperations";
import { IpcError } from "./ipcError";
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const t = (key: string, vars?: Record<string, string | number>) => `${key} ${JSON.stringify(vars)}`;
let sequence = 0;
function setup(sourceId: string | null = "source", workspace = `workspace-${++sequence}`) {
  const mutation = deferred<SkillRecord[] | SyncAllOutcome>();
  const execute = vi.fn(() => mutation.promise);
  const options = { workspace, workspaceLabel: "Workspace A", sourceId, label: "Source A", total: 1, t, execute };
  return { ...mutation, execute, options };
}
beforeEach(() => { mocks.listen.mockReset().mockResolvedValue(vi.fn()); mocks.notice.mockClear(); });
describe("Skills operation ownership", () => {
  it.each([false, true])("unmount then settle failure=%s still publishes exactly once", async (failure) => {
    const task = setup(); const off = subscribeSkillOperations(vi.fn());
    const promise = startSkillOperation(task.options); off();
    if (failure) task.reject(new Error("network failed")); else task.resolve([]);
    const final = await promise;
    expect(final.active).toBe(false); expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0].message).toContain("Workspace A");
    expect(mocks.notice.mock.calls[0][0].kind).toBe(failure ? "error" : "success");
  });
  it("remount duplicate reattaches the same promise and source progress", async () => {
    const task = setup(); const promise = startSkillOperation(task.options);
    const off = subscribeSkillOperations(vi.fn()); off();
    const again = subscribeSkillOperations(vi.fn());
    expect(startSkillOperation(task.options)).toBe(promise);
    expect(isSkillOperationActive(task.options.workspace, "source")).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    const handler = mocks.listen.mock.calls[0][1] as (event: { payload: SkillProgressEvent }) => void;
    const id = getLatestSkillOperation(task.options.workspace)!.operationId;
    handler({ payload: { progressId: "other", level: "info", message: "ignore" } });
    expect(getLatestSkillOperation(task.options.workspace)!.message).toBeNull();
    handler({ payload: { progressId: id, level: "info", message: "pulling", completed: 1, total: 2 } });
    expect(getLatestSkillOperation(task.options.workspace)!.message).toBe("pulling");
    task.resolve([]); await promise; again();
    expect(task.execute).toHaveBeenCalledTimes(1); expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(isSkillOperationActive(task.options.workspace, "source")).toBe(false);
  });
  it("independent sources proceed and retained snapshots are immutable", async () => {
    const a = setup("a"); const b = setup("b", a.options.workspace);
    const first = startSkillOperation(a.options); const before = getSkillOperationsSnapshot();
    const second = startSkillOperation(b.options);
    expect(getSkillOperationsSnapshot()).not.toBe(before);
    expect(getSkillOperationsSnapshot().filter((x) => x.workspace === a.options.workspace && x.active)).toHaveLength(2);
    a.resolve([]); b.resolve([]); await Promise.all([first, second]);
    expect(mocks.notice).toHaveBeenCalledTimes(2);
    expect(before.at(-1)!.active).toBe(true);
  });
  it.each([false, true])("A -> B navigation then return=%s invalidates earlier view refresh", async (returnToA) => {
    const scope = createSkillViewScope(); scope.enter("A"); const first = scope.request("A");
    const task = setup("source", `A-${++sequence}`); const promise = startSkillOperation(task.options);
    scope.leave(); scope.enter("B"); if (returnToA) { scope.leave(); scope.enter("A"); }
    task.resolve([]); await promise;
    expect(first()).toBe(false);
    expect(getLatestSkillOperation(task.options.workspace)!.active).toBe(false);
    expect(getLatestSkillOperation("B")).toBeUndefined();
    expect(scope.request(returnToA ? "A" : "B")()).toBe(true);
  });
  it("late listener is disposed after settlement and late events cannot republish", async () => {
    const listener = deferred<() => void>(); mocks.listen.mockReturnValue(listener.promise);
    const task = setup(); const promise = startSkillOperation(task.options); task.resolve([]); await promise;
    const before = getSkillOperationsSnapshot(); const off = vi.fn(); listener.resolve(off);
    await Promise.resolve(); await Promise.resolve();
    expect(off).toHaveBeenCalledTimes(1);
    mocks.listen.mock.calls[0][1]({ payload: { progressId: getLatestSkillOperation(task.options.workspace)!.operationId, level: "error", message: "late" } });
    expect(getSkillOperationsSnapshot()).toBe(before); expect(mocks.notice).toHaveBeenCalledTimes(1);
  });
  it("listener registration rejection never prevents mutation reporting", async () => {
    mocks.listen.mockRejectedValue(new Error("listen failed"));
    const task = setup(); const promise = startSkillOperation(task.options); task.resolve([]); await promise;
    expect(mocks.notice).toHaveBeenCalledTimes(1); expect(task.execute).toHaveBeenCalledTimes(1);
  });
  it.each(["skills_source_busy", "skills_source_stale"] as const)("known %s offers manual retry without starting one", async (code) => {
    const task = setup(); const promise = startSkillOperation(task.options);
    task.reject(new IpcError({ code, message: "current source changed" })); await promise;
    expect(task.execute).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0].message).toContain(code === "skills_source_busy" ? "skills.operation.skipped" : "skills.operation.stale");
    const retry = startSkillOperation({ ...task.options, execute: async () => [] });
    expect(retry).not.toBe(promise); await retry;
  });
  it("fulfilled partial batch retains successes, skipped count and failed reason", async () => {
    const task = setup(null); const promise = startSkillOperation(task.options);
    const result: SyncAllOutcome = { total: 3, succeeded: 1, failed: 1, skipped: 1, results: [
      { sourceId: "a", kind: "linked", ok: true, skipped: false, skills: 1 },
      { sourceId: "b", kind: "linked", ok: false, skipped: true, skills: 0, error: "busy", errorCode: "skills_source_busy" },
      { sourceId: "c", kind: "linked", ok: false, skipped: false, skills: 0, error: "network failed" },
    ] }; task.resolve(result); const final = await promise;
    expect(final.result).toBe(result); expect(final.message).toContain("network failed"); expect(final.message).toContain("skipped");
    expect(mocks.notice.mock.calls[0][0].kind).toBe("error");
  });
});
