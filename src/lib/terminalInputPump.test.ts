import { describe, expect, it, vi } from "vitest";
import type { TerminalInputCommand } from "./api";
import { TerminalInputPump } from "./terminalInputPump";

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("TerminalInputPump", () => {
  it("buffers startup input and flushes it in one ordered batch", async () => {
    const sent: Array<{ seq: number; commands: TerminalInputCommand[] }> = [];
    const pump = new TerminalInputPump(async (seq, commands) => {
      sent.push({ seq, commands });
    }, vi.fn());

    pump.push({ type: "text", text: "ㅎ" });
    pump.push({ type: "text", text: "한" });
    expect(sent).toEqual([]);

    pump.ready();
    await flushPromises();
    expect(sent).toEqual([
      {
        seq: 1,
        commands: [
          { type: "text", text: "ㅎ" },
          { type: "text", text: "한" },
        ],
      },
    ]);
  });

  it("keeps only one IPC batch in flight", async () => {
    let release!: () => void;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pump = new TerminalInputPump(send, vi.fn());
    pump.ready();
    pump.push({ type: "key", key: "Enter" });
    pump.push({ type: "paste", text: "next" });
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);

    release();
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("drops batches already chained behind an in-flight send once failed", async () => {
    let release: () => void = () => {};
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const onError = vi.fn();
    const pump = new TerminalInputPump(send, onError);
    pump.ready();
    pump.push({ type: "key", key: "a" });
    pump.push({ type: "key", key: "b" });
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);

    // Session torn down while batch B is still queued behind batch A.
    pump.fail();
    release();
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects startup input beyond the bounded one MiB buffer", () => {
    const onError = vi.fn();
    const pump = new TerminalInputPump(async () => {}, onError);
    expect(pump.push({ type: "paste", text: "x".repeat(1024 * 1024 + 1) })).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });
});
