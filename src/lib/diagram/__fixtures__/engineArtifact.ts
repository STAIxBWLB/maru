import { createHash } from "node:crypto";
import type { EngineReceipt } from "../../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import type { EngineRenderedCandidate } from "../engine";

type Format = "svg" | "png";

/** Test-only internally consistent host report; it does not claim native or pixel-renderer proof. */
export function makeEngineArtifactFixture(input: {
  specJson: string;
  format: Format;
  theme?: "light" | "dark";
  pixelRatio?: number;
  svg?: string;
  bytes?: Uint8Array | number[];
  width?: number;
  height?: number;
  textMode?: "text" | "outlines";
  receiptOverrides?: Partial<EngineReceipt>;
  storeWarning?: string | null;
}): EngineRenderedCandidate {
  const theme = input.theme ?? "light";
  const pixelRatio = input.pixelRatio ?? 1;
  const svg = input.svg ?? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600"><title>Fixture export</title><desc>Mock outlined artifact</desc><path aria-label="한日中" d="M10 10h30v30H10z"/></svg>';
  const svgBytes = new TextEncoder().encode(svg);
  const bytes = input.bytes instanceof Uint8Array
    ? [...input.bytes]
    : input.bytes ?? (input.format === "svg" ? [...svgBytes] : [137, 80, 78, 71, 13, 10, 26, 10]);
  const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const hashBytes = (value: number[]) => sha256(new Uint8Array(value));
  const source = JSON.parse(input.specJson) as { diagram_type?: unknown };
  const receipt: EngineReceipt = {
    schemaVersion: 1,
    inputSpecSha256: sha256(new TextEncoder().encode(input.specJson)),
    engine: { id: "maru-diagram-engine", version: "0.1.0-fixture", revision: "fixture" },
    engineOutputSha256: sha256(svgBytes),
    conversion: { format: input.format, theme, pixelRatio },
    outputSha256: hashBytes(bytes),
    outputMimeType: input.format === "svg" ? "image/svg+xml" : "image/png",
    gates: {
      schema: { status: "passed", scope: `${String(source.diagram_type)}-document-validity` },
      artifact: { status: "passed", scope: input.format === "svg" ? "independent-svg-artifact" : "independent-svg-and-png-artifacts" },
      browser: { status: "not-run", scope: "non-browser-rasterization" },
      visualReview: { status: "not-run", scope: "manual" },
    },
    readback: { status: "not-run", scope: "saved-file-byte-comparison" },
  };
  return {
    apiVersion: 1,
    ok: true,
    bytes,
    svg,
    width: input.width ?? 800 * pixelRatio,
    height: input.height ?? 600 * pixelRatio,
    diagnostics: [],
    receipt: { ...receipt, ...input.receiptOverrides },
    textMode: input.textMode ?? (input.format === "svg" ? "outlines" : "text"),
    ...(input.storeWarning !== undefined ? { storeWarning: input.storeWarning } : {}),
  };
}
