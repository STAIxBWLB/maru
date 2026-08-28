import { InboxPane } from "../../components/InboxPane";
import { useInboxModeSlice } from "../communicationsModeStore";
import type { ModeAdapterProps } from "../modeRegistry";

/** Dedicated lazy Inbox surface backed by its isolated communications slice. */
export function InboxModeAdapter({ scope }: ModeAdapterProps) {
  const inbox = useInboxModeSlice();
  if (!inbox.props || inbox.workspacePath !== scope.workspacePath) return null;
  return <InboxPane {...inbox.props} />;
}
