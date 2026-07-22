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
 * Paths stay case-sensitive because Maru also runs on case-sensitive vaults.
 * A target with a null owner matches on relPath alone: callers that cannot
 * know the owning workspace (fixtures, older saved views) must still resolve,
 * while the Rust scanner stamps an owner on every real node — requiring exact
 * equality against null made every real handoff report the target missing. */
export function graphNodeMatchesLocalTarget(
  node: GraphNode,
  target: GraphLocalTarget,
): boolean {
  if (!node.relPath || normalizeRelPath(node.relPath) !== normalizeRelPath(target.relPath)) {
    return false;
  }
  const targetOwner = normalizeOwnerPath(target.ownerWorkspacePath);
  return targetOwner === null
    || normalizeOwnerPath(node.ownerWorkspacePath) === targetOwner;
}

export function graphLocalTargetForNode(node: GraphNode): GraphLocalTarget | null {
  if (!node.relPath) return null;
  return {
    ownerWorkspacePath: node.ownerWorkspacePath ?? null,
    relPath: node.relPath,
  };
}
