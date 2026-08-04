// Multi-turn conversation with an agent's CLI backend.
//
// Deliberately not a skill dispatch: `skills_dispatch_background` requires a
// skill id and prepends the whole SKILL.md, which is right for a job and wrong
// for a conversation. Chat goes through `start_agent_cli_invocation`, the same
// primitive the inbox classifier uses, so no new Rust command exists for it.

import { startAgentCliInvocation, stopAiMission } from "./api";
import type { AiDoneEvent, AiErrorEvent, AiOutputEvent } from "./aiInvoke";
import {
  resolveAgentPermissionMode,
  resolveAgentRuntime,
  resolveAvailableRuntime,
  type AgentRecord,
} from "./agents";
import type { AiRuntime, AiSettings } from "./settings";

const isTauri = () =>
  typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

function chatAbortError(): Error {
  const error = new Error("agent_chat_cancelled");
  error.name = "AbortError";
  return error;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
  /** Assistant turns only — what actually ran, after runtime fallback. */
  runtime?: AiRuntime;
  permissionMode?: string;
  exitCode?: number | null;
  elapsedMs?: number;
  /** Persisted guard against applying the same append-capable proposal twice. */
  proposalAppliedAt?: string;
}

/**
 * claude, kimi and kiro pass the whole prompt as a single argv entry, which the
 * OS length-limits; codex pipes it over stdin. This cap is sized for the argv
 * case, not for a model's context window.
 */
export const CHAT_PROMPT_MAX_CHARS = 24_000;

/** Scrollback kept per agent. UI state — anything worth keeping leaves through
 *  the turn actions, which write real files. */
export const CHAT_HISTORY_CAP = 20;
export const CHAT_PROPOSAL_APPLIED_EVENT = "maru:agent-chat:proposal-applied";
export const CHAT_PROPOSAL_APPLY_STATE_EVENT = "maru:agent-chat:proposal-apply-state";

export interface ChatProposalAppliedDetail {
  workPath: string;
  agentId: string;
  turns: ChatTurn[];
}

export interface ChatProposalApplyStateDetail {
  workPath: string;
  agentId: string;
  turnAt: string;
  applying: boolean;
}

const applyingChatProposals = new Set<string>();
const appliedChatProposals = new Set<string>();

const chatProposalKey = (workPath: string, agentId: string, turnAt: string) =>
  JSON.stringify([workPath, agentId, turnAt]);

function dispatchChatEvent<T>(name: string, detail: T): void {
  if (
    typeof window !== "undefined"
    && typeof window.dispatchEvent === "function"
    && typeof CustomEvent !== "undefined"
  ) {
    window.dispatchEvent(new CustomEvent<T>(name, { detail }));
  }
}

export function beginChatProposalApply(
  workPath: string,
  agentId: string,
  turnAt: string,
): boolean {
  const key = chatProposalKey(workPath, agentId, turnAt);
  if (applyingChatProposals.has(key) || appliedChatProposals.has(key)) return false;
  applyingChatProposals.add(key);
  dispatchChatEvent<ChatProposalApplyStateDetail>(CHAT_PROPOSAL_APPLY_STATE_EVENT, {
    workPath,
    agentId,
    turnAt,
    applying: true,
  });
  return true;
}

export function finishChatProposalApply(
  workPath: string,
  agentId: string,
  turnAt: string,
): void {
  const key = chatProposalKey(workPath, agentId, turnAt);
  if (!applyingChatProposals.delete(key)) return;
  dispatchChatEvent<ChatProposalApplyStateDetail>(CHAT_PROPOSAL_APPLY_STATE_EVENT, {
    workPath,
    agentId,
    turnAt,
    applying: false,
  });
}

export function isChatProposalApplying(
  workPath: string,
  agentId: string,
  turnAt: string,
): boolean {
  return applyingChatProposals.has(chatProposalKey(workPath, agentId, turnAt));
}

export function isChatProposalApplied(
  workPath: string,
  agentId: string,
  turnAt: string,
): boolean {
  return appliedChatProposals.has(chatProposalKey(workPath, agentId, turnAt));
}

/** Append against the latest stored transcript so concurrent turn actions
 *  (for example, applying a proposal) are never replaced by a stale snapshot. */
export function appendChatTurn(turns: ChatTurn[], turn: ChatTurn): ChatTurn[] {
  return [...turns, turn].slice(-CHAT_HISTORY_CAP);
}

/** Failed and cancelled user turns must never be replayed in a later prompt. */
export function removeChatUserTurn(turns: ChatTurn[], turnAt: string): ChatTurn[] {
  return turns.filter((turn) => !(turn.role === "user" && turn.at === turnAt));
}

/** Mark an applied proposal without rebuilding the turn from a stale snapshot. */
export function markChatProposalApplied(
  turns: ChatTurn[],
  turnAt: string,
  proposalAppliedAt: string,
): ChatTurn[] {
  return turns.map((turn) =>
    turn.role === "assistant" && turn.at === turnAt
      ? { ...turn, proposalAppliedAt }
      : turn,
  );
}

// ponytail: multi-turn = replay the capped transcript as one prompt. Ceiling:
// the prompt grows O(turns^2) in tokens, and no server-side tool or file state
// carries across turns — every turn is a cold subprocess. Upgrade path is
// native resume (claude --resume, codex exec resume, kimi --session) through
// startAgentCliInvocation's extraArgs, once (1) the session id is captured per
// provider from --output-format json, (2) build_cli_command stops terminating
// the codex argv with "-" so appended args still land before it, and (3) kiro
// grows a resume flag. AGENT_CAPABILITIES.resume already records who could.
export function buildChatPrompt(
  agent: AgentRecord,
  turns: ChatTurn[],
  message: string,
): { prompt: string; droppedTurns: number } {
  const preamble = agent.prompt.trim();
  const head = preamble ? `<agent_instructions>\n${preamble}\n</agent_instructions>\n\n` : "";
  const tail = `User: ${message}`;

  const render = (turn: ChatTurn) =>
    `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`;

  // Drop oldest first. The newest user message is never truncated: a silently
  // mangled question answered confidently is worse than the CLI erroring.
  let dropped = 0;
  let kept = turns;
  for (;;) {
    const body = kept.map(render).join("\n\n");
    const prompt = body ? `${head}${body}\n\n${tail}` : `${head}${tail}`;
    if (prompt.length <= CHAT_PROMPT_MAX_CHARS || kept.length === 0) {
      return { prompt, droppedTurns: dropped };
    }
    kept = kept.slice(1);
    dropped += 1;
  }
}

const storageKey = (workPath: string | null, agentId: string) =>
  `maru:agent-chat:v1:${workPath ?? "no-workspace"}:${agentId}`;

export function loadChatTurns(workPath: string | null, agentId: string): ChatTurn[] {
  try {
    const raw = window.localStorage.getItem(storageKey(workPath, agentId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (turn): turn is ChatTurn =>
        typeof turn === "object"
        && turn !== null
        && typeof (turn as ChatTurn).text === "string"
        && ((turn as ChatTurn).role === "user" || (turn as ChatTurn).role === "assistant"),
    );
  } catch {
    // A corrupt or unavailable store must not take the pane down with it.
    return [];
  }
}

export function saveChatTurns(
  workPath: string | null,
  agentId: string,
  turns: ChatTurn[],
): boolean {
  try {
    window.localStorage.setItem(
      storageKey(workPath, agentId),
      JSON.stringify(turns.slice(-CHAT_HISTORY_CAP)),
    );
    return true;
  } catch {
    // Quota or private mode — the conversation still works for this session.
    return false;
  }
}

/** Remove an incomplete user turn from durable replay state. */
export function discardStoredChatUserTurn(
  workPath: string,
  agentId: string,
  turnAt: string,
): ChatTurn[] {
  const next = removeChatUserTurn(loadChatTurns(workPath, agentId), turnAt);
  saveChatTurns(workPath, agentId, next);
  return next;
}

/** Persist the proposal guard independently of any mounted chat component. */
export function persistChatProposalApplied(
  workPath: string,
  agentId: string,
  turnAt: string,
  proposalAppliedAt: string,
): ChatTurn[] {
  const key = chatProposalKey(workPath, agentId, turnAt);
  const next = markChatProposalApplied(
    loadChatTurns(workPath, agentId),
    turnAt,
    proposalAppliedAt,
  );
  // The files are already applied at this point. Retain an in-process guard
  // even when localStorage is unavailable, so remounting cannot apply the
  // same proposal again during this app session.
  appliedChatProposals.add(key);
  const marked = next.some(
    (turn) =>
      turn.role === "assistant"
      && turn.at === turnAt
      && turn.proposalAppliedAt === proposalAppliedAt,
  );
  if (!marked) {
    throw new Error(
      "agent_chat_proposal_marker_missing: proposal applied, but its replay guard could not be recorded",
    );
  }
  if (!saveChatTurns(workPath, agentId, next)) {
    throw new Error(
      "agent_chat_proposal_marker_persist_failed: proposal applied, but its replay guard could not be saved",
    );
  }
  dispatchChatEvent<ChatProposalAppliedDetail>(CHAT_PROPOSAL_APPLIED_EVENT, {
    workPath,
    agentId,
    turns: next,
  });
  return next;
}

export interface ChatSendResult {
  text: string;
  runtime: AiRuntime;
  permissionMode: string;
  exitCode: number | null;
}

export interface SendAgentChatTurnParams {
  agent: AgentRecord;
  ai: AiSettings;
  workPath: string;
  turns: ChatTurn[];
  message: string;
  /** The selection displayed by the pane; dispatch must use the same backend. */
  runtimeSelection?: AgentRuntimeSelection;
  /** Unmounting a foreground chat aborts its subprocess and stale callbacks. */
  signal?: AbortSignal;
  /** Fires as soon as the subprocess is registered, so the UI can offer Stop. */
  onInvocation?: (invocationId: string) => void;
  /** Live stdout tail while the turn runs. */
  onChunk?: (line: string) => void;
}

export interface AgentRuntimeSelection {
  runtime: AiRuntime;
  commandOverride: string | null;
}

type BufferedChatEvent =
  | { type: "output"; payload: AiOutputEvent }
  | { type: "done"; payload: AiDoneEvent }
  | { type: "error"; payload: AiErrorEvent };

/** One chat turn against the agent's resolved backend. */
export async function sendAgentChatTurn(
  params: SendAgentChatTurnParams,
): Promise<ChatSendResult> {
  const { agent, ai, workPath, turns, message } = params;
  // Turning an agent off has to stop its conversation too — runAgentDetailed's
  // guard never runs on this path.
  if (!agent.enabled) throw new Error(`agent_disabled: ${agent.id}`);
  if (!message.trim()) throw new Error("agent_prompt_required");

  const { runtime, commandOverride } = params.runtimeSelection
    ?? await resolveAvailableRuntime(resolveAgentRuntime(agent, ai), ai);
  const permissionMode = resolveAgentPermissionMode(agent, ai);
  const { prompt } = buildChatPrompt(agent, turns, message);

  if (!isTauri()) {
    // Browser dev shell: no ai:// bus, so the e2e override's return value is
    // the assistant turn. Real event replay can come when a spec needs to
    // assert streaming rather than the final answer.
    if (params.signal?.aborted) throw chatAbortError();
    const starting = startAgentCliInvocation(
      runtime,
      prompt,
      workPath,
      null,
      null,
      commandOverride,
      permissionMode,
    );
    const invocationId = await new Promise<string>((resolve, reject) => {
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        reject(chatAbortError());
      };
      params.signal?.addEventListener("abort", onAbort, { once: true });
      void starting.then(
        (id) => {
          params.signal?.removeEventListener("abort", onAbort);
          if (aborted || params.signal?.aborted) {
            void stopAiMission(id).catch(() => {});
            return;
          }
          resolve(id);
        },
        (error) => {
          params.signal?.removeEventListener("abort", onAbort);
          if (!aborted) reject(error);
        },
      );
    });
    params.onInvocation?.(invocationId);
    return { text: invocationId, runtime, permissionMode, exitCode: 0 };
  }

  const { listen } = await import("@tauri-apps/api/event");
  return await new Promise<ChatSendResult>((resolve, reject) => {
    let invocationId: string | null = null;
    let stdout = "";
    const stderr: string[] = [];
    let settled = false;
    const unlisteners: Array<() => void> = [];
    const bufferedEvents: BufferedChatEvent[] = [];

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
    const safeReject = (error: Error) => {
      if (settled) return;
      cleanup();
      reject(error);
    };

    const abort = () => {
      if (invocationId !== null) {
        void stopAiMission(invocationId).catch(() => {});
      }
      safeReject(chatAbortError());
    };
    if (params.signal) {
      params.signal.addEventListener("abort", abort, { once: true });
      unlisteners.push(() => params.signal?.removeEventListener("abort", abort));
      if (params.signal.aborted) {
        abort();
        return;
      }
    }

    const handleEvent = (event: BufferedChatEvent) => {
      if (invocationId === null) {
        // A short-lived CLI can emit output and completion before the Tauri
        // command's invocation-id response crosses back to the webview. Keep
        // those events until the id is known, then replay only its events.
        bufferedEvents.push(event);
        return;
      }
      if (event.payload.invocationId !== invocationId || settled) return;
      if (event.type === "output") {
        if (event.payload.stream === "stdout") {
          stdout += `${event.payload.line}\n`;
        } else {
          stderr.push(event.payload.line);
        }
        params.onChunk?.(event.payload.line);
        return;
      }
      if (event.type === "error") {
        safeReject(new Error(`${event.payload.kind}: ${event.payload.message}`));
        return;
      }
      if (!event.payload.success) {
        // stderr is only surfaced on failure; it is noise on the happy path.
        const detail = stderr.join("\n").trim();
        safeReject(
          new Error(
            detail
              || `${runtime} CLI exited with code ${event.payload.exitCode ?? "unknown"}`,
          ),
        );
        return;
      }
      cleanup();
      resolve({
        text: stdout.trim(),
        runtime,
        permissionMode,
        exitCode: event.payload.exitCode,
      });
    };

    const register = async <T>(
      eventName: string,
      callback: (event: { payload: T }) => void,
    ): Promise<boolean> => {
      const off = await listen<T>(eventName, callback);
      if (settled) {
        off();
        return false;
      }
      unlisteners.push(off);
      return true;
    };

    void (async () => {
      try {
        // Registration must finish before Rust starts the subprocess. Tauri
        // events are not replayed, and immediate auth/argv failures can finish
        // before the invoke response otherwise.
        if (!(await register<AiOutputEvent>("ai://output", (evt) =>
          handleEvent({ type: "output", payload: evt.payload })))) return;
        if (!(await register<AiDoneEvent>("ai://done", (evt) =>
          handleEvent({ type: "done", payload: evt.payload })))) return;
        if (!(await register<AiErrorEvent>("ai://error", (evt) =>
          handleEvent({ type: "error", payload: evt.payload })))) return;
        if (settled) return;

        const startedInvocationId = await startAgentCliInvocation(
          runtime,
          prompt,
          workPath,
          null,
          null,
          commandOverride,
          permissionMode,
        );
        invocationId = startedInvocationId;
        if (settled || params.signal?.aborted) {
          await stopAiMission(startedInvocationId).catch(() => {});
          return;
        }
        params.onInvocation?.(invocationId);
        const pending = bufferedEvents.splice(0);
        for (const event of pending) handleEvent(event);
      } catch (error) {
        safeReject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

/** Chat runs are foreground and visible in the tab, so they are stopped
 *  directly rather than through the mission board. */
export async function stopAgentChatTurn(invocationId: string): Promise<void> {
  await stopAiMission(invocationId);
}
