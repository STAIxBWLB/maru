import type { DiagramDoc, DiagramNode } from "./types";

/**
 * Whether the model draws a node at all: not hidden itself and not on a layer
 * the reader has made invisible. The canvas and the SVG export both apply this
 * one rule, to member bodies and to the engine shapes that belong to them.
 */
export function modelDrawsNode(doc: Pick<DiagramDoc, "layers">): (node: DiagramNode) => boolean {
  const hiddenLayers = new Set(doc.layers.filter((layer) => !layer.visible).map((layer) => layer.id));
  return (node) => !node.hidden && !(node.layerId && hiddenLayers.has(node.layerId));
}
