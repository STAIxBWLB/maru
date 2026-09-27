import { afterEach, describe, expect, it, vi } from "vitest";

const pluginConfirm = vi.fn<(message: string, options?: unknown) => Promise<boolean>>();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (message: string, options?: unknown) => pluginConfirm(message, options),
  message: vi.fn(async () => "Ok"),
}));

import { confirmDialog } from "./confirmDialog";

function deferred() {
  let resolve!: (value: boolean) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<boolean>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  pluginConfirm.mockReset();
  vi.unstubAllGlobals();
});

describe("confirmDialog", () => {
  it("opens one sheet at a time: the second waits for the first to answer", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const first = deferred();
    const second = deferred();
    pluginConfirm.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const a = confirmDialog("first");
    const b = confirmDialog("second", { kind: "info" });
    await flush();
    expect(pluginConfirm).toHaveBeenCalledTimes(1);
    expect(pluginConfirm).toHaveBeenLastCalledWith("first", { kind: "warning" });

    first.resolve(true);
    await expect(a).resolves.toBe(true);
    await flush();
    expect(pluginConfirm).toHaveBeenCalledTimes(2);
    expect(pluginConfirm).toHaveBeenLastCalledWith("second", { kind: "info" });

    second.resolve(false);
    await expect(b).resolves.toBe(false);
  });

  it("answers false when the dialog fails, and the next one still opens", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    pluginConfirm.mockRejectedValueOnce(new Error("no sheet")).mockResolvedValueOnce(true);

    await expect(confirmDialog("broken")).resolves.toBe(false);
    await expect(confirmDialog("next")).resolves.toBe(true);
  });

  it("falls back to the browser confirm outside Tauri", async () => {
    const browserConfirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm: browserConfirm });

    await expect(confirmDialog("browser")).resolves.toBe(true);
    expect(browserConfirm).toHaveBeenCalledWith("browser");
    expect(pluginConfirm).not.toHaveBeenCalled();

    browserConfirm.mockReturnValueOnce(false);
    await expect(confirmDialog("browser")).resolves.toBe(false);
  });
});
