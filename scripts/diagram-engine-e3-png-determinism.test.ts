import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  compareManifests,
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
