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
    return await new Promise<string>((resolve, reject) => {
      let invocationId: string | null = null;
      let stdoutBuffer = "";
      let settled = false;
      const unlisteners: Array<() => void> = [];
      const early: Array<() => void> = [];
      const cleanup = () => {
        settled = true;
        cancelCurrent = null;
        early.length = 0;
        for (const off of unlisteners) off();
      };
      const safeReject = (err: Error) => {
        if (settled) return;
        cleanup();
        reject(err);
      };
      const stop = () => {
        if (invocationId) void stopAiMission(invocationId).catch(() => {});
      };
      cancelCurrent = () => {
        stop();
        safeReject(new Error("cancelled"));
      };
      const timeout = window.setTimeout(() => {
        stop();
        safeReject(new Error(`Diagram generation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      unlisteners.push(() => window.clearTimeout(timeout));
      const correlate = (id: string, handle: () => void) => {
        if (settled) return;
        if (invocationId === null) {
          early.push(() => { if (id === invocationId) handle(); });
        } else if (id === invocationId) handle();
      };
      const register = async <T,>(event: string, handle: (payload: T) => void) => {
        const off = await listen<T>(event, (evt) => handle(evt.payload));
        if (settled) off();
        else unlisteners.push(off);
      };
      void (async () => {
        try {
          // All listeners are ready before Rust can emit the first output.
          await register<AiOutputEvent>("ai://output", (payload) => {
            correlate(payload.invocationId, () => {
              if (payload.stream === "stdout") stdoutBuffer += `${payload.line}\n`;
            });
          });
          await register<AiDoneEvent>("ai://done", (payload) => {
            correlate(payload.invocationId, () => {
              if (!payload.success) {
                safeReject(new Error(`${runtime} CLI exited with code ${payload.exitCode ?? "unknown"}`));
              } else if (!settled) {
                cleanup();
                resolve(stdoutBuffer);
              }
            });
          });
          await register<AiErrorEvent>("ai://error", (payload) => {
            correlate(payload.invocationId, () => safeReject(new Error(`${payload.kind}: ${payload.message}`)));
          });
          if (settled) return;
          invocationId = await startAgentCliInvocation(
            runtime, promptText, options.workPath, null, null,
            options.commandOverride ?? null, options.permissionMode ?? null,
            { origin: "diagram-generation", ...(options.adaptivePolicy ? { adaptivePolicy: options.adaptivePolicy } : {}) },
          );
          if (settled) { stop(); return; }
          // Events emitted before the invoke response retain their order.
          for (const replay of early.splice(0)) {
            if (settled) break;
            replay();
          }
        } catch (err) {
          safeReject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
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
