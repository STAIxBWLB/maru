import { invoke } from "@tauri-apps/api/core";
export const FAMILY_PACKAGES = {
  ahub: "@staix/agent-hub", amem: "@staix/agent-mem", vmem: "@staix/vault-mem", acon: "@staix/agent-console",
} as const;
export type FamilyToolId = keyof typeof FAMILY_PACKAGES;
export interface FamilyToolStatus {
  id: FamilyToolId;
  package: string;
  installedVersion: string | null;
  availableVersion: string | null;
  state: "absent" | "installed" | "stale" | "unavailable";
  ownership: "bun-global" | "external";
  commands: string[];
  canLaunch: boolean;
  detail: string[];
}
export const familyToolsStatus = (): Promise<FamilyToolStatus[]> => invoke("family_tools_status");
/** Display/copy only: package installers remain externally owned. */
export function familyPackageCommand(id: FamilyToolId, version: string | null): string | null {
  if (!Object.hasOwn(FAMILY_PACKAGES, id) || !version || !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(version)) return null;
  return `bun add -g ${FAMILY_PACKAGES[id]}@${version}`;
}
