import { describe, expect, it } from "vitest";
import { IpcError, ipcErrorMessage, isIpcErrorCode, normalizeIpcError } from "./ipcError";

describe("isIpcErrorCode", () => {
  it("accepts only the four contract codes", () => {
    expect(isIpcErrorCode("evidence_binder_revision_conflict")).toBe(true);
    expect(isIpcErrorCode("today_conflict")).toBe(true);
    expect(isIpcErrorCode("task_conflict")).toBe(true);
    expect(isIpcErrorCode("document_conflict")).toBe(true);
    expect(isIpcErrorCode("evidence_binder_lock_poisoned")).toBe(false);
    expect(isIpcErrorCode("")).toBe(false);
  });
});

describe("normalizeIpcError", () => {
  it("wraps a contract-coded body into an IpcError", () => {
    const result = normalizeIpcError({
      code: "evidence_binder_revision_conflict",
      message: "m",
    });
    expect(result).toBeInstanceOf(Error);
    expect(result).toBeInstanceOf(IpcError);
    const err = result as IpcError;
    expect(err.code).toBe("evidence_binder_revision_conflict");
    expect(err.message).toBe("evidence_binder_revision_conflict: m");
  });

  it("degrades an unknown code to a plain Error, never an IpcError", () => {
    const result = normalizeIpcError({
      code: "not_a_contract_code",
      message: "m",
    });
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(IpcError);
    expect((result as Error).message).toBe("not_a_contract_code: m");
  });

  it("drops the empty-code prefix, matching today's un-prefixed display text", () => {
    const result = normalizeIpcError({ code: "", message: "plain text" });
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(IpcError);
    expect((result as Error).message).toBe("plain text");
  });

  it("is idempotent — re-normalizing an IpcError returns the same instance", () => {
    const first = normalizeIpcError({
      code: "today_conflict",
      message: "expected revision a, found b",
    }) as IpcError;
    const second = normalizeIpcError(first);
    expect(second).toBe(first);
    expect((second as IpcError).message).toBe("today_conflict: expected revision a, found b");
  });

  it("passes through null, strings, plain Errors, and shapeless objects unchanged", () => {
    const err = new Error("boom");
    expect(normalizeIpcError(null)).toBeNull();
    expect(normalizeIpcError(undefined)).toBeUndefined();
    expect(normalizeIpcError("raw string")).toBe("raw string");
    expect(normalizeIpcError(err)).toBe(err);
    expect(normalizeIpcError({ message: "no code field" })).toEqual({
      message: "no code field",
    });
    expect(normalizeIpcError({ code: 42, message: "code not a string" })).toEqual({
      code: 42,
      message: "code not a string",
    });
  });
});

describe("ipcErrorMessage", () => {
  it.each(["render_store_failed", "<script>forged</script>", 42])("displays unknown code %s as text with its recovery step", (code) => {
    expect(ipcErrorMessage({ code, message: "Store unavailable.", nextStep: "Refresh the workspace." }))
      .toBe(`${typeof code === "string" ? `${code}: ` : ""}Store unavailable. Refresh the workspace.`);
  });
  it("keeps contract codes normalized and ignores non-text recovery fields", () => {
    expect(ipcErrorMessage({ code: "today_conflict", message: "Stale revision.", nextStep: {} }))
      .toBe("today_conflict: Stale revision.");
    expect(ipcErrorMessage(new Error("Read failed; retry."))).toBe("Read failed; retry.");
    expect(ipcErrorMessage("Plain failure; retry.")).toBe("Plain failure; retry.");
  });
});

it("shows malformed IPC bodies without object coercion or duplicate recovery text", () => {
  expect(ipcErrorMessage({ code: {}, message: {} })).toBe("The request returned an unrecognized error response; retry the operation.");
  expect(ipcErrorMessage(Object.assign(new Error("Read failed; retry."), { nextStep: "retry." })))
    .toBe("Read failed; retry.");
});
