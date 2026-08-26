import { E2EFlowPane } from "../../components/e2e/E2EFlowPane";
import type { ModeAdapterProps } from "../modeRegistry";

/** Lazy feature-gated adapter that keeps the E2E pane out of App's render tree. */
export function E2EFlowModeAdapter({ scope, commands }: ModeAdapterProps) {
  return <E2EFlowPane workPath={scope.workspacePath} onRevealPath={commands.revealPath} />;
}
