import { CommsPane } from "../../components/CommsPane";
import { useCommsModeSlice } from "../communicationsModeStore";
import type { ModeAdapterProps } from "../modeRegistry";

/** Dedicated lazy Comms surface sharing the canonical processed-items slice. */
export function CommsModeAdapter({ scope }: ModeAdapterProps) {
  const comms = useCommsModeSlice();
  if (!comms.props || comms.workspacePath !== scope.workspacePath) return null;
  return <CommsPane {...comms.props} />;
}
