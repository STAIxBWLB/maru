/** Keeps cross-mode open requests alive while the lazy Diagram surface loads. */
const pending = new Map<string, string>();
const listeners = new Set<() => void>();

export function requestDiagramHandoff(workspace: string, name: string): void {
  pending.set(workspace, name);
  for (const listener of listeners) listener();
}

export function takeDiagramHandoff(workspace: string): string | null {
  const name = pending.get(workspace) ?? null;
  pending.delete(workspace);
  return name;
}

export function subscribeDiagramHandoff(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
