#!/usr/bin/env node
// Release admission reads workflow conclusions for the exact tag commit. It
// never reruns CI, accepts PR-only receipts, or falls back to an older success.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_WORKFLOWS = ["ci.yml", "native-e2e.yml"];

export function selectLatestEligibleRun(runs, { sha, tag }) {
  return runs.filter((run) => run.head_sha === sha
    && (run.event === "workflow_dispatch"
      || (run.event === "push" && (run.head_branch === "main" || run.head_branch === tag))))
    .map((run) => {
      const started = Date.parse(run.run_started_at ?? run.created_at ?? "");
      if (!Number.isFinite(started) || !Number.isSafeInteger(run.id) || run.id <= 0) {
        throw new Error("workflow run metadata is incomplete");
      }
      return { run, started };
    })
    .sort((a, b) => a.started - b.started || a.run.id - b.run.id
      || (a.run.run_attempt ?? 1) - (b.run.run_attempt ?? 1))
    .at(-1)?.run;
}

export function evaluateWorkflowRuns(workflow, runs, context) {
  const workflowUrl = `https://github.com/${context.repo}/actions/workflows/${workflow}`;
  const next = "Run that workflow successfully on the release tag, then retry Release Bundles.";
  let run;
  try {
    run = selectLatestEligibleRun(runs, context);
  } catch {
    return { ok: false, message: `${workflow}: invalid run metadata for ${context.sha}; inspect ${workflowUrl}. ${next}` };
  }
  if (!run) {
    return { ok: false, message: `${workflow}: no main/tag push or manual run for ${context.sha}; inspect ${workflowUrl}. ${next}` };
  }
  const url = `https://github.com/${context.repo}/actions/runs/${run.id}`;
  if (run.status !== "completed") {
    return { ok: false, message: `${workflow}: latest run is ${run.status}, not completed, for ${context.sha}: ${url}. Wait for success, then retry Release Bundles.` };
  }
  if (run.conclusion !== "success") {
    return { ok: false, message: `${workflow}: latest run concluded ${run.conclusion}, not success, for ${context.sha}: ${url}. ${next}` };
  }
  // Use the overall workflow conclusion: a successful CI decision that
  // deliberately skipped full verify is still a successful receipt.
  return { ok: true, message: `${workflow}: success for ${context.sha}: ${url}` };
}

function githubJson(route, fields, paginate = false) {
  const args = ["api", "--method", "GET", route];
  for (const [name, value] of Object.entries(fields)) args.push("-f", `${name}=${value}`);
  if (paginate) args.push("--paginate", "--slurp");
  try {
    return JSON.parse(execFileSync("gh", args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    }));
  } catch {
    throw new Error("GitHub lookup failed; check repository access and Actions read permission, then retry Release Bundles");
  }
}

export function verifyReleaseWorkflows(tag, repo, readJson = githubJson, report = console.log) {
  if (!tag?.startsWith("v") || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) {
    throw new Error("release verification requires a v-prefixed tag and GITHUB_REPOSITORY=owner/repo; correct the inputs and retry Release Bundles");
  }
  const commits = readJson(`repos/${repo}/commits`, { sha: `refs/tags/${tag}`, per_page: "1" });
  const sha = Array.isArray(commits) ? commits[0]?.sha : undefined;
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) {
    throw new Error("release tag did not resolve to a commit; confirm the tag exists and retry Release Bundles");
  }
  report(`Release tag ${JSON.stringify(tag)} resolves to ${sha}`);
  for (const workflow of REQUIRED_WORKFLOWS) {
    let runs;
    try {
      const pages = readJson(`repos/${repo}/actions/workflows/${workflow}/runs`, { head_sha: sha, per_page: "100" }, true);
      if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page.workflow_runs))) throw new Error("invalid pages");
      runs = pages.flatMap((page) => page.workflow_runs);
    } catch {
      throw new Error(`${workflow}: run lookup failed for ${sha}; inspect https://github.com/${repo}/actions/workflows/${workflow}, check Actions read permission and retry Release Bundles`);
    }
    const result = evaluateWorkflowRuns(workflow, runs, { repo, sha, tag });
    if (!result.ok) throw new Error(result.message);
    report(result.message);
  }
  return sha;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: GITHUB_REPOSITORY=owner/repo node scripts/check-release-workflows.mjs <tag>; supply the release tag and retry");
    const sha = verifyReleaseWorkflows(process.argv[2], process.env.GITHUB_REPOSITORY);
    if (process.env.GITHUB_OUTPUT) {
      try {
        appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
      } catch {
        throw new Error("verified SHA could not be recorded in GITHUB_OUTPUT; check runner file permissions and retry Release Bundles");
      }
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : "release verification failed; inspect workflow runs and retry Release Bundles"}`);
    process.exitCode = 1;
  }
}
