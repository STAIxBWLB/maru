// Run every hosted Rust SVG integration target with both SVG and PNG features.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_SVG_SUITE_COUNT = 20;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(ROOT, "src-tauri/crates/maru-diagram-engine/tests");

export function assertSvgSuiteCount(suiteNames, expected = EXPECTED_SVG_SUITE_COUNT) {
  if (!Array.isArray(suiteNames) || suiteNames.length !== expected
      || new Set(suiteNames).size !== suiteNames.length
      || suiteNames.some((name) => typeof name !== "string" || !/^svg_.+\.rs$/.test(name))) {
    throw new Error(`Expected ${expected} unique svg_*.rs integration suites, found ${suiteNames?.length ?? 0}; inspect the test directory and update the gate only with an explicit coverage review.`);
  }
  return suiteNames.map((filename) => filename.replace(/\.rs$/, "")).sort();
}

export function parseCargoTestSummary(output, suiteName) {
  const summaries = [...String(output).matchAll(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/gm)];
  if (summaries.length !== 1) {
    throw new Error(`${suiteName} produced ${summaries.length} Cargo test summaries, expected exactly one; preserve the raw command output and inspect whether the target ran.`);
  }
  const [, result, passedText, failedText, ignoredText, measuredText, filteredText] = summaries[0];
  const passed = Number(passedText);
  const failed = Number(failedText);
  const ignored = Number(ignoredText);
  const measured = Number(measuredText);
  const filtered = Number(filteredText);
  if (!Number.isSafeInteger(passed + failed + ignored + measured + filtered)
      || passed + failed === 0) {
    throw new Error(`${suiteName} executed no passing or failing test cases; check its feature gates and target registration instead of counting a compiled binary as coverage.`);
  }
  if (result !== "ok" || failed !== 0) {
    throw new Error(`${suiteName} Cargo result is ${result}: ${passed} passed, ${failed} failed, ${ignored} ignored; repair the failing suite before accepting SVG integration coverage.`);
  }
  return { passed, failed, ignored, measured, filtered, executed: passed + failed };
}

export function assertExecutedCoverage(expectedSvgSuites, completedSuites) {
  const filenames = expectedSvgSuites.map((suite) => suite.endsWith(".rs") ? suite : `${suite}.rs`);
  const svgTargets = assertSvgSuiteCount(filenames);
  const expected = [...svgTargets, "png_contract"];
  if (!Array.isArray(completedSuites) || completedSuites.length !== expected.length
      || new Set(completedSuites).size !== completedSuites.length
      || expected.some((target) => !completedSuites.includes(target))) {
    throw new Error(`Expected completed coverage for ${svgTargets.length} SVG suites plus png_contract; got ${completedSuites?.length ?? 0} unique suite receipts. Re-run the missing target and preserve its Cargo test result.`);
  }
  return { svgSuiteCount: svgTargets.length, pngContractExecuted: true };
}

function discoverSuites(directory = TEST_DIR) {
  let files;
  try {
    files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^svg_.+\.rs$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    throw new Error(`Cannot enumerate SVG integration tests at ${directory}: ${error}; restore the test directory before running the hosted renderer gate.`);
  }
  return assertSvgSuiteCount(files).map((name) => name.replace(/\.rs$/, ""));
}

export function runSvgIntegrationCoverage({ root = ROOT, suites = discoverSuites() } = {}) {
  const svgTargets = assertSvgSuiteCount(suites.map((suite) => suite.endsWith(".rs") ? suite : `${suite}.rs`));
  const targets = [...svgTargets, "png_contract"];
  const receipts = [];
  for (const suite of targets) {
    const result = spawnSync("cargo", [
      "test",
      "--locked",
      "--manifest-path",
      join(root, "src-tauri/crates/Cargo.toml"),
      "-p",
      "maru-diagram-engine",
      "--features",
      "render-svg,render-png,render-outline",
      "--test",
      suite,
      "--",
      "--test-threads=2",
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CARGO_BUILD_JOBS: "2", CARGO_TERM_COLOR: "never" },
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.error) {
      throw new Error(`${suite} could not start Cargo: ${result.error}; install the pinned Rust toolchain and rerun the SVG integration gate.`);
    }
    if (result.status !== 0) {
      throw new Error(`${suite} failed with Cargo exit ${result.status}; inspect the captured test output and fix the failing integration suite before accepting coverage.\n${output}`);
    }
    const summary = parseCargoTestSummary(output, suite);
    receipts.push({ suite, ...summary });
    console.log(`SVG_INTEGRATION_SUITE ${JSON.stringify(receipts.at(-1))}`);
  }
  const coverage = assertExecutedCoverage(svgTargets, receipts.map((receipt) => receipt.suite));
  const testCount = receipts.reduce((sum, receipt) => sum + receipt.executed, 0);
  console.log(`SVG_INTEGRATION_COVERAGE_PASS ${JSON.stringify({ expectedSvgSuites: EXPECTED_SVG_SUITE_COUNT, completedSvgSuites: coverage.svgSuiteCount, pngContractExecuted: coverage.pngContractExecuted, executedTests: testCount })}`);
  return receipts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runSvgIntegrationCoverage();
  } catch (error) {
    console.error(`Hosted SVG integration coverage failed: ${error instanceof Error ? error.message : String(error)}; resolve the stated target-count or test-result gap before accepting the Linux renderer gate.`);
    process.exitCode = 1;
  }
}
