import { name, version, revision } from "../../../sidecars/archify/PIN.json";
import { archifyRenderCandidate, type ArchifyRenderHost, type ArchifyRenderReceipt } from "../archify";
import { canonicalSemanticExportInput, rasterise, blobToUint8Array } from "./export";
import { extractEngineSvg, type StaticTheme } from "./engineSvg";
import type { DiagramDoc } from "./types";

export interface VerifiedStaticArtifact { bytes: Uint8Array; receipt: ArchifyRenderReceipt }

export async function bytesSha256(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A cancelled or semantically changed document can never reach the save bridge. */
export async function exportVerifiedSemanticArtifact(input: {
  doc: DiagramDoc; datasetId?: string; workspace: string; format: "svg" | "png";
  theme?: StaticTheme; host?: ArchifyRenderHost; isCurrent?: () => boolean;
}): Promise<VerifiedStaticArtifact> {
  const current = () => {
    if (input.isCurrent?.() === false) throw new Error("The export was cancelled or its document changed; start a new export from the current diagram.");
  };
  current();
  const canonical = canonicalSemanticExportInput(input.doc, input.datasetId);
  const candidateHash = await bytesSha256(new TextEncoder().encode(canonical.candidateJson));
  current();
  const rendered = await (input.host ?? ((type, json) => archifyRenderCandidate(input.workspace, type, json)))(canonical.diagramType, canonical.candidateJson);
  current();
  if (!rendered || !Array.isArray(rendered.bytes) || rendered.bytes.length > 8 * 1024 * 1024
      || rendered.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("The renderer returned invalid artifact bytes; update Maru and retry the export.");
  }
  const engineBytes = new Uint8Array(rendered.bytes);
  const receipt = rendered.receipt;
  if (receipt?.schemaVersion !== 1 || receipt.inputSpecSha256 !== candidateHash
      || receipt.enginePin?.name !== name || receipt.enginePin?.version !== version || receipt.enginePin?.revision !== revision
      || receipt.gates?.schema?.status !== "passed" || receipt.gates?.schema?.scope !== "pinned-engine-validation"
      || receipt.gates?.artifact?.status !== "passed" || receipt.gates?.artifact?.scope !== "pinned-engine-rendered-html"
      || receipt.outputSha256 !== await bytesSha256(engineBytes) || receipt.outputMimeType !== "text/html") {
    throw new Error("The engine receipt does not match this spec, pin or artifact; regenerate the export with the current Maru bundle.");
  }
  current();
  let html: string;
  try { html = new TextDecoder("utf-8", { fatal: true }).decode(engineBytes); } catch {
    throw new Error("The engine artifact is not valid UTF-8; regenerate it with the current Maru bundle and retry.");
  }
  const svg = extractEngineSvg(html, input.theme);
  let bytes: Uint8Array;
  if (input.format === "png") {
    const element = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
    const renderedPng = await rasterise(element as unknown as SVGSVGElement, "image/png", null, 1, 1);
    bytes = await blobToUint8Array(renderedPng.blob);
  } else bytes = new TextEncoder().encode(svg);
  const hash = await bytesSha256(bytes);
  current();
  return {
    bytes,
    receipt: {
      schemaVersion: 1, inputSpecSha256: receipt.inputSpecSha256,
      enginePin: { name, version, revision },
      engineOutputSha256: receipt.outputSha256, outputSha256: hash,
      outputMimeType: input.format === "svg" ? "image/svg+xml" : "image/png",
      conversion: { format: input.format, theme: input.theme ?? "light", pixelRatio: 1 },
      gates: { schema: { status: "passed", scope: "pinned-engine-validation" }, artifact: { status: "passed", scope: "pinned-engine-rendered-html" }, browser: { status: "passed", scope: input.format === "png" ? "sanitized-svg-to-platform-canvas-png" : "domparser-and-svg-profile-sanitization" }, visualReview: { status: "not-run", scope: "manual-visual-review" } },
      readback: { status: "not-run", scope: "saved-file-byte-comparison" },
    },
  };
}
