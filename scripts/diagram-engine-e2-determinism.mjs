// Compare canonical reports emitted by the pure SDK on every required OS.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function compareManifests(manifests) {
  if (manifests.length !== 3) throw new Error(`Expected Linux/macOS/Windows receipts, found ${manifests.length}; inspect the matrix artifacts and rerun the missing platform.`);
  const baseline = manifests[0];
  if (!baseline || baseline.apiVersion !== 1 || !Array.isArray(baseline.cases) || baseline.cases.length === 0)
    throw new Error("Determinism receipt is empty/incompatible; regenerate it with the pinned SDK harness.");
  const canonical = JSON.stringify(baseline);
  for (const candidate of manifests.slice(1)) {
    if (JSON.stringify(candidate) !== canonical) {
      const index = baseline.cases.findIndex((item, i) => JSON.stringify(item) !== JSON.stringify(candidate?.cases?.[i]));
      const id = baseline.cases[index]?.id ?? "manifest metadata";
      throw new Error(`Cross-platform engine hashes differ at ${id}; compare the fixed arithmetic, font tables and stable ordering, then regenerate all three receipts.`);
    }
  }
  return baseline.cases.length;
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = join(directory, entry.name);
    return entry.isDirectory() ? files(name) : entry.name.endsWith(".json") ? [name] : [];
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = files(resolve(process.argv[2] ?? ".engine-e2/determinism"));
  const count = compareManifests(paths.sort().map((filename) => JSON.parse(readFileSync(filename, "utf8"))));
  console.log(`Engine foundation determinism PASS: ${count} corpus metric/fixed-arithmetic records identical across all three platforms; scene geometry is not covered in S1.`);
}
