/** Keyboard and ribbon Delete share a previewed, atomic semantic cascade.
 * Every confirmation settles before mutation; a changed doc invalidates it.
 */
import { createGenerationHost } from "../../lib/diagram/generationHost";
import { validateSemanticDraft, type SemanticValidationHost } from "../../lib/diagram/semanticApply";
import { confirmDialog, messageDialog } from "../../lib/confirmDialog";
import { removeEdges, removeNodes, withSnapshot } from "../../lib/diagram/actions";
import type { Coalescer } from "../../lib/diagram/history";
import { analyzeViewDrag, detachViewMembersSnippetAction } from "../../lib/diagram/patternStudio";
import { projectSemanticDataset, resolveSemanticMember, semanticContainerId, semanticDatasetsIn, semanticMemberNodeIds } from "../../lib/diagram/semantic";
import { planSemanticEdit, removeSemanticEntries, type SemanticContainerIndexRemap } from "../../lib/diagram/semanticEdit";
import type { DiagramStore } from "../../lib/diagram/state";
import { semanticCascadeLines, type SemanticTranslate } from "./semanticCascade";

export async function deleteSelection(store: DiagramStore, coalescer: Coalescer, t: SemanticTranslate, host: SemanticValidationHost = createGenerationHost({ workPath: null }),
  selection?: { nodes: readonly string[]; edges: readonly string[] }): Promise<void> {
  const state = store.getState();
  const nodeIds = [...(selection?.nodes ?? state.ephemeral.selection.nodes)].filter((id) => !state.doc.nodes.find((node) => node.id === id)?.locked);
  const edgeIds = [...(selection?.edges ?? state.ephemeral.selection.edges)];
  if (nodeIds.length + edgeIds.length === 0) return;
  const analysis = analyzeViewDrag(state.doc, nodeIds);
  if (analysis.subsets.length > 0 && !(await confirmDialog(t("diagram.detach.confirm")))) return;
  const targets = [
    ...nodeIds.map((nodeId) => resolveSemanticMember(state.doc, { nodeId })),
    ...edgeIds.map((edgeId) => resolveSemanticMember(state.doc, { edgeId })),
  ].filter((member) => member !== null);
  const plans = semanticDatasetsIn(state.doc, nodeIds, edgeIds).map((dataset) => ({
    dataset,
    removal: removeSemanticEntries(dataset.diagramType, dataset.spec,
      targets.filter((member) => member.dataset.id === dataset.id).map(({ field, index }) => ({ field, index }))),
  }));
  const freeNodes = nodeIds.filter((nodeId) => resolveSemanticMember(state.doc, { nodeId }) === null);
  const freeEdges = edgeIds.filter((edgeId) => resolveSemanticMember(state.doc, { edgeId }) === null);
  const removing = new Set(freeNodes);
  const remappedContainerId = (nodeId: string, datasetId: string, remaps: readonly SemanticContainerIndexRemap[]): string | null => {
    const node = state.doc.nodes.find((candidate) => candidate.id === nodeId);
    const role = node?.meta?.semanticContainer;
    const memberId = node?.meta?.memberId;
    if (typeof role !== "string" || typeof memberId !== "string") return nodeId;
    const prefix = `${datasetId}:${role}:`;
    const key = memberId.startsWith(prefix) ? memberId.slice(prefix.length) : "";
    if (!/^\d+$/.test(key)) return nodeId;
    const remap = remaps.find((entry) => entry.role === role && entry.oldIndex === Number(key));
    return remap ? (remap.newIndex === null ? null : semanticContainerId(datasetId, remap.role, String(remap.newIndex))) : nodeId;
  };
  const scopes = plans.map(({ dataset, removal }) => {
    const owned = new Set(semanticMemberNodeIds(state.doc, dataset.id));
    const candidate = removal.transform(dataset.spec);
    if (candidate) {
      const retained = new Set(projectSemanticDataset({ ...dataset, spec: candidate.spec }, { containers: true }).nodes.map((node) => node.id));
      for (const id of owned) {
        const mapped = remappedContainerId(id, dataset.id, candidate.containerIndexRemaps ?? []);
        if (mapped === null || !retained.has(mapped)) removing.add(id);
      }
    }
    return owned;
  });
  // A bridge between two nodes in this batch must be absent before planning
  // either dataset. Keep bridges to unselected external nodes protected.
  const admittedAnnotations = state.doc.edges.filter((edge) =>
    resolveSemanticMember(state.doc, { edgeId: edge.id }) === null &&
    (freeEdges.includes(edge.id) ||
      ((removing.has(edge.fromNode) || removing.has(edge.toNode)) &&
        (scopes.some((scope) => scope.has(edge.fromNode) && scope.has(edge.toNode)) ||
          (removing.has(edge.fromNode) && removing.has(edge.toNode))))),
  );
  // Plan everything on an isolated state, removing selected freeform objects
  // first. A later refusal must not commit any earlier part of the batch.
  let next = state;
  for (const subset of analysis.subsets) next = detachViewMembersSnippetAction(subset.viewId, subset.memberIds)(next);
  next = removeEdges(admittedAnnotations.map((edge) => edge.id))(next);
  next = removeNodes(freeNodes)(next);
  for (const { dataset, removal } of plans) {
    const outcome = planSemanticEdit(next, dataset.id, removal.transform);
    if (outcome.status === "invalid") {
      await messageDialog([t("diagram.semantic.editRefused"), ...outcome.diagnostics.map((item) => t(item.key, item.params ?? {}))].join("\n"), "warning");
      return;
    }
    if (outcome.status === "applied") next = outcome.transformer(next);
  }
  if (plans.length > 0) {
    const retainedEdges = new Set(next.doc.edges.map((edge) => edge.id));
    const annotationLines = state.doc.edges.filter((edge) => !retainedEdges.has(edge.id) &&
      resolveSemanticMember(state.doc, { edgeId: edge.id }) === null).map((edge) =>
      t("diagram.semantic.annotationRemoved", { name: edge.label ? `${edge.label} (${edge.id})` : edge.id }),
    );
    const lines = plans.flatMap(({ dataset, removal }) => [dataset.name, ...semanticCascadeLines(removal.effects, t)]);
    if (!(await confirmDialog([t("diagram.semantic.removeConfirm"), ...lines, ...annotationLines].join("\n")))) return;
  }
  if (store.getState().doc !== state.doc) {
    await messageDialog(t("diagram.semantic.editStale"), "warning");
    return;
  }
  const diagnostics = await validateSemanticDraft(next.doc, plans.map(({ dataset }) => dataset.id), host);
  if (store.getState().doc !== state.doc) {
    await messageDialog(t("diagram.semantic.editStale"), "warning");
    return;
  }
  if (diagnostics.length > 0) {
    await messageDialog(diagnostics.map((item) => t(item.key, item.params ?? {})).join("\n"), "warning");
    return;
  }
  if (next !== state) store.setState(withSnapshot(() => next, coalescer));
}
