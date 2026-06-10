import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pluginReadText = vi.fn(async (): Promise<string> => "from-plugin");
const pluginWriteText = vi.fn(async (_text: string) => undefined);
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: () => pluginReadText(),
  writeText: (text: string) => pluginWriteText(text),
}));

import { clipboardReadText, clipboardWriteText } from "./clipboard";

function enterTauri() {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
}

const navigatorClipboard = {
  readText: vi.fn(async (): Promise<string> => "from-navigator"),
  writeText: vi.fn(async (_text: string) => undefined),
};

describe("clipboard helpers", () => {
  beforeEach(() => {
    pluginReadText.mockClear();
    pluginReadText.mockResolvedValue("from-plugin");
    pluginWriteText.mockClear();
    navigatorClipboard.readText.mockClear();
    navigatorClipboard.writeText.mockClear();
    vi.stubGlobal("navigator", { clipboard: navigatorClipboard });
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.unstubAllGlobals();
  });

  it("reads through the Tauri plugin when running inside Tauri", async () => {
    enterTauri();
    await expect(clipboardReadText()).resolves.toBe("from-plugin");
    expect(pluginReadText).toHaveBeenCalledTimes(1);
    expect(navigatorClipboard.readText).not.toHaveBeenCalled();
  });

  it("treats a plugin read rejection (empty clipboard) as empty text", async () => {
    enterTauri();
    pluginReadText.mockRejectedValueOnce(new Error("empty"));
    await expect(clipboardReadText()).resolves.toBe("");
  });

  it("writes through the Tauri plugin when running inside Tauri", async () => {
    enterTauri();
    await clipboardWriteText("hello");
    expect(pluginWriteText).toHaveBeenCalledWith("hello");
    expect(navigatorClipboard.writeText).not.toHaveBeenCalled();
  });

  it("falls back to navigator.clipboard outside Tauri", async () => {
    await expect(clipboardReadText()).resolves.toBe("from-navigator");
    await clipboardWriteText("dev");
    expect(navigatorClipboard.writeText).toHaveBeenCalledWith("dev");
    expect(pluginReadText).not.toHaveBeenCalled();
    expect(pluginWriteText).not.toHaveBeenCalled();
  });
});
