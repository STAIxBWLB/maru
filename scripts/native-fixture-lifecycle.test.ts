import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";

// Dynamic paths keep the scripts typecheck project separate from native-e2e.
const fixtureModule = path.resolve("e2e-native/helpers/fixtureWorkspace.ts");
const hooksModule = path.resolve("e2e-native/rootHooks.ts");
const configModule = path.resolve("e2e-native/wdio.conf.ts");
const originalHome = process.env.MARU_NATIVE_E2E_HOME;
const originalConfig = process.env.MARU_NATIVE_E2E_CONFIG_DIR;
let disposable: string | undefined;

afterEach(async () => {
  if (disposable) await fs.rm(disposable, { recursive: true, force: true });
  disposable = undefined;
  if (originalHome === undefined) delete process.env.MARU_NATIVE_E2E_HOME;
  else process.env.MARU_NATIVE_E2E_HOME = originalHome;
  if (originalConfig === undefined) delete process.env.MARU_NATIVE_E2E_CONFIG_DIR;
  else process.env.MARU_NATIVE_E2E_CONFIG_DIR = originalConfig;
  vi.resetModules();
});

describe("native fixture lifecycle", () => {
  it("disposes the old root after app exit and seeds before the next worker", async () => {
    const { createNativeFixtureLifecycle } = await import(fixtureModule);
    const events: string[] = [];
    let exit: () => void = () => {};
    const exited = new Promise<void>((resolve) => { exit = resolve; });
    const lifecycle = createNativeFixtureLifecycle({
      seed: async () => { events.push("seed"); },
      stopOwnedApp: async () => { events.push("stop-request"); await exited; events.push("app-exited"); },
      cleanup: async () => { events.push("dispose"); },
    });
    await lifecycle.prepare();
    await lifecycle.start("first");
    expect(events).toEqual(["seed"]);
    const ending = lifecycle.end("first");
    await expect(lifecycle.start("second")).rejects.toThrow("still owned");
    expect(events).toEqual(["seed", "stop-request"]);
    exit(); await ending;
    await lifecycle.start("second");
    expect(events).toEqual(["seed", "stop-request", "app-exited", "dispose", "seed"]);
  });

  it("preserves a live root when owned process shutdown cannot be proved", async () => {
    const { createNativeFixtureLifecycle } = await import(fixtureModule);
    const cleanup = vi.fn(async () => {});
    const lifecycle = createNativeFixtureLifecycle({ seed: async () => {}, stopOwnedApp: async () => { throw new Error("ownership uncertain"); }, cleanup });
    await lifecycle.prepare(); await lifecycle.start("worker");
    await expect(lifecycle.end("worker")).rejects.toThrow("ownership uncertain");
    expect(cleanup).not.toHaveBeenCalled();
    await expect(lifecycle.start("other")).rejects.toThrow("still owned");
  });

  it("retains a partially seeded root for ordered failure-path cleanup", async () => {
    const { createNativeFixtureLifecycle } = await import(fixtureModule);
    const events: string[] = [];
    const lifecycle = createNativeFixtureLifecycle({
      seed: async () => { throw new Error("seed failed"); },
      stopOwnedApp: async () => { events.push("stop"); }, cleanup: async () => { events.push("dispose"); },
    });
    await expect(lifecycle.prepare()).rejects.toThrow("seed failed");
    await lifecycle.complete();
    expect(events).toEqual(["stop", "dispose"]);
  });

  it("restores Welcome while preserving live state and registry bytes", async () => {
    disposable = await fs.mkdtemp(path.join(os.tmpdir(), "maru-fixture-leaves-"));
    const work = path.join(disposable, "workspace");
    const config = path.join(disposable, "config");
    const home = path.join(disposable, "home");
    await fs.mkdir(path.join(work, ".maru"), { recursive: true });
    await fs.mkdir(path.join(config, "com.maru.app"), { recursive: true });
    const audit = path.join(work, ".maru", "live-audit.json");
    const registry = path.join(config, "com.maru.app", "workspaces.json");
    await fs.writeFile(audit, "live state"); await fs.writeFile(registry, "registry bytes");
    await fs.writeFile(path.join(work, "Welcome.md"), "changed leaf");
    process.env.MARU_NATIVE_E2E_HOME = home; process.env.MARU_NATIVE_E2E_CONFIG_DIR = config;
    const { resetFixtureWorkspace } = await import(fixtureModule);
    await resetFixtureWorkspace();
    expect(await fs.readFile(audit, "utf8")).toBe("live state");
    expect(await fs.readFile(registry, "utf8")).toBe("registry bytes");
    expect(await fs.readFile(path.join(work, "Welcome.md"), "utf8")).toContain("# Welcome");
    const before = await fs.stat(path.join(work, "Welcome.md"));
    await resetFixtureWorkspace();
    expect((await fs.stat(path.join(work, "Welcome.md"))).ino).toBe(before.ino);
  });

  it("fails an actual Mocha setup hook without executing the test body", async () => {
    process.env.MARU_NATIVE_E2E_HOME = "/disposable/native/home";
    process.env.MARU_NATIVE_E2E_CONFIG_DIR = "/disposable/native/config";
    const { createNativeRootHooks } = await import(hooksModule);
    // Resolve through the installed framework's dependency directory; the
    // framework itself deliberately has import-only package exports.
    const frameworkRequire = createRequire(await fs.realpath(path.resolve("node_modules/@wdio/mocha-framework/package.json")));
    const Mocha = frameworkRequire("mocha") as typeof import("mocha");
    class QuietReporter extends Mocha.reporters.Base {}
    const mocha = new Mocha({ reporter: QuietReporter });
    const hooks = createNativeRootHooks(async () => { throw new Error("deliberate fixture setup failure"); });
    mocha.suite.beforeAll(hooks.beforeAll);
    mocha.suite.beforeEach(hooks.beforeEach);
    let ran = false;
    mocha.suite.addTest(new Mocha.Test("must not run", () => { ran = true; }));
    const failures = await new Promise<number>((resolve) => mocha.run(resolve));
    expect(failures).toBe(1);
    expect(ran).toBe(false);
  });

  it("fails Mocha startup when the profile-isolation probe rejects", async () => {
    process.env.MARU_NATIVE_E2E_HOME = "/disposable/native/home";
    process.env.MARU_NATIVE_E2E_CONFIG_DIR = "/disposable/native/config";
    const { createNativeRootHooks } = await import(hooksModule);
    const frameworkRequire = createRequire(await fs.realpath(path.resolve("node_modules/@wdio/mocha-framework/package.json")));
    const Mocha = frameworkRequire("mocha") as typeof import("mocha");
    class QuietReporter extends Mocha.reporters.Base {}
    const mocha = new Mocha({ reporter: QuietReporter });
    const restore = vi.fn(async () => {});
    const hooks = createNativeRootHooks(restore, async () => { throw new Error("profile marker leaked from another spec"); });
    mocha.suite.beforeAll(hooks.beforeAll);
    mocha.suite.beforeEach(hooks.beforeEach);
    let ran = false;
    mocha.suite.addTest(new Mocha.Test("must not touch leaked profile", () => { ran = true; }));
    expect(await new Promise<number>((resolve) => mocha.run(resolve))).toBe(1);
    expect(restore).not.toHaveBeenCalled();
    expect(ran).toBe(false);
  });

  it("excludes other launchers/checkouts and refuses ambiguous ownership", async () => {
    const { selectOwnedFixtureApp } = await import(configModule);
    const own = { pid: 101, parent: 10, cwd: "/fixture/repo", started: "first" };
    const others = [{ ...own, pid: 102, parent: 20 }, { ...own, pid: 103, cwd: "/other/repo" }];
    assert.deepEqual(selectOwnedFixtureApp([own, ...others], 10, "/fixture/repo"), own);
    expect(selectOwnedFixtureApp(others, 10, "/fixture/repo")).toBeUndefined();
    expect(() => selectOwnedFixtureApp([own, { ...own, pid: 104 }], 10, "/fixture/repo")).toThrow("ambiguous");
  });

  it.each(["success", "last-worker-failure", "cleanup-failure"])("actual WDIO completion exit propagates %s", async (mode) => {
    // Execute the installed launcher's real completion collector and private
    // exit-code method, not executeHooksWithArgs or a mirrored assertion.
    // No driver/desktop starts: only native hook plus launcher completion run.
    const cli = await fs.readFile(path.resolve("node_modules/@wdio/cli/build/index.js"), "utf8");
    const helperStart = cli.indexOf("async function runOnCompleteHook(");
    const helperEnd = cli.indexOf("function getRunnerName(", helperStart);
    const methodStart = cli.indexOf("  async #runOnCompleteHook(");
    const methodEnd = cli.indexOf("\n  }\n", methodStart) + 5;
    expect(helperStart).toBeGreaterThan(0); expect(helperEnd).toBeGreaterThan(helperStart);
    expect(methodStart).toBeGreaterThan(0); expect(methodEnd).toBeGreaterThan(methodStart);
    const program = [
      `const native = await import(${JSON.stringify(pathToFileURL(configModule).href)});`,
      'const log = { error() {} }; const log3 = { info() {} };',
      'class SevereServiceError extends Error {} class HookError extends Error {}',
      cli.slice(helperStart, helperEnd),
      'async function runServiceHook() { throw new Error("unexpected service effect"); }',
      'class ActualLauncherCompletion {', cli.slice(methodStart, methodEnd),
      'run(hook) { return this.#runOnCompleteHook({onComplete: [hook]}, [], 0); }', '}',
      `const mode = ${JSON.stringify(mode)};`,
      'let hook = native.config.onComplete;',
      'if (mode === "last-worker-failure") { try { await native.config.onWorkerEnd("never-started-worker"); } catch {} }',
      'if (mode === "cleanup-failure") hook = native.createNativeCompletionHook(async () => { throw new Error("deliberate cleanup failure"); }, []);',
      'process.exit(await new ActualLauncherCompletion().run(hook));',
    ].join("\n");
    const cliRequire = createRequire(await fs.realpath(path.resolve("node_modules/@wdio/cli/package.json")));
    const loader = pathToFileURL(cliRequire.resolve("tsx")).href;
    const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", program], { encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(mode === "success" ? 0 : 1);
  });

  it.each(["initial-setup", "same-spec-reload"])("latched %s failure survives actual SDK swallowing and fails Mocha", async (phase) => {
    const frameworkPackage = await fs.realpath(path.resolve("node_modules/@wdio/mocha-framework/package.json"));
    const frameworkRequire = createRequire(frameworkPackage);
    const mochaUrl = pathToFileURL(frameworkRequire.resolve("mocha")).href;
    const utilsUrl = pathToFileURL(await fs.realpath(path.resolve(path.dirname(frameworkPackage), "../utils/build/index.js"))).href;
    const program = [
      'import assert from "node:assert/strict";',
      `import Mocha from ${JSON.stringify(mochaUrl)};`,
      `import {executeHooksWithArgs} from ${JSON.stringify(utilsUrl)};`,
      `import {createNativeRootHooks, nativeWorkerBoundary} from ${JSON.stringify(pathToFileURL(hooksModule).href)};`,
      'process.env.MARU_NATIVE_E2E_HOME = "/disposable/home";',
      'process.env.MARU_NATIVE_E2E_CONFIG_DIR = "/disposable/config";',
      'delete process.env.MARU_NATIVE_E2E_SETUP_ERROR;',
      `const phase = ${JSON.stringify(phase)};`,
      'let swallowed = false; let bodyRan = false;',
      'async function invokeReloadOwnershipFailure() {',
      '  const errors = await executeHooksWithArgs("beforeSession", [() => nativeWorkerBoundary(async () => { throw new Error("deliberate ambiguous app ownership"); })]);',
      '  swallowed = errors[0] instanceof Error;',
      '  assert.equal(swallowed, true); assert.equal(process.env.MARU_NATIVE_E2E_SETUP_ERROR, "deliberate ambiguous app ownership");',
      '}',
      'if (phase === "initial-setup") await invokeReloadOwnershipFailure();',
      'class QuietReporter extends Mocha.reporters.Base {}',
      'const mocha = new Mocha({reporter: QuietReporter});',
      'const hooks = createNativeRootHooks(async () => {});',
      'mocha.suite.beforeAll(hooks.beforeAll); mocha.suite.beforeEach(hooks.beforeEach); mocha.suite.afterEach(hooks.afterEach);',
      'mocha.suite.addTest(new Mocha.Test("ownership latch must fail closed", async () => {',
      '  if (phase === "same-spec-reload") await invokeReloadOwnershipFailure();',
      '  bodyRan = true;',
      '}));',
      'const failures = await new Promise(resolve => mocha.run(resolve));',
      'process.stdout.write("RESULT=" + JSON.stringify({failures, bodyRan, swallowed}) + "\\n");',
      'process.exit(failures);',
    ].join("\n");
    const cliRequire = createRequire(await fs.realpath(path.resolve("node_modules/@wdio/cli/package.json")));
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(cliRequire.resolve("tsx")).href, "--input-type=module", "-e", program], { encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const record = result.stdout.split("\n").find((line) => line.startsWith("RESULT="));
    expect(record, result.stderr).toBeDefined();
    expect(JSON.parse(record!.slice("RESULT=".length))).toEqual({ failures: 1, bodyRan: phase === "same-spec-reload", swallowed: true });
  });
});


describe("native fresh fixture startup/profile gate", () => {
  const owner = "/owned-fixture/config";
  const raw = "/var/owned-fixture/workspace";
  const real = "/private/var/owned-fixture/workspace";
  let dom: JSDOM;
  let state: ReturnType<typeof readyState> | null;
  let menuReady: boolean;
  let readState: ReturnType<typeof vi.fn<() => ReturnType<typeof readyState> | null>>;
  function readyState() {
    return { booting: false, settingsLoaded: true, settingsWritable: true,
      workspacePath: raw as string | null, settingsWorkPath: real as string | null, terminalWorkspacePath: raw as string | null,
      catalogReady: true, catalogLoading: false, catalogHasFixtureDocument: true,
      appMode: "pkm", terminalOpen: false, terminalSplitOpen: false };
  }
  beforeEach(() => {
    vi.useFakeTimers();
    dom = new JSDOM('<div class="activity-rail"></div>', { url: "https://native.test.invalid" });
    vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.window.document);
    state = readyState(); menuReady = true;
    readState = vi.fn(() => state);
    Object.assign(dom.window, { __MARU_NATIVE_E2E__: { menuCommand: () => false,
      menuCommandReady: () => menuReady, readAppState: readState } });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); dom.window.close(); });
  async function run(fresh = true) {
    const { pollNativeFixtureProfile, NATIVE_PROFILE_MARKER_KEY } = await import(hooksModule);
    const done = vi.fn();
    pollNativeFixtureProfile({ key: NATIVE_PROFILE_MARKER_KEY, owner, fresh,
      ownedPaths: [raw, real], deadline: Date.now() + 20_000 }, done);
    return { done, key: NATIVE_PROFILE_MARKER_KEY };
  }

  it("does not confuse a ready command bridge with boot/settings/catalog ownership readiness", async () => {
    state = null;
    const { done, key } = await run();
    expect(done).not.toHaveBeenCalled(); expect(dom.window.localStorage.getItem(key)).toBeNull();
    vi.advanceTimersByTime(20_000);
    expect(done.mock.calls[0][0]).toMatchObject({ ok: false, diagnostics: { menuReady: true, state: null } });
  });

  it.each(["booting", "settingsLoaded", "settingsWritable", "catalogReady", "catalogLoading", "catalogHasFixtureDocument"])
    ("rejects incomplete %s while retaining the original deadline and unmodified marker", async (field) => {
      state = { ...readyState(), [field]: field === "booting" || field === "catalogLoading" };
      const { done, key } = await run(); vi.advanceTimersByTime(20_000);
      expect(done.mock.calls[0][0].ok).toBe(false);
      expect(dom.window.localStorage.getItem(key)).toBeNull();
    });

  it.each(["workspacePath", "settingsWorkPath", "terminalWorkspacePath"])("rejects unowned %s without logging the foreign path", async (field) => {
    state = { ...readyState(), [field]: "/foreign-user-data/private-workspace" };
    const { done } = await run(); vi.advanceTimersByTime(20_000);
    const result = done.mock.calls[0][0];
    expect(result.ok).toBe(false);
    expect(result.diagnostics.state[field]).toBe("outside-fixture");
    expect(JSON.stringify(result)).not.toContain("foreign-user-data");
  });

  it.each(["workspacePath", "settingsWorkPath", "terminalWorkspacePath"])("rejects missing %s", async (field) => {
    state = { ...readyState(), [field]: null };
    const { done } = await run(); vi.advanceTimersByTime(20_000);
    expect(done.mock.calls[0][0].ok).toBe(false);
  });

  it("cannot acknowledge readiness after the shared startup/profile deadline has already elapsed", async () => {
    const { pollNativeFixtureProfile, NATIVE_PROFILE_MARKER_KEY } = await import(hooksModule);
    const done = vi.fn();
    pollNativeFixtureProfile({ key: NATIVE_PROFILE_MARKER_KEY, owner, fresh: true,
      ownedPaths: [raw, real], deadline: Date.now() - 1 }, done);
    expect(done.mock.calls[0][0].ok).toBe(false);
    expect(dom.window.localStorage.getItem(NATIVE_PROFILE_MARKER_KEY)).toBeNull();
  });

  it("requires actual dispatcher readiness even though menuCommand is a function", async () => {
    menuReady = false;
    const { done, key } = await run(); vi.advanceTimersByTime(20_000);
    expect(done.mock.calls[0][0]).toMatchObject({ ok: false, diagnostics: { menuReady: false } });
    expect(dom.window.localStorage.getItem(key)).toBeNull();
  });

  it("accepts only the raw/real owned path pair and commits the fresh marker after all state catches up", async () => {
    state = { ...readyState(), catalogHasFixtureDocument: false };
    const { done, key } = await run(); vi.advanceTimersByTime(19_900);
    expect(done).not.toHaveBeenCalled(); expect(dom.window.localStorage.getItem(key)).toBeNull();
    state = readyState(); vi.advanceTimersByTime(100);
    expect(done).toHaveBeenCalledOnce(); expect(done.mock.calls[0][0].ok).toBe(true);
    expect(dom.window.localStorage.getItem(key)).toBe(owner);
  });

  it("strictly rejects an existing fresh marker without clearing it", async () => {
    const { NATIVE_PROFILE_MARKER_KEY } = await import(hooksModule);
    dom.window.localStorage.setItem(NATIVE_PROFILE_MARKER_KEY, "/another-fixture/config");
    const { done, key } = await run();
    expect(done.mock.calls[0][0]).toMatchObject({ ok: false, reason: "profile marker leaked from another spec" });
    expect(dom.window.localStorage.getItem(key)).toBe("/another-fixture/config");
  });

  it("keeps retained marker verification independent of boot/catalog state or reader availability", async () => {
    const { NATIVE_PROFILE_MARKER_KEY } = await import(hooksModule);
    dom.window.localStorage.setItem(NATIVE_PROFILE_MARKER_KEY, owner);
    state = { ...readyState(), booting: true, settingsLoaded: false, catalogReady: false, catalogHasFixtureDocument: false };
    readState.mockImplementation(() => { throw new Error("retained verification must not read startup state"); });
    const { done } = await run(false);
    expect(done.mock.calls[0][0].ok).toBe(true); expect(readState).not.toHaveBeenCalled();
  });
});
