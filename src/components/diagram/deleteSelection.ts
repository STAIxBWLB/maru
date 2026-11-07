/** Keyboard and ribbon Delete share a previewed, atomic semantic cascade.
 * Every confirmation settles before mutation; a changed doc invalidates it.
 */
import { confirmDialog, messageDialog } from "../../lib/confirmDialog";
import { removeEdges, removeNodes, withSnapshot } from "../../lib/diagram/actions";
import type { Coalescer } from "../../lib/diagram/history";
import { analyzeViewDrag, detachViewMembersSnippetAction } from "../../lib/diagram/patternStudio";
import { resolveSemanticMember, semanticDatasetsIn } from "../../lib/diagram/semantic";
import { planSemanticEdit, removeSemanticEntries } from "../../lib/diagram/semanticEdit";
import type { DiagramStore } from "../../lib/diagram/state";
import { semanticCascadeLines, type SemanticTranslate } from "./semanticCascade";

export async function deleteSelection(store: DiagramStore, coalescer: Coalescer, t: SemanticTranslate): Promise<void> {
  const state = store.getState();
  const nodeIds = [...state.ephemeral.selection.nodes].filter((id) => !state.doc.nodes.find((node) => node.id === id)?.locked);
  const edgeIds = [...state.ephemeral.selection.edges];
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
  if (plans.length > 0) {
    const lines = plans.flatMap(({ dataset, removal }) => [dataset.name, ...semanticCascadeLines(removal.effects, t)]);
    if (!(await confirmDialog([t("diagram.semantic.removeConfirm"), ...lines].join("\n")))) return;
  }
  if (store.getState().doc !== state.doc) {
    await messageDialog(t("diagram.semantic.editStale"), "warning");
    return;
  }
  // Plan everything on an isolated state. A later refusal must not commit an
  // earlier dataset's cascade or a pattern detach.
  let next = state;
  for (const subset of analysis.subsets) next = detachViewMembersSnippetAction(subset.viewId, subset.memberIds)(next);
  for (const { dataset, removal } of plans) {
    const outcome = planSemanticEdit(next, dataset.id, removal.transform);
    if (outcome.status === "invalid") {
      await messageDialog([t("diagram.semantic.editRefused"), ...outcome.diagnostics.map((item) => t(item.key, item.params ?? {}))].join("\n"), "warning");
      return;
    }
    if (outcome.status === "applied") next = outcome.transformer(next);
  }
  const freeNodes = nodeIds.filter((nodeId) => resolveSemanticMember(state.doc, { nodeId }) === null);
  const freeEdges = edgeIds.filter((edgeId) => resolveSemanticMember(state.doc, { edgeId }) === null);
  next = removeNodes(freeNodes)(next);
  next = removeEdges(freeEdges)(next);
  if (next !== state) store.setState(withSnapshot(() => next, coalescer));
}
