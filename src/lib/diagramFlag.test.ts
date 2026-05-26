import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DIAGRAM_ENABLE_STORAGE_KEY } from "./diagramFlag";

interface MockWindow {
  location: { search: string };
  localStorage: { getItem: (key: string) => string | null };
  __TAURI_INTERNALS__?: unknown;
}

function setWindow(search: string, stored: string | null) {
  const w: MockWindow = {
    location: { search },
    localStorage: { getItem: (key) => (key === DIAGRAM_ENABLE_STORAGE_KEY ? stored : null) },
  };
  (globalThis as unknown as { window?: MockWindow }).window = w;
}

describe("isDiagramEnabled (Phase 7 default-on)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("returns true with no env, no query, no localStorage", async () => {
    setWindow("", null);
    const { isDiagramEnabled } = await import("./diagramFlag");
    expect(isDiagramEnabled()).toBe(true);
  });

  it("returns false when localStorage says 0", async () => {
    setWindow("", "0");
    const { isDiagramEnabled } = await import("./diagramFlag");
    expect(isDiagramEnabled()).toBe(false);
  });

  it("returns false when localStorage says false", async () => {
    setWindow("", "false");
    const { isDiagramEnabled } = await import("./diagramFlag");
    expect(isDiagramEnabled()).toBe(false);
  });

  it("returns false when ?anchor-diagram=0", async () => {
    setWindow("?anchor-diagram=0", null);
    const { isDiagramEnabled } = await import("./diagramFlag");
    expect(isDiagramEnabled()).toBe(false);
  });

  it("leaves other localStorage values as enabled", async () => {
    setWindow("", "1");
    const { isDiagramEnabled } = await import("./diagramFlag");
    expect(isDiagramEnabled()).toBe(true);
  });
});
