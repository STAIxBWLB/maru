// E0 test oracle/intake only. The SDK crates never import or invoke Archify.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = join(root, "src-tauri/crates/maru-diagram-engine/testdata");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const privateText = /(?:(?:^|[\s"'(=])\/(?:Users|home|raid|private|tmp)\/|(?:^|[\s"'(])[A-Za-z]:[\\/]|~[\\/]|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|Young Joon Lee|이영준)/i;
function sanitize(value, changes, location = "spec") {
  if (typeof value === "string" && privateText.test(value)) {
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
export async function collectCases(publicCandidates = []) {
  const cases = [];
  const add = (id, type, rule, spec, origin, expectedCoreOk) => {
    const changes = [];
    const normalized = sanitize(spec, changes);
    if (normalized?.meta) {
      normalized.meta.output = `${id}.html`;
    }
    const inputJson = typeof normalized === "string" ? normalized : JSON.stringify(normalized);
    if (privateText.test(inputJson)) throw new Error(`Private content remains in ${id}; synthesize a fixture before adding it`);
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
  for (const [id, rule, change, expected] of [
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
  ]) { const spec = seed(); change(spec); add(`generated-${id}`, "architecture", rule, spec, { kind: "synthetic-generated" }, expected); }
  return cases;
}
function oracle(corpusCase) {
  const temp = join(root, ".engine-e0/oracle-input.json"); mkdirSync(join(root, ".engine-e0"), { recursive: true }); writeFileSync(temp, corpusCase.inputJson);
  const result = spawnSync(process.execPath, [join(root, "sidecars/archify/bin/archify.mjs"), "validate", corpusCase.diagramType, temp, "--json"], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
  if (result.error) throw new Error(`Oracle failed for ${corpusCase.id}: ${result.error.message}; check the pinned Node engine`);
  let report; try { report = JSON.parse(result.stdout); } catch { throw new Error(`Oracle returned no JSON for ${corpusCase.id}; inspect the pinned engine`); }
  return { ...(corpusCase.diagramType === "floorplan" ? { scope: "unsupported-type, not a document validity verdict" } : {}), ok: report.ok === true, codes: (report.diagnostics ?? []).map((d) => d.code ?? "diagnostic"), diagnostics: report.diagnostics ?? [], ...(report.error ? { error: report.error } : {}) };
}
async function main() {
  const source = process.argv[2];
  const descriptors = source ? JSON.parse(readFileSync(source, "utf8")) : [];
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
  const cases = await collectCases(publicCandidates);
  for (const item of cases) item.oracle = oracle(item);
  const pin = JSON.parse(readFileSync(join(root, "sidecars/archify/PIN.json"), "utf8"));
  if (privateText.test(JSON.stringify(cases))) throw new Error("Private metadata remains in oracle/corpus output; sanitize it before committing");
  writeFileSync(join(output, "parity.json"), `${JSON.stringify({ schemaVersion: 1, oracle: { id: pin.name, version: pin.version, revision: pin.revision }, cases }, null, 2)}\n`);
  const { unlinkSync } = await import("node:fs"); unlinkSync(join(root, ".engine-e0/oracle-input.json"));
  console.log(JSON.stringify({ cases: cases.length, byType: Object.fromEntries([...new Set(cases.map((c) => c.diagramType))].map((type) => [type, cases.filter((c) => c.diagramType === type).length])), byRule: Object.fromEntries([...new Set(cases.map((c) => c.rule))].map((rule) => [rule, cases.filter((c) => c.rule === rule).length])) }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
