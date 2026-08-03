import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_cmd: string) => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invoke(cmd),
}));

import {
  browserPasskeyRequestAuthorization,
  browserPasskeyStatus,
  UNSUPPORTED_BROWSER_PASSKEY_STATUS,
} from "./browserPasskeys";

describe("browser passkey invoke wrappers", () => {
  beforeEach(() => {
    invoke.mockClear();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("returns an unsupported mock outside Tauri", async () => {
    await expect(browserPasskeyStatus()).resolves.toEqual(
      UNSUPPORTED_BROWSER_PASSKEY_STATUS,
    );
    await expect(browserPasskeyRequestAuthorization()).resolves.toEqual(
      UNSUPPORTED_BROWSER_PASSKEY_STATUS,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses separate status and explicit authorization commands in Tauri", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    const status = {
      supported: true,
      authorization: "notDetermined" as const,
      requiresManagedEntitlement: true,
    };
    invoke.mockResolvedValue(status);

    await expect(browserPasskeyStatus()).resolves.toEqual(status);
    await expect(browserPasskeyRequestAuthorization()).resolves.toEqual(status);
    expect(invoke).toHaveBeenNthCalledWith(1, "browser_passkey_status");
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      "browser_passkey_request_authorization",
    );
  });
});
