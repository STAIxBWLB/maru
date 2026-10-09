/**
 * Delete the current selection: the one path behind keyboard Delete /
 * Backspace and the ribbon's Delete button.
 *
 * Every prompt is answered before anything mutates, and cancelling any of
 * them leaves the doc untouched:
 *
 * - a strict subset of a pattern view's members asks to detach them first
 *   (Phase 2b), then detaches one snapshot per subset;
 * - semantic members (issue #433 P2) ask `diagram.semantic.deleteRequiresDetach`
 *   with what detaching loses, then detach one snapshot per dataset; the
 *   spec stays canonical, so members are never deleted out from under it.
 *
 * The selection is then removed (nodes, then edges), as before.
 */

import { confirmDialog } from "../../lib/confirmDialog";
import { removeEdges, removeNodes, withSnapshot } from "../../lib/diagram/actions";
import type { Coalescer } from "../../lib/diagram/history";
import { analyzeViewDrag, detachViewMembersSnippetAction } from "../../lib/diagram/patternStudio";
import { semanticDatasetsIn, semanticLosses } from "../../lib/diagram/semantic";
import { detachSemanticDatasetAction } from "../../lib/diagram/semanticEdit";
import type { DiagramStore } from "../../lib/diagram/state";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export async function deleteSelection(store: DiagramStore, coalescer: Coalescer, t: Translate): Promise<void> {
  const state = store.getState();
  const nodeIds = [...state.ephemeral.selection.nodes];
  const edgeIds = [...state.ephemeral.selection.edges];
  if (nodeIds.length + edgeIds.length === 0) return;

  const analysis = analyzeViewDrag(state.doc, nodeIds);
  if (analysis.subsets.length > 0 && !(await confirmDialog(t("diagram.detach.confirm")))) return;
  const datasets = semanticDatasetsIn(state.doc, nodeIds, edgeIds);
  if (datasets.length > 0) {
    const lines = datasets.flatMap((dataset) => [
      dataset.name,
      ...semanticLosses(dataset).map((loss) => `- ${t(loss.key, loss.params ?? {})}`),
    ]);
    if (!(await confirmDialog([t("diagram.semantic.deleteRequiresDetach"), ...lines].join("\n")))) return;
  }

  for (const subset of analysis.subsets) {
    store.setState(withSnapshot(detachViewMembersSnippetAction(subset.viewId, subset.memberIds), coalescer));
  }
  for (const dataset of datasets) {
    store.setState(withSnapshot(detachSemanticDatasetAction(dataset.id), coalescer));
  }
  if (nodeIds.length > 0) store.setState(withSnapshot(removeNodes(nodeIds), coalescer));
  if (edgeIds.length > 0) store.setState(withSnapshot(removeEdges(edgeIds), coalescer));
}
