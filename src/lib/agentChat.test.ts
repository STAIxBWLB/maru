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
  buildChatPrompt,
  CHAT_HISTORY_CAP,
  CHAT_PROMPT_MAX_CHARS,
  loadChatTurns,
  saveChatTurns,
  sendAgentChatTurn,
  type ChatTurn,
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
  };
  (globalThis as unknown as { window?: unknown }).window = {
    localStorage,
    ...(tauri ? { __TAURI_INTERNALS__: {} } : {}),
  };
  return store;
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
