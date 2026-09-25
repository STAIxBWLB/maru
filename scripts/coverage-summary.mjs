#!/usr/bin/env node
/**
 * coverage-summary — prints the non-gating `make coverage` totals table
 * (TEST-02, D-02/D-03/D-04).
 *
 * Reads the Vitest v8 `json-summary` reporter output for the TypeScript half
 * and cargo-llvm-cov's `report --json` output for the Rust half, and prints
 * one markdown table with a row per scope: TypeScript, then each Rust crate
 * (maru, maru-cli) plus a workspace total.
 *
 * No thresholds, no fail-under option, no lcov output (D-04). This is a
 * diagnostic report, not a gate.
 *
 * Hermetic — node builtins only.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TS_SUMMARY_PATH = path.join(REPO_ROOT, "coverage/ts/coverage-summary.json");
const RUST_SUMMARY_PATH = path.join(REPO_ROOT, "coverage/rust/coverage.json");

/** Formats a covered/total pair as "NN.NN% (covered/total)", or "n/a (0/0)" for a zero denominator. */
function formatCell(covered, total) {
  if (total === 0) {
    return "n/a (0/0)";
  }
  const pct = (covered / total) * 100;
  return `${pct.toFixed(2)}% (${covered}/${total})`;
}

function emptyMetric() {
  return { total: 0, covered: 0 };
}

function addMetric(metric, count, covered) {
  metric.total += count;
  metric.covered += covered;
}

/**
 * Groups a cargo-llvm-cov JSON export's files by crate (maru, maru-cli) and
 * accumulates a workspace total across every file, regardless of crate. A
 * file whose path matches neither crate still counts toward the workspace
 * total only.
 *
 * @param {{ data?: Array<{ files?: Array<{ filename: string, summary?: { lines?: { count: number, covered: number }, functions?: { count: number, covered: number } } }> }> }} rust
 */
function groupRustFiles(rust) {
  const groups = {
    maru: { lines: emptyMetric(), functions: emptyMetric(), hasFiles: false },
    maruCli: { lines: emptyMetric(), functions: emptyMetric(), hasFiles: false },
    workspace: { lines: emptyMetric(), functions: emptyMetric(), hasFiles: false },
  };

  const files = rust?.data?.[0]?.files ?? [];
  for (const file of files) {
    const filename = (file.filename ?? "").replaceAll("\\", "/");
    const lines = file.summary?.lines ?? { count: 0, covered: 0 };
    const functions = file.summary?.functions ?? { count: 0, covered: 0 };

    groups.workspace.hasFiles = true;
    addMetric(groups.workspace.lines, lines.count, lines.covered);
    addMetric(groups.workspace.functions, functions.count, functions.covered);

    const kind = filename.includes("/src-tauri/maru-cli/") ? "maruCli" : filename.includes("/src-tauri/src/") ? "maru" : null;
    if (kind) {
      const group = groups[kind];
      group.hasFiles = true;
      addMetric(group.lines, lines.count, lines.covered);
      addMetric(group.functions, functions.count, functions.covered);
    }
  }

  return groups;
}

function formatGroupCell(group, key) {
  return group.hasFiles ? formatCell(group[key].covered, group[key].total) : "no files in report";
}

/**
 * Builds the markdown totals table.
 *
 * @param {{
 *   ts?: { total: { lines: { total: number, covered: number }, functions: { total: number, covered: number } } },
 *   rust?: { data?: Array<{ files?: Array<{ filename: string, summary?: { lines?: object, functions?: object } }> }> },
 * }} input
 * @returns {string}
 */
export function summarizeCoverage({ ts, rust } = {}) {
  const rows = [];

  if (ts) {
    const linesCell = formatCell(ts.total.lines.covered, ts.total.lines.total);
    const functionsCell = formatCell(ts.total.functions.covered, ts.total.functions.total);
    rows.push(`| TypeScript (src + scripts) | ${linesCell} | ${functionsCell} |`);
  }

  if (rust) {
    const groups = groupRustFiles(rust);
    rows.push(`| Rust maru (src-tauri/src) | ${formatGroupCell(groups.maru, "lines")} | ${formatGroupCell(groups.maru, "functions")} |`);
    rows.push(
      `| Rust maru-cli (src-tauri/maru-cli) | ${formatGroupCell(groups.maruCli, "lines")} | ${formatGroupCell(groups.maruCli, "functions")} |`,
    );
    rows.push(
      `| Rust workspace total | ${formatGroupCell(groups.workspace, "lines")} | ${formatGroupCell(groups.workspace, "functions")} |`,
    );
  }

  return ["### Coverage totals", "| Scope | Lines | Functions |", "|---|---|---|", ...rows].join("\n");
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function readRequired(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    console.error(
      `coverage-summary: could not read ${path.relative(REPO_ROOT, filePath)} (${
        error instanceof Error ? error.message : String(error)
      }) - run \`make coverage\` first`,
    );
    process.exit(1);
    return undefined;
  }
}

async function main() {
  const ts = await readRequired(TS_SUMMARY_PATH);
  const rust = await readRequired(RUST_SUMMARY_PATH);
  console.log(summarizeCoverage({ ts, rust }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
