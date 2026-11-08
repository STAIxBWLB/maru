// Classify the actual emitted ES graph, including Vite-inlined WASM assets.
import { gzipSync } from "node:zlib";
export function payloadReport(chunks) {
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const reachable = new Set();
  function visit(name, visited = reachable) {
    if (visited.has(name)) return;
    const chunk = byName.get(name);
    if (!chunk) throw new Error(`Emitted static chunk ${name} is missing; inspect the Vite library output and rebuild the engine.`);
    visited.add(name);
    for (const dependency of chunk.imports) visit(dependency, visited);
  }
  const entry = chunks.find((chunk) => chunk.isEntry);
  if (!entry) throw new Error("Engine browser entry is missing; rebuild the Vite engine library.");
  visit(entry.fileName);
  const geometry = new Set();
  for (const chunk of chunks.filter((item) => item.name.startsWith("engineGeometry"))) visit(chunk.fileName, geometry);
  const sizes = chunks.map((chunk) => ({ name: chunk.fileName,
    bytes: Buffer.byteLength(chunk.code), gzipBytes: gzipSync(chunk.code, { level: 9 }).length,
    path: reachable.has(chunk.fileName) ? "validation" : geometry.has(chunk.fileName) ? "lazy-geometry-metrics" : "lazy-transport",
  }));
  const sum = (kind) => sizes.filter((item) => item.path === kind).reduce((value, item) => value + item.gzipBytes, 0);
  return { sizes, gzipBytes: sum("validation"), validationGzipBytes: sum("validation"),
    lazyGeometryGzipBytes: sum("lazy-geometry-metrics"), lazyTransportGzipBytes: sum("lazy-transport"),
    totalGzipBytes: sizes.reduce((value, item) => value + item.gzipBytes, 0) };
}
