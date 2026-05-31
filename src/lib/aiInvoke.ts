// Frontend orchestration on top of the Rust Claude CLI bridge +
// inbox classifier. Single helper `classifyInboxItem(item)` that:
//   1. asks Rust to build the prompt for `item`
//   2. spawns `claude -p <prompt>` via the CLI bridge, captures the
//      returned invocation id
//   3. listens for `ai://output` events filtered to that invocation id,
//      accumulating stdout lines
//   4. on `ai://done`, asks Rust to parse the accumulated raw text into
//      a typed Classification
//   5. on `ai://error`, rejects with a typed message
//
// In the browser dev shell (no Tauri runtime), the helper short-circuits
// to a small heuristic stub so InboxPane is still exercisable without a
// real subprocess.

import {
  buildInboxClassificationPrompt,
  parseInboxClassification,
  startAgentCliInvocation,
  type AgentProvider,
} from "./api";
import type { InboxClassification, InboxDropItem } from "./types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

interface AiOutputEvent {
  invocationId: string;
  stream: string;
  line: string;
}

interface AiDoneEvent {
  invocationId: string;
  exitCode: number | null;
  success: boolean;
}

interface AiErrorEvent {
  invocationId: string;
  kind: string;
  message: string;
}

const HARD_TIMEOUT_MS = 60_000;

export async function classifyInboxItem(
  item: InboxDropItem,
  runtime: AgentProvider = "claude",
  cwd: string | null = null,
  commandOverride: string | null = null,
  permissionMode: string | null = null,
): Promise<InboxClassification> {
  const prompt = await buildInboxClassificationPrompt(item);

  if (!isTauri()) {
    // Browser dev path — bypass the subprocess entirely.
    return parseInboxClassification(prompt);
  }

  const { listen } = await import("@tauri-apps/api/event");
  // Pass the workspace cwd so the agent runs in the right tree. Codex `exec`
  // in particular refuses to run outside a trusted (git) directory, so without
  // a workspace cwd it would fail; the inbox workspace is always a git repo.
  // The command override + permission mode come from AI settings so a CLI
  // installed outside PATH (or a non-plan mode) is honored.
  const invocationId = await startAgentCliInvocation(
    runtime,
    prompt,
    cwd,
    null,
    null,
    commandOverride,
    permissionMode,
  );

  return await new Promise<InboxClassification>((resolve, reject) => {
    let stdoutBuffer = "";
    let settled = false;
    const unlisteners: Array<() => void> = [];

    const cleanup = () => {
      settled = true;
      for (const off of unlisteners) {
        try {
          off();
        } catch {
          // best-effort
        }
      }
    };

    const safeResolve = async () => {
      if (settled) return;
      try {
        const parsed = await parseInboxClassification(stdoutBuffer);
        cleanup();
        resolve(parsed);
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const safeReject = (err: Error) => {
      if (settled) return;
      cleanup();
      reject(err);
    };

    const timeout = window.setTimeout(() => {
      safeReject(new Error(`Classifier timed out after ${HARD_TIMEOUT_MS}ms`));
    }, HARD_TIMEOUT_MS);
    unlisteners.push(() => window.clearTimeout(timeout));

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
          new Error(
            `${runtime} CLI exited with code ${evt.payload.exitCode ?? "unknown"}`,
          ),
        );
        return;
      }
      void safeResolve();
    }).then((off) => unlisteners.push(off));

    void listen<AiErrorEvent>("ai://error", (evt) => {
      if (evt.payload.invocationId !== invocationId) return;
      safeReject(new Error(`${evt.payload.kind}: ${evt.payload.message}`));
    }).then((off) => unlisteners.push(off));
  });
}
