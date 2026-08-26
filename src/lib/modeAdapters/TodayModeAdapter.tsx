import { TodayPane } from "../../components/today/TodayPane";
import { planningModeController, useTodayModeSlice } from "../planningModeStore";
import type { ModeAdapterProps } from "../modeRegistry";

/** Dedicated lazy Today surface with route and lifecycle intents owned by the planning store. */
export function TodayModeAdapter(_props: ModeAdapterProps) {
  const today = useTodayModeSlice();
  if (!today.host) return null;
  return <TodayPane {...today.host} route={today.route} onRouteChange={planningModeController.setTodayRoute} rolloverEpoch={today.rolloverEpoch} refreshRequestEpoch={today.refreshRequestEpoch} />;
}
