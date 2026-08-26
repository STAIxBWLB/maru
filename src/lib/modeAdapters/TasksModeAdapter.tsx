import { TasksPane } from "../../components/tasks/TasksPane";
import { useTasksModeSlice, useTodayModeSlice } from "../planningModeStore";
import type { ModeAdapterProps } from "../modeRegistry";

/** Dedicated lazy Tasks surface sharing the planning store's logical-day owner. */
export function TasksModeAdapter(_props: ModeAdapterProps) {
  const tasks = useTasksModeSlice();
  const today = useTodayModeSlice();
  return tasks.host ? <TasksPane {...tasks.host} logicalDay={today.logicalDay} /> : null;
}
