/**
 * Agent-host glue for AI diagram generation (issue #433 P1).
 *
 * Mirrors the `aiInvoke` one-shot pattern: `start_agent_cli_invocation` with
 * the built prompt, stdout accumulated from `ai://output`, resolution on
 * `ai://done`, rejection on `ai://error` or a client-side hard timeout.
 * Cancellation goes through the existing mission stop (`stop_ai_mission`)
 * and also rejects the pending promise locally so `runGenerationJob` settles
 * immediately instead of waiting for the backend to notice.
 *
 * `validateCandidate` forwards to the pinned-engine Rust command via
 * {@link archifyValidateCandidate}; an unavailable engine surfaces as the
 * typed {@link ENGINE_UNAVAILABLE} error (see `src/lib/archify.ts`).
 */

import { startAgentCliInvocation, stopAiMission, type AgentProvider } from "../api";
import { archifyValidateCandidate } from "../archify";
import type { AdaptivePolicy } from "../settings";
import type { GenerationHost } from "./generation";
import type { SemanticDiagramType } from "./reportTypes";
import type { AiDoneEvent, AiErrorEvent, AiOutputEvent } from "../aiInvoke";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

const DEFAULT_TIMEOUT_MS = 180_000;

export interface GenerationHostOptions {
  /** Workspace cwd the agent CLI runs in. */
  workPath: string | null;
  runtime?: AgentProvider;
  commandOverride?: string | null;
  permissionMode?: string | null;
  adaptivePolicy?: AdaptivePolicy | null;
  timeoutMs?: number;
}

export interface DiagramGenerationHost extends GenerationHost {
  /** Stop the running invocation, if any; the pending runAgent rejects. */
  cancel(): void;
}

export function createGenerationHost(options: GenerationHostOptions): DiagramGenerationHost {
  const runtime = options.runtime ?? "claude";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cancelCurrent: (() => void) | null = null;

  const runAgent = async (promptText: string): Promise<string> => {
    if (!isTauri()) {
      throw new Error("Diagram generation is only available inside the Tauri shell.");
    }
    const { listen } = await import("@tauri-apps/api/event");
    const invocationId = await startAgentCliInvocation(
      runtime,
      promptText,
      options.workPath,
      null,
      null,
      options.commandOverride ?? null,
      options.permissionMode ?? null,
      {
        origin: "diagram-generation",
        ...(options.adaptivePolicy ? { adaptivePolicy: options.adaptivePolicy } : {}),
      },
    );

    return await new Promise<string>((resolve, reject) => {
      let stdoutBuffer = "";
      let settled = false;
      const unlisteners: Array<() => void> = [];

      const cleanup = () => {
        settled = true;
        cancelCurrent = null;
        for (const off of unlisteners) {
          try {
            off();
          } catch {
            // best-effort
          }
        }
      };

      const safeResolve = (value: string) => {
        if (settled) return;
        cleanup();
        resolve(value);
      };

      const safeReject = (err: Error) => {
        if (settled) return;
        cleanup();
        reject(err);
      };

      const timeout = window.setTimeout(() => {
        void stopAiMission(invocationId).catch(() => {
          // best-effort: the local rejection below settles the promise either way
        });
        safeReject(new Error(`Diagram generation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      unlisteners.push(() => window.clearTimeout(timeout));

      cancelCurrent = () => {
        void stopAiMission(invocationId).catch(() => {
          // best-effort
        });
        safeReject(new Error("cancelled"));
      };

      void listen<AiOutputEvent>("ai://output", (evt) => {
        if (evt.payload.invocationId !== invocationId) return;
        if (evt.payload.stream === "stdout") {
          stdoutBuffer += `${evt.payload.line}\n`;
        }
      }).then((off) => unlisteners.push(off));

      void listen<AiDoneEvent>("ai://done", (evt) => {
        if (evt.payload.invocationId !== invocationId) return;
        if (!evt.payload.success) {
          safeReject(
            new Error(`${runtime} CLI exited with code ${evt.payload.exitCode ?? "unknown"}`),
          );
          return;
        }
        safeResolve(stdoutBuffer);
      }).then((off) => unlisteners.push(off));

      void listen<AiErrorEvent>("ai://error", (evt) => {
        if (evt.payload.invocationId !== invocationId) return;
        safeReject(new Error(`${evt.payload.kind}: ${evt.payload.message}`));
      }).then((off) => unlisteners.push(off));
    });
  };

  const validateCandidate = async (
    diagramType: SemanticDiagramType,
    spec: unknown,
  ): Promise<{ ok: boolean; errors: string[]; warnings: string[]; candidateSha256?: string }> => {
    if (!options.workPath) {
      throw new Error("Diagram generation requires an open workspace.");
    }
    return archifyValidateCandidate(options.workPath, diagramType, JSON.stringify(spec));
  };

  return {
    runAgent,
    validateCandidate,
    cancel: () => cancelCurrent?.(),
  };
}
