import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_WAIT_MS,
  REQUIRED_WORKFLOWS,
  evaluateWorkflowRuns,
  selectLatestEligibleRun,
  verifyReleaseWorkflows,
} from "./check-release-workflows.mjs";

const repo = "owner/maru";
const sha = "a".repeat(40);
const tag = "v1.2.3";
const context = { repo, sha, tag };

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    head_sha: sha,
    head_branch: "main",
    event: "push",
    run_started_at: "2026-11-01T00:00:00Z",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function workflowPages(runs: unknown[]) {
  return [{ workflow_runs: runs }];
}

describe("release workflow run eligibility", () => {
  it("accepts main pushes, tag pushes, and manual runs for the exact tag SHA", () => {
    const main = run();
    const tagPush = run({ id: 2, head_branch: tag });
    const manual = run({ id: 3, event: "workflow_dispatch", head_branch: "release" });
    expect(selectLatestEligibleRun([main], context)).toBe(main);
    expect(selectLatestEligibleRun([tagPush], context)).toBe(tagPush);
    expect(selectLatestEligibleRun([manual], context)).toBe(manual);
    expect(selectLatestEligibleRun([main, tagPush, manual], context)).toBe(manual);
  });

  it("excludes pull requests, other branches, and any different SHA", () => {
    const excluded = [
      run({ id: 1, event: "pull_request", head_branch: tag }),
      run({ id: 2, head_branch: "feature/release" }),
      run({ id: 3, head_sha: "b".repeat(40), head_branch: tag }),
    ];
    expect(selectLatestEligibleRun(excluded, context)).toBeUndefined();
  });

  it("exposes stable result metadata for missing and successful receipts", () => {
    const missing = evaluateWorkflowRuns("native-e2e.yml", [], context);
    expect(missing.message).toContain("no main/tag push or manual run");
    expect(missing).toMatchObject({
      ok: false,
      pending: false,
      fatal: true,
      workflow: "native-e2e.yml",
      url: "https://github.com/owner/maru/actions/workflows/native-e2e.yml",
    });
    expect(evaluateWorkflowRuns("ci.yml", [run()], context)).toMatchObject({
      ok: true,
      pending: false,
      fatal: false,
      workflow: "ci.yml",
      url: "https://github.com/owner/maru/actions/runs/1",
    });
  });

  it("returns pending metadata for an eligible in-flight run even when a newer run is green", () => {
    const olderInFlight = run({ id: 10, status: "in_progress", conclusion: null });
    const newerGreen = run({ id: 11, head_branch: tag, run_started_at: "2026-11-02T00:00:00Z" });
    const result = evaluateWorkflowRuns("ci.yml", [olderInFlight, newerGreen], context);
    expect(result).toMatchObject({
      ok: false,
      pending: true,
      fatal: false,
      workflow: "ci.yml",
      url: "https://github.com/owner/maru/actions/runs/10",
    });
    expect(result.message).toContain("Waiting for completion before judging the release");
  });

  it("fails closed on invalid metadata, cancelled runs, and skipped runs with actionable URLs", () => {
    expect(evaluateWorkflowRuns("ci.yml", [run({ run_started_at: "not a timestamp" })], context))
      .toMatchObject({ ok: false, fatal: true, workflow: "ci.yml" });
    const queued = run({ id: 2, run_started_at: null, created_at: "2026-11-02T00:00:00Z", status: "queued", conclusion: null });
    expect(selectLatestEligibleRun([run(), queued], context)).toBe(queued);
    expect(evaluateWorkflowRuns("ci.yml", [run(), queued], context).pending).toBe(true);

    for (const conclusion of ["cancelled", "skipped"]) {
      const result = evaluateWorkflowRuns("native-e2e.yml", [run({ conclusion })], context);
      expect(result).toMatchObject({
        ok: false,
        pending: false,
        workflow: "native-e2e.yml",
        url: "https://github.com/owner/maru/actions/runs/1",
      });
      expect(result.message).toContain(`concluded ${conclusion}, not success`);
    }
  });

  it("accepts overall CI success when an intentionally skipped job is present", () => {
    const result = evaluateWorkflowRuns("ci.yml", [run({
      conclusion: "success",
      jobs: [{ name: "full-verify", conclusion: "skipped" }],
    })], context);
    expect(result).toMatchObject({ ok: true, pending: false, fatal: false, workflow: "ci.yml" });
    expect(result.message).toBe(`ci.yml: success for ${sha}: https://github.com/${repo}/actions/runs/1`);
  });
});

describe("verifyReleaseWorkflows polling", () => {
  it.each(REQUIRED_WORKFLOWS)("rejects settled red %s without waiting for its pending sibling", async (failedWorkflow) => {
    const sleeps: number[] = [];
    const readJson = async (route: string) => {
      if (route.endsWith("/commits")) return [{ sha }];
      return workflowPages([route.includes(failedWorkflow)
        ? run({ id: 50, conclusion: "failure" })
        : run({ id: 51, status: "in_progress", conclusion: null })]);
    };
    await expect(verifyReleaseWorkflows(tag, repo, readJson, () => {}, {
      now: () => 0,
      sleep: async (ms: number) => { sleeps.push(ms); throw new Error("must not wait"); },
    })).rejects.toThrow(`${failedWorkflow}: latest run concluded failure, not success`);
    expect(sleeps).toEqual([]);
  });

  it("refreshes both workflow snapshots until a newer tag run succeeds", async () => {
    let now = 0;
    let nativePolls = 0;
    const calls: string[] = [];
    const sleeps: number[] = [];
    const reports: string[] = [];
    const readJson = async (route: string) => {
      calls.push(route);
      if (route === `repos/${repo}/commits`) return [{ sha }];
      if (route.includes("native-e2e.yml")) {
        nativePolls += 1;
        return workflowPages([run({ id: 30 }), run({
          id: 31,
          head_branch: tag,
          run_started_at: "2026-11-02T00:00:00Z",
          status: nativePolls === 1 ? "in_progress" : "completed",
          conclusion: nativePolls === 1 ? null : "success",
        })]);
      }
      return workflowPages([run({ id: 20 })]);
    };
    const waitOptions = {
      now: () => now,
      sleep: async (ms: number) => { sleeps.push(ms); now += ms; },
      waitMs: 100,
      pollMs: 20,
    };

    await expect(verifyReleaseWorkflows(tag, repo, readJson, (message) => reports.push(message), waitOptions))
      .resolves.toBe(sha);
    expect(nativePolls).toBe(2);
    expect(calls.filter((route) => route.includes("/runs"))).toHaveLength(4);
    expect(sleeps).toEqual([20]);
    expect(reports.some((message) => message.includes("Waiting for completion"))).toBe(true);
    expect(reports.some((message) => message.includes("native-e2e.yml: success"))).toBe(true);
  });

  it("rejects when the pending latest tag run later fails instead of falling back to older green", async () => {
    let now = 0;
    let nativePolls = 0;
    const readJson = async (route: string) => {
      if (route.endsWith("/commits")) return [{ sha }];
      if (route.includes("native-e2e.yml")) {
        nativePolls += 1;
        return workflowPages([
          run({ id: 40, conclusion: "success" }),
          run({
            id: 41,
            head_branch: tag,
            run_started_at: "2026-11-02T00:00:00Z",
            status: nativePolls === 1 ? "in_progress" : "completed",
            conclusion: nativePolls === 1 ? null : "failure",
          }),
        ]);
      }
      return workflowPages([run({ id: 20 })]);
    };
    const waitOptions = {
      now: () => now,
      sleep: async (ms: number) => { now += ms; },
      waitMs: 100,
      pollMs: 20,
    };

    await expect(verifyReleaseWorkflows(tag, repo, readJson, () => {}, waitOptions))
      .rejects.toThrow(`native-e2e.yml: latest run concluded failure, not success, for ${sha}: https://github.com/${repo}/actions/runs/41`);
    expect(nativePolls).toBe(2);
  });

  it("reports the pending run URL and next step when the fake deadline expires", async () => {
    let now = 0;
    const readJson = async (route: string) => {
      if (route.endsWith("/commits")) return [{ sha }];
      if (route.includes("native-e2e.yml")) {
        return workflowPages([run({ id: 42, head_branch: tag, status: "in_progress", conclusion: null })]);
      }
      return workflowPages([run({ id: 20 })]);
    };
    const waitOptions = {
      now: () => now,
      sleep: async (ms: number) => { now += ms; },
      waitMs: 25,
      pollMs: 10,
    };

    await expect(verifyReleaseWorkflows(tag, repo, readJson, () => {}, waitOptions)).rejects.toThrow(
      `native-e2e.yml: release wait deadline expired for ${sha}: https://github.com/${repo}/actions/runs/42. Finish or cancel the stuck run, run the workflow successfully at this exact SHA, then retry Release Bundles`,
    );
    expect(now).toBe(25);
  });

  it("reads every API page and fails closed when a workflow lookup fails", async () => {
    const calls: Array<{ route: string; fields: Record<string, string>; paginate: boolean }> = [];
    const reports: string[] = [];
    const readJson = async (route: string, fields: Record<string, string>, paginate = false) => {
      calls.push({ route, fields, paginate });
      if (route === `repos/${repo}/commits`) return [{ sha }];
      const workflow = route.includes("native-e2e.yml") ? "native-e2e.yml" : "ci.yml";
      return [
        { workflow_runs: [run({ id: workflow === "ci.yml" ? 20 : 30, run_started_at: "2026-11-01T00:00:00Z" })] },
        { workflow_runs: [run({ id: workflow === "ci.yml" ? 21 : 31, head_branch: tag, run_started_at: "2026-11-02T00:00:00Z" })] },
      ];
    };
    await expect(verifyReleaseWorkflows(tag, repo, readJson, (message) => reports.push(message), { waitMs: 0 }))
      .resolves.toBe(sha);
    expect(calls).toHaveLength(1 + REQUIRED_WORKFLOWS.length);
    expect(calls[0]).toMatchObject({ route: `repos/${repo}/commits`, fields: { sha: `refs/tags/${tag}`, per_page: "1" }, paginate: false });
    for (const workflow of REQUIRED_WORKFLOWS) {
      expect(calls.find((call) => call.route.endsWith(`/workflows/${workflow}/runs`)))
        .toMatchObject({ paginate: true, fields: { head_sha: sha, per_page: "100" } });
    }
    expect(reports).toHaveLength(1 + REQUIRED_WORKFLOWS.length);
    expect(reports).toContain(`ci.yml: success for ${sha}: https://github.com/${repo}/actions/runs/21`);
    expect(reports).toContain(`native-e2e.yml: success for ${sha}: https://github.com/${repo}/actions/runs/31`);

    const failingReader = async (route: string) => {
      if (route === `repos/${repo}/commits`) return [{ sha }];
      throw new Error("API unavailable");
    };
    await expect(verifyReleaseWorkflows(tag, repo, failingReader, () => {}, { waitMs: 0 }))
      .rejects.toThrow(`ci.yml: run lookup failed for ${sha}; inspect https://github.com/${repo}/actions/workflows/ci.yml`);
  });

  it("rejects a completed native failure on a later page after successful CI", async () => {
    const readJson = async (route: string) => {
      if (route.endsWith("/commits")) return [{ sha }];
      return [
        { workflow_runs: [run()] },
        { workflow_runs: [run({ id: 2, run_started_at: "2026-11-02T00:00:00Z", conclusion: route.includes("native-e2e.yml") ? "failure" : "success" })] },
      ];
    };
    await expect(verifyReleaseWorkflows(tag, repo, readJson, () => {}, { waitMs: 0 }))
      .rejects.toThrow("native-e2e.yml: latest run concluded failure");
  });

  it("keeps the 50-minute gate budget between the 45-minute suite and 60-minute prepare job", () => {
    const nativeWorkflow = readFileSync(resolve(process.cwd(), ".github/workflows/native-e2e.yml"), "utf8");
    const releaseWorkflow = readFileSync(resolve(process.cwd(), ".github/workflows/release-bundles.yml"), "utf8");
    const nativeBlock = nativeWorkflow.match(/^  native-e2e-suite:\n[\s\S]*?(?=^  [A-Za-z0-9_-]+:|$(?![\s\S]))/m)?.[0] ?? "";
    const nativeTimeout = nativeBlock.match(/^    timeout-minutes: (\d+)$/m);
    const prepareBlock = releaseWorkflow.match(/^  prepare:\n[\s\S]*?(?=^  [A-Za-z0-9_-]+:|$(?![\s\S]))/m)?.[0] ?? "";
    const prepareTimeout = prepareBlock.match(/^    timeout-minutes: (\d+)$/m);
    expect(nativeTimeout).not.toBeNull();
    expect(prepareTimeout).not.toBeNull();
    expect(MAX_WAIT_MS).toBe((Number(nativeTimeout?.[1]) + 5) * 60_000);
    expect(Number(prepareTimeout?.[1]) * 60_000).toBeGreaterThanOrEqual(MAX_WAIT_MS + 10 * 60_000);
  });
});

describe("release lookup diagnostics", () => {
  it.each([
    { stage: "tag", detail: "gh: Not Found (HTTP 404)", status: 1 },
    { stage: "runs", detail: "gh: Resource not accessible by integration (HTTP 403)", status: 4 },
    { stage: "runs", detail: "gh: API rate limit exceeded (HTTP 403)", status: 1 },
    { stage: "missing", detail: "ENOENT", status: undefined },
  ])("retains gh cause for $stage: $detail", ({ stage, detail, status }) => {
    const fixture = mkdtempSync(resolve(tmpdir(), "maru-release-lookup-"));
    try {
      if (stage !== "missing") {
        writeFileSync(resolve(fixture, "gh"), `#!${process.execPath}
if (${JSON.stringify(stage)} === "runs" && process.argv.includes("repos/${repo}/commits")) {
  console.log(JSON.stringify([{ sha: ${JSON.stringify(sha)} }]));
} else {
  process.stderr.write(${JSON.stringify(`  ${detail}\n`)});
  process.exit(${status});
}
`, { mode: 0o755 });
      }
      const output = resolve(fixture, "github-output");
      const result = spawnSync(process.execPath, [resolve(process.cwd(), "scripts/check-release-workflows.mjs"), tag], {
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: fixture, HOME: fixture, GITHUB_REPOSITORY: repo, GITHUB_OUTPUT: output },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(detail);
      if (status !== undefined) expect(result.stderr).toContain(`gh exit status ${status}`);
      expect(result.stderr).toContain("retry Release Bundles");
      if (stage === "runs") expect(result.stderr).toContain("ci.yml: run lookup failed");
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
