import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  compareManifests,
  compareSvgParityFixture,
  parseManifest,
  REQUIRED_RECEIPTS,
  REQUIRED_SCENES,
  validateManifest,
} from "./diagram-engine-e3-png-determinism.mjs";

function digest(seed: string) {
  return createHash("sha256").update(seed).digest("hex");
}

function manifest() {
  return {
    schemaVersion: 1,
    scope: "pinned-png-raster-determinism",
    sceneCount: REQUIRED_SCENES.length,
    fontPin: {
      "400": { id: "Noto Sans CJK KR", revision: "metrics-v1", fontSha256: digest("a"), weight: 400 },
      "700": { id: "Noto Sans CJK KR", revision: "metrics-v1", fontSha256: digest("b"), weight: 700 },
    },
    scenes: REQUIRED_SCENES.map((name, index) => ({
      name,
      theme: name.slice(name.lastIndexOf("-") + 1),
      sceneInputSha256: digest(`input-${index}`),
      repeatByteEqual: true,
      pngSha256: digest(`png-${index}`),
      pixelsSha256: digest(`pixels-${index}`),
      svgSha256: digest(`svg-${index}`),
      pngBytes: 1024 + index,
      width: 800,
      height: 600,
    })),
  };
}

describe("E3 PNG determinism manifest", () => {
  it("accepts the complete strict native and WASM receipt set", () => {
    const reports = REQUIRED_RECEIPTS.map(() => manifest());
    expect(compareManifests(reports, REQUIRED_RECEIPTS)).toBe(REQUIRED_SCENES.length);
  });

  it("rejects malformed JSON and incomplete or misordered scene reports", () => {
    expect(() => parseManifest("{" )).toThrow(/not valid JSON/);
    const missing = manifest();
    missing.scenes.pop();
    expect(() => validateManifest(missing, "missing-scene")).toThrow(/scene records/);
    const reordered = manifest();
    [reordered.scenes[0], reordered.scenes[1]] = [reordered.scenes[1], reordered.scenes[0]];
    expect(() => validateManifest(reordered, "reordered-scenes")).toThrow(/canonical fixture\/theme order/);
  });

  it("rejects invalid byte counts, hashes, and same-run PNG repeats", () => {
    const badBytes = manifest();
    badBytes.scenes[0].pngBytes = 0;
    expect(() => validateManifest(badBytes, "bad-bytes")).toThrow(/byte count or dimensions/);
    const badHash = manifest();
    badHash.scenes[0].pngSha256 = "xyz";
    expect(() => validateManifest(badHash, "bad-png-hash")).toThrow(/malformed architecture-light\.pngSha256/);
    const repeat = manifest();
    repeat.scenes[0].repeatByteEqual = false;
    expect(() => validateManifest(repeat, "repeat-mismatch")).toThrow(/did not reproduce identical PNG bytes/);
  });

  it("fails on byte-hash differences without permitting a visual tolerance", () => {
    const reports = REQUIRED_RECEIPTS.map(() => manifest());
    reports[3].scenes[4].pngSha256 = digest("different-png");
    expect(() => compareManifests(reports, REQUIRED_RECEIPTS)).toThrow(/lifecycle-light\.pngSha256.*No image tolerance/);
  });

  it("fails on decoded RGBA pixel differences even when dimensions and PNG byte count match", () => {
    const reports = REQUIRED_RECEIPTS.map(() => manifest());
    reports[1].scenes[10].pixelsSha256 = digest("different-pixels");
    expect(() => compareManifests(reports, REQUIRED_RECEIPTS)).toThrow(/bench-1000-light\.pixelsSha256.*No image tolerance/);
  });

  it("requires complete receipt provenance and identical pinned fonts", () => {
    expect(() => compareManifests([manifest()], ["native-linux"])).toThrow(/Expected four PNG receipts/);
    const reports = REQUIRED_RECEIPTS.map(() => manifest());
    reports[2].fontPin["700"].fontSha256 = digest("wrong-font");
    expect(() => compareManifests(reports, REQUIRED_RECEIPTS)).toThrow(/font identity differs/);
  });
});

describe("native and WASM SVG bytes in PNG artifacts", () => {
  const nativeSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>한글 마루</text></svg>";
  const specJson = "{\"diagram_type\":\"architecture\"}";
  const sceneInputSha256 = createHash("sha256").update(specJson).digest("hex");
  const svgSha256 = createHash("sha256").update(Buffer.from(nativeSvg, "utf8")).digest("hex");
  const fixture = {
    name: "architecture-light",
    sceneInputSha256,
    nativeSvgSha256: svgSha256,
    specJson,
    geometry: { nodes: [], containers: [], routes: [], labels: [], legend: {}, page: {} },
    options: { theme: "light", title: "마루", description: "한글" },
    nativeSvg,
  };
  const manifestScene = {
    name: fixture.name,
    theme: "light",
    sceneInputSha256,
    svgSha256,
  };

  it("accepts exact UTF-8 bytes from the native PNG report and WASM SVG API", () => {
    expect(compareSvgParityFixture(fixture, manifestScene, { apiVersion: 1, ok: true, svg: nativeSvg })).toMatchObject({
      name: fixture.name,
      svgSha256,
      byteEqual: true,
    });
  });

  it("rejects byte changes even when the SVG remains valid text", () => {
    expect(() => compareSvgParityFixture(fixture, manifestScene, {
      apiVersion: 1,
      ok: true,
      svg: nativeSvg.replace("한글", "한국"),
    })).toThrow(/WASM SVG SHA-256.*differs from the native PNG manifest/);
  });

  it("rejects a source or manifest digest mismatch", () => {
    expect(() => compareSvgParityFixture(fixture, { ...manifestScene, sceneInputSha256: digest("other") }, {
      apiVersion: 1,
      ok: true,
      svg: nativeSvg,
    })).toThrow(/does not match the native PNG manifest/);
  });

  it("preserves WASM refusal diagnostics with the actionable fix", () => {
    expect(() => compareSvgParityFixture(fixture, manifestScene, {
      apiVersion: 1,
      ok: false,
      diagnostics: [{ message: "bad geometry", fix: "repair the geometry" }],
    })).toThrow(/bad geometry; fix: repair the geometry/);
  });

  it("rejects incomplete native fixture dumps", () => {
    expect(() => compareSvgParityFixture({ name: fixture.name }, manifestScene, {
      apiVersion: 1,
      ok: true,
      svg: nativeSvg,
    })).toThrow(/missing specJson, retained geometry, SVG options, or nativeSvg/);
  });
});
