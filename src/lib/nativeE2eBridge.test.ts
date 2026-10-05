// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type MaruNativeE2eBridge,
  nativeE2eEnabled,
  installNativeE2eHarness,
  registerMenuCommandDispatcher,
  registerTerminalTextReader,
} from "./nativeE2eBridge";

function bridge(): MaruNativeE2eBridge | undefined {
  return window.__MARU_NATIVE_E2E__;
}

const disposers: Array<() => void> = [];
function track(dispose: () => void): () => void {
  disposers.push(dispose);
  return dispose;
}

beforeEach(() => {
  // Registrations are disposed after each case; the new namespace must not
  // inherit a previous test's reader or ready dispatcher.
  delete window.__MARU_NATIVE_E2E__;
});

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
  vi.unstubAllEnvs();
  delete window.__MARU_NATIVE_E2E__;
});

describe("nativeE2eEnabled", () => {
  it("returns false when the runner flag is unset", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "");
    expect(nativeE2eEnabled()).toBe(false);
  });

  it('returns true when the runner flag is "1"', () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    expect(nativeE2eEnabled()).toBe(true);
  });
});

describe("registerTerminalTextReader", () => {
  it("installs no global when the runner flag is unset", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "");
    const dispose = track(registerTerminalTextReader("s1", () => "screen text"));
    expect(bridge()).toBeUndefined();
    dispose();
    expect(bridge()).toBeUndefined();
  });

  it("serves the registered reader's text verbatim through the bridge global", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    track(registerTerminalTextReader("s1", () => "line one\nline two"));
    expect(bridge()?.terminalText("s1")).toBe("line one\nline two");
  });

  it("returns null for a session id that was never registered instead of throwing", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    track(registerTerminalTextReader("s1", () => "text"));
    expect(bridge()?.terminalText("never-registered")).toBeNull();
  });

  it("stops serving a session once its disposer runs", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    const dispose = track(registerTerminalTextReader("s1", () => "text"));
    expect(bridge()?.terminalText("s1")).toBe("text");
    dispose();
    expect(bridge()?.terminalText("s1")).toBeNull();
  });

  it("keeps two registered sessions independent", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    const disposeFirst = track(registerTerminalTextReader("s1", () => "first screen"));
    const disposeSecond = track(registerTerminalTextReader("s2", () => "second screen"));
    expect(bridge()?.terminalText("s1")).toBe("first screen");
    expect(bridge()?.terminalText("s2")).toBe("second screen");
    disposeFirst();
    disposeSecond();
  });
});

describe("registerMenuCommandDispatcher", () => {
  it("installs menuCommand on the same single namespace object", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    track(registerTerminalTextReader("s1", () => "text"));
    const namespace = bridge();
    expect(namespace).toBeDefined();

    const dispatched: string[] = [];
    track(registerMenuCommandDispatcher((id) => dispatched.push(id)));

    expect(bridge()).toBe(namespace);
    expect(bridge()?.menuCommandReady()).toBe(true);
    expect(bridge()?.menuCommand("maru.about")).toBe(true);
    expect(dispatched).toEqual(["maru.about"]);
  });

  it("installs no global when the runner flag is unset", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "");
    const dispose = track(registerMenuCommandDispatcher(() => {}));
    expect(bridge()).toBeUndefined();
    dispose();
    expect(bridge()).toBeUndefined();
  });

  it("does not acknowledge or queue a command when only the harness has installed the namespace", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    installNativeE2eHarness();
    expect(typeof bridge()?.menuCommand).toBe("function");
    expect(bridge()?.menuCommandReady()).toBe(false);
    expect(bridge()?.menuCommand("view.documents")).toBe(false);
    const dispatch = vi.fn<(id: string) => void>();
    const dispose = track(registerMenuCommandDispatcher(dispatch));
    expect(bridge()?.menuCommandReady()).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(bridge()?.menuCommand("view.documents")).toBe(true);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("view.documents");
    dispose();
    expect(bridge()?.menuCommandReady()).toBe(false);
    expect(bridge()?.menuCommand("view.documents")).toBe(false);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("reports not ready when a terminal reader installs the namespace before the dispatcher", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    track(registerTerminalTextReader("reader-only", () => "screen"));
    expect(bridge()?.terminalText("reader-only")).toBe("screen");
    expect(bridge()?.menuCommandReady()).toBe(false);
    expect(bridge()?.menuCommand("terminal.shell")).toBe(false);
  });

  it("keeps a replacement dispatcher ready after the previous registration is disposed", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    const first = vi.fn<(id: string) => void>();
    const second = vi.fn<(id: string) => void>();
    const disposeFirst = track(registerMenuCommandDispatcher(first));
    const disposeSecond = track(registerMenuCommandDispatcher(second));
    disposeFirst();
    expect(bridge()?.menuCommandReady()).toBe(true);
    expect(bridge()?.menuCommand("terminal.shell")).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith("terminal.shell");
    disposeSecond();
    expect(bridge()?.menuCommandReady()).toBe(false);
    expect(bridge()?.menuCommand("terminal.shell")).toBe(false);
    expect(second).toHaveBeenCalledOnce();
  });

  it("does not confuse replacing the same callback with retaining its previous registration", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    const dispatch = vi.fn<(id: string) => void>();
    const disposeFirst = track(registerMenuCommandDispatcher(dispatch));
    const disposeSecond = track(registerMenuCommandDispatcher(dispatch));
    disposeFirst();
    expect(bridge()?.menuCommandReady()).toBe(true);
    expect(bridge()?.menuCommand("view.documents")).toBe(true);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("view.documents");
    disposeSecond();
    expect(bridge()?.menuCommandReady()).toBe(false);
  });

});
