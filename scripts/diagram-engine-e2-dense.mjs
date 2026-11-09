// Synthetic-only deterministic geometry stress fixtures. No repository intake,
// host paths, system fonts, current time or platform-dependent randomness.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = "src-tauri/crates/maru-diagram-engine/testdata/dense-scenes.json";
const PARITY = "src-tauri/crates/maru-diagram-engine/testdata/parity.json";
export const DENSE_SEED = 5502026;
export const DENSE_NODE_COUNT = 200;
const LONG_EDGES = 32;
const ADJACENT_EDGES = 16;
const sha = (text) => createHash("sha256").update(text).digest("hex");

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}
function shuffle(values, random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = random() % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
const nodeId = (index) => `n${String(index).padStart(3, "0")}`;
function edgePairs(columns, seed) {
  const random = rng(seed);
  const sources = shuffle(Array.from({ length: 40 }, (_, i) => i), random);
  const targets = shuffle(Array.from({ length: 40 }, (_, i) => DENSE_NODE_COUNT - 40 + i), random);
  const pairs = [];
  for (let i = 0; i < LONG_EDGES; i += 1) {
    const from = sources[i];
    const targetIndex = targets.findIndex((to) => to % columns !== from % columns);
    if (targetIndex < 0) throw new Error("Seeded dense graph cannot find a distinct target column; repair the fixed generator seed.");
    const [to] = targets.splice(targetIndex, 1);
    pairs.push({ id: `long-${i}`, from: nodeId(from), to: nodeId(to), label: `L${i}` });
  }
  const rows = DENSE_NODE_COUNT / columns;
  const adjacent = shuffle(Array.from({ length: rows * (columns - 1) }, (_, i) => i), random).slice(0, ADJACENT_EDGES);
  for (const [index, slot] of adjacent.entries()) {
    const row = Math.floor(slot / (columns - 1));
    const col = slot % (columns - 1);
    const from = row * columns + col;
    pairs.push({ id: `adjacent-${index}`, from: nodeId(from), to: nodeId(from + 1), label: `A${index}` });
  }
  return pairs;
}
function specification(kind, seed) {
  const columns = kind === "architecture" ? 10 : 5;
  const meta = { title: `Seeded dense ${kind}`, output: `dense-${kind}.html` };
  const nodes = Array.from({ length: DENSE_NODE_COUNT }, (_, index) => {
    const shared = { id: nodeId(index), type: ["frontend", "backend", "database"][index % 3], label: `N${index}` };
    const col = index % columns;
    const row = Math.floor(index / columns);
    if (kind === "architecture") return { ...shared, row, col, size: [180, 88] };
    if (kind === "workflow") return { ...shared, lane: `row-${row}`, col, width: 40, height: 40 };
    return { ...shared, stage: col, row, width: 180, height: 88 };
  });
  const edges = edgePairs(columns, seed);
  const common = { schema_version: 1, diagram_type: kind, meta };
  if (kind === "architecture") return { ...common, layout: { mode: "grid", cols: columns, origin: [64, 160], cellW: 180, cellH: 88, gapX: 100, gapY: 112 }, components: nodes, connections: edges };
  if (kind === "workflow") return { ...common, lanes: Array.from({ length: DENSE_NODE_COUNT / columns }, (_, row) => ({ id: `row-${row}`, label: `Row ${row}` })), nodes, edges };
  return { ...common, stages: Array.from({ length: columns }, (_, index) => ({ label: `Stage ${index}` })), nodes, flows: edges };
}
export function generateDenseScenes() {
  return {
    schemaVersion: 1,
    generator: { id: "seeded-e2-dense-v2", seed: DENSE_SEED, nodeCountPerScene: DENSE_NODE_COUNT, longEdgesPerScene: LONG_EDGES, adjacentEdgesPerScene: ADJACENT_EDGES,
      policy: "synthetic non-overlapping source-layout grids; workflow uses40 lanes and40px nodes at legacy column centers; unique-endpoint long cross-edges plus adjacent clear routes; no authored route/port/channel shortcuts" },
    cases: ["architecture", "workflow", "dataflow"].map((kind, index) => ({
      id: `dense-${kind}-seed-${DENSE_SEED + index}`,
      seed: DENSE_SEED + index,
      spec: specification(kind, DENSE_SEED + index),
    })),
  };
}
export function denseContents() { return `${JSON.stringify(generateDenseScenes(), null, 2)}\n`; }

export function combinedCorpus(parityContents, fixtureContents) {
  let parity;
  let dense;
  try { parity = JSON.parse(parityContents); dense = JSON.parse(fixtureContents); }
  catch (error) { throw new Error(`Determinism corpus source is invalid JSON: ${error}; regenerate the dense fixture and repair the base corpus.`); }
  if (!Array.isArray(parity?.cases) || parity.cases.length === 0 || !Array.isArray(dense?.cases) || dense.cases.length !== 3) {
    throw new Error("Determinism corpus sources have missing cases; restore the parity corpus and all three seeded dense scenes.");
  }
  if (parity.boundaryCases !== undefined && !Array.isArray(parity.boundaryCases)) throw new Error("Boundary corpus is not an array; regenerate the geometry evidence before comparing platforms.");
  const cases = [...parity.cases, ...(parity.boundaryCases ?? []), ...dense.cases.map((item) => {
    if (!item || typeof item.id !== "string" || !item.spec || typeof item.spec !== "object" || Array.isArray(item.spec)) {
      throw new Error("Dense scene fixture has a missing ID or spec object; regenerate it from the checked-in seeded generator.");
    }
    const inputJson = JSON.stringify(item.spec);
    return { id: item.id, diagramType: item.spec.diagram_type, inputJson,
      origin: { kind: "synthetic-seeded", source: "scripts/diagram-engine-e2-dense.mjs", seed: item.seed },
      expectedCoreOk: true, comparison: { inputJson, accepted: true } };
  })];
  const ids = cases.map((item) => item?.id);
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) {
    throw new Error("Combined determinism corpus has missing or duplicate IDs; give every base and dense case a unique ID.");
  }
  return `${JSON.stringify({ ...parity, determinismSources: { paritySha256: sha(parityContents), denseSha256: sha(fixtureContents), denseGenerator: dense.generator }, cases }, null, 2)}\n`;
}

function run() {
  const args = process.argv.slice(2);
  const filename = resolve(FIXTURE);
  if (args.length === 1 && args[0] === "--write") {
    writeFileSync(filename, denseContents());
    console.log("Seeded dense geometry fixtures regenerated.");
  } else if (args.length === 1 && args[0] === "--check") {
    if (readFileSync(filename, "utf8") !== denseContents()) throw new Error("Seeded dense fixtures drifted; run node scripts/diagram-engine-e2-dense.mjs --write and commit the regenerated JSON.");
    console.log("Seeded dense geometry fixtures match the generator.");
  } else if (args[0] === "combine" && (args.length === 2 || args.length === 3)) {
    const output = resolve(args.length === 3 ? args[2] : args[1]);
    const parityFile = resolve(args.length === 3 ? args[1] : PARITY);
    const fixture = readFileSync(filename, "utf8");
    if (fixture !== denseContents()) throw new Error("Seeded dense fixtures drifted; regenerate and check them before combining platform inputs.");
    const contents = combinedCorpus(readFileSync(parityFile, "utf8"), fixture);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, contents);
    console.log(`Combined scene corpus: ${JSON.parse(contents).cases.length} cases, SHA256 ${sha(contents)}`);
  } else throw new Error("Unknown dense corpus action; use --write, --check, or combine [parity.json] <output.json>.");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) {
    console.error(`Dense geometry corpus failed: ${error instanceof Error ? error.message : String(error)}; inspect the source files and rerun the seeded generator.`);
    process.exitCode = 1;
  }
}
