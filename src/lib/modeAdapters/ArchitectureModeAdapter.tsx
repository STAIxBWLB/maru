import { ArchitecturePane } from "../../components/architecture/ArchitecturePane";
import type { ModeAdapterProps } from "../modeRegistry";
import { useWorkspaceRegistry } from "../workspaceStore";

/** Dedicated lazy 설계도 surface: blueprints live in the private work root's dev/ and sites/ submodules. */
export function ArchitectureModeAdapter({ commands }: ModeAdapterProps) {
  const registry = useWorkspaceRegistry();
  const workPath =
    registry.activeByVisibility.private ??
    registry.workspaces.find((workspace) => workspace.visibility === "private")?.path ??
    null;
  const revealInFiles = commands.revealInFiles;
  return (
    <ArchitecturePane
      workspacePath={workPath}
      onRevealInFiles={
        workPath && revealInFiles ? (target) => revealInFiles(workPath, "private", target) : undefined
      }
    />
  );
}
