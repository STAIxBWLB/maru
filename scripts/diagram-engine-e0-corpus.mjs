// E0 test oracle/intake only. The SDK crates never import or invoke Archify.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { generatedCases, comparisonFor, seedFor, TYPES, RULE_TABLE, INTENDED_DIFFERENCES } from "./diagram-engine-e1-cases.mjs";
// Raw fixtures deliberately contain invalid field values for rejection probes.
// The loose value type is confined to this host-side mutation boundary.
/** @typedef {Record<string, any>} RawSpec */
/** @typedef {{code:string, message?:string, subject?:{path?:string}, [key:string]:unknown}} OracleDiagnostic */
/** @typedef {{ok:boolean, codes:string[], diagnostics:OracleDiagnostic[], scope?:string, error?:string, inputSha256?:string, strippedFields?:string[]}} OracleReport */
/** @typedef {{kind:string, reasonId?:string, reason?:string}} CurrentScope */
/** @typedef {{inputJson:string, accepted:boolean, equivalentCodes:string[], currentScope:CurrentScope, oracleLayer?:string}} Comparison */
/** @typedef {{id:string, diagramType:string, rule:string, inputJson:string, inputSha256:string, origin:Record<string,any>, expectedCoreOk?:boolean, expectedEngineCode?:string, oracle?:OracleReport, schemaOracle?:OracleReport, validityInputJson?:string, validityOracle?:OracleReport, validitySchemaOracle?:OracleReport, comparison?:Comparison, currentScope?:CurrentScope}} CorpusCase */
/** @typedef {{validateSchema:(type:string,input:RawSpec)=>void}} SchemaFacade */
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Runtime-only foreign test-oracle import. Its source must not become part of
// tsconfig.scripts; the SDK itself imports no oracle or application module.
const schemaModuleUrl = pathToFileURL(join(root, "sidecars/archify/renderers/shared/validator.mjs")).href;
/** @type {SchemaFacade} */
const schemaFacade = await import(schemaModuleUrl);
const validateSchema = schemaFacade.validateSchema;
if (typeof validateSchema !== "function") throw new Error("Pinned schema oracle API is unavailable; check the engine pin and restore validateSchema before retrying.");
const output = join(root, "src-tauri/crates/maru-diagram-engine/testdata");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const privateText = /(?:(?:^|[\s"'(=])\/(?:Users|home|raid|private|tmp)\/|(?:^|[\s"'(])[A-Za-z]:[\\/]|~[\\/]|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i;
const extraPrivateTerms = (process.env.MARU_E0_PRIVATE_TERMS ?? "").split("\n").map((term) => term.trim()).filter(Boolean);
export function hasPrivateText(text, extraTerms = []) {
  return privateText.test(text) || extraTerms.some((term) => text.toLowerCase().includes(term.toLowerCase()));
}
export function withoutRepositoryEvidence(spec, diagramType) {
  const clean = structuredClone(spec);
  if (clean.meta) delete clean.meta.repository;
  const collection = { architecture: "components", workflow: "nodes", sequence: "participants", dataflow: "nodes", lifecycle: "states" }[diagramType];
  for (const node of clean[collection] ?? []) if (node && typeof node === "object") delete node.sources;
  return clean;
}
function sanitize(value, changes, location = "spec") {
  if (typeof value === "string" && hasPrivateText(value, extraPrivateTerms)) {
    changes.push(location); return "source metadata omitted";
  }
  if (Array.isArray(value)) return value.map((item, i) => sanitize(item, changes, `${location}[${i}]`));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, changes, `${location}.${key}`)]));
  return value;
}
export function benchmarkFixture(count) {
  return { schema_version: 1, diagram_type: "architecture", meta: { title: `E0 ${count}-component fixture`, output: `e0-${count}.html` },
    layout: { mode: "grid", cols: 12 }, components: Array.from({ length: count }, (_, i) => ({ id: `node-${i}`, label: `Node ${i + 1}`, type: "backend", row: Math.floor(i / 12), col: i % 12 })),
    connections: Array.from({ length: count - 1 }, (_, i) => ({ from: `node-${i}`, to: `node-${i + 1}` })) };
}
const seed = () => ({ schema_version: 1, diagram_type: "architecture", meta: { title: "E0 synthetic", output: "fixture.html" }, layout: { mode: "grid", cols: 4 }, components: [{ id: "a", label: "A", type: "backend", row: 0, col: 0 }, { id: "b", label: "B", type: "backend", row: 0, col: 1 }], connections: [{ from: "a", to: "b" }] });
/** @param {RawSpec[]} publicCandidates @param {CorpusCase[]} retainedPublicCases @returns {Promise<CorpusCase[]>} */
export async function collectCases(publicCandidates = [], retainedPublicCases = []) {
  /** @type {CorpusCase[]} */
  const cases = [];
  /** @param {string} id @param {string} type @param {string} rule @param {RawSpec|string} spec @param {Record<string,any>} origin @param {boolean} [expectedCoreOk] */
  const add = (id, type, rule, spec, origin, expectedCoreOk) => {
    const changes = [];
    const normalized = sanitize(spec, changes);
    if (normalized?.meta && origin.kind !== "synthetic-generated") {
      normalized.meta.output = `${id}.html`;
    }
    const inputJson = typeof normalized === "string" ? normalized : JSON.stringify(normalized);
    if (hasPrivateText(inputJson, extraPrivateTerms)) throw new Error(`Private content remains in ${id}; synthesize a fixture before adding it`);
    cases.push({ id, diagramType: type, rule, inputJson, inputSha256: digest(inputJson), origin: { ...origin, ...(changes.length ? { sanitizedFields: changes } : {}) }, ...(expectedCoreOk === undefined ? {} : { expectedCoreOk }) });
  };
  // This existing fixture has one extensionless app import. Do not resolve the
  // Floorplan source: its provenance is unverified; use the synthetic substitute below.
  const fixtureSource = readFileSync(join(root, "src/lib/diagram/__fixtures__/semantic.ts"), "utf8")
    .replace(/^import .*FLOORPLAN_FIXTURE.*;$/m, "")
    .replace("floorplan: FLOORPLAN_FIXTURE", "floorplan: {}");
  const fixtureJs = stripTypeScriptTypes(fixtureSource);
  const { SEMANTIC_FIXTURES } = await import(`data:text/javascript;base64,${Buffer.from(fixtureJs).toString("base64")}`);
  for (const [type, spec] of Object.entries(SEMANTIC_FIXTURES)) {
    if (type === "floorplan") {
      // Original provenance is not currently verified PUBLIC; synthesize instead.
      add("app-floorplan-substitute", type, "privacy-substitute", {
        $schema: "floorplan/architecture@1", project: { name: "Synthetic E0 fixture" },
        nodes: [{ id: "root", name: "System", kind: "system" }, { id: "service", name: "Service", kind: "service", parent: "root" }],
        edges: [], flows: [], tours: [],
      }, { kind: "synthetic-generated", source: "privacy substitute for the existing Floorplan fixture" });
    } else add(`app-${type}`, type, "existing-fixture", spec, { kind: "synthetic-existing", source: "src/lib/diagram/__fixtures__/semantic.ts" }, type === "architecture" ? true : undefined);
  }
  const { NATIVE_EXPORT_SPEC } = await import(pathToFileURL(join(root, "src/lib/diagram/__fixtures__/nativeExport.ts")).href);
  add("app-native-export", "architecture", "existing-fixture", NATIVE_EXPORT_SPEC, { kind: "synthetic-existing", source: "src/lib/diagram/__fixtures__/nativeExport.ts" }, true);
  const rust = readFileSync(join(root, "src-tauri/src/archify.rs"), "utf8");
  let literalIndex = 0;
  for (const match of rust.matchAll(/r#"([\s\S]*?)"#;/g)) {
    let spec; try { spec = JSON.parse(match[1]); } catch { continue; }
    if (!spec.diagram_type) continue;
    add(`rust-literal-${++literalIndex}`, spec.diagram_type, "existing-fixture", spec, { kind: "synthetic-existing", source: `src-tauri/src/archify.rs raw JSON fixture ${literalIndex}` });
  }
  for (const [i, source] of publicCandidates.entries()) {
    if (source.visibility !== "PUBLIC") throw new Error("Corpus source visibility was not verified; check it with gh before copying");
    add(`public-${String(i + 1).padStart(2, "0")}`, "architecture", "public-spec", source.spec, { kind: "public", repository: source.repo, sourceUrl: source.sourceUrl, blobSha: source.blobSha, visibility: "PUBLIC" });
  }
  for (const previous of retainedPublicCases) {
    if (previous.origin?.kind !== "public" || previous.origin.visibility !== "PUBLIC"
        || !/^[a-f0-9]{40}$/.test(previous.origin.blobSha ?? "")
        || digest(previous.inputJson) !== previous.inputSha256) {
      throw new Error("Recorded public source provenance/hash is invalid; restore its verified immutable record before regenerating.");
    }
    if (hasPrivateText(previous.inputJson, extraPrivateTerms)) throw new Error("Recorded public source needs redaction; sanitize it before regenerating.");
    cases.push({ id: previous.id, diagramType: previous.diagramType, rule: previous.rule,
      inputJson: previous.inputJson, inputSha256: previous.inputSha256, origin: previous.origin });
  }
  /** @type {Array<[string, string, (spec: ReturnType<typeof seed>) => void, boolean]>} */
  const generated = [
    ["valid", "ids", () => {}, true],
    ["blank-id", "ids", (s) => { s.components[0].id = ""; s.connections = []; }, false],
    ["duplicate-id", "ids", (s) => { s.components[1].id = "a"; s.connections = []; }, false],
    ["invalid-id", "ids", (s) => { s.components[0].id = "Bad Id"; s.connections = []; }, false],
    ["missing-from", "references", (s) => { s.connections[0].from = "absent"; }, false],
    ["missing-to", "references", (s) => { s.connections[0].to = "absent"; }, false],
    ["zero-cols", "grid-bounds", (s) => { s.layout.cols = 0; }, false],
    ["too-many-cols", "grid-bounds", (s) => { s.layout.cols = 13; }, false],
    ["col-outside", "grid-bounds", (s) => { s.components[1].col = 4; }, false],
    ["negative-row", "grid-bounds", (s) => { s.components[0].row = -1; }, false],
  ];
  for (const [id, rule, change, expected] of generated) {
    const spec = seed(); change(spec); add(`generated-${id}`, "architecture", rule, spec, { kind: "synthetic-generated" }, expected);
  }
  for (const generated of generatedCases()) {
    add(generated.id, generated.diagramType, generated.rule, generated.spec, { kind: "synthetic-generated" });
    Object.assign(cases.at(-1), { expectedEngineCode: generated.expectedEngineCode,
      ...(generated.currentScope ? { currentScope: generated.currentScope } : {}) });
  }
  return cases;
}
const cacheFile = join(root, ".engine-e0/oracle-cache.json");
/** @type {Record<string, OracleReport>} */
const oracleCache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
function portableOracleReport(value) {
  return JSON.parse(JSON.stringify(value).split(root).join("<fixture-root>")
    .replace(/\/tmp\/archify-validate-[A-Za-z0-9_-]+/g, "<oracle-staging>"));
}
function oracle(corpusCase) {
  const key = digest(readFileSync(join(root, "sidecars/archify/PIN.json"), "utf8") + corpusCase.diagramType + corpusCase.inputJson);
  if (oracleCache[key]) return portableOracleReport(oracleCache[key]);
  const temp = join(root, ".engine-e0/oracle-input.json"); mkdirSync(join(root, ".engine-e0"), { recursive: true }); writeFileSync(temp, corpusCase.inputJson);
  const result = spawnSync(process.execPath, [join(root, "sidecars/archify/bin/archify.mjs"), "validate", corpusCase.diagramType, temp, "--json"], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
  if (result.error) throw new Error(`Oracle failed for ${corpusCase.id}: ${result.error.message}; check the pinned Node engine`);
  let report; try { report = JSON.parse(result.stdout); } catch { throw new Error(`Oracle returned no JSON for ${corpusCase.id}; inspect the pinned engine`); }
  report = portableOracleReport(JSON.parse(JSON.stringify(report).replaceAll(temp, "oracle-input.json")));
  const receipt = { ...(corpusCase.diagramType === "floorplan" ? { scope: "unsupported-type, not a document validity verdict" } : {}), ok: report.ok === true, codes: (report.diagnostics ?? []).map((d) => d.code ?? "diagnostic"), diagnostics: report.diagnostics ?? [], ...(report.error ? { error: report.error } : {}) };
  oracleCache[key] = receipt;
  writeFileSync(cacheFile, JSON.stringify(oracleCache));
  return receipt;
}

function schemaOracle(corpusCase) {
  if (corpusCase.diagramType === "floorplan") return { ok: false, codes: ["oracle/type-unsupported"], diagnostics: [], scope: "unsupported-type, not a document validity verdict" };
  try {
    validateSchema(corpusCase.diagramType, JSON.parse(corpusCase.inputJson));
    return { ok: true, codes: [], diagnostics: [] };
  } catch (error) {
    const diagnostics = error && typeof error === "object" && "archifyDiagnostics" in error
      ? error.archifyDiagnostics : null;
    if (!Array.isArray(diagnostics)) throw new Error(`Schema oracle failed for ${corpusCase.id}; inspect the pinned schema oracle before retrying.`);
    return { ok: false, codes: diagnostics.map((item) => item.code), diagnostics };
  }
}
async function main() {
  const source = process.argv[2];
  const descriptors = source ? JSON.parse(readFileSync(source, "utf8")) : [];
  // No descriptor argument means refresh already admitted immutable sources,
  // not replace the public corpus with an empty intake list.
  const recorded = !source && existsSync(join(output, "parity.json"))
    ? JSON.parse(readFileSync(join(output, "parity.json"), "utf8")).cases.filter((item) => item.origin?.kind === "public") : [];
  const publicCandidates = [];
  for (const item of descriptors) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.repo) || !/^[a-f0-9]{40}$/.test(item.blobSha)) throw new Error("Invalid public source descriptor; rebuild the intake inventory");
    const visibility = spawnSync("gh", ["repo", "view", item.repo, "--json", "visibility"], { encoding: "utf8", timeout: 30000 });
    if (visibility.status !== 0 || JSON.parse(visibility.stdout).visibility !== "PUBLIC") throw new Error("Corpus source is not verified PUBLIC; omit it or synthesize a fixture");
    const response = spawnSync("gh", ["api", `repos/${item.repo}/git/blobs/${item.blobSha}`], { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    if (response.status !== 0) throw new Error("Public source blob could not be fetched; omit it or retry after checking the immutable source");
    const blob = JSON.parse(response.stdout);
    if (blob.encoding !== "base64" || blob.sha !== item.blobSha) throw new Error("Public source blob identity mismatch; rebuild the inventory");
    const spec = JSON.parse(Buffer.from(blob.content, "base64").toString("utf8"));
    publicCandidates.push({ repo: item.repo, sourceUrl: item.sourceUrl, blobSha: item.blobSha, visibility: "PUBLIC", spec });
  }
  mkdirSync(output, { recursive: true });
  for (const count of [50, 1000]) writeFileSync(join(output, `bench-${count}.json`), `${JSON.stringify(benchmarkFixture(count))}\n`);
  for (const type of TYPES) writeFileSync(join(output, `valid-${type}.json`), `${JSON.stringify(seedFor(type), null, 2)}\n`);
  const cases = await collectCases(publicCandidates, recorded);
  // Fail a bad positive seed before running the full differential inventory.
  for (const type of TYPES) {
    const minimal = cases.find((item) => item.id === `e1-${type}-valid-minimal`);
    if (!minimal) throw new Error(`Synthetic ${type} seed is missing; restore it before generating the corpus.`);
    minimal.oracle = oracle(minimal);
    if (!minimal.oracle.ok) throw new Error(`Synthetic ${type} seed was rejected: ${minimal.oracle.error}; repair the fixture before generating comparisons.`);
  }
  for (const item of cases) {
    item.oracle ??= oracle(item);
    item.schemaOracle = schemaOracle(item);
    if (item.origin.kind === "public") {
      const input = withoutRepositoryEvidence(JSON.parse(item.inputJson), item.diagramType);
      item.validityInputJson = JSON.stringify(input);
      item.validitySchemaOracle = schemaOracle({ ...item, inputJson: item.validityInputJson });
      item.validityOracle = {
        scope: "document validity with machine-bound repository evidence stripped; original input/verdict retained separately",
        inputSha256: digest(JSON.stringify(input)),
        strippedFields: ["meta.repository", "components[].sources"],
        ...oracle({ ...item, inputJson: JSON.stringify(input) }),
      };
    }
    item.comparison = comparisonFor(item);
    item.currentScope = item.comparison.currentScope;
  }
  for (const type of TYPES) {
    const minimal = cases.find((item) => item.id === `e1-${type}-valid-minimal`);
    if (!minimal?.oracle.ok) throw new Error(`Synthetic ${type} seed was rejected by the pinned oracle: ${minimal?.oracle.error ?? "missing case"}; repair the seed before recording corpus results.`);
  }
  const pin = JSON.parse(readFileSync(join(root, "sidecars/archify/PIN.json"), "utf8"));
  if (hasPrivateText(JSON.stringify(cases), extraPrivateTerms)) {
    writeFileSync(join(root, ".engine-e0/private-output.json"), JSON.stringify(cases));
    const fields = [];
    const inspect = (value, path) => { if (typeof value === "string" && hasPrivateText(value, extraPrivateTerms)) fields.push(path); else if (value && typeof value === "object") for (const [key,item] of Object.entries(value)) inspect(item, `${path}/${key}`); };
    for (const item of cases) inspect(item, item.id);
    throw new Error(`Private metadata remains in corpus fields ${fields.slice(0, 4).join(", ")}; sanitize those oracle fields before committing.`);
  }
  writeFileSync(join(output, "parity.json"), `${JSON.stringify({ schemaVersion: 2, oracle: { id: pin.name, version: pin.version, revision: pin.revision }, rules: RULE_TABLE, intendedDifferences: INTENDED_DIFFERENCES, cases }, null, 2)}\n`);
  const { unlinkSync } = await import("node:fs"); unlinkSync(join(root, ".engine-e0/oracle-input.json"));
  console.log(JSON.stringify({ cases: cases.length, byType: Object.fromEntries([...new Set(cases.map((c) => c.diagramType))].map((type) => [type, cases.filter((c) => c.diagramType === type).length])), byRule: Object.fromEntries([...new Set(cases.map((c) => c.rule))].map((rule) => [rule, cases.filter((c) => c.rule === rule).length])) }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
