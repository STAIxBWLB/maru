import type { GraphLocalTarget } from "../settings";
import type { GraphNode } from "./model";

function normalizeRelPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeOwnerPath(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Resolve a Local target without relying on the collision-prone node id.
 * Paths stay case-sensitive because Maru also runs on case-sensitive vaults. */
export function graphNodeMatchesLocalTarget(
  node: GraphNode,
  target: GraphLocalTarget,
): boolean {
  return Boolean(
    node.relPath &&
      normalizeRelPath(node.relPath) === normalizeRelPath(target.relPath) &&
      normalizeOwnerPath(node.ownerWorkspacePath) ===
        normalizeOwnerPath(target.ownerWorkspacePath),
  );
}

export function graphLocalTargetForNode(node: GraphNode): GraphLocalTarget | null {
  if (!node.relPath) return null;
  return {
    ownerWorkspacePath: node.ownerWorkspacePath ?? null,
    relPath: node.relPath,
  };
}
