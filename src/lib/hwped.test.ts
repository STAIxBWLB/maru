// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { createHwpedEngine } from "./hwped";

const document = { name: "report.hwpx", data: new Uint8Array([1, 2, 3]) };
const ops = [{ kind: "replace" as const, find: "가", replace: "나" }];

function answerCapabilities(capabilities: Record<string, unknown>): void {
  invokeMock.mockImplementation((command: string) => {
    if (command === "hwped_capabilities") return Promise.resolve(capabilities);
    if (command === "hwped_edit") {
      return Promise.resolve({ name: "report.hwpx", dataBase64: "" });
    }
    throw new Error(`unexpected command ${command}`);
  });
}

function editPayload(): Record<string, unknown> {
  const call = invokeMock.mock.calls.find(([command]) => command === "hwped_edit");
  if (call === undefined) throw new Error("hwped_edit was never called");
  return call[1] as Record<string, unknown>;
}

describe("createHwpedEngine", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("sends the edit-ops-v1 JSON array when the host advertises editOps v1", async () => {
    answerCapabilities({ version: "1.6.2", editable: true, formats: [], editOps: "v1" });

    await createHwpedEngine({ workspaceRoot: "/workspace" }).edit(document, ops);

    expect(invokeMock.mock.calls[0][0]).toBe("hwped_capabilities");
    const payload = editPayload();
    // The JSON channel carries the edit-ops-v1 wire spelling, which is not the
    // TypeScript op shape: `kind/find/replace` goes out as `op/from/to`.
    expect(payload.ops).toEqual([{ op: "replace", from: "가", to: "나" }]);
    expect(payload.opsArgv).toBeUndefined();
    expect(payload.workspaceRoot).toBe("/workspace");
  });

  it("falls back to opsArgv on a host that does not advertise it", async () => {
    answerCapabilities({ version: "1.2.0", editable: true, formats: [] });

    await createHwpedEngine({ workspaceRoot: "/workspace" }).edit(document, ops);

    const payload = editPayload();
    expect(payload.ops).toBeUndefined();
    expect(payload.opsArgv).toContain("가=>나");
  });

  it("crosses the document as a workspace-relative path when pathOf answers", async () => {
    answerCapabilities({ version: "1.6.2", editable: true, formats: [], editOps: "v1" });

    const engine = createHwpedEngine({
      workspaceRoot: "/workspace",
      pathOf: (candidate) =>
        candidate.name === "report.hwpx" ? "docs/report.hwpx" : undefined,
    });
    await engine.edit(document, ops);

    expect(editPayload().document).toEqual({
      name: "report.hwpx",
      path: "docs/report.hwpx",
    });
  });

  it("falls back to base64 bytes when pathOf declines the document", async () => {
    answerCapabilities({ version: "1.6.2", editable: true, formats: [], editOps: "v1" });

    const engine = createHwpedEngine({
      workspaceRoot: "/workspace",
      pathOf: () => undefined,
    });
    await engine.edit(document, ops);

    const ref = editPayload().document as Record<string, unknown>;
    expect(ref.name).toBe("report.hwpx");
    expect(ref.path).toBeUndefined();
    expect(ref.dataBase64).toBe("AQID");
  });
});
