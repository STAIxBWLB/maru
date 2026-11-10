import type { EngineReceipt } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import { renderEngineCandidate, verifyRenderedArtifact, type EngineRenderHost } from "./engine";
import { canonicalSemanticExportInput } from "./export";
import type { StaticTheme } from "./engineSvg";
import { serializeDoc } from "./persistence";
import type { DiagramDoc } from "./types";

export interface VerifiedStaticArtifact { bytes: Uint8Array; receipt: EngineReceipt; storeWarning?: string }

export async function bytesSha256(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function receiptDisplayName(value: string): string {
  let result = "";
  let bytes = 0;
  for (const character of value.trim()) {
    if (/\p{Cc}/u.test(character)) continue;
    const width = new TextEncoder().encode(character).length;
    if (bytes + width > 256) break;
    result += character; bytes += width;
  }
  return result || "Untitled diagram";
}

/** Source, renderer gates and final bytes are verified before a save can begin. */
export async function exportVerifiedSemanticArtifact(input: {
  doc: DiagramDoc; datasetId?: string; workspace: string; format: "svg" | "png";
  theme?: StaticTheme; host?: EngineRenderHost; isCurrent?: () => boolean;
  documentName?: string; documentRevision?: string;
}): Promise<VerifiedStaticArtifact> {
  const current = () => {
    if (input.isCurrent?.() === false) throw new Error("The export was cancelled or its document changed; start a new export from the current diagram.");
  };
  current();
  const canonical = canonicalSemanticExportInput(input.doc, input.datasetId);
  const theme = input.theme ?? "light";
  const context = {
    docId: input.doc.id,
    documentName: receiptDisplayName(input.documentName ?? (input.doc.docTitle || input.doc.id)),
    datasetId: canonical.datasetId,
    documentRevision: input.documentRevision ?? await bytesSha256(new TextEncoder().encode(serializeDoc(input.doc))),
    diagramType: canonical.diagramType,
  };
  current();
  const rendered = await (input.host ?? ((type, json, renderContext, options) => renderEngineCandidate(input.workspace, type, json, renderContext, options)))(
    canonical.diagramType, canonical.candidateJson, context,
    { format: input.format, theme, pixelRatio: 1 },
  );
  current();
  const verified = await verifyRenderedArtifact({
    specJson: canonical.candidateJson, format: input.format, theme, pixelRatio: 1, purpose: "export",
  }, rendered);
  current();
  if (!verified.ok || !verified.bytes) {
    const first = verified.diagnostics[0];
    throw new Error(first ? `${first.message} ${first.fix}` : "The diagram engine refused this export; repair the displayed diagnostics and retry.");
  }
  return {
    bytes: new Uint8Array(verified.bytes), receipt: verified.receipt,
    ...(rendered.storeWarning ? { storeWarning: rendered.storeWarning } : {}),
  };
}

/** Isolated measurement compatibility; product exports use the engine facade above. */
export async function exportVerifiedEngineArtifactForTest(input: {
  doc: DiagramDoc;
  datasetId?: string;
  format: "svg" | "png";
  theme?: StaticTheme;
  pixelRatio?: number;
  pinSet?: import("../../../src-tauri/crates/maru-diagram-engine/bindings/engine").PinSet;
  host?: import("./engineArtifactForTest").EngineArtifactHost;
  isCurrent?: () => boolean;
}): Promise<import("./engineArtifactForTest").VerifiedEngineArtifactForTest> {
  if (import.meta.env.VITE_ENGINE_GEOMETRY_TEST !== "1") {
    throw new Error("Native engine artifact export is disabled in this build; use the isolated geometry test build.");
  }
  const { exportVerifiedEngineArtifactForTest: verify } = await import("./engineArtifactForTest");
  return verify(input);
}
