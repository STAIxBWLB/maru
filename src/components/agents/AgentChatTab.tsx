// Conversation with an agent's backend, without leaving Maru for a PTY.
//
// The tab hangs off the selected AgentRecord on purpose: runtime, permission
// mode and prompt are already that record's, already persisted, and already
// editable in the adjacent config tab — so there is nothing to re-pick per
// message, and no new settings store for chat.

import { ClipboardCopy, FileText, ListTodo, Send, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ApprovalInput } from "../../approval/ApprovalDialog";
import type { AgentRecord } from "../../lib/agents";
import { agentLabel, resolveAvailableRuntime } from "../../lib/agents";
import {
  appendChatTurn,
  beginChatProposalApply,
  buildChatPrompt,
  CHAT_HISTORY_CAP,
  CHAT_PROPOSAL_APPLIED_EVENT,
  CHAT_PROPOSAL_APPLY_STATE_EVENT,
  finishChatProposalApply,
  isChatProposalApplying,
  loadChatTurns,
  persistChatProposalApplied,
  saveChatTurns,
  sendAgentChatTurn,
  stopAgentChatTurn,
  type AgentRuntimeSelection,
  type ChatProposalAppliedDetail,
  type ChatProposalApplyStateDetail,
  type ChatTurn,
} from "../../lib/agentChat";
import { createTaskNote, saveScratchpadDocument } from "../../lib/api";
import { clipboardWriteText } from "../../lib/clipboard";
import { useTranslation } from "../../lib/i18n";
import type { AiSettings } from "../../lib/settings";
import {
  agentApplySkillProposal,
  agentParseSkillProposal,
  skillsRuntimeStatus,
  SKILL_PROPOSAL_APPLY_APPROVAL_KIND,
  type SkillDispatchRuntime,
  type SkillProposal,
  type SkillRuntimeStatus,
} from "../../lib/skills";
import { Button, IconButton } from "../ui/Button";
import { EmptyState, StatusBanner } from "../ui/ModeChrome";

interface AgentChatTabProps {
  agent: AgentRecord;
  ai: AiSettings;
  workPath: string | null;
  tasksRoot: string | null;
  runtimeCommands: Partial<Record<SkillDispatchRuntime, string | null>>;
  resolvedRuntime: SkillDispatchRuntime;
  permissionMode: string;
  onConfirmApproval: (input: ApprovalInput) => Promise<string | null>;
  onError: (message: string | null) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** First non-empty line, trimmed to something that reads as a title. */
function titleFrom(text: string): string {
  const line = text
    .split("\n")
    .map((value) => value.replace(/^#+\s*/, "").trim())
    .find((value) => value.length > 0);
  if (!line) return "";
  return line.length > 60 ? `${line.slice(0, 60).trimEnd()}…` : line;
}

export function AgentChatTab({
  agent,
  ai,
  workPath,
  tasksRoot,
  runtimeCommands,
  resolvedRuntime,
  permissionMode,
  onConfirmApproval,
  onError,
}: AgentChatTabProps) {
  const { t } = useTranslation();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [invocationId, setInvocationId] = useState<string | null>(null);
  const [tail, setTail] = useState<string[]>([]);
  const [runtime, setRuntime] = useState<SkillRuntimeStatus | null>(null);
  const [runtimeSelection, setRuntimeSelection] = useState<AgentRuntimeSelection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, setProposalApplyRevision] = useState(0);
  const tailRef = useRef<HTMLPreElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const sendAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setTurns(loadChatTurns(workPath, agent.id));
    setInput("");
    setTail([]);
    setNotice(null);
  }, [workPath, agent.id]);

  useEffect(() => () => sendAbortRef.current?.abort(), []);

  useEffect(() => {
    const syncAppliedProposal = (event: Event) => {
      const detail = (event as CustomEvent<ChatProposalAppliedDetail>).detail;
      if (detail.workPath !== workPath || detail.agentId !== agent.id) return;
      setTurns(detail.turns);
      setNotice(t("agents.chat.proposalApplied"));
    };
    window.addEventListener(CHAT_PROPOSAL_APPLIED_EVENT, syncAppliedProposal);
    return () => window.removeEventListener(
      CHAT_PROPOSAL_APPLIED_EVENT,
      syncAppliedProposal,
    );
  }, [agent.id, t, workPath]);

  useEffect(() => {
    const syncApplyState = (event: Event) => {
      const detail = (event as CustomEvent<ChatProposalApplyStateDetail>).detail;
      if (detail.workPath !== workPath || detail.agentId !== agent.id) return;
      setProposalApplyRevision((revision) => revision + 1);
    };
    window.addEventListener(CHAT_PROPOSAL_APPLY_STATE_EVENT, syncApplyState);
    return () => window.removeEventListener(
      CHAT_PROPOSAL_APPLY_STATE_EVENT,
      syncApplyState,
    );
  }, [agent.id, workPath]);

  // Resolve the same availability fallback that dispatch uses, then display
  // that exact backend and binary instead of the unavailable preference.
  useEffect(() => {
    let cancelled = false;
    setRuntime(null);
    setRuntimeSelection(null);
    void resolveAvailableRuntime(resolvedRuntime, ai)
      .then((selection) => {
        if (cancelled) return;
        setRuntimeSelection({
          runtime: selection.runtime,
          commandOverride: selection.commandOverride,
        });
        setRuntime(selection.status);
      })
      .catch(() => {
        // No fallback is ready. Preserve the preferred backend's actionable
        // diagnosis in the header instead of replacing it with a generic error.
        void skillsRuntimeStatus({
          runtime: resolvedRuntime,
          commandOverride: runtimeCommands[resolvedRuntime] ?? null,
        })
          .then((status) => {
            if (!cancelled) setRuntime(status);
          })
          .catch(() => {
            if (!cancelled) setRuntime(null);
          });
      });
    return () => {
      cancelled = true;
    };
  }, [ai, resolvedRuntime, runtimeCommands]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, tail]);

  useEffect(() => {
    const node = tailRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [tail]);

  const persist = useCallback(
    (next: ChatTurn[]) => {
      const capped = next.slice(-CHAT_HISTORY_CAP);
      setTurns(capped);
      saveChatTurns(workPath, agent.id, capped);
      return capped;
    },
    [workPath, agent.id],
  );

  const appendTurn = useCallback(
    (turn: ChatTurn) => {
      setTurns((current) => {
        const next = appendChatTurn(current, turn);
        saveChatTurns(workPath, agent.id, next);
        return next;
      });
    },
    [agent.id, workPath],
  );

  const droppedTurns = useMemo(() => {
    if (!input.trim()) return 0;
    return buildChatPrompt(agent, turns, input).droppedTurns;
  }, [agent, turns, input]);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || busy || !workPath || !runtimeSelection) return;
    setBusy(true);
    setTail([]);
    setNotice(null);
    onError(null);
    const startedAt = Date.now();
    const abortController = new AbortController();
    sendAbortRef.current = abortController;
    appendTurn({ role: "user", text: message, at: new Date().toISOString() });
    setInput("");
    try {
      const result = await sendAgentChatTurn({
        agent,
        ai,
        workPath,
        turns,
        message,
        runtimeSelection,
        signal: abortController.signal,
        onInvocation: setInvocationId,
        onChunk: (line) => setTail((lines) => [...lines, line].slice(-200)),
      });
      appendTurn({
        role: "assistant",
        text: result.text,
        at: new Date().toISOString(),
        runtime: result.runtime,
        permissionMode: result.permissionMode,
        exitCode: result.exitCode,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        onError(errorMessage(error));
      }
    } finally {
      if (sendAbortRef.current === abortController) {
        sendAbortRef.current = null;
        setBusy(false);
        setInvocationId(null);
        setTail([]);
      }
    }
  }, [agent, ai, appendTurn, busy, input, onError, runtimeSelection, turns, workPath]);

  const stop = useCallback(async () => {
    const controller = sendAbortRef.current;
    if (controller && !controller.signal.aborted) {
      controller.abort();
      return;
    }
    if (!invocationId) return;
    try {
      await stopAgentChatTurn(invocationId);
    } catch (error) {
      onError(errorMessage(error));
    }
  }, [invocationId, onError]);

  const clear = useCallback(() => {
    persist([]);
    setNotice(null);
  }, [persist]);

  const toTask = useCallback(
    async (text: string) => {
      if (!workPath) return;
      const title = titleFrom(text) || agentLabel(agent, t);
      try {
        const row = await createTaskNote(
          workPath,
          {
            slug: title,
            title,
            bucket: "active",
            frontmatter: { title, status: "active", priority: "medium" },
            body: text,
          },
          tasksRoot,
        );
        setNotice(t("agents.chat.saved", { path: row.relPath ?? title }));
      } catch (error) {
        onError(errorMessage(error));
      }
    },
    [agent, onError, t, tasksRoot, workPath],
  );

  const toMemo = useCallback(
    async (text: string) => {
      if (!workPath) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      try {
        const doc = await saveScratchpadDocument(
          workPath,
          "memos",
          `chat-${agent.id}-${stamp}.md`,
          "markdown",
          text,
          null,
        );
        setNotice(t("agents.chat.saved", { path: doc.relativePath }));
      } catch (error) {
        onError(errorMessage(error));
      }
    },
    [agent.id, onError, t, workPath],
  );

  const applyProposal = useCallback(
    async (turnAt: string, proposal: SkillProposal) => {
      if (!workPath) return;
      if (!beginChatProposalApply(workPath, agent.id, turnAt)) return;
      try {
        const approvalId = await onConfirmApproval({
          kind: SKILL_PROPOSAL_APPLY_APPROVAL_KIND,
          summary: t("skillRuns.applySummary", {
            files: proposal.files.length,
            commands: proposal.commands.length,
          }),
          target: proposal.files.map((file) => file.path).join("\n"),
        });
        if (!approvalId) return;
        await agentApplySkillProposal({ cwd: workPath, proposal, approvalId });
        const proposalAppliedAt = new Date().toISOString();
        // Applying writes durable files. Persist its idempotence marker from
        // the latest stored transcript even if this tab unmounted while the
        // approval or apply command was in flight.
        persistChatProposalApplied(
          workPath,
          agent.id,
          turnAt,
          proposalAppliedAt,
        );
      } catch (error) {
        onError(errorMessage(error));
      } finally {
        finishChatProposalApply(workPath, agent.id, turnAt);
      }
    },
    [agent.id, onConfirmApproval, onError, t, workPath],
  );

  const activeRuntime = runtimeSelection?.runtime ?? resolvedRuntime;

  if (!workPath) {
    return <EmptyState title={t("agents.chat.noWorkspace")} />;
  }

  return (
    <div className="agents-chat">
      <div className="agents-chat-runtime">
        <span className="agents-chat-runtime-name">{activeRuntime}</span>
        <span>·</span>
        <span>{permissionMode}</span>
        {runtime === null ? (
          <span>{t("skills.runtime.checking")}</span>
        ) : (
          <>
            <span>·</span>
            <span data-ready={runtime.available ? "yes" : "no"}>
              {runtime.available
                ? t("skills.runtime.ready", {
                    runtime: runtime.runtime,
                    version: runtime.version ?? "",
                  })
                : t("skills.runtime.unavailable")}
            </span>
            {runtime.binaryPath ? (
              <code title={runtime.binaryPath}>
                {t("agents.chat.runtimePath", { path: runtime.binaryPath })}
              </code>
            ) : null}
          </>
        )}
        <span className="agents-chat-runtime-spacer" />
        {turns.length > 0 ? (
          <IconButton
            label={t("agents.chat.clear")}
            title={t("agents.chat.clear")}
            disabled={busy}
            onClick={clear}
          >
            <Trash2 size={13} />
          </IconButton>
        ) : null}
      </div>

      {!agent.enabled ? (
        <StatusBanner tone="warning">
          <span>{t("agents.chat.disabled")}</span>
        </StatusBanner>
      ) : null}
      {runtime && !runtime.available && runtime.suggestedAction ? (
        <StatusBanner tone="warning">
          <span>{runtime.suggestedAction}</span>
        </StatusBanner>
      ) : null}
      {notice ? (
        <StatusBanner tone="info">
          <span>{notice}</span>
        </StatusBanner>
      ) : null}

      <div className="agents-chat-turns">
        {turns.length === 0 && !busy ? (
          <EmptyState
            title={t("agents.chat.empty")}
            description={t("agents.chat.emptyHint", {
              runtime: activeRuntime,
              mode: permissionMode,
            })}
          />
        ) : null}
        {turns.map((turn, index) => (
          <ChatBubble
            key={`${turn.at}-${index}`}
            turn={turn}
            onCopy={() => void clipboardWriteText(turn.text)}
            onTask={() => void toTask(turn.text)}
            onMemo={() => void toMemo(turn.text)}
            proposalApplying={isChatProposalApplying(workPath, agent.id, turn.at)}
            onApplyProposal={(proposal) => applyProposal(turn.at, proposal)}
          />
        ))}
        {busy ? (
          <div className="agents-chat-bubble" data-role="assistant" data-pending="yes">
            <p className="agents-chat-meta">
              {t("agents.chat.thinking", { runtime: activeRuntime })}
            </p>
            <pre className="processing-log" ref={tailRef}>
              {tail.length > 0 ? tail.join("\n") : t("agents.status.waiting")}
            </pre>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      {droppedTurns > 0 ? (
        <p className="agents-chat-truncated">
          {t("agents.chat.truncated", { count: droppedTurns })}
        </p>
      ) : null}

      <div className="agents-chat-composer">
        <textarea
          value={input}
          rows={3}
          disabled={busy || !agent.enabled || runtimeSelection === null}
          placeholder={t("agents.chat.placeholder")}
          aria-label={t("agents.chat.placeholder")}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {busy ? (
          <Button variant="secondary" size="sm" onClick={() => void stop()}>
            <Square size={13} />
            <span>{t("agents.action.stop")}</span>
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={!input.trim() || !agent.enabled || runtimeSelection === null}
            onClick={() => void send()}
          >
            <Send size={13} />
            <span>{t("agents.chat.send")}</span>
          </Button>
        )}
      </div>
    </div>
  );
}

function ChatBubble({
  turn,
  onCopy,
  onTask,
  onMemo,
  proposalApplying,
  onApplyProposal,
}: {
  turn: ChatTurn;
  onCopy: () => void;
  onTask: () => void;
  onMemo: () => void;
  proposalApplying: boolean;
  onApplyProposal: (proposal: SkillProposal) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [proposal, setProposal] = useState<SkillProposal | null>(null);

  // A conversational answer usually is not a proposal; parsing is how we find
  // out, and a failure is the normal case rather than an error.
  useEffect(() => {
    let cancelled = false;
    if (turn.role !== "assistant") return;
    void agentParseSkillProposal(turn.text)
      .then((parsed) => {
        if (!cancelled) setProposal(parsed);
      })
      .catch(() => {
        if (!cancelled) setProposal(null);
      });
    return () => {
      cancelled = true;
    };
  }, [turn.role, turn.text]);

  return (
    <div className="agents-chat-bubble" data-role={turn.role}>
      <p className="agents-chat-text">{turn.text}</p>
      {turn.role === "assistant" ? (
        <div className="agents-chat-actions">
          <span className="agents-chat-meta">
            {t("agents.chat.turnMeta", {
              runtime: turn.runtime ?? "?",
              mode: turn.permissionMode ?? "?",
              elapsed: turn.elapsedMs ? `${Math.round(turn.elapsedMs / 1000)}s` : "?",
            })}
          </span>
          <Button variant="ghost" size="sm" onClick={onTask}>
            <ListTodo size={13} />
            <span>{t("agents.chat.toTask")}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={onMemo}>
            <FileText size={13} />
            <span>{t("agents.chat.toMemo")}</span>
          </Button>
          {proposal ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={proposalApplying || Boolean(turn.proposalAppliedAt)}
              onClick={() => {
                if (proposalApplying || turn.proposalAppliedAt) return;
                void onApplyProposal(proposal);
              }}
            >
              {turn.proposalAppliedAt
                ? t("agents.chat.proposalApplied")
                : t("agents.chat.applyProposal")}
            </Button>
          ) : null}
          <IconButton label={t("agents.chat.copy")} title={t("agents.chat.copy")} onClick={onCopy}>
            <ClipboardCopy size={13} />
          </IconButton>
        </div>
      ) : null}
    </div>
  );
}
