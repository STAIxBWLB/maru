import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MARU_SETTINGS } from "./lib/settings";
import { applyStoredAppMode, bootAppMode } from "./lib/startupAppMode";

// Execute the actual App effect against deferred subscription/read ports.
// This avoids mounting the whole desktop app or reproducing its lifecycle.
const source = readFileSync(resolve("src/App.tsx"), "utf8");
const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let effectSource: string | undefined;
function find(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect") {
    const effect = node.arguments[0];
    if (effect && effect.getText(ast).includes("listenMaruSettingsUpdated")) effectSource = effect.getText(ast);
  }
  ts.forEachChild(node, find);
}
find(ast);
if (!effectSource) throw new Error("settings listener effect not found");
const code = ts.transpileModule(`export const effect = ${effectSource}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
function fixture() {
  const subscription = deferred<() => void>();
  const read = deferred<typeof DEFAULT_MARU_SETTINGS>();
  let receive!: (payload: { workPath: string; settings: typeof DEFAULT_MARU_SETTINGS; globalChanged?: boolean; readOrigin?: { actorId: string; revision: number } }) => void;
  const applyIncoming = vi.fn((settings: typeof DEFAULT_MARU_SETTINGS) => settings);
  const ports = {
    listenMaruSettingsUpdated: vi.fn((callback: typeof receive) => { receive = callback; return subscription.promise; }),
    readMaruSettings: vi.fn(() => read.promise),
    settingsWorkPath: "/fixture/current", todayAutoOpenPathRef: { current: null },
    userPickedAppModeRef: { current: null }, browserPasskeyBuildRef: { current: false }, booting: false,
    normalizeMaruSettings: (settings: typeof DEFAULT_MARU_SETTINGS) => settings,
    applyStoredAppMode, bootAppMode,
    applyIncomingShellSettings: applyIncoming, hasPendingShellSettingsIntent: () => false,
    isOwnShellSettingsOrigin: (origin?: { actorId: string }) => origin?.actorId === "fixture-owner",
    setMaruSettings: applyIncoming, setAppMode: vi.fn(), setEditorPaneViewModes: vi.fn(), setRightPaneTab: vi.fn(), setError: vi.fn(),
  };
  const exported: { effect?: () => () => void } = {};
  new Function("exports", "ports", `const {${Object.keys(ports).join(",")}} = ports; ${code}`)(exported, ports);
  const dispose = exported.effect!();
  const off = vi.fn();
  return { ports, subscription, read, dispose, off,
    receive: (workPath = ports.settingsWorkPath, globalChanged = false) => receive({ workPath, globalChanged, settings: DEFAULT_MARU_SETTINGS, readOrigin: { actorId: "fixture-owner", revision: 0 } }),
    receiveLegacy: () => receive({ workPath: ports.settingsWorkPath, settings: DEFAULT_MARU_SETTINGS }),
  };
}

describe("App settings listener disposal", () => {
  it("disposes a late subscription and ignores callbacks after cleanup", async () => {
    const state = fixture();
    state.dispose();
    state.receive();
    state.receive("/fixture/other", true);
    expect(state.ports.setMaruSettings).not.toHaveBeenCalled();
    expect(state.ports.readMaruSettings).not.toHaveBeenCalled();
    state.subscription.resolve(state.off);
    await settle();
    expect(state.off).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"] as const)("ignores a pending global read that %s after cleanup", async (outcome) => {
    const state = fixture();
    state.subscription.resolve(state.off);
    await settle();
    state.receive("/fixture/other", true);
    expect(state.ports.readMaruSettings).toHaveBeenCalledWith(state.ports.settingsWorkPath);
    state.dispose();
    if (outcome === "resolve") state.read.resolve(DEFAULT_MARU_SETTINGS);
    else state.read.reject(new Error("late fixture read"));
    await settle();
    expect(state.off).toHaveBeenCalledOnce();
    expect(state.ports.setMaruSettings).not.toHaveBeenCalled();
    expect(state.ports.setAppMode).not.toHaveBeenCalled();
    expect(state.ports.setEditorPaneViewModes).not.toHaveBeenCalled();
    expect(state.ports.setRightPaneTab).not.toHaveBeenCalled();
    expect(state.ports.setError).not.toHaveBeenCalled();
  });

  it("re-reads a legacy same-workspace envelope instead of applying its snapshot", async () => {
    const state = fixture();
    state.subscription.resolve(state.off);
    await settle();
    state.receiveLegacy();
    expect(state.ports.readMaruSettings).toHaveBeenCalledWith(state.ports.settingsWorkPath);
    expect(state.ports.setMaruSettings).not.toHaveBeenCalled();
    state.read.resolve(DEFAULT_MARU_SETTINGS);
    await settle();
    expect(state.ports.setMaruSettings).toHaveBeenCalledWith(DEFAULT_MARU_SETTINGS, undefined);
    state.dispose();
    expect(state.off).toHaveBeenCalledOnce();
  });

  it("applies current settings while alive and disposes the active subscription", async () => {
    const state = fixture();
    state.subscription.resolve(state.off);
    await settle();
    state.receive();
    expect(state.ports.setMaruSettings).toHaveBeenCalledWith(DEFAULT_MARU_SETTINGS, undefined, { actorId: "fixture-owner", revision: 0 });
    expect(state.ports.setAppMode).toHaveBeenCalledWith("pkm");
    state.dispose();
    expect(state.off).toHaveBeenCalledOnce();
  });
});
