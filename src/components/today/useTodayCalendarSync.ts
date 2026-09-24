import { useCallback, useState } from "react";
import type { CalendarSyncOutcome, DailyPlanItem } from "../../lib/today";
import { calendarSyncRun, isTodayConflict, todayCalendarPublish } from "../../lib/today";
import { useToday } from "./todayContext";

export type TodayCalendarNotice = "conflict" | "error" | "calendarBlocked" | null;

export function useTodayCalendarSync() {
  const { workPath, settings, defaultCalendar, gwsBinary, snapshot, mutate, reload } =
    useToday();
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<TodayCalendarNotice>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<CalendarSyncOutcome | null>(null);

  const resolvedDestination = useCallback((): string | null => {
    const configured = settings.calendarDestination?.trim() ?? "";
    if (!configured || configured === "defaultCalendar") {
      return defaultCalendar?.trim() || null;
    }
    return configured;
  }, [settings.calendarDestination, defaultCalendar]);

  const setSelected = useCallback(
    (item: DailyPlanItem, selected: boolean) =>
      mutate({
        type: "setCalendarSync",
        itemRef: item.itemRef,
        selected,
        destination: selected
          ? item.calendarSync.destination ?? resolvedDestination()
          : null,
      }),
    [mutate, resolvedDestination],
  );

  const publishSelected = useCallback(
    async (revisionOverride?: string) => {
      if (!workPath || !snapshot || publishing) return;
      setPublishing(true);
      setNotice(null);
      try {
        const outcome = await todayCalendarPublish(
          workPath,
          snapshot.logicalDay,
          revisionOverride ?? snapshot.revision,
          resolvedDestination(),
          gwsBinary ?? null,
        );
        setNotice(outcome.blocked ? "calendarBlocked" : null);
        await reload();
      } catch (err) {
        if (isTodayConflict(err)) {
          setNotice("conflict");
          await reload();
        } else {
          setNotice("error");
        }
      } finally {
        setPublishing(false);
      }
    },
    [gwsBinary, publishing, reload, resolvedDestination, snapshot, workPath],
  );

  /** Manual trigger of the note → calendar reconcile; the daily job runs the
   *  same Rust entry point. */
  const syncNotes = useCallback(async () => {
    if (!workPath || syncing) return;
    setSyncing(true);
    setNotice(null);
    try {
      const outcome = await calendarSyncRun(workPath, resolvedDestination(), gwsBinary ?? null);
      setLastSync(outcome);
      setNotice(outcome.blocked > 0 ? "calendarBlocked" : null);
      await reload();
    } catch {
      setNotice("error");
    } finally {
      setSyncing(false);
    }
  }, [gwsBinary, reload, resolvedDestination, syncing, workPath]);

  const retryItem = useCallback(
    async (item: DailyPlanItem) => {
      const next = await setSelected(item, true);
      if (next) await publishSelected(next.revision);
    },
    [publishSelected, setSelected],
  );

  return {
    destination: resolvedDestination(),
    notice,
    publishing,
    publishSelected,
    retryItem,
    setSelected,
    syncing,
    lastSync,
    syncNotes,
  };
}
