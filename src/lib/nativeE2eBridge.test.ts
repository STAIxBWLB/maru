// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type MaruNativeE2eBridge,
  nativeE2eEnabled,
  registerMenuCommandDispatcher,
  registerTerminalTextReader,
} from "./nativeE2eBridge";

function bridge(): MaruNativeE2eBridge | undefined {
  return window.__MARU_NATIVE_E2E__;
}

beforeEach(() => {
  // The module keeps its readers in module-level state; deleting the global
  // between cases stops one test's registration leaking into the next.
  delete window.__MARU_NATIVE_E2E__;
});

afterEach(() => {
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
    const dispose = registerTerminalTextReader("s1", () => "screen text");
    expect(bridge()).toBeUndefined();
    dispose();
    expect(bridge()).toBeUndefined();
  });

  it("serves the registered reader's text verbatim through the bridge global", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    registerTerminalTextReader("s1", () => "line one\nline two");
    expect(bridge()?.terminalText("s1")).toBe("line one\nline two");
  });

  it("returns null for a session id that was never registered instead of throwing", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    registerTerminalTextReader("s1", () => "text");
    expect(bridge()?.terminalText("never-registered")).toBeNull();
  });

  it("stops serving a session once its disposer runs", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    const dispose = registerTerminalTextReader("s1", () => "text");
    expect(bridge()?.terminalText("s1")).toBe("text");
    dispose();
    expect(bridge()?.terminalText("s1")).toBeNull();
  });

  it("keeps two registered sessions independent", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    const disposeFirst = registerTerminalTextReader("s1", () => "first screen");
    const disposeSecond = registerTerminalTextReader("s2", () => "second screen");
    expect(bridge()?.terminalText("s1")).toBe("first screen");
    expect(bridge()?.terminalText("s2")).toBe("second screen");
    disposeFirst();
    disposeSecond();
  });
});

describe("registerMenuCommandDispatcher", () => {
  it("installs menuCommand on the same single namespace object", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "1");
    registerTerminalTextReader("s1", () => "text");
    const namespace = bridge();
    expect(namespace).toBeDefined();

    const dispatched: string[] = [];
    registerMenuCommandDispatcher((id) => dispatched.push(id));

    expect(bridge()).toBe(namespace);
    bridge()?.menuCommand("maru.about");
    expect(dispatched).toEqual(["maru.about"]);
  });

  it("installs no global when the runner flag is unset", () => {
    vi.stubEnv("VITE_NATIVE_E2E", "");
    const dispose = registerMenuCommandDispatcher(() => {});
    expect(bridge()).toBeUndefined();
    dispose();
    expect(bridge()).toBeUndefined();
  });
});
