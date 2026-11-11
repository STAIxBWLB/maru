/** Shared gesture positions for every consumer of the painted canvas boxes. */
import type { CanvasDisplayOffset, CanvasGeometryPoint, CanvasGeometryState } from "./engineCanvasGeometry";
import type { DiagramDoc, NodeId } from "./types";

export type CanvasPositions = ReadonlyMap<NodeId, CanvasGeometryPoint>;
interface PositionsState {
  live: CanvasPositions | null;
  committed: { scene: CanvasGeometryState; positions: CanvasPositions } | null;
}
const EMPTY: PositionsState = Object.freeze({ live: null, committed: null });
const entries = new Map<string, { state: PositionsState; listeners: Set<() => void> }>();
function entryFor(documentId: string) {
  let entry = entries.get(documentId);
  if (!entry) {
    entry = { state: EMPTY, listeners: new Set() };
    entries.set(documentId, entry);
  }
  return entry;
}
export function canvasPositionsState(documentId: string): PositionsState {
  return entryFor(documentId).state;
}
export function subscribeCanvasPositions(documentId: string, listener: () => void): () => void {
  const entry = entryFor(documentId);
  entry.listeners.add(listener);
  return () => { entry.listeners.delete(listener); };
}
function publish(documentId: string, state: PositionsState): void {
  const entry = entryFor(documentId);
  entry.state = state;
  for (const listener of [...entry.listeners]) listener();
}
export function setLiveCanvasPositions(documentId: string, live: CanvasPositions | null): void {
  publish(documentId, { ...entryFor(documentId).state, live });
}
function committedPositions(state: PositionsState, scene: CanvasGeometryState, doc: DiagramDoc): Map<NodeId, CanvasGeometryPoint> {
  const positions = new Map<NodeId, CanvasGeometryPoint>();
  if (state.committed?.scene !== scene) return positions;
  const nodes = new Map(doc.nodes.map((node) => [node.id, node]));
  for (const [id, position] of state.committed.positions) {
    const node = nodes.get(id);
    if (node?.meta?.pinned === true && node.x === position.x && node.y === position.y) positions.set(id, position);
  }
  return positions;
}
export function commitCanvasPositions(
  doc: DiagramDoc,
  scene: CanvasGeometryState,
  movedIds: readonly NodeId[],
  placed: readonly ({ id: NodeId } & CanvasGeometryPoint)[],
): void {
  const current = entryFor(doc.id).state;
  const positions = committedPositions(current, scene, doc);
  for (const id of movedIds) positions.delete(id);
  if (scene.geometry) for (const { id, x, y } of placed) positions.set(id, { x, y });
  publish(doc.id, { live: null, committed: positions.size ? { scene, positions } : null });
}
export function canvasDisplayOffset(doc: DiagramDoc, scene: CanvasGeometryState, state = entryFor(doc.id).state): CanvasDisplayOffset | null {
  const positions = committedPositions(state, scene, doc);
  for (const [id, position] of state.live ?? []) positions.set(id, position);
  return positions.size ? { ids: new Set(positions.keys()), dx: 0, dy: 0, positions } : null;
}
/** Document replacement invalidates copied ids as well as published geometry. */
export function resetCanvasPositions(): void {
  for (const [id] of entries) publish(id, EMPTY);
}
