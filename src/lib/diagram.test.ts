import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

describe("diagram api wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    (globalThis as unknown as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {},
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("diagramSaveDocument forwards the workspace/name/body envelope", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const { diagramSaveDocument } = await import("./diagram");
    await diagramSaveDocument("/w", "demo", "{\"v\":7}");
    expect(invokeMock).toHaveBeenCalledWith("diagram_save_document", {
      workspace: "/w",
      name: "demo",
      body: "{\"v\":7}",
    });
  });

  it("diagramLoadDocument returns the body string", async () => {
    invokeMock.mockResolvedValueOnce("{\"v\":7}");
    const { diagramLoadDocument } = await import("./diagram");
    const body = await diagramLoadDocument("/w", "demo");
    expect(body).toBe("{\"v\":7}");
    expect(invokeMock).toHaveBeenCalledWith("diagram_load_document", {
      workspace: "/w",
      name: "demo",
    });
  });

  it("diagramListDocuments returns an array", async () => {
    invokeMock.mockResolvedValueOnce([
      { name: "a", size: 12, modifiedAt: 1, docTitle: "A" },
    ]);
    const { diagramListDocuments } = await import("./diagram");
    const files = await diagramListDocuments("/w");
    expect(files).toEqual([{ name: "a", size: 12, modifiedAt: 1, docTitle: "A" }]);
  });

  it("diagramDeleteDocument returns the boolean", async () => {
    invokeMock.mockResolvedValueOnce(true);
    const { diagramDeleteDocument } = await import("./diagram");
    expect(await diagramDeleteDocument("/w", "a")).toBe(true);
  });

  it("diagramExportBlobToPath forwards a selected target path", async () => {
    invokeMock.mockResolvedValueOnce("/tmp/demo.png");
    const { diagramExportBlobToPath } = await import("./diagram");
    const path = await diagramExportBlobToPath("/tmp/demo.png", "png", new Uint8Array([1, 2]));
    expect(path).toBe("/tmp/demo.png");
    expect(invokeMock).toHaveBeenCalledWith("diagram_export_blob_to_path", {
      targetPath: "/tmp/demo.png",
      kind: "png",
      bytes: [1, 2],
    });
  });

  it("falls back to an empty list when not in Tauri", async () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    const { diagramListDocuments } = await import("./diagram");
    expect(await diagramListDocuments("/w")).toEqual([]);
  });

  it("uses browser localStorage as the mock diagram document store", async () => {
    (globalThis as unknown as { window?: unknown }).window = {
      localStorage: memoryStorage(),
    };
    const {
      diagramSaveDocument,
      diagramLoadDocument,
      diagramListDocuments,
      diagramDeleteDocument,
    } = await import("./diagram");

    await diagramSaveDocument("/w", "demo", "{\"docTitle\":\"Demo\",\"nodes\":[],\"edges\":[]}");
    expect(await diagramLoadDocument("/w", "demo")).toContain("Demo");
    expect(await diagramListDocuments("/w")).toMatchObject([{ name: "demo", docTitle: "Demo" }]);
    expect(await diagramDeleteDocument("/w", "demo")).toBe(true);
    expect(await diagramListDocuments("/w")).toEqual([]);
  });

  it("save throws outside Tauri", async () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    const { diagramSaveDocument } = await import("./diagram");
    await expect(diagramSaveDocument("/w", "n", "")).rejects.toThrow(/requires_tauri/);
  });
});
