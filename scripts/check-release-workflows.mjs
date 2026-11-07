#!/usr/bin/env node
// Release admission reads workflow conclusions for the exact tag commit. It
// never reruns CI, accepts PR-only receipts, or falls back to an older success.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const REQUIRED_WORKFLOWS = ["ci.yml", "native-e2e.yml"];
// native-e2e-suite allows 45 minutes; allow 5 more for queue/startup.
// A source-contract test keeps this budget and prepare's timeout aligned.
export const MAX_WAIT_MS = 50 * 60_000;
export const POLL_INTERVAL_MS = 60_000;
const IN_FLIGHT = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);

function eligibleRuns(runs, { sha, tag }) {
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
    .map(({ run }) => run);
}

export function selectLatestEligibleRun(runs, context) {
  return eligibleRuns(runs, context).at(-1);
}

export function evaluateWorkflowRuns(workflow, runs, context) {
  const workflowUrl = `https://github.com/${context.repo}/actions/workflows/${workflow}`;
  const next = "Run that workflow successfully on the release tag, then retry Release Bundles.";
  const outcome = (ok, message, flags = {}) => ({
    ok, pending: false, fatal: false, workflow, url: workflowUrl, message, ...flags,
  });
  let eligible;
  try {
    eligible = eligibleRuns(runs, context);
  } catch {
    return outcome(false, `${workflow}: invalid run metadata for ${context.sha}; inspect ${workflowUrl}. ${next}`, { fatal: true });
  }
  const run = eligible.at(-1);
  if (!run) {
    return outcome(false, `${workflow}: no main/tag push or manual run for ${context.sha}; inspect ${workflowUrl}. ${next}`, { fatal: true });
  }
  // A tag push starts native E2E alongside Release Bundles. Wait for all
  // eligible in-flight runs before selecting the latest completed receipt.
  const inFlight = eligible.filter((candidate) => IN_FLIGHT.has(candidate.status)).at(-1);
  if (inFlight) {
    const url = `https://github.com/${context.repo}/actions/runs/${inFlight.id}`;
    return outcome(false, `${workflow}: eligible run is ${inFlight.status} for ${context.sha}: ${url}. Waiting for completion before judging the release.`, { pending: true, url });
  }
  const url = `https://github.com/${context.repo}/actions/runs/${run.id}`;
  if (run.status !== "completed") {
    return outcome(false, `${workflow}: latest run is ${run.status}, not completed, for ${context.sha}: ${url}. Inspect the run and retry Release Bundles after success.`, { fatal: true, url });
  }
  if (run.conclusion !== "success") {
    return outcome(false, `${workflow}: latest run concluded ${run.conclusion}, not success, for ${context.sha}: ${url}. ${next}`, { url });
  }
  // Use the overall workflow conclusion: a successful CI decision that
  // deliberately skipped full verify is still a successful receipt.
  return outcome(true, `${workflow}: success for ${context.sha}: ${url}`, { url });
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
  } catch (error) {
    const status = Number.isInteger(error?.status) ? `exit status ${error.status}` : error?.code ?? "invalid response";
    const detail = error?.stderr?.toString().trim() || (error instanceof Error ? error.message : "unknown failure");
    throw new Error(`GitHub lookup failed (gh ${status}): ${detail}. Check gh availability, repository access and Actions read permission, then retry Release Bundles`);
  }
}

/** Clock/sleep injection keeps pending-run transitions deterministic in tests.
 * @param {{now?: () => number, sleep?: (ms: number) => Promise<unknown>, waitMs?: number, pollMs?: number}} [waitOptions]
 */
export async function verifyReleaseWorkflows(tag, repo, readJson = githubJson, report = console.log, waitOptions = {}) {
  const { now = () => performance.now(), sleep = delay, waitMs = MAX_WAIT_MS, pollMs = POLL_INTERVAL_MS } = waitOptions;
  if (!Number.isFinite(waitMs) || waitMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error("release wait budget is invalid; restore the bounded gate configuration and retry Release Bundles");
  }
  if (!tag?.startsWith("v") || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) {
    throw new Error("release verification requires a v-prefixed tag and GITHUB_REPOSITORY=owner/repo; correct the inputs and retry Release Bundles");
  }
  const commits = await readJson(`repos/${repo}/commits`, { sha: `refs/tags/${tag}`, per_page: "1" });
  const sha = Array.isArray(commits) ? commits[0]?.sha : undefined;
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) {
    throw new Error("release tag did not resolve to a commit; confirm the tag exists and retry Release Bundles");
  }
  report(`Release tag ${JSON.stringify(tag)} resolves to ${sha}`);
  const deadline = now() + waitMs;
  while (true) {
    const results = [];
    for (const workflow of REQUIRED_WORKFLOWS) {
      let runs;
      try {
        const pages = await readJson(`repos/${repo}/actions/workflows/${workflow}/runs`, { head_sha: sha, per_page: "100" }, true);
        if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page.workflow_runs))) throw new Error("invalid pages");
        runs = pages.flatMap((page) => page.workflow_runs);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${workflow}: run lookup failed for ${sha}; inspect https://github.com/${repo}/actions/workflows/${workflow}, check Actions read permission and retry Release Bundles. Cause: ${detail}`);
      }
      const result = evaluateWorkflowRuns(workflow, runs, { repo, sha, tag });
      // A settled red workflow cannot be rescued by waiting for its sibling.
      // Its own in-flight runs still take precedence inside evaluation.
      if (result.fatal || (!result.ok && !result.pending)) throw new Error(result.message);
      results.push(result);
    }
    const pending = results.find((result) => result.pending);
    if (!pending) {
      for (const result of results) report(result.message);
      break;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(`${pending.workflow}: release wait deadline expired for ${sha}: ${pending.url}. Finish or cancel the stuck run, run the workflow successfully on this tag, then retry Release Bundles`);
    }
    report(pending.message);
    await sleep(Math.min(pollMs, remaining));
  }
  return sha;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: GITHUB_REPOSITORY=owner/repo node scripts/check-release-workflows.mjs <tag>; supply the release tag and retry");
    const sha = await verifyReleaseWorkflows(process.argv[2], process.env.GITHUB_REPOSITORY);
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
