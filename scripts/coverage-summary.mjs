#!/usr/bin/env node
/**
 * coverage-summary — prints the non-gating `make coverage` totals table
 * (TEST-02, D-02/D-03/D-04).
 *
 * Reads the Vitest v8 `json-summary` reporter output for the TypeScript half
 * and cargo-llvm-cov's `report --json` output for the Rust half, and prints
 * one markdown table with a row per scope: TypeScript, then (once Task 3
 * wires it in) each Rust crate plus a workspace total.
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

/** Formats a covered/total pair as "NN.NN% (covered/total)", or "n/a (0/0)" for a zero denominator. */
function formatCell(covered, total) {
  if (total === 0) {
    return "n/a (0/0)";
  }
  const pct = (covered / total) * 100;
  return `${pct.toFixed(2)}% (${covered}/${total})`;
}

/**
 * Builds the markdown totals table.
 *
 * @param {{ ts?: { total: { lines: { total: number, covered: number }, functions: { total: number, covered: number } } } }} input
 * @returns {string}
 */
export function summarizeCoverage({ ts } = {}) {
  const rows = [];

  if (ts) {
    const linesCell = formatCell(ts.total.lines.covered, ts.total.lines.total);
    const functionsCell = formatCell(ts.total.functions.covered, ts.total.functions.total);
    rows.push(`| TypeScript (src + scripts) | ${linesCell} | ${functionsCell} |`);
  }

  return ["### Coverage totals", "| Scope | Lines | Functions |", "|---|---|---|", ...rows].join("\n");
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function main() {
  let ts;
  try {
    ts = await readJson(TS_SUMMARY_PATH);
  } catch (error) {
    console.error(
      `coverage-summary: could not read ${path.relative(REPO_ROOT, TS_SUMMARY_PATH)} (${
        error instanceof Error ? error.message : String(error)
      }) - run \`make coverage\` first`,
    );
    process.exit(1);
    return;
  }

  console.log(summarizeCoverage({ ts }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
