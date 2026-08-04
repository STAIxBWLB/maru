import { beforeEach, describe, expect, it, vi } from "vitest";

const startAgentCliInvocation = vi.fn(async (..._args: unknown[]) => "ai-chat-1");
const stopAiMission = vi.fn(async (_id: string) => ({}) as never);
vi.mock("./api", () => ({
  startAgentCliInvocation: (...args: unknown[]) => startAgentCliInvocation(...args),
  stopAiMission: (id: string) => stopAiMission(id),
}));

interface RuntimeStatusStub {
  runtime: string;
  available: boolean;
  authStatus: string;
  message: string;
  suggestedAction: string | null;
}
const skillsRuntimeStatus = vi.fn(
  async (params: { runtime: string }): Promise<RuntimeStatusStub> => ({
    runtime: params.runtime,
    available: true,
    authStatus: "authenticated",
    message: `${params.runtime} ready`,
    suggestedAction: null,
  }),
);
vi.mock("./skills", () => ({
  skillsDispatchBackground: vi.fn(),
  skillsRuntimeStatus: (params: { runtime: string }) => skillsRuntimeStatus(params),
}));

type EventHandler = (event: { payload: never }) => void;
const eventHandlers = new Map<string, EventHandler>();
const unlisten = vi.fn();
const listen = vi.fn(async (event: string, handler: EventHandler) => {
  eventHandlers.set(event, handler);
  return unlisten;
});
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import {
  appendChatTurn,
  beginChatProposalApply,
  buildChatPrompt,
  CHAT_HISTORY_CAP,
  CHAT_PROPOSAL_APPLIED_EVENT,
  CHAT_PROMPT_MAX_CHARS,
  discardStoredChatUserTurn,
  finishChatProposalApply,
  isChatProposalApplied,
  isChatProposalApplying,
  loadChatTurns,
  markChatProposalApplied,
  persistChatProposalApplied,
  removeChatUserTurn,
  saveChatTurns,
  sendAgentChatTurn,
  type ChatTurn,
  type ChatProposalAppliedDetail,
} from "./agentChat";
import type { AgentRecord } from "./agents";
import type { AiSettings } from "./settings";

const ai: AiSettings = {
  defaultRuntime: "claude",
  classifierRuntime: "inherit",
  taskIngestMinImportance: "medium",
  permissionMode: "plan",
  commandOverrides: { claude: null, codex: null, kimi: "/opt/kimi", kiro: null },
  extra: {},
};

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "vault-hygiene",
    labelKey: "agents.builtin.vaultHygiene",
    skillName: "vault-lint",
    runtime: "inherit",
    permissionMode: "inherit",
    prompt: "",
    kind: "background",
    enabled: true,
    builtin: true,
    customized: false,
    ...overrides,
  };
}

function turn(role: ChatTurn["role"], text: string): ChatTurn {
  return { role, text, at: "2026-08-04T00:00:00.000Z" };
}

/** Same stub idiom as skillsInstallMode.test.ts — cheaper than a jsdom env,
 *  and `throwing` covers the quota/private-mode path. */
function setWindow(throwing = false, tauri = false): Map<string, string> {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => {
      if (throwing) throw new Error("blocked");
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem: (key: string, value: string) => {
      if (throwing) throw new Error("blocked");
      store.set(key, value);
    },
    removeItem: (key: string) => {
      if (throwing) throw new Error("blocked");
      store.delete(key);
    },
  };
  const target = new EventTarget() as EventTarget & {
    localStorage: typeof localStorage;
    __TAURI_INTERNALS__?: unknown;
  };
  target.localStorage = localStorage;
  if (tauri) target.__TAURI_INTERNALS__ = {};
  (globalThis as unknown as { window?: unknown }).window = target;
  return store;
}

function setWindowWithWriteFailure(store: Map<string, string>, removalWorks = false): void {
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: () => {
      throw new Error("quota exceeded");
    },
    removeItem: (key: string) => {
      if (!removalWorks) throw new Error("read only");
      store.delete(key);
    },
  };
  const target = new EventTarget() as EventTarget & { localStorage: typeof localStorage };
  target.localStorage = localStorage;
  (globalThis as unknown as { window?: unknown }).window = target;
}

beforeEach(() => {
  startAgentCliInvocation.mockClear();
  stopAiMission.mockClear();
  skillsRuntimeStatus.mockClear();
  eventHandlers.clear();
  listen.mockClear();
  unlisten.mockClear();
  skillsRuntimeStatus.mockImplementation(async (params: { runtime: string }) => ({
    runtime: params.runtime,
    available: true,
    authStatus: "authenticated",
    message: `${params.runtime} ready`,
    suggestedAction: null,
  }));
  setWindow();
});

describe("buildChatPrompt", () => {
  it("replays turns in order and uses the agent prompt as a preamble", () => {
    const { prompt, droppedTurns } = buildChatPrompt(
      agent({ prompt: "너는 정합성 점검 도우미다." }),
      [turn("user", "첫 질문"), turn("assistant", "첫 답변")],
      "두 번째 질문",
    );
    expect(droppedTurns).toBe(0);
    expect(prompt).toContain("<agent_instructions>\n너는 정합성 점검 도우미다.\n</agent_instructions>");
    expect(prompt.indexOf("User: 첫 질문")).toBeLessThan(prompt.indexOf("Assistant: 첫 답변"));
    expect(prompt.indexOf("Assistant: 첫 답변")).toBeLessThan(prompt.indexOf("User: 두 번째 질문"));
    expect(prompt.endsWith("User: 두 번째 질문")).toBe(true);
  });

  it("omits the preamble when the agent has no prompt", () => {
    const { prompt } = buildChatPrompt(agent(), [], "안녕");
    expect(prompt).toBe("User: 안녕");
  });

  it("drops the oldest turns and reports how many", () => {
    const filler = "가".repeat(5_000);
    const turns = [
      turn("user", filler),
      turn("assistant", filler),
      turn("user", filler),
      turn("assistant", filler),
      turn("user", filler),
      turn("assistant", filler),
    ];
    const { prompt, droppedTurns } = buildChatPrompt(agent(), turns, "마지막 질문");
    expect(droppedTurns).toBeGreaterThan(0);
    expect(prompt.length).toBeLessThanOrEqual(CHAT_PROMPT_MAX_CHARS);
    // The survivors are the most recent ones, and the new message is last.
    expect(prompt.endsWith("User: 마지막 질문")).toBe(true);
  });

  it("never truncates the newest user message, even alone over the cap", () => {
    // If the cap logic were written backwards this would silently ship a
    // mangled question that the model answers with confidence.
    const huge = "나".repeat(CHAT_PROMPT_MAX_CHARS + 500);
    const { prompt, droppedTurns } = buildChatPrompt(agent(), [turn("user", "이전")], huge);
    expect(prompt).toContain(huge);
    expect(prompt.length).toBeGreaterThan(CHAT_PROMPT_MAX_CHARS);
    expect(droppedTurns).toBe(1);
  });
});

describe("chat storage", () => {
  it("marks an applied proposal in the latest transcript", () => {
    const current: ChatTurn[] = [
      turn("assistant", "proposal"),
      turn("user", "newer question"),
    ];
    const next = markChatProposalApplied(
      current,
      current[0].at,
      "2026-08-04T01:00:00.000Z",
    );

    expect(next[0].proposalAppliedAt).toBe("2026-08-04T01:00:00.000Z");
    expect(next[1]).toEqual(current[1]);
  });

  it("preserves proposal markers when a later assistant turn is appended", () => {
    const current: ChatTurn[] = [
      { ...turn("assistant", "proposal"), proposalAppliedAt: "2026-08-04T01:00:00.000Z" },
      turn("user", "next question"),
    ];
    const next = appendChatTurn(current, turn("assistant", "next answer"));

    expect(next[0].proposalAppliedAt).toBe("2026-08-04T01:00:00.000Z");
    expect(next.map((value) => value.text)).toEqual([
      "proposal",
      "next question",
      "next answer",
    ]);
  });

  it("removes a cancelled user turn without removing adjacent turns", () => {
    const cancelled = { ...turn("user", "cancelled"), at: "cancelled-at" };
    const current = [turn("assistant", "before"), cancelled, turn("assistant", "after")];

    expect(removeChatUserTurn(current, "cancelled-at").map((value) => value.text)).toEqual([
      "before",
      "after",
    ]);
  });

  it("removes a cancelled user turn from durable replay state", () => {
    const cancelled = { ...turn("user", "do not replay"), at: "cancelled-stored-at" };
    saveChatTurns("/w", "cancelled-agent", [turn("assistant", "before"), cancelled]);

    discardStoredChatUserTurn("/w", "cancelled-agent", cancelled.at);

    const loaded = loadChatTurns("/w", "cancelled-agent");
    expect(loaded.map((value) => value.text)).toEqual(["before"]);
    expect(buildChatPrompt(agent(), loaded, "next").prompt).not.toContain("do not replay");
  });

  it("clears the transcript if a cancelled-turn rewrite fails", () => {
    const cancelled = { ...turn("user", "unsafe replay"), at: "cancelled-fallback-at" };
    const store = setWindow();
    saveChatTurns("/w", "fallback-agent", [turn("assistant", "before"), cancelled]);
    setWindowWithWriteFailure(store, true);

    expect(discardStoredChatUserTurn("/w", "fallback-agent", cancelled.at)).toEqual([]);
    expect(store.size).toBe(0);
    expect(loadChatTurns("/w", "fallback-agent")).toEqual([]);
  });

  it("reports when neither rewrite nor deletion can remove a cancelled turn", () => {
    const cancelled = { ...turn("user", "unsafe replay"), at: "cancelled-blocked-at" };
    const store = setWindow();
    saveChatTurns("/w", "blocked-agent", [cancelled]);
    setWindowWithWriteFailure(store);

    expect(() =>
      discardStoredChatUserTurn("/w", "blocked-agent", cancelled.at)).toThrow(
      "agent_chat_cancelled_turn_persist_failed",
    );
  });

  it("round-trips turns and caps the history", () => {
    const turns = Array.from({ length: CHAT_HISTORY_CAP + 5 }, (_, i) =>
      turn("user", `메시지 ${i}`),
    );
    saveChatTurns("/w", "vault-hygiene", turns);
    const loaded = loadChatTurns("/w", "vault-hygiene");
    expect(loaded).toHaveLength(CHAT_HISTORY_CAP);
    expect(loaded[loaded.length - 1].text).toBe(`메시지 ${CHAT_HISTORY_CAP + 4}`);
  });

  it("keys by workspace and agent", () => {
    saveChatTurns("/w", "a", [turn("user", "A")]);
    saveChatTurns("/w", "b", [turn("user", "B")]);
    saveChatTurns("/other", "a", [turn("user", "C")]);
    expect(loadChatTurns("/w", "a")[0].text).toBe("A");
    expect(loadChatTurns("/w", "b")[0].text).toBe("B");
    expect(loadChatTurns("/other", "a")[0].text).toBe("C");
    expect(loadChatTurns("/w", "missing")).toEqual([]);
  });

  it("persists the proposal-applied guard with the assistant turn", () => {
    saveChatTurns("/w", "a", [
      { ...turn("assistant", "proposal"), proposalAppliedAt: "2026-08-04T01:00:00.000Z" },
    ]);
    expect(loadChatTurns("/w", "a")[0].proposalAppliedAt).toBe(
      "2026-08-04T01:00:00.000Z",
    );
  });

  it("persists an applied marker against the latest stored transcript", () => {
    const proposal = turn("assistant", "proposal");
    saveChatTurns("/w", "a", [proposal, turn("user", "newer question")]);

    const next = persistChatProposalApplied(
      "/w",
      "a",
      proposal.at,
      "2026-08-04T02:00:00.000Z",
    );

    expect(next).toHaveLength(2);
    expect(loadChatTurns("/w", "a")[0].proposalAppliedAt).toBe(
      "2026-08-04T02:00:00.000Z",
    );
  });

  it("notifies a replacement chat after persisting an applied marker", () => {
    const proposal = turn("assistant", "proposal");
    saveChatTurns("/w", "a", [proposal]);
    const details: ChatProposalAppliedDetail[] = [];
    window.addEventListener(CHAT_PROPOSAL_APPLIED_EVENT, (event) => {
      details.push((event as CustomEvent<ChatProposalAppliedDetail>).detail);
    });

    persistChatProposalApplied(
      "/w",
      "a",
      proposal.at,
      "2026-08-04T03:00:00.000Z",
    );

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      workPath: "/w",
      agentId: "a",
      turns: [{ proposalAppliedAt: "2026-08-04T03:00:00.000Z" }],
    });
  });

  it("reports marker write failure and keeps an in-memory apply guard", () => {
    const proposal = {
      ...turn("assistant", "proposal with failed marker write"),
      at: "write-failure-proposal-at",
    };
    const store = setWindow();
    expect(saveChatTurns("/w", "write-failure-agent", [proposal])).toBe(true);
    setWindowWithWriteFailure(store);
    const appliedEvents: ChatProposalAppliedDetail[] = [];
    window.addEventListener(CHAT_PROPOSAL_APPLIED_EVENT, (event) => {
      appliedEvents.push((event as CustomEvent<ChatProposalAppliedDetail>).detail);
    });

    expect(() =>
      persistChatProposalApplied(
        "/w",
        "write-failure-agent",
        proposal.at,
        "2026-08-04T04:00:00.000Z",
      )).toThrow("agent_chat_proposal_marker_persist_failed");
    expect(isChatProposalApplied("/w", "write-failure-agent", proposal.at)).toBe(true);
    expect(beginChatProposalApply("/w", "write-failure-agent", proposal.at)).toBe(false);
    expect(appliedEvents).toEqual([]);
  });

  it("keeps one proposal apply lock across component remounts", () => {
    expect(beginChatProposalApply("/w", "a", "turn-1")).toBe(true);
    expect(beginChatProposalApply("/w", "a", "turn-1")).toBe(false);
    expect(isChatProposalApplying("/w", "a", "turn-1")).toBe(true);

    finishChatProposalApply("/w", "a", "turn-1");
    expect(isChatProposalApplying("/w", "a", "turn-1")).toBe(false);
    expect(beginChatProposalApply("/w", "a", "turn-1")).toBe(true);
    finishChatProposalApply("/w", "a", "turn-1");
  });

  it("returns an empty transcript for a malformed payload instead of throwing", () => {
    const key = "maru:agent-chat:v1:/w:vault-hygiene";
    for (const payload of ["{not json", '{"role":"user"}', '[{"role":"nope"}]', "[3]"]) {
      const store = setWindow();
      store.set(key, payload);
      expect(loadChatTurns("/w", "vault-hygiene"), payload).toEqual([]);
    }
    // A store that throws outright must not take the pane down with it.
    setWindow(true);
    expect(loadChatTurns("/w", "vault-hygiene")).toEqual([]);
    expect(() => saveChatTurns("/w", "vault-hygiene", [turn("user", "x")])).not.toThrow();
  });
});

describe("sendAgentChatTurn", () => {
  it("passes the agent's resolved runtime, override and permission mode", async () => {
    await sendAgentChatTurn({
      agent: agent({ runtime: "kimi", permissionMode: "acceptEdits" }),
      ai,
      workPath: "/w",
      turns: [],
      message: "정합성 점검해줘",
    });

    expect(skillsRuntimeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "kimi" }),
    );
    const args = startAgentCliInvocation.mock.calls[0];
    expect(args[0]).toBe("kimi");
    expect(String(args[1])).toContain("정합성 점검해줘");
    expect(args[2]).toBe("/w");
    expect(args[5]).toBe("/opt/kimi");
    expect(args[6]).toBe("acceptEdits");
  });

  it("dispatches the exact fallback runtime already displayed by the pane", async () => {
    await sendAgentChatTurn({
      agent: agent({ runtime: "claude" }),
      ai,
      workPath: "/w",
      turns: [],
      message: "fallback으로 실행해줘",
      runtimeSelection: { runtime: "codex", commandOverride: "/opt/codex" },
    });

    expect(skillsRuntimeStatus).not.toHaveBeenCalled();
    const args = startAgentCliInvocation.mock.calls[0];
    expect(args[0]).toBe("codex");
    expect(args[5]).toBe("/opt/codex");
  });

  it("reports the invocation id so the caller can offer Stop", async () => {
    const onInvocation = vi.fn();
    await sendAgentChatTurn({
      agent: agent(),
      ai,
      workPath: "/w",
      turns: [],
      message: "안녕",
      onInvocation,
    });
    expect(onInvocation).toHaveBeenCalledWith("ai-chat-1");
  });

  it("registers listeners before starting and replays events emitted during invoke", async () => {
    setWindow(false, true);
    const onChunk = vi.fn();
    startAgentCliInvocation.mockImplementationOnce(async () => {
      eventHandlers.get("ai://output")?.({
        payload: {
          invocationId: "ai-chat-1",
          stream: "stdout",
          line: "fast answer",
        } as never,
      });
      eventHandlers.get("ai://done")?.({
        payload: {
          invocationId: "ai-chat-1",
          success: true,
          exitCode: 0,
        } as never,
      });
      return "ai-chat-1";
    });

    const result = await sendAgentChatTurn({
      agent: agent(),
      ai,
      workPath: "/w",
      turns: [],
      message: "안녕",
      onChunk,
    });

    expect(result.text).toBe("fast answer");
    expect(onChunk).toHaveBeenCalledWith("fast answer");
    expect(listen).toHaveBeenCalledTimes(3);
    expect(Math.max(...listen.mock.invocationCallOrder)).toBeLessThan(
      startAgentCliInvocation.mock.invocationCallOrder[0],
    );
    expect(unlisten).toHaveBeenCalledTimes(3);
  });

  it("rejects an immediate error emitted before the invoke response", async () => {
    setWindow(false, true);
    startAgentCliInvocation.mockImplementationOnce(async () => {
      eventHandlers.get("ai://error")?.({
        payload: {
          invocationId: "ai-chat-1",
          kind: "spawn_failed",
          message: "bad argv",
        } as never,
      });
      return "ai-chat-1";
    });

    await expect(
      sendAgentChatTurn({
        agent: agent(),
        ai,
        workPath: "/w",
        turns: [],
        message: "안녕",
      }),
    ).rejects.toThrow("spawn_failed: bad argv");
    expect(unlisten).toHaveBeenCalledTimes(3);
  });

  it("stops a late-starting invocation when the chat is aborted during invoke", async () => {
    setWindow(false, true);
    let resolveStart: ((id: string) => void) | null = null;
    startAgentCliInvocation.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const controller = new AbortController();
    const pending = sendAgentChatTurn({
      agent: agent(),
      ai,
      workPath: "/w",
      turns: [],
      message: "안녕",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(startAgentCliInvocation).toHaveBeenCalledTimes(1));

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(resolveStart).not.toBeNull();
    resolveStart!("ai-chat-1");
    await vi.waitFor(() => expect(stopAiMission).toHaveBeenCalledWith("ai-chat-1"));
  });

  it("refuses a disabled agent without spawning anything", async () => {
    await expect(
      sendAgentChatTurn({
        agent: agent({ enabled: false }),
        ai,
        workPath: "/w",
        turns: [],
        message: "안녕",
      }),
    ).rejects.toThrow("agent_disabled: vault-hygiene");
    expect(startAgentCliInvocation).not.toHaveBeenCalled();
  });

  it("refuses an empty message without spawning anything", async () => {
    await expect(
      sendAgentChatTurn({ agent: agent(), ai, workPath: "/w", turns: [], message: "   " }),
    ).rejects.toThrow("agent_prompt_required");
    expect(startAgentCliInvocation).not.toHaveBeenCalled();
  });

  it("surfaces the preferred runtime's diagnosis when no CLI is available", async () => {
    skillsRuntimeStatus.mockImplementation(async (params) => ({
      runtime: params.runtime,
      available: false,
      authStatus: "unavailable",
      message: `${params.runtime} not logged in`,
      suggestedAction: "Run login.",
    }));
    await expect(
      sendAgentChatTurn({ agent: agent(), ai, workPath: "/w", turns: [], message: "안녕" }),
    ).rejects.toThrow("claude not logged in Run login.");
  });
});
