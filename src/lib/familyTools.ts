import { invoke } from "@tauri-apps/api/core";
export const FAMILY_PACKAGES = {
  ahub: "@staix/agent-hub", amem: "@staix/agent-mem", vmem: "@staix/vault-mem", acon: "@staix/agent-console",
} as const;
export type FamilyToolId = keyof typeof FAMILY_PACKAGES;
export type FamilyToolOwnership = "dot-family" | "ahub-upgrade" | "bun-global" | "external";
export interface FamilyToolStatus {
  id: FamilyToolId;
  package: string;
  installedVersion: string | null;
  availableVersion: string | null;
  state: "absent" | "installed" | "stale" | "unavailable";
  ownership: FamilyToolOwnership;
  previousVersion: string | null;
  commands: string[];
  canLaunch: boolean;
  detail: string[];
}
export const familyToolsStatus = (): Promise<FamilyToolStatus[]> => invoke("family_tools_status");
/** Display/copy only: package installers remain externally owned. */
export function familyPackageCommand(id: FamilyToolId, version: string | null, ownership: FamilyToolOwnership): string | null {
  if (!Object.hasOwn(FAMILY_PACKAGES, id) || ownership === "external" || !version || !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(version)) return null;
  if (id === "ahub") return ownership === "ahub-upgrade" ? `ahub upgrade --to ${version}` : null;
  return ownership === "dot-family" || ownership === "bun-global" ? `dot ai family install ${id} --version ${version}` : null;
}
export function familyRollbackCommand(tool: FamilyToolStatus): string | null {
  if (!Object.hasOwn(FAMILY_PACKAGES, tool.id) || tool.id === "ahub" || tool.ownership !== "dot-family" || !tool.previousVersion || !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(tool.previousVersion)) return null;
  return `dot ai rollback ${tool.id}`;
}
