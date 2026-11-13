import { beforeEach, describe, expect, it, vi } from "vitest";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { captureHwpedSource, saveHwpedDocument } from "./hwped";
import { IpcError } from "./ipcError";

describe("HWPX host persistence transport", () => {
  beforeEach(() => { invokeMock.mockReset(); });
  it("captures by the selected full path with opt-in immutable source", async () => {
    const result = { markdown: "본문", segments: [], source: { dataBase64: "AQ==", revision: "a".repeat(64) } };
    invokeMock.mockResolvedValue(result);
    expect(await captureHwpedSource("/work", "같은 폴더/report.hwpx")).toBe(result);
    expect(invokeMock).toHaveBeenCalledWith("hwped_read", {
      workspaceRoot: "/work", document: { name: "report.hwpx", path: "같은 폴더/report.hwpx" }, captureSource: true,
    });
  });
  it("sends the original revision and selected path without using a document name", async () => {
    invokeMock.mockResolvedValue({ revision: "b".repeat(64), sizeBytes: 1, snapshotPath: ".maru/versions/a.hwpx" });
    await saveHwpedDocument("/work", "other/report.hwpx", "AQ==", "a".repeat(64));
    expect(invokeMock).toHaveBeenCalledWith("hwped_save", {
      workspaceRoot: "/work", documentPath: "other/report.hwpx", dataBase64: "AQ==", expectedRevision: "a".repeat(64),
    });
  });
  it("preserves only allowlisted conflict identity", async () => {
    invokeMock.mockRejectedValue({ code: "document_conflict", message: "changed" });
    await expect(saveHwpedDocument("/work", "report.hwpx", "AQ==", "a".repeat(64))).rejects.toBeInstanceOf(IpcError);
    invokeMock.mockRejectedValue({ code: "forged_conflict", message: "changed" });
    const error = await saveHwpedDocument("/work", "report.hwpx", "AQ==", "a".repeat(64)).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(IpcError);
    expect(error).not.toHaveProperty("code");
  });
});
