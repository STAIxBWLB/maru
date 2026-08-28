import { DashboardPane } from "../../components/dashboard/DashboardPane";
import { useDashboardModeSlice } from "../planningModeStore";
import type { ModeAdapterProps } from "../modeRegistry";

/** Dedicated lazy Dashboard surface; navigation stays on the generic command port. */
export function DashboardModeAdapter(_props: ModeAdapterProps) {
  const dashboard = useDashboardModeSlice();
  return dashboard.host ? <DashboardPane {...dashboard.host} /> : null;
}
