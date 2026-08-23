import { describe, expect, it } from "vitest";
import { IpcError, isIpcErrorCode, normalizeIpcError } from "./ipcError";

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
