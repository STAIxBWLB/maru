import { invoke } from "@tauri-apps/api/core";
import type { ArchifyRenderReceipt } from "../archify";
import { readDiagramDetailed } from "./persistence";
import { canonicalSemanticExportInput } from "./export";
import { archifyRenderCandidate } from "../archify";
import { openInFileManager, revealInFileManager } from "../api";

export interface RenderDocumentContext {
  docId: string;
  documentName: string;
  documentRevision: string;
  diagramType: string;
  datasetId?: string | null;
}
export interface RenderReceipt extends ArchifyRenderReceipt, RenderDocumentContext {
  renderedAt: string;
}
export interface StoredRender {
  docId: string;
  renderId: string;
  receipt?: RenderReceipt | null;
  verified: boolean;
  diagnostic?: string | null;
  artifactName?: string | null;
}
export interface RenderGroup {
  /** Filesystem-safe bucket key; the original document identity stays in the receipt. */
  docId: string;
  originalDocId?: string | null;
  documentName?: string | null;
  orphaned: boolean;
  ambiguous?: boolean;
  diagnostic?: string | null;
  renders: StoredRender[];
}
export interface RenderView { path: string; mimeType: string; receipt: RenderReceipt }

export function rendersAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}
function requireDesktop(): void {
  if (!rendersAvailable()) throw new Error("Saved renders require the desktop app; open this workspace in Maru.");
}
export async function listRenders(workspace: string): Promise<RenderGroup[]> {
  requireDesktop();
  return invoke("diagram_list_renders", { workspace });
}
export async function prepareRenderView(workspace: string, docId: string, renderId: string): Promise<RenderView> {
  requireDesktop();
  return invoke("diagram_prepare_render_view", { workspace, docId, renderId });
}
export async function deleteRender(workspace: string, docId: string, renderId: string): Promise<void> {
  requireDesktop();
  return invoke("diagram_delete_render", { workspace, docId, renderId });
}
/** Re-check immediately before launching/revealing a stored artifact too. */
export async function openRender(workspace: string, render: StoredRender, reveal = false): Promise<void> {
  const view = await prepareRenderView(workspace, render.docId, render.renderId);
  await (reveal ? revealInFileManager : openInFileManager)(workspace, view.path);
}

/** Rerender the current saved spec, never an old render's embedded input. */
export async function rerenderDocument(workspace: string, group: RenderGroup, render?: StoredRender): Promise<void> {
  requireDesktop();
  if (group.ambiguous) throw new Error(group.diagnostic ?? "Multiple diagrams share this document ID; change one document's ID and refresh before re-rendering.");
  if (group.orphaned || !group.documentName) throw new Error("The source document is missing; restore its diagram file before re-rendering.");
  const current = await readDiagramDetailed(workspace, group.documentName);
  const originalDocId = group.originalDocId ?? render?.receipt?.docId ?? group.docId;
  if (current.doc.id !== originalDocId) throw new Error("The source document identity changed; refresh the render list before re-rendering.");
  const datasets = (current.doc.datasets ?? []).filter((dataset) => dataset.kind === "semanticSpec");
  const requestedId = render?.receipt?.datasetId;
  const matchingType = datasets.filter((dataset) => dataset.diagramType === render?.receipt?.diagramType);
  const datasetId = requestedId ?? (matchingType.length === 1 ? matchingType[0].id : undefined);
  if (!datasetId) throw new Error("This render has no unique source dataset; open the diagram, select a semantic dataset in Export and create a new render.");
  const canonical = canonicalSemanticExportInput(current.doc, datasetId);
  const artifact = await archifyRenderCandidate(workspace, canonical.diagramType, canonical.candidateJson, {
    docId: current.doc.id, documentName: group.documentName,
    documentRevision: current.fileRevision, diagramType: canonical.diagramType, datasetId: canonical.datasetId,
  });
  if (artifact?.storeWarning) throw new Error(`The render was generated but not kept in history: ${artifact.storeWarning}`);
}
