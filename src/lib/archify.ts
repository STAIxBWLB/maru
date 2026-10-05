/**
 * Frontend wrapper for the pinned Archify engine adapter (issue #433 P1).
 *
 * The Rust `archify_validate_candidate` command (src-tauri/src/archify.rs)
 * stages a candidate spec and runs the vendored engine's `validate` verb,
 * returning a camelCase receipt. Two failure families matter to callers:
 *
 * - **Engine unavailable** — the engine or a Node runtime is missing, or the
 *   command itself is not registered (older backend / browser dev shell).
 *   These are normalized to a typed {@link ArchifyEngineError} with
 *   {@link ENGINE_UNAVAILABLE} so the dialog can surface a diagnostic instead
 *   of crashing; Mermaid-only flows keep working without the engine.
 * - **Everything else** (invalid type, oversize candidate, engine timeout,
 *   engine failure) is passed through `normalizeIpcError` unchanged.
 */

import { invoke } from "@tauri-apps/api/core";
import { normalizeIpcError } from "./ipcError";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Code carried by {@link ArchifyEngineError} when the engine cannot run. */
export const ENGINE_UNAVAILABLE = "engine_unavailable";

/** Matches `ARCHIFY_ENGINE_UNAVAILABLE` in src-tauri/src/archify.rs. */
const BACKEND_ENGINE_UNAVAILABLE = "archify_engine_unavailable";

export class ArchifyEngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArchifyEngineError";
    this.code = code;
  }
}

export function isEngineUnavailable(error: unknown): boolean {
  return error instanceof ArchifyEngineError && error.code === ENGINE_UNAVAILABLE;
}

export interface ArchifyValidationReceipt {
  ok: boolean;
  diagramType?: string;
  errors: string[];
  warnings: string[];
  candidateSha256?: string;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

function rawCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/** Tauri rejects an unregistered command with an "unknown command" string. */
function isUnknownCommand(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown command/i.test(message);
}

export async function archifyValidateCandidate(
  workspace: string,
  diagramType: string,
  candidateJson: string,
): Promise<ArchifyValidationReceipt> {
  if (!isTauri()) {
    throw new ArchifyEngineError(
      ENGINE_UNAVAILABLE,
      "The Archify engine is only available inside the Tauri shell.",
    );
  }
  try {
    return await invoke<ArchifyValidationReceipt>("archify_validate_candidate", {
      workspace,
      diagramType,
      candidateJson,
    });
  } catch (err) {
    if (rawCode(err) === BACKEND_ENGINE_UNAVAILABLE || isUnknownCommand(err)) {
      const message =
        typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : String(err);
      throw new ArchifyEngineError(ENGINE_UNAVAILABLE, message);
    }
    throw normalizeIpcError(err);
  }
}
