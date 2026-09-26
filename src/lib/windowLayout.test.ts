// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Review finding #2, round 2: the owner-observed regression was a Cmd+Q
// pressed while the skill editor window exists but its React content is
// still loading, hanging requestSkillEditorQuitCheck() forever (no listener
// had registered yet to answer the quit-check event). These tests drive the
// two-phase ack/timeout handshake directly, mocking only the Tauri event/
// window bridges.
const mocks = vi.hoisted(() => ({
  getByLabel: vi.fn(),
  emitTo: vi.fn<(...args: unknown[]) => Promise<void>>(),
  listen: vi.fn<(...args: unknown[]) => Promise<() => void>>(),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: mocks.getByLabel },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
  emitTo: mocks.emitTo,
}));

import {
  SKILL_EDITOR_QUIT_CHECK_ACK_EVENT,
  SKILL_EDITOR_QUIT_CHECK_EVENT,
  SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT,
} from "./skillEditorEvents";
import {
  requestSkillEditorQuitCheck,
  SKILL_EDITOR_QUIT_CHECK_ACK_TIMEOUT_MS,
} from "./windowLayout";

type EventHandler = (event: { payload: unknown }) => void;

function handlersFor(eventName: string): EventHandler[] {
  return mocks.listen.mock.calls
    .filter(([name]) => name === eventName)
    .map(([, handler]) => handler as EventHandler);
}

function setTauriAvailable(available: boolean) {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = available
    ? {}
    : undefined;
}

describe("requestSkillEditorQuitCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    setTauriAvailable(true);
    mocks.listen.mockImplementation(() => Promise.resolve(vi.fn()));
    mocks.emitTo.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    setTauriAvailable(false);
  });

  it("resolves true immediately when the skill editor window is not open", async () => {
    mocks.getByLabel.mockResolvedValue(null);

    await expect(requestSkillEditorQuitCheck()).resolves.toBe(true);

    expect(mocks.emitTo).not.toHaveBeenCalled();
  });

  it("resolves true via the ack-timeout when no ack ever arrives (listener not registered yet)", async () => {
    mocks.getByLabel.mockResolvedValue({});

    const promise = requestSkillEditorQuitCheck();
    await vi.advanceTimersByTimeAsync(0); // let the listen()/emitTo() microtasks settle

    expect(mocks.emitTo).toHaveBeenCalledWith(
      "skill-editor",
      SKILL_EDITOR_QUIT_CHECK_EVENT,
      undefined,
    );

    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(SKILL_EDITOR_QUIT_CHECK_ACK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe(true);
  });

  it("does not time out once an ack arrives, and waits indefinitely for the real response instead", async () => {
    mocks.getByLabel.mockResolvedValue({});

    const promise = requestSkillEditorQuitCheck();
    await vi.advanceTimersByTimeAsync(0);
    handlersFor(SKILL_EDITOR_QUIT_CHECK_ACK_EVENT).forEach((handler) =>
      handler({ payload: undefined }),
    );

    // Well past the ack timeout: an ack already landed, so this must not
    // resolve on its own — the user may still be looking at a real dialog.
    await vi.advanceTimersByTimeAsync(SKILL_EDITOR_QUIT_CHECK_ACK_TIMEOUT_MS * 5);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    handlersFor(SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT).forEach((handler) =>
      handler({ payload: { proceed: false } }),
    );
    await expect(promise).resolves.toBe(false);
  });

  // PR #361 review: a missing ack may only mean "no listener yet" once the
  // request has actually been sent; a slow emitTo is not that.
  it("starts the ack timeout only after emitTo has sent the request", async () => {
    mocks.getByLabel.mockResolvedValue({});
    let sent!: () => void;
    mocks.emitTo.mockReturnValue(new Promise<void>((resolve) => (sent = resolve)));

    const promise = requestSkillEditorQuitCheck();
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(SKILL_EDITOR_QUIT_CHECK_ACK_TIMEOUT_MS * 2);
    expect(settled).toBe(false);

    sent();
    await vi.advanceTimersByTimeAsync(SKILL_EDITOR_QUIT_CHECK_ACK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe(true);
  });

  it("resolves per the response event when it arrives before the ack timeout", async () => {
    mocks.getByLabel.mockResolvedValue({});

    const promise = requestSkillEditorQuitCheck();
    await vi.advanceTimersByTimeAsync(0);
    handlersFor(SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT).forEach((handler) =>
      handler({ payload: { proceed: true } }),
    );

    await expect(promise).resolves.toBe(true);
  });
});
