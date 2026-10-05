// Real CLI children and launchd run only local disposable fixture programs.
// UI assertions use the real WKWebView Jobs IPC, without a mock invoke bridge.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import type {} from "webdriverio";
import { fixtureRootDir } from "../helpers/fixtureWorkspace";

const execute = promisify(execFile);
const binary = path.resolve("src-tauri/target/debug/maru");
const jobId = "native-receipt-check";
const title = "Native receipt check";

interface Receipt {
  runId: string;
  source: string;
  processOutcome: string;
  exitCode: number | null;
  verificationOutcome: string;
  coalescedInto: string | null;
  finishedAt: number | null;
  ledgerRecorded: boolean;
  owner: { pid: number; start: string } | null;
  child: { pid: number; start: string } | null;
}

function workDir(): string { return path.join(fixtureRootDir(), "workspace"); }
function receiptFile(): string { return path.join(workDir(), ".maru/jobs-state", `${jobId}.receipts.json`); }
async function receipts(): Promise<Receipt[]> {
  try { return JSON.parse(await fs.readFile(receiptFile(), "utf8")) as Receipt[]; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function pollReceipts(predicate: (items: Receipt[]) => boolean): Promise<Receipt[]> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const items = await receipts();
    if (predicate(items)) return items;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`receipt deadline: ${JSON.stringify(await receipts())}`);
}
async function cli(args: string[]): Promise<string> {
  const result = await execute(binary, ["--maru-cli", "jobs", ...args], { cwd: workDir(), env: process.env, timeout: 10_000 });
  return result.stdout;
}

async function seedNativeCommandShim(): Promise<void> {
  const home = process.env.MARU_NATIVE_E2E_HOME;
  assert.ok(home);
  const uid = process.getuid!();
  const suffix = createHash("sha256").update(await fs.realpath(workDir())).digest("hex").slice(0, 8);
  const main = `gui/${uid}/com.maru.job.${jobId}.${suffix}`;
  const guard = `gui/${uid}/com.maru.job.guard.${jobId}.${suffix}`;
  // The native-e2e guard deliberately forbids ambient id/launchctl. This
  // private shim forwards only exact fixture targets, with no install/run
  // operation or arbitrary service access. Domain readback is read-only.
  const script = [
    "#!/bin/sh", "set -eu", 'program="$1"', "shift",
    'if test "$program" = id && test "$#" -eq 1 && test "$1" = -u; then exec /usr/bin/id -u; fi',
    'test "$program" = launchctl && test "$#" -eq 2 || exit 97',
    'operation="$1"', 'target="$2"',
    `if test "$operation" = print-disabled && test "$target" = 'gui/${uid}'; then exec /bin/launchctl "$@"; fi`,
    `test "$target" = '${main}' || test "$target" = '${guard}' || exit 98`,
    'case "$operation" in print|enable|disable|bootout) exec /bin/launchctl "$@" ;; *) exit 99 ;; esac', "",
  ].join("\n");
  const shim = path.join(home, ".maru/test-jobs-command");
  await fs.mkdir(path.dirname(shim), { recursive: true });
  const handle = await fs.open(shim, "w", 0o600);
  try { await handle.writeFile(script); await handle.sync(); }
  finally { await handle.close(); }
  await fs.chmod(shim, 0o755);
  // This macOS-only fixture is published only after its writable descriptor
  // closes, and direct readiness execution must succeed before CLI probes.
  const ready = await execute(shim, ["id", "-u"], { timeout: 5_000 });
  assert.equal(ready.stdout.trim(), String(uid));
  await assert.rejects(execute(shim, ["launchctl", "disable", `gui/${uid}/com.apple.Finder`]),
    "the shim must reject every nonfixture service label");
}

async function openJobs(): Promise<void> {
  const result = await browser.executeAsync((done: (result: { ok: boolean; text: string }) => void) => {
    let stage = "settings";
    const deadline = Date.now() + 25_000;
    const timer = setInterval(() => {
      if (stage === "settings") {
        const button = document.querySelector<HTMLButtonElement>('.activity-rail button[aria-label="설정"]');
        if (button) { button.click(); stage = "jobs"; }
      } else if (stage === "jobs") {
        const button = [...document.querySelectorAll<HTMLButtonElement>('.settings-overlay [role="tab"]')]
          .find((item) => /^(예약 작업|Jobs)$/.test(item.textContent?.trim() ?? ""));
        if (button) { button.click(); stage = "readback"; }
      } else {
        const form = document.querySelector(".jobs-settings-form");
        if (form?.textContent?.includes("Native receipt check")) {
          clearInterval(timer); done({ ok: true, text: form.textContent ?? "" }); return;
        }
      }
      if (Date.now() > deadline) {
        clearInterval(timer); done({ ok: false, text: document.body.innerText.slice(-6000) });
      }
    }, 100);
  });
  assert.equal(result.ok, true, result.text);
}

async function historyText(): Promise<string> {
  return browser.execute(() => {
    const row = [...document.querySelectorAll(".jobs-list-item")]
      .find((item) => item.textContent?.includes("Native receipt check"));
    if (!row) throw new Error("fixture Jobs row is absent");
    // Receipts are a details element, so expose the readback to a user too.
    row.querySelectorAll<HTMLDetailsElement>("details").forEach((element) => { element.open = true; });
    return row.textContent ?? "";
  });
}

describe("native durable job receipts", () => {
  it("distinguishes real exits and skipped fires, survives WKWebView restart, and keeps Stop prompt", async () => {
    assert.equal(process.platform, "darwin");
    assert.ok(process.env.MARU_NATIVE_E2E_HOME, "native isolation must be active");
    const root = fixtureRootDir();
    const release = path.join(root, "release-job");
    const started = path.join(root, "child-started");
    const finished = path.join(root, "child-finished");
    const script = path.join(root, "receipt-child.sh");
    // Deliberately bounded even if an assertion fails before release is written.
    await fs.writeFile(script, 'printf "%s\\n" "$$" >> "$1"\n/bin/sleep 0.2\nstep=0\nwhile test "$step" -lt 80; do\n  if test -e "$2"; then printf finished > "$3"; exit 0; fi\n  /bin/sleep 0.1\n  step=$((step + 1))\ndone\nprintf finished > "$3"\nexit 0\n');
    await fs.mkdir(path.join(workDir(), ".maru/jobs-state"), { recursive: true });
    await fs.mkdir(path.join(root, "home", "Library", "LaunchAgents"), { recursive: true });
    const manifest = {
      schema: 1,
      jobs: [{ id: jobId, title, enabled: true,
        program: { command: "/bin/sh", args: [script, started, release, finished], env: {} },
        schedule: { hour: 0, minute: 0, recoveryMode: "missedFire", recoveryIntervalSeconds: 21_600, runAtLoad: false },
        logs: { dir: ".maru/native-receipt-logs" } }],
    };
    await fs.writeFile(path.join(workDir(), ".maru/jobs.json"), JSON.stringify(manifest));
    await seedNativeCommandShim();
    // Fail before any launchd effect if this binary ignores the isolation vars.
    const statuses = JSON.parse(await cli(["list", "--json"])) as Array<{ plistPath: string; label: string }>;
    assert.equal(statuses.length, 1);
    const realAgents = await fs.realpath(path.join(root, "home", "Library", "LaunchAgents"));
    assert.ok(statuses[0].plistPath.startsWith(realAgents + path.sep));

    const runner = spawn(binary, ["--maru-cli", "jobs", "exec", jobId], { cwd: workDir(), env: process.env, stdio: "pipe" });
    const ended = new Promise<number | null>((resolve, reject) => {
      runner.once("error", reject); runner.once("exit", resolve);
    });
    let label: string | undefined;
    let crashEnded: Promise<number | null> | undefined;
    try {
      const active = (await pollReceipts((items) => items.some((item) => item.processOutcome === "running")))
        .find((item) => item.processOutcome === "running")!;
      assert.equal(active.owner?.pid, runner.pid);
      assert.ok(active.owner?.start && active.child?.start, "native process creation identity must be durable");
      assert.ok(active.child!.pid !== runner.pid);
      await cli(["exec", "--if-missed", jobId]);
      const collision = (await receipts()).find((item) => item.processOutcome === "skipped_active");
      assert.ok(collision, "active recovery must have a distinct skipped receipt");
      assert.equal(collision.source, "recovery");
      assert.equal(collision.exitCode, null);
      assert.equal(collision.coalescedInto, active.runId);

      const beforeStop = Date.now();
      await cli(["stop", jobId]);
      assert.ok(Date.now() - beforeStop < 5_000, "Stop waited for the child's long run lock");
      assert.equal(runner.exitCode, null, "fixture child must still be running when Stop returns");
      await fs.writeFile(release, "release");
      assert.equal(await ended, 0);
      const exited = (await receipts()).find((item) => item.runId === active.runId)!;
      assert.equal(exited.processOutcome, "exited");
      assert.equal(exited.exitCode, 0);
      assert.equal(exited.verificationOutcome, "notRequested");

      // Restore fixture-owned state for a covered calendar fire; no provider replay.
      const statePath = path.join(workDir(), ".maru/jobs-state", `${jobId}.json`);
      const state = JSON.parse(await fs.readFile(statePath, "utf8"));
      state.agentEnabled = true;
      await fs.writeFile(statePath, JSON.stringify(state));
      await cli(["exec", "--if-missed", jobId]);
      assert.ok((await receipts()).some((item) => item.processOutcome === "deduplicated" && item.exitCode === null));

      // An actual launchd service runs the same hermetic wrapper. Its unique
      // label is unrelated to installed Maru labels and is always booted out.
      label = `com.maru.native-e2e.receipts.${randomUUID()}`;
      const plist = path.join(root, "receipt-launchd.plist");
      const domain = `gui/${process.getuid!()}`;
      await execute("/usr/bin/plutil", ["-create", "xml1", plist]);
      await execute("/usr/bin/plutil", ["-insert", "Label", "-string", label, plist]);
      await execute("/usr/bin/plutil", ["-insert", "ProgramArguments", "-json", JSON.stringify([binary, "--maru-cli", "jobs", "exec", "--if-missed", jobId]), plist]);
      await execute("/usr/bin/plutil", ["-insert", "WorkingDirectory", "-string", workDir(), plist]);
      await execute("/usr/bin/plutil", ["-insert", "RunAtLoad", "-bool", "YES", plist]);
      await execute("/usr/bin/plutil", ["-insert", "EnvironmentVariables", "-json", JSON.stringify({
        MARU_NATIVE_E2E_HOME: process.env.MARU_NATIVE_E2E_HOME,
        MARU_NATIVE_E2E_CONFIG_DIR: process.env.MARU_NATIVE_E2E_CONFIG_DIR,
      }), plist]);
      const previousCount = (await receipts()).length;
      state.lastSuccessAt = null;
      state.lastSuccessFireAt = null;
      state.installBaselineAt = null;
      await fs.writeFile(statePath, JSON.stringify(state));
      await execute("/bin/launchctl", ["bootstrap", domain, plist]);
      const launched = await pollReceipts((items) => items.length > previousCount && items.at(-1)?.processOutcome === "exited" && items.at(-1)?.ledgerRecorded === true);
      const recovered = launched.at(-1)!;
      assert.equal(recovered.source, "recovery");
      assert.equal(recovered.exitCode, 0);
      assert.equal(recovered.verificationOutcome, "notRequested");
      assert.ok(recovered.owner?.start && recovered.child?.start);
      assert.notEqual(recovered.owner!.pid, runner.pid, "launchd must own a new wrapper process");

      // Kill only the launcher this test spawned, after its native child
      // identity is durable. The local child stays alive to prove owner death
      // alone cannot justify replay of provider work.
      await fs.rm(release);
      await fs.rm(finished, { force: true });
      state.lastSuccessAt = null;
      state.lastSuccessFireAt = null;
      state.installBaselineAt = null;
      await fs.writeFile(statePath, JSON.stringify(state));
      const beforeCrashCount = (await receipts()).length;
      const crashing = spawn(binary, ["--maru-cli", "jobs", "exec", jobId], { cwd: workDir(), env: process.env, stdio: "pipe" });
      crashEnded = new Promise<number | null>((resolve, reject) => {
        crashing.once("error", reject); crashing.once("exit", resolve);
      });
      const crashReceipt = (await pollReceipts((items) => items.length > beforeCrashCount && items.at(-1)?.processOutcome === "running")).at(-1)!;
      assert.equal(crashReceipt.owner?.pid, crashing.pid);
      assert.ok(crashReceipt.child?.pid && crashReceipt.child.start);
      const orphanPid = crashReceipt.child.pid;
      const markerDeadline = Date.now() + 2_000;
      while (!(await fs.readFile(started, "utf8")).trim().split("\n").includes(String(orphanPid))) {
        assert.ok(Date.now() < markerDeadline, "the native child never wrote its start marker");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const startsBeforeGuard = await fs.readFile(started, "utf8");
      assert.ok(startsBeforeGuard.trim().split("\n").includes(String(orphanPid)), "side-effect marker must identify the real child");
      assert.equal(crashing.kill("SIGKILL"), true);
      assert.equal(await crashEnded, null);
      process.kill(orphanPid, 0);
      const orphanReadback = JSON.parse(await cli(["list", "--json"])) as Array<{ receipts: Receipt[] }>;
      const interrupted = orphanReadback[0].receipts.find((item) => item.runId === crashReceipt.runId)!;
      assert.equal(interrupted.processOutcome, "interrupted");
      assert.equal(interrupted.finishedAt, null, "live orphan ownership must remain unresolved");
      assert.deepEqual(interrupted.child, crashReceipt.child);
      await assert.rejects(cli(["exec", "--if-missed", jobId]), /job_interrupted_requires_manual_request|job_process_ownership_uncertain/);
      assert.equal(await fs.readFile(started, "utf8"), startsBeforeGuard, "guard must never start a second child after launcher crash");
      process.kill(orphanPid, 0);
      await fs.writeFile(release, "release");
      const orphanDeadline = Date.now() + 10_000;
      while (true) {
        const reconciled = JSON.parse(await cli(["list", "--json"])) as Array<{ receipts: Receipt[] }>;
        const orphan = reconciled[0].receipts.find((item) => item.runId === crashReceipt.runId)!;
        if (orphan.finishedAt !== null) {
          assert.equal(orphan.processOutcome, "interrupted");
          assert.equal(orphan.exitCode, null, "a dead launcher did not observe the child's exit status");
          assert.equal(orphan.verificationOutcome, "notRequested");
          break;
        }
        assert.ok(Date.now() < orphanDeadline, "released local orphan ownership did not reconcile");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(await fs.readFile(finished, "utf8"), "finished");

      const expectedIds = (await receipts()).map((item) => item.runId).sort();
      await openJobs();
      const before = await historyText();
      for (const outcome of ["exited", "skipped_active", "deduplicated", "interrupted"]) assert.ok(before.includes(outcome), before);
      assert.match(before, /요청하지 않음|Not requested/);
      await browser.reloadSession();
      await openJobs();
      const after = await historyText();
      for (const outcome of ["exited", "skipped_active", "deduplicated", "interrupted"]) assert.ok(after.includes(outcome), after);
      assert.match(after, /요청하지 않음|Not requested/);
      assert.deepEqual((await receipts()).map((item) => item.runId).sort(), expectedIds);
    } finally {
      await fs.writeFile(release, "release");
      await ended;
      if (crashEnded) await crashEnded;
      if (label) await execute("/bin/launchctl", ["bootout", `gui/${process.getuid!()}/${label}`]).catch(() => undefined);
      // Stop disabled only this fixture-derived label. Remove that persistent
      // launchd override as part of cleanup, without touching any live label.
      await execute("/bin/launchctl", ["enable", `gui/${process.getuid!()}/${statuses[0].label}`]);
      const guardLabel = statuses[0].label.replace("com.maru.job.", "com.maru.job.guard.");
      await execute("/bin/launchctl", ["enable", `gui/${process.getuid!()}/${guardLabel}`]);
    }
  }).timeout(180_000);
});
