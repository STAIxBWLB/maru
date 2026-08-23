import { IPC_ERROR_CODES, type IpcErrorCode } from "./types";

// ---------------------------------------------------------------------------
// Typed IPC error contract (Phase 3, ERR-01/ERR-02/ERR-07). Migrated Tauri
// commands reject with a serialized `{ code, message }` object instead of a
// bare string; normalizeIpcError is the single point every invoke funnel
// runs a rejection through, turning that object into an `IpcError` a
// component can branch on via `.code` instead of parsing `.message` text.
// ---------------------------------------------------------------------------

export function isIpcErrorCode(code: string): code is IpcErrorCode {
  return (IPC_ERROR_CODES as readonly string[]).includes(code);
}

/** Error subclass so `err instanceof Error`, `err.message`, and `err.code`
 *  all read correctly at existing catch sites. `message` keeps the legacy
 *  "code: message" text so toasts and e2e assertions stay byte-identical. */
export class IpcError extends Error {
  readonly code: IpcErrorCode;

  constructor(body: { code: IpcErrorCode; message: string }) {
    super(`${body.code}: ${body.message}`);
    this.name = "IpcError";
    this.code = body.code;
  }
}

/** Normalizes an invoke rejection value into an `IpcError` when it carries a
 *  contract code, else passes it through unchanged. Idempotent: an
 *  already-normalized `IpcError` is returned by identity, so re-normalizing
 *  (e.g. an e2e fixture that pre-throws one) never doubles the "code: "
 *  prefix. */
export function normalizeIpcError(reason: unknown): unknown {
  if (reason instanceof IpcError) return reason;
  if (
    typeof reason === "object" &&
    reason !== null &&
    typeof (reason as { code?: unknown }).code === "string" &&
    typeof (reason as { message?: unknown }).message === "string"
  ) {
    const { code, message } = reason as { code: string; message: string };
    if (isIpcErrorCode(code)) return new IpcError({ code, message });
    return new Error(code ? `${code}: ${message}` : message);
  }
  return reason;
}
