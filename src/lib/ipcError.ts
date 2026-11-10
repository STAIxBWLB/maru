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

/** Display-only IPC errors, including plugin messages with a recovery step.
 * Unknown codes stay plain text and never acquire a contract error type. */
export function ipcErrorMessage(reason: unknown): string {
  const body = typeof reason === "object" && reason !== null
    ? reason as { code?: unknown; message?: unknown; nextStep?: unknown }
    : undefined;
  const normalized = body && typeof body.message === "string" && !(reason instanceof Error)
    ? normalizeIpcError({ code: typeof body.code === "string" ? body.code : "", message: body.message })
    : normalizeIpcError(reason);
  const message = normalized instanceof Error ? normalized.message : typeof normalized === "string"
    ? normalized : "The request returned an unrecognized error response; retry the operation.";
  const nextStep = typeof body?.message === "string" && typeof body.nextStep === "string" ? body.nextStep : "";
  return nextStep && !message.includes(nextStep) ? `${message} ${nextStep}` : message;
}
