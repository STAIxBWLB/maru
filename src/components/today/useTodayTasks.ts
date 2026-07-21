// Maru Today — shared task scan for the stage screens. Wraps
// scanTaskNotes + rowsToTaskEntries (the same loading approach the Prepare
// planner uses) so Execute/Review/TaskSheet consumers resolve plan itemRefs
// to real task rows without duplicating the scan plumbing.

import { useCallback, useEffect, useState } from "react";
import { scanTaskNotes } from "../../lib/api";
import { rowsToTaskEntries, type TaskEntry } from "../../lib/tasks";
import { useToday } from "./todayContext";

export interface TodayTasks {
  /** Most recently scanned task rows (empty until the first scan lands). */
  tasks: TaskEntry[];
  /** Re-scan and return the fresh rows (callers needing the result inline). */
  refresh: () => Promise<TaskEntry[]>;
}

export function useTodayTasks(): TodayTasks {
  const { workPath } = useToday();
  const [tasks, setTasks] = useState<TaskEntry[]>([]);

  const refresh = useCallback(async (): Promise<TaskEntry[]> => {
    if (!workPath) return [];
    try {
      const entries = rowsToTaskEntries(await scanTaskNotes(workPath));
      setTasks(entries);
      return entries;
    } catch {
      return [];
    }
  }, [workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { tasks, refresh };
}
