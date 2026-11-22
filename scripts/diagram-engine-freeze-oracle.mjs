// E6 T1 (maru#554): freeze the pinned Archify oracle verdicts into the corpus.
//
// The differential tests already read every verdict from parity.json; this
// script is the reproducible proof that those recorded verdicts are exactly
// what the pinned sidecar returns, and it stamps which oracle produced them.
//
//   node scripts/diagram-engine-freeze-oracle.mjs --write   # record from the pinned sidecar
//   node scripts/diagram-engine-freeze-oracle.mjs --check   # fail if any recorded verdict differs
//
// Both modes rerun the CLI oracle uncached for every case. --write changes
// only oracle-produced fields (the verdicts, `frozenOracle` and each case's
// `label`); nothing here is hand-edited. After E6 T2 removes the sidecar the
// recorded verdicts are the oracle, and new cases carry
// `label: {source: "maru-engine", reviewedIn: "<PR>"}` instead.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { documentOracle, oracle, schemaOracle } from "./diagram-engine-e0-corpus.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const corpusPath = join(root, "src-tauri/crates/maru-diagram-engine/testdata/parity.json");
const pinPath = join(root, "sidecars/archify/PIN.json");
export const FREEZE_COMMAND = "node scripts/diagram-engine-freeze-oracle.mjs --write";
export const ORACLE_LABEL = { source: "archify-oracle" };

/** The verdict fields one case records, recomputed from the live oracle.
 * @param {any} item */
export function liveVerdicts(item) {
  const fields = { oracle: oracle(item, { useCache: false }) };
  fields.schemaOracle = schemaOracle(item);
  fields.documentOracle = documentOracle(item, fields.schemaOracle);
  if (item.validityInputJson !== undefined) {
    const stripped = { ...item, inputJson: item.validityInputJson };
    fields.validitySchemaOracle = schemaOracle(stripped);
    fields.validityDocumentOracle = documentOracle(stripped, fields.validitySchemaOracle);
    // The validity envelope keeps its recorded provenance keys; only the
    // oracle verdict inside it is recomputed.
    const { ok, codes, diagnostics, error, ...provenance } = item.validityOracle ?? {};
    fields.validityOracle = { ...provenance, ...oracle(stripped, { useCache: false }) };
  }
  return fields;
}

/** Names the fields of `item` whose recorded verdict differs from `live`.
 * @param {any} item @param {Record<string, unknown>} live */
export function verdictDifferences(item, live) {
  return Object.entries(live)
    .filter(([field, value]) => !isDeepStrictEqual(item[field], value))
    .map(([field]) => field);
}

function frozenOracleBlock() {
  const pinText = readFileSync(pinPath, "utf8");
  const pin = JSON.parse(pinText);
  return {
    id: pin.name,
    version: pin.version,
    revision: pin.revision,
    pinSha256: createHash("sha256").update(pinText).digest("hex"),
    command: FREEZE_COMMAND,
    note: "Verdicts recorded from the pinned sidecar; cases labelled maru-engine were added after E6 and reviewed in the named PR.",
  };
}

function main() {
  const mode = process.argv[2];
  if (mode !== "--check" && mode !== "--write") {
    console.error("diagram-engine-freeze-oracle: mode required: --check or --write");
    console.error("Usage: node scripts/diagram-engine-freeze-oracle.mjs --check|--write");
    process.exit(2);
  }
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  const expectedBlock = frozenOracleBlock();
  const failures = [];
  if (mode === "--check" && !isDeepStrictEqual(corpus.frozenOracle, expectedBlock)) {
    failures.push(`frozenOracle does not match sidecars/archify/PIN.json; run ${FREEZE_COMMAND}`);
  }
  let checked = 0;
  for (const item of [...corpus.cases, ...corpus.boundaryCases]) {
    const label = item.label ?? ORACLE_LABEL;
    if (label.source !== "archify-oracle") continue; // engine-labelled: no oracle to ask
    const live = liveVerdicts(item);
    checked += 1;
    if (mode === "--write") {
      Object.assign(item, live, { label: ORACLE_LABEL });
      continue;
    }
    if (!item.label) failures.push(`${item.id}: no label; run ${FREEZE_COMMAND}`);
    const differences = verdictDifferences(item, live);
    if (differences.length) failures.push(`${item.id}: recorded ${differences.join(", ")} differs from the pinned oracle`);
  }
  if (mode === "--write") {
    corpus.frozenOracle = expectedBlock;
    writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`);
    console.log(`diagram-engine-freeze-oracle: recorded ${checked} oracle verdict sets into parity.json`);
    return;
  }
  if (failures.length) {
    console.error(`diagram-engine-freeze-oracle: ${failures.length} frozen verdict(s) differ from the pinned oracle`);
    for (const failure of failures.filter((f) => !f.includes("no label")).slice(0, 20)) console.error(`  ${failure}`);
    console.error(`  -> inspect the oracle change, then run ${FREEZE_COMMAND}`);
    process.exit(1);
  }
  console.log(`diagram-engine-freeze-oracle: ${checked} frozen verdict sets equal the pinned oracle`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
