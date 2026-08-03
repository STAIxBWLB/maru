import { invoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export type BrowserPasskeyAuthorization =
  | "authorized"
  | "denied"
  | "notDetermined"
  | "unknown"
  | "unsupported";

export interface BrowserPasskeyStatus {
  supported: boolean;
  authorization: BrowserPasskeyAuthorization;
  requiresManagedEntitlement: boolean;
}

export const UNSUPPORTED_BROWSER_PASSKEY_STATUS: BrowserPasskeyStatus = {
  supported: false,
  authorization: "unsupported",
  requiresManagedEntitlement: true,
};

const isTauri = () =>
  typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

/** Read-only capability/status check. Browser development deliberately
 *  resolves to unsupported instead of throwing. */
export async function browserPasskeyStatus(): Promise<BrowserPasskeyStatus> {
  if (!isTauri()) return UNSUPPORTED_BROWSER_PASSKEY_STATUS;
  return invoke<BrowserPasskeyStatus>("browser_passkey_status");
}

let browserPasskeyBuildPromise: Promise<boolean> | null = null;

/**
 * True only in a provisioned browser-passkey build: `supported` is derived from
 * the running process's effective code signature, so it cannot be spoofed by
 * config. Memoized because the answer is fixed for the process lifetime.
 */
export function browserPasskeyBuildOnce(): Promise<boolean> {
  browserPasskeyBuildPromise ??= browserPasskeyStatus()
    .then((status) => status.supported)
    .catch(() => false);
  return browserPasskeyBuildPromise;
}

/** Must only be called from an explicit user action; macOS may show a system
 *  authorization prompt. */
export async function browserPasskeyRequestAuthorization(): Promise<BrowserPasskeyStatus> {
  if (!isTauri()) return UNSUPPORTED_BROWSER_PASSKEY_STATUS;
  return invoke<BrowserPasskeyStatus>("browser_passkey_request_authorization");
}
