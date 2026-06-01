import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SKILLS_INSTALL_MODE_STORAGE_KEY,
  readDefaultInstallMode,
  writeDefaultInstallMode,
} from "./skillsInstallMode";

interface MockStore {
  store: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function setWindow(stored: string | null, throwing = false): MockStore {
  const store = new Map<string, string>();
  if (stored !== null) store.set(SKILLS_INSTALL_MODE_STORAGE_KEY, stored);
  const localStorage: MockStore = {
    store,
    getItem: (key) => {
      if (throwing) throw new Error("blocked");
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem: (key, value) => {
      if (throwing) throw new Error("blocked");
      store.set(key, value);
    },
  };
  (globalThis as unknown as { window?: { localStorage: MockStore } }).window = { localStorage };
  return localStorage;
}

describe("skillsInstallMode", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("defaults to symlink when storage is empty", () => {
    setWindow(null);
    expect(readDefaultInstallMode()).toBe("symlink");
  });

  it("reads copy when stored", () => {
    setWindow("copy");
    expect(readDefaultInstallMode()).toBe("copy");
  });

  it("treats any non-copy value as symlink", () => {
    setWindow("garbage");
    expect(readDefaultInstallMode()).toBe("symlink");
  });

  it("falls back to symlink when storage throws", () => {
    setWindow(null, true);
    expect(readDefaultInstallMode()).toBe("symlink");
  });

  it("writes to the versioned key", () => {
    const ls = setWindow(null);
    writeDefaultInstallMode("copy");
    expect(ls.store.get(SKILLS_INSTALL_MODE_STORAGE_KEY)).toBe("copy");
  });
});
