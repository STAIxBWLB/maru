import { describe, expect, it } from "vitest";
import {
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

describe("release workflow run eligibility", () => {
  it("accepts main pushes, tag pushes, and manual runs for the exact tag SHA", () => {
    const main = run();
    const tagPush = run({ id: 2, head_branch: tag });
    const manual = run({ id: 3, event: "workflow_dispatch", head_branch: "release" });
    expect(selectLatestEligibleRun([main], context)).toBe(main);
    expect(selectLatestEligibleRun([tagPush], context)).toBe(tagPush);
    expect(selectLatestEligibleRun([manual], context)).toBe(manual);
    const selected = selectLatestEligibleRun([main, tagPush, manual], context);
    expect(selected).toBe(manual);
  });

  it("excludes pull requests, other branches, and any different SHA", () => {
    const excluded = [
      run({ id: 1, event: "pull_request", head_branch: tag }),
      run({ id: 2, head_branch: "feature/release" }),
      run({ id: 3, head_sha: "b".repeat(40), head_branch: tag }),
    ];
    expect(selectLatestEligibleRun(excluded, context)).toBeUndefined();
  });

  it.each([
    ["failed", "completed", "failure"],
    ["in progress", "in_progress", null],
    ["queued", "queued", null],
  ])("does not fall back to an older green run when the latest eligible run is %s", (_label, status, conclusion) => {
    const result = evaluateWorkflowRuns("ci.yml", [
      run({ id: 10, run_started_at: "2026-11-01T00:00:00Z" }),
      run({ id: 11, run_started_at: "2026-11-02T00:00:00Z", status, conclusion }),
    ], context);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(status === "completed" ? "concluded failure" : `latest run is ${status}`);
    expect(result.message).toContain("actions/runs/11");
  });

  it("reports missing, cancelled, and skipped receipts with actionable workflow/run URLs", () => {
    const missing = evaluateWorkflowRuns("native-e2e.yml", [], context);
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("no main/tag push or manual run");
    expect(missing.message).toContain("https://github.com/owner/maru/actions/workflows/native-e2e.yml");

    for (const conclusion of ["cancelled", "skipped"]) {
      const result = evaluateWorkflowRuns("native-e2e.yml", [run({ conclusion })], context);
      expect(result.ok).toBe(false);
      expect(result.message).toContain(`concluded ${conclusion}, not success`);
      expect(result.message).toContain("native-e2e.yml");
      expect(result.message).toContain("https://github.com/owner/maru/actions/runs/1");
    }
  });

  it("fails closed on incomplete run metadata and uses creation time for a queued run", () => {
    expect(evaluateWorkflowRuns("ci.yml", [run({ run_started_at: "not a timestamp" })], context).ok).toBe(false);
    const queued = run({ id: 2, run_started_at: null, created_at: "2026-11-02T00:00:00Z", status: "queued", conclusion: null });
    expect(selectLatestEligibleRun([run(), queued], context)).toBe(queued);
  });

  it("accepts overall CI success when an intentionally skipped job is present", () => {
    const result = evaluateWorkflowRuns("ci.yml", [run({
      conclusion: "success",
      jobs: [{ name: "full-verify", conclusion: "skipped" }],
    })], context);
    expect(result).toEqual({
      ok: true,
      message: "ci.yml: success for " + sha + ": https://github.com/owner/maru/actions/runs/1",
    });
  });
});

describe("verifyReleaseWorkflows lookup", () => {
  it("reads every page for each required workflow before evaluating the latest run", () => {
    const calls: Array<{ route: string; fields: Record<string, string>; paginate: boolean }> = [];
    const reports: string[] = [];
    const readJson = (route: string, fields: Record<string, string>, paginate = false) => {
      calls.push({ route, fields, paginate });
      if (route === `repos/${repo}/commits`) return [{ sha }];
      const workflow = route.includes("native-e2e.yml") ? "native-e2e.yml" : "ci.yml";
      return [
        { workflow_runs: [run({ id: workflow === "ci.yml" ? 20 : 30, run_started_at: "2026-11-01T00:00:00Z" })] },
        { workflow_runs: [run({ id: workflow === "ci.yml" ? 21 : 31, head_branch: tag, run_started_at: "2026-11-02T00:00:00Z" })] },
      ];
    };

    expect(verifyReleaseWorkflows(tag, repo, readJson, (message) => reports.push(message))).toBe(sha);
    expect(calls).toHaveLength(1 + REQUIRED_WORKFLOWS.length);
    expect(calls[0]).toMatchObject({ route: `repos/${repo}/commits`, fields: { sha: `refs/tags/${tag}`, per_page: "1" }, paginate: false });
    for (const workflow of REQUIRED_WORKFLOWS) {
      const query = calls.find((call) => call.route.endsWith(`/workflows/${workflow}/runs`));
      expect(query).toMatchObject({ paginate: true, fields: { head_sha: sha, per_page: "100" } });
    }
    expect(reports).toHaveLength(1 + REQUIRED_WORKFLOWS.length);
    expect(reports.every((message) => message.includes(sha))).toBe(true);
  });

  it("rejects a failed native receipt on a later page after successful CI", () => {
    const readJson = (route: string) => {
      if (route.endsWith("/commits")) return [{ sha }];
      return [
        { workflow_runs: [run()] },
        { workflow_runs: [run({ id: 2, run_started_at: "2026-11-02T00:00:00Z", conclusion: route.includes("native-e2e.yml") ? "failure" : "success" })] },
      ];
    };
    expect(() => verifyReleaseWorkflows(tag, repo, readJson, () => {})).toThrow("native-e2e.yml: latest run concluded failure");
  });

  it("fails closed with the workflow URL when the Actions API lookup fails", () => {
    const readJson = (route: string) => {
      if (route === `repos/${repo}/commits`) return [{ sha }];
      throw new Error("API unavailable");
    };
    expect(() => verifyReleaseWorkflows(tag, repo, readJson, () => {})).toThrow(
      `ci.yml: run lookup failed for ${sha}; inspect https://github.com/${repo}/actions/workflows/ci.yml`,
    );
  });
});
