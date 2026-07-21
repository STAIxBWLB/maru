// Maru Today — Prepare panel: brain dump editor. Autosaves (debounced) into
// the day snapshot, hard-caps at 2000 chars, runs the planner on demand, and
// hosts the Undo affordance with its availability state.

import { Info, RotateCcw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import { useToday } from "./todayContext";

const MAX_BRAIN_DUMP_CHARS = 2000;
const AUTOSAVE_DEBOUNCE_MS = 800;

type SaveStatus = "idle" | "saving" | "saved" | "planning" | "planned";

interface TodayBrainDumpProps {
  /** True while a plan run (manual or auto) is in flight. */
  planning: boolean;
  /** Item count adjusted by the last auto-applied plan (transient). */
  lastDiffCount: number | null;
  /** Manual "자동 계획 만들기" run. */
  onAutoPlan: () => void;
  /** Called after a brain-dump autosave lands (auto-plan trigger). */
  onSaved: () => void;
}

export function TodayBrainDump({
  planning,
  lastDiffCount,
  onAutoPlan,
  onSaved,
}: TodayBrainDumpProps) {
  const { t } = useTranslation();
  const { snapshot, mutate } = useToday();

  const [text, setText] = useState(snapshot?.brainDump ?? "");
  const [status, setStatus] = useState<SaveStatus>("idle");
  // Nothing to undo until a mutation lands in this session.
  const [undoAvailable, setUndoAvailable] = useState(false);
  const lastSavedRef = useRef(snapshot?.brainDump ?? "");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTextRef = useRef<string | null>(null);

  // External snapshot changes (undo, conflict reload, planner) resync the
  // editor — but not our own in-flight saves, which would clobber typing.
  const snapshotBrainDump = snapshot?.brainDump ?? "";
  useEffect(() => {
    if (snapshotBrainDump !== lastSavedRef.current) {
      lastSavedRef.current = snapshotBrainDump;
      setText(snapshotBrainDump);
    }
  }, [snapshotBrainDump]);

  // A freshly auto-applied plan is itself undoable.
  useEffect(() => {
    if (lastDiffCount !== null) setUndoAvailable(true);
  }, [lastDiffCount]);

  // Manual plan run finished → transient "planned" status.
  const wasPlanningRef = useRef(false);
  useEffect(() => {
    if (wasPlanningRef.current && !planning) {
      setStatus("planned");
    }
    wasPlanningRef.current = planning;
  }, [planning]);

  const save = useCallback(
    async (value: string) => {
      if (!snapshot) return;
      pendingTextRef.current = null;
      setStatus("saving");
      const next = await mutate({ type: "setBrainDump", brainDump: value });
      if (next) {
        lastSavedRef.current = value;
        setStatus("saved");
        setUndoAvailable(true);
        onSaved();
      } else {
        setStatus("idle");
      }
    },
    [snapshot, mutate, onSaved],
  );

  // Flush (not drop) a pending debounced save on unmount — stage/route
  // switches within the debounce window must not lose the typed tail.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      if (pendingTextRef.current !== null) void saveRef.current(pendingTextRef.current);
    },
    [],
  );

  const handleChange = (value: string) => {
    // Code-point cap: String.slice counts UTF-16 units and can split a
    // surrogate pair on paste-truncate.
    const capped =
      value.length > MAX_BRAIN_DUMP_CHARS
        ? [...value].slice(0, MAX_BRAIN_DUMP_CHARS).join("")
        : value;
    setText(capped);
    setStatus("idle");
    pendingTextRef.current = capped;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void save(capped);
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  const handleUndo = async () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingTextRef.current = null; // undo supersedes any unsaved typing
    const next = await mutate({ type: "undo" });
    // The backend returns today_undo_unavailable for a second undo in a row;
    // a null result here means the undo stack was empty.
    setUndoAvailable(false);
    if (next) setStatus("idle");
  };

  const statusText = (() => {
    if (planning) return t("today.prepare.braindump.planning");
    switch (status) {
      case "saving":
        return t("today.prepare.braindump.saving");
      case "saved":
        return t("today.prepare.braindump.saved");
      case "planned":
        return t("today.prepare.braindump.planned");
      default:
        return "";
    }
  })();

  const undoDisabled = !undoAvailable || !snapshot;

  return (
    <section className="today-panel today-panel-braindump" data-today-section="braindump">
      <header className="today-panel-header">
        <h3 className="today-panel-title">{t("today.panel.braindump.title")}</h3>
        <Info size={14} strokeWidth={1.9} className="today-panel-info" aria-hidden="true" />
      </header>
      <p className="today-panel-hint">{t("today.panel.braindump.hint")}</p>
      <div className="today-panel-body">
        <textarea
          className="today-braindump-textarea"
          value={text}
          onChange={(event) => handleChange(event.target.value)}
          placeholder={t("today.prepare.braindump.placeholder")}
          aria-label={t("today.panel.braindump.title")}
          maxLength={MAX_BRAIN_DUMP_CHARS}
          disabled={!snapshot}
        />
        <div className="today-braindump-meta">
          <span className="today-braindump-status" role="status">
            {statusText}
          </span>
          <span className="today-braindump-counter">
            {t("today.prepare.braindump.counter", {
              count: text.length,
              max: MAX_BRAIN_DUMP_CHARS,
            })}
          </span>
        </div>
        <div className="today-braindump-actions">
          <button
            type="button"
            className="today-button-primary"
            onClick={onAutoPlan}
            disabled={!snapshot || planning}
          >
            <Sparkles size={14} strokeWidth={1.9} aria-hidden="true" />
            {t("today.prepare.braindump.autoPlan")}
          </button>
        </div>
        <footer className="today-braindump-footer">
          <span className="today-braindump-hint">{t("today.prepare.braindump.undoHint")}</span>
          {lastDiffCount !== null ? (
            <span className="today-diff-summary" role="status">
              {t("today.prepare.diffSummary", { count: lastDiffCount })}
            </span>
          ) : null}
          <button
            type="button"
            className="today-button-ghost"
            onClick={() => void handleUndo()}
            disabled={undoDisabled}
            title={undoDisabled ? t("today.prepare.braindump.undoUnavailable") : undefined}
          >
            <RotateCcw size={13} strokeWidth={1.9} aria-hidden="true" />
            {t("today.prepare.braindump.undo")}
          </button>
        </footer>
      </div>
    </section>
  );
}
