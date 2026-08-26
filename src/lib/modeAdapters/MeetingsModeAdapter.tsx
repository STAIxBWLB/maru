import { MeetingsPane } from "../../components/meetings/MeetingsPane";
import { planningModeController, useMeetingsModeSlice } from "../planningModeStore";
import type { ModeAdapterProps } from "../modeRegistry";

/** Dedicated lazy Meetings surface over canonical agent/settings projections. */
export function MeetingsModeAdapter(_props: ModeAdapterProps) {
  const meetings = useMeetingsModeSlice();
  if (!meetings.host) return null;
  return <MeetingsPane {...meetings.host} requestedView={meetings.requestedView} onViewConsumed={() => planningModeController.consumeMeetingsView(meetings.requestEpoch)} />;
}
