// Compare whole-scene native reports on three OSes and the actual WASM build.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function corpusContract(contents) {
  let corpus;
  try {
    corpus = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Parity corpus JSON is invalid: ${error}; repair the corpus file and rerun the determinism comparison.`);
  }
  if (!corpus || !Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    throw new Error("Parity corpus has no cases; regenerate the corpus before comparing platform reports.");
  }
  const caseIds = corpus.cases.map((item) => item?.id);
  if (caseIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("Parity corpus contains a case without an ID; repair or regenerate the corpus.");
  }
  if (new Set(caseIds).size !== caseIds.length) {
    throw new Error("Parity corpus has duplicate case IDs; assign unique IDs and regenerate the reports.");
  }
  return {
    corpusSha256: createHash("sha256").update(contents).digest("hex"),
    caseCount: caseIds.length,
    caseIds,
  };
}

function validateReport(report, expected, index) {
  const label = `scene report ${index + 1}`;
  if (!report || report.apiVersion !== 1 || report.scope !== "whole-scene-geometry" || report.repeatCheck !== true || !Array.isArray(report.cases)) {
    throw new Error(`${label} is empty or incompatible; regenerate it with the pinned SDK harness.`);
  }
  if (report.corpusSha256 !== expected.corpusSha256) {
    throw new Error(`${label} corpus SHA-256 does not match the checked-in parity corpus; rerun all platform hashes from the same corpus revision.`);
  }
  if (report.corpusCaseCount !== expected.caseCount || report.cases.length !== expected.caseCount) {
    throw new Error(`${label} has ${report.cases.length} case records but the corpus has ${expected.caseCount}; regenerate the complete whole-scene report.`);
  }
  const work = report.benchmarkWork;
  const workValues = work?.stats && [work.stats.astarExpandedStates, work.stats.routeEvaluations, work.stats.constraintEvaluations];
  if (!work || !/^[a-f0-9]{64}$/.test(work.fixtureSha256 ?? "") || work.nodes !== 1000 || work.routes !== 999
      || !Array.isArray(workValues) || workValues.some((n) => !Number.isSafeInteger(n) || n < 0)
      || workValues.some((n) => n === 0) || work.total !== workValues.reduce((sum, n) => sum + n, 0)) {
    throw new Error(`${label} has no valid deterministic1000-node work receipt; rebuild all OS/WASM reports with geometry-corpus before comparing them.`);
  }
  if (report.svgHashVersion !== 1) throw new Error(`${label} has no SVG hash contract; regenerate all native/WASM reports with E3 artifact gates.`);
  for (let caseIndex = 0; caseIndex < expected.caseCount; caseIndex += 1) {
    if (!/^[a-f0-9]{64}$/.test(report.cases[caseIndex]?.hash ?? "")) {
      throw new Error(`${label} case hash is missing or malformed at index ${caseIndex}; regenerate every corpus hash with the SDK harness.`);
    }
    const svg = report.cases[caseIndex].svg;
    if (typeof report.cases[caseIndex].geometryRetained !== "boolean"
        || (svg !== null) !== report.cases[caseIndex].geometryRetained
        || (report.cases[caseIndex].ok === true && !report.cases[caseIndex].geometryRetained)) {
      throw new Error(`${label} omits SVG for retained geometry; regenerate SVG for rejected as well as accepted scene reports.`);
    }
    if (svg !== null && (!svg || ["light", "dark"].some((theme) => !/^[a-f0-9]{64}$/.test(svg[theme]?.hash ?? "")
        || svg[theme].artifactGate !== true || !Number.isSafeInteger(svg[theme].bytes) || svg[theme].bytes <= 0))) {
      throw new Error(`${label} case SVG hash or artifact gate is missing; regenerate both light/dark retained-scene SVG reports.`);
    }
    if (report.cases[caseIndex]?.id !== expected.caseIds[caseIndex]) {
      throw new Error(`${label} case order/IDs differ at index ${caseIndex}; regenerate the report from the current corpus order.`);
    }
  }
}

export const REQUIRED_RECEIPTS = ["native-linux", "native-macos", "native-windows", "wasm-linux"];

export function compareManifests(manifests, expectedCorpus, receiptLabels) {
  if (!Array.isArray(manifests) || manifests.length !== REQUIRED_RECEIPTS.length) {
    throw new Error(`Expected Linux/macOS/Windows native and Linux WASM receipts, found ${manifests?.length ?? 0}; inspect the matrix artifacts and rerun the missing platform or WASM job.`);
  }
  if (!Array.isArray(receiptLabels) || receiptLabels.length !== REQUIRED_RECEIPTS.length
      || new Set(receiptLabels).size !== REQUIRED_RECEIPTS.length
      || REQUIRED_RECEIPTS.some((name) => !receiptLabels.includes(name))) {
    throw new Error("Scene receipt provenance is incomplete; require native-linux, native-macos, native-windows and wasm-linux artifacts before comparing geometry.");
  }
  if (!expectedCorpus || !Number.isSafeInteger(expectedCorpus.caseCount) || expectedCorpus.caseCount <= 0 || !Array.isArray(expectedCorpus.caseIds) || expectedCorpus.caseIds.length !== expectedCorpus.caseCount) {
    throw new Error("Expected corpus identity is missing; load the checked-in parity corpus and rerun the comparison.");
  }
  manifests.forEach((report, index) => validateReport(report, expectedCorpus, index));
  const canonical = JSON.stringify(manifests[0]);
  for (const [index, candidate] of manifests.slice(1).entries()) {
    if (JSON.stringify(candidate) !== canonical) {
      const caseIndex = manifests[0].cases.findIndex((item, itemIndex) => (
        JSON.stringify(item) !== JSON.stringify(candidate.cases[itemIndex])
      ));
      const id = manifests[0].cases[caseIndex]?.id ?? "manifest metadata";
      throw new Error(`Cross-platform engine hashes differ at ${id} (report ${index + 2}); compare fixed arithmetic, font tables and stable ordering, then regenerate all four native/WASM receipts.`);
    }
  }
  return expectedCorpus.caseCount;
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = join(directory, entry.name);
    return entry.isDirectory() ? files(name) : entry.name.endsWith(".json") ? [name] : [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const reportDirectory = resolve(process.argv[2] ?? ".engine-e2/determinism");
  const corpusPath = resolve(process.argv[3] ?? "src-tauri/crates/maru-diagram-engine/testdata/parity.json");
  let contents;
  try {
    contents = readFileSync(corpusPath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read parity corpus ${corpusPath}: ${error}; include the corpus file in this checkout and retry.`);
  }
  const expected = corpusContract(contents);
  let reportFiles;
  try {
    reportFiles = files(reportDirectory).sort();
  } catch (error) {
    throw new Error(`Cannot read platform reports from ${reportDirectory}: ${error}; download all three native and the WASM matrix artifacts and retry.`);
  }
  const labels = reportFiles.map((filename) => filename.split(/[\\/]/).at(-1)?.replace(/\.json$/, ""));
  const reports = reportFiles.map((filename) => {
    try {
      return JSON.parse(readFileSync(filename, "utf8"));
    } catch (error) {
      throw new Error(`Platform report ${filename} is unreadable or invalid JSON: ${error}; rerun the affected platform hash job.`);
    }
  });
  const count = compareManifests(reports, expected, labels);
  console.log(`Engine scene determinism PASS: ${count} corpus scenes/rejections match across native Linux/macOS/Windows and the Linux WASM build, with identical corpus identity and repeat checks.`);
}
