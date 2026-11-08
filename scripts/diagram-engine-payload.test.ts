import { expect, it } from "vitest";
import { payloadReport } from "./diagram-engine-payload.mjs";
it("accounts for static validation dependencies separately from lazy metric and transport assets", () => {
  const result = payloadReport([
    { fileName: "entry.js", name: "engine", code: "entry", isEntry: true, imports: ["shared.js"] },
    { fileName: "shared.js", name: "shared", code: "static", imports: [] },
    { fileName: "geometry.js", name: "engineGeometry", code: "font tables", imports: ["metrics.js"] },
    { fileName: "metrics.js", name: "metrics", code: "helper", imports: [] },
    { fileName: "ipc.js", name: "core", code: "transport", imports: [] },
  ]);
  expect(result.sizes.map((item) => item.path)).toEqual(["validation", "validation", "lazy-geometry-metrics", "lazy-geometry-metrics", "lazy-transport"]);
  expect(result.gzipBytes).toBe(result.validationGzipBytes);
  expect(result.totalGzipBytes).toBe(result.validationGzipBytes + result.lazyGeometryGzipBytes + result.lazyTransportGzipBytes);
});
