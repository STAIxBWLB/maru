import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BRAND_RAIL_CASES = [
  "e2-boundary-architecture-brand-rail-71",
  "e2-boundary-dataflow-brand-rail-71",
  "e2-boundary-lifecycle-brand-rail-71",
  "e2-boundary-workflow-brand-rail-71",
  "e2-boundary-workflow-brand-rail-73",
];

const ENTITY_FIELD = {
  architecture: "components",
  workflow: "nodes",
  sequence: "participants",
  dataflow: "nodes",
  lifecycle: "states",
};

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function gitRevision(ref) {
  return execFileSync("git", ["rev-parse", ref], { cwd: ROOT, encoding: "utf8" }).trim();
}

function currentIdentity() {
  return {
    engineSourceCommit: gitRevision("HEAD"),
    sdkTreePath: "src-tauri/crates",
    sdkTree: gitRevision("HEAD:src-tauri/crates"),
    engineCrateTreePath: "src-tauri/crates/maru-diagram-engine",
    engineCrateTree: gitRevision("HEAD:src-tauri/crates/maru-diagram-engine"),
  };
}

function caseInput(record, corpusCase) {
  const source = corpusCase.geometryComparison?.inputJson ?? corpusCase.inputJson;
  if (record.source.inputJson !== source) {
    throw new Error(`${record.id}: stored input differs from the pinned comparison source`);
  }
  if (sha256(source) !== record.source.inputSha256) {
    throw new Error(`${record.id}: stored input SHA-256 does not match its exact UTF-8 source`);
  }
  const spec = JSON.parse(source);
  if (stableJson(spec) !== stableJson(record.source.spec)) {
    throw new Error(`${record.id}: parsed source does not match the preserved spec object`);
  }
  if (record.oracle.ok !== corpusCase.oracle.ok) {
    throw new Error(`${record.id}: pinned oracle verdict changed; refusing ledger refresh`);
  }
  return source;
}

function ownedNodeLabels(geometry, node) {
  const prefix = `node:${node.id}:`;
  return geometry.labels.filter((label) => label.targetId === node.id
    && typeof label.id === "string" && label.id.startsWith(prefix));
}

function inkBounds(label) {
  const boxes = (label.glyphs ?? [])
    .filter((glyph) => glyph.ink && glyph.ink.width > 0 && glyph.ink.height > 0)
    .map((glyph) => ({
      left: glyph.ink.x,
      top: glyph.ink.y,
      right: glyph.ink.x + glyph.ink.width,
      bottom: glyph.ink.y + glyph.ink.height,
    }));
  if (boxes.length === 0) return null;
  return {
    x: Math.min(...boxes.map((box) => box.left)),
    y: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

function checkAllNodeTextFits(geometry, caseId) {
  const nodes = new Map(geometry.nodes.map((node) => [node.id, node]));
  const measurements = [];
  for (const node of geometry.nodes) {
    for (const label of ownedNodeLabels(geometry, node)) {
      const ink = inkBounds(label);
      if (!ink) continue;
      const nodeRight = node.bounds.x + node.bounds.width;
      const nodeBottom = node.bounds.y + node.bounds.height;
      const overflow = {
        left: Math.max(0, node.bounds.x - ink.x),
        top: Math.max(0, node.bounds.y - ink.y),
        right: Math.max(0, ink.right - nodeRight),
        bottom: Math.max(0, ink.bottom - nodeBottom),
      };
      const maxOverflow = Math.max(...Object.values(overflow));
      if (maxOverflow !== 0) {
        throw new Error(`${caseId}: emitted Noto ink ${label.id} exceeds retained node ${node.id} by ${JSON.stringify(overflow)} fixed-point ticks`);
      }
      measurements.push({
        nodeId: node.id,
        labelId: label.id,
        text: label.text,
        font: label.font,
        fontSize: label.fontSize,
        nodeBounds: node.bounds,
        labelBounds: label.bounds,
        inkBounds: { x: ink.x, y: ink.y, width: ink.right - ink.x, height: ink.bottom - ink.y },
        overflow,
      });
    }
  }
  const source = JSON.parse(caseInputForGeometry(caseId));
  const field = ENTITY_FIELD[source.diagram_type];
  const first = source[field]?.[0];
  if (!first || typeof first.id !== "string") {
    throw new Error(`${caseId}: cannot identify the source brand-rail node`);
  }
  const node = nodes.get(first.id);
  const brandLabel = geometry.labels.find((label) => label.targetId === first.id
    && label.id === `node:${first.id}:label` && label.text === first.label);
  if (!node || !brandLabel) {
    throw new Error(`${caseId}: current geometry omitted the source brand-rail node or its primary label`);
  }
  const brandInk = inkBounds(brandLabel);
  if (!brandInk) throw new Error(`${caseId}: current brand label has no positioned glyph ink`);
  return {
    unitsPerPixel: 64,
    allNodeLabelsChecked: measurements.length,
    primaryLabel: {
      nodeId: node.id,
      labelId: brandLabel.id,
      text: brandLabel.text,
      font: brandLabel.font,
      fontSize: brandLabel.fontSize,
      nodeBounds: node.bounds,
      labelBounds: brandLabel.bounds,
      inkBounds: { x: brandInk.x, y: brandInk.y, width: brandInk.right - brandInk.x, height: brandInk.bottom - brandInk.y },
      overflow: { left: 0, top: 0, right: 0, bottom: 0 },
    },
  };
}

let geometryInputByCase = new Map();
function caseInputForGeometry(id) {
  const input = geometryInputByCase.get(id);
  if (!input) throw new Error(`${id}: missing pinned input during text-fit verification`);
  return input;
}

function verifyNativeCase(nativeReport, id, wasmReport) {
  if (!nativeReport) return;
  const rows = nativeReport.cases ?? nativeReport.records ?? nativeReport.results;
  if (!Array.isArray(rows)) throw new Error("Native corpus report has no cases/records/results array");
  const row = rows.find((candidate) => candidate?.id === id);
  if (!row) throw new Error(`Native corpus report is missing refreshed case ${id}`);
  const accepted = typeof row.ok === "boolean" ? row.ok
    : typeof row.accepted === "boolean" ? row.accepted
      : typeof row.engineAccepted === "boolean" ? row.engineAccepted : undefined;
  if (typeof accepted !== "boolean" || accepted !== wasmReport.ok) {
    throw new Error(`${id}: native corpus acceptance does not match the WASM layout result`);
  }
  const nativeCodes = Array.isArray(row.diagnosticCodes) ? row.diagnosticCodes
    : Array.isArray(row.codes) ? row.codes
    : Array.isArray(row.diagnostics) ? row.diagnostics.map((diagnostic) => diagnostic.code) : undefined;
  if (nativeCodes) {
    const sorted = (codes) => [...codes].sort();
    const wasmCodes = wasmReport.diagnostics.map((diagnostic) => diagnostic.code);
    if (stableJson(sorted(nativeCodes)) !== stableJson(sorted(wasmCodes))) {
      throw new Error(`${id}: native corpus diagnostic codes differ from the WASM layout result`);
    }
  }
  if (row.geometry !== undefined && stableJson(row.geometry) !== stableJson(wasmReport.geometry)) {
    throw new Error(`${id}: native corpus geometry differs from the WASM layout result`);
  }
}

function preserveHistoricalEvidence(record, sourceIdentity) {
  if (record.historicalEvidence) return record.historicalEvidence;
  if (record.engine?.accepted !== false || record.disposition?.status !== "fixed-by-role-budget") {
    throw new Error(`${record.id}: original brand-rail snapshot is not the expected refused role-budget record`);
  }
  return {
    engineSourceCommit: record.engineSourceCommit ?? sourceIdentity.engineSourceCommit,
    sdkTreePath: record.sdkTreePath ?? sourceIdentity.sdkTreePath,
    sdkTree: record.sdkTree ?? sourceIdentity.sdkTree,
    engineCrateTreePath: record.engineCrateTreePath ?? sourceIdentity.engineCrateTreePath,
    engineCrateTree: record.engineCrateTree ?? sourceIdentity.engineCrateTree,
    currentMismatch: record.currentMismatch,
    engine: record.engine,
    disposition: record.disposition,
    numericGeometryEvidence: record.numericGeometryEvidence,
  };
}

function refreshLedger(ledger, corpus, reports, identity, nativeReport) {
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.records)) {
    throw new Error("Admission ledger schema is incompatible; preserve the original and repair the host script");
  }
  const corpusCases = new Map([...corpus.cases, ...corpus.boundaryCases].map((row) => [row.id, row]));
  const rows = new Map(ledger.records.map((row) => [row.id, row]));
  if (rows.size !== ledger.records.length) throw new Error("Admission ledger contains duplicate case ids");
  const baselineIdentity = {
    engineSourceCommit: ledger.sourceScope?.preservedSourceCommit ?? ledger.sourceCommit,
    sdkTreePath: ledger.sourceScope?.preservedSdkTreePath ?? ledger.sdkTreePath,
    sdkTree: ledger.sourceScope?.preservedSdkTree ?? ledger.sdkTree,
    engineCrateTreePath: ledger.sourceScope?.preservedEngineCrateTreePath ?? ledger.engineCrateTreePath,
    engineCrateTree: ledger.sourceScope?.preservedEngineCrateTree ?? ledger.engineCrateTree,
  };

  const updated = ledger.records.map((record) => {
    if (!BRAND_RAIL_CASES.includes(record.id)) {
      return {
        ...record,
        engineSourceCommit: record.engineSourceCommit ?? baselineIdentity.engineSourceCommit,
        sdkTreePath: record.sdkTreePath ?? baselineIdentity.sdkTreePath,
        sdkTree: record.sdkTree ?? baselineIdentity.sdkTree,
        engineCrateTreePath: record.engineCrateTreePath ?? baselineIdentity.engineCrateTreePath,
        engineCrateTree: record.engineCrateTree ?? baselineIdentity.engineCrateTree,
        engineEvidenceScope: record.engineEvidenceScope ?? "preserved-source-stamped-model-record",
      };
    }
    const sourceCase = corpusCases.get(record.id);
    if (!sourceCase) throw new Error(`${record.id}: missing from pinned parity corpus`);
    const specJson = caseInput(record, sourceCase);
    geometryInputByCase.set(record.id, specJson);
    const report = reports.get(record.id);
    if (!report || report.apiVersion !== 1 || !report.geometry || !Array.isArray(report.diagnostics)) {
      throw new Error(`${record.id}: WASM returned an incomplete E2 geometry report`);
    }
    if (!report.ok) throw new Error(`${record.id}: expected the current emitted-ink fit to accept the brand-rail scene; got ${JSON.stringify(report.diagnostics)}`);
    verifyNativeCase(nativeReport, record.id, report);
    const historicalEvidence = preserveHistoricalEvidence(record, baselineIdentity);
    const numericGeometryEvidence = checkAllNodeTextFits(report.geometry, record.id);
    return {
      ...record,
      currentMismatch: record.oracle.ok !== report.ok,
      engineSourceCommit: identity.engineSourceCommit,
      sdkTreePath: identity.sdkTreePath,
      sdkTree: identity.sdkTree,
      engineCrateTreePath: identity.engineCrateTreePath,
      engineCrateTree: identity.engineCrateTree,
      engineEvidenceScope: nativeReport ? "current-wasm-layout-with-native-acceptance-cross-check" : "current-wasm-layout",
      engine: {
        accepted: report.ok,
        geometry: report.geometry,
        diagnostics: report.diagnostics,
      },
      historicalEvidence,
      numericGeometryEvidence,
      disposition: {
        status: "intentional-noto-ink-fit-model-difference",
        reason: `The pinned source brand rail refuses this node-width threshold, while current Noto ${numericGeometryEvidence.primaryLabel.fontSize / 64}px glyph ink for ${JSON.stringify(numericGeometryEvidence.primaryLabel.text)} lies within the retained node bounds (0px overflow). The original source verdict remains preserved; this is an intentional renderer-model difference, not a role-budget fix.`,
      },
    };
  });

  const mismatches = updated.filter((row) => row.currentMismatch).length;
  const statusCounts = Object.fromEntries(
    [...new Set(updated.map((row) => row.disposition.status))]
      .sort()
      .map((status) => [status, updated.filter((row) => row.disposition.status === status).length]),
  );
  const fixedStatusCounts = Object.fromEntries(Object.entries(statusCounts).filter(([status]) => status.startsWith("fixed-")));
  const sourceScope = {
    kind: "mixed-per-record-engine-snapshots",
    refreshedCaseIds: [...BRAND_RAIL_CASES],
    refreshedSourceCommit: identity.engineSourceCommit,
    refreshedSdkTreePath: identity.sdkTreePath,
    refreshedSdkTree: identity.sdkTree,
    refreshedEngineCrateTreePath: identity.engineCrateTreePath,
    refreshedEngineCrateTree: identity.engineCrateTree,
    preservedSourceCommit: baselineIdentity.engineSourceCommit,
    preservedSdkTreePath: baselineIdentity.sdkTreePath,
    preservedSdkTree: baselineIdentity.sdkTree,
    preservedEngineCrateTreePath: baselineIdentity.engineCrateTreePath,
    preservedEngineCrateTree: baselineIdentity.engineCrateTree,
    preservedCaseCount: updated.length - BRAND_RAIL_CASES.length,
    nativeCorpusReportSha256: nativeReport ? sha256(stableJson(nativeReport)) : null,
  };
  const counts = {
    ...ledger.counts,
    unionCases: updated.length,
    currentMismatches: mismatches,
    currentAgreementsWithinUnion: updated.length - mismatches,
    fixedCases: updated.filter((row) => row.disposition.status.startsWith("fixed-")).length,
    fixedStatusCounts,
    statusCounts,
  };
  const output = {
    ...ledger,
    sourceCommit: identity.engineSourceCommit,
    sdkTreePath: identity.sdkTreePath,
    sdkTree: identity.sdkTree,
    engineCrateTreePath: identity.engineCrateTreePath,
    engineCrateTree: identity.engineCrateTree,
    sourceScope,
    counts,
    records: updated,
  };
  geometryInputByCase = new Map();
  return output;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag.startsWith("--") || index + 1 >= args.length) throw new Error(`Expected a value after ${flag}`);
    options[flag.slice(2)] = args[++index];
  }
  for (const required of ["wasm-bindings", "ledger", "output"]) {
    if (!options[required]) throw new Error(`Missing --${required}`);
  }
  return options;
}

export function refreshAdmissionLedger(ledger, corpus, reports, identity, nativeReport = null) {
  return refreshLedger(ledger, corpus, reports, identity, nativeReport);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bindingDir = resolve(ROOT, options["wasm-bindings"]);
  const ledgerPath = resolve(ROOT, options.ledger);
  const outputPath = resolve(ROOT, options.output);
  const jsBinding = join(bindingDir, "maru_diagram_engine.js");
  const wasmBinding = join(bindingDir, "maru_diagram_engine_bg.wasm");
  if (!existsSync(jsBinding) || !existsSync(wasmBinding)) {
    throw new Error(`Generated WASM bindings not found in ${bindingDir}; pass a completed bindgen-web directory`);
  }
  const bindings = await import(pathToFileURL(jsBinding).href);
  if (typeof bindings.default !== "function" || typeof bindings.layout_json !== "function") {
    throw new Error("Generated WASM module is missing initialization or layout_json; rebuild wasm-layout bindings");
  }
  await bindings.default({ module_or_path: new Uint8Array(readFileSync(wasmBinding)) });

  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const corpus = JSON.parse(readFileSync(join(ROOT, "src-tauri/crates/maru-diagram-engine/testdata/parity.json"), "utf8"));
  const nativeReport = options["native-corpus-report"]
    ? JSON.parse(readFileSync(resolve(ROOT, options["native-corpus-report"]), "utf8"))
    : null;
  if (nativeReport) {
    const identity = currentIdentity();
    for (const [field, actual] of [["sourceCommit", identity.engineSourceCommit], ["sdkTree", identity.sdkTree], ["engineCrateTree", identity.engineCrateTree]]) {
      if (nativeReport[field] !== undefined && nativeReport[field] !== actual) {
        throw new Error(`Native corpus report ${field} does not match the current committed engine source`);
      }
    }
  }
  const reports = new Map();
  const corpusCases = new Map([...corpus.cases, ...corpus.boundaryCases].map((row) => [row.id, row]));
  for (const id of BRAND_RAIL_CASES) {
    const record = ledger.records.find((row) => row.id === id);
    const sourceCase = corpusCases.get(id);
    if (!record || !sourceCase) throw new Error(`${id}: missing ledger or pinned corpus record`);
    const specJson = caseInput(record, sourceCase);
    const raw = bindings.layout_json(JSON.stringify({ specJson }));
    if (typeof raw !== "string") throw new Error(`${id}: WASM layout_json did not return JSON text`);
    reports.set(id, JSON.parse(raw));
  }
  const output = refreshAdmissionLedger(ledger, corpus, reports, currentIdentity(), nativeReport);
  const temporary = `${outputPath}.tmp-${process.pid}`;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(output, null, 2)}\n`);
  renameSync(temporary, outputPath);
  console.log(`ENGINE_E2_ADMISSION_REFRESH ${JSON.stringify({
    sourceCommit: output.sourceCommit,
    sdkTree: output.sdkTree,
    unionCases: output.counts.unionCases,
    currentMismatches: output.counts.currentMismatches,
    refreshedCaseIds: BRAND_RAIL_CASES,
    output: outputPath,
  })}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(`Admission ledger refresh failed: ${error instanceof Error ? error.message : String(error)}; preserve the prior ledger and refresh only after a completed native/WASM run.`);
    process.exitCode = 1;
  }
}
