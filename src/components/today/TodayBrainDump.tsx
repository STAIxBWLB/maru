// Maru Today — Prepare panel: brain dump editor. Autosaves (debounced) into
// the day snapshot, hard-caps at 2000 chars, runs the planner on demand, and
// hosts the Undo affordance with its availability state.

import { Info, RotateCcw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createDebouncedSaver } from "../../lib/debouncedSave";
import { useTeardownFlush } from "../../lib/teardownSave";
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
  /** Register a flush hook so Finish/Quick skip can persist the typed tail
   *  before the atomic finalize command reads the snapshot revision. */
  onRegisterFlush?: (flush: () => Promise<void>) => () => void;
}

export function TodayBrainDump({
  planning,
  lastDiffCount,
  onAutoPlan,
  onSaved,
  onRegisterFlush,
}: TodayBrainDumpProps) {
  const { t } = useTranslation();
  const { workPath, snapshot, mutate } = useToday();

  const [text, setText] = useState(snapshot?.brainDump ?? "");
  const [status, setStatus] = useState<SaveStatus>("idle");
  // Nothing to undo until a mutation lands in this session.
  const [undoAvailable, setUndoAvailable] = useState(false);
  const lastSavedRef = useRef(snapshot?.brainDump ?? "");

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
      setStatus("saving");
      const next = await mutate({ type: "setBrainDump", brainDump: value });
      if (next) {
        lastSavedRef.current = value;
        setStatus("saved");
        setUndoAvailable(true);
        onSaved();
        return;
      }
      setStatus("idle");
      throw new Error("today_brain_dump_save_failed");
    },
    [snapshot, mutate, onSaved],
  );

  // ref-indirection so the saver's stable save callback always calls the
  // latest `save` without recreating the saver every render.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  // One saver per mount — schedule/flush/cancel via the shared debounced-save
  // helper; unmount performs the pending save instead of only cancelling it
  // (D-01, REL-02).
  const [saver] = useState(() =>
    createDebouncedSaver<string>((value) => saveRef.current(value), AUTOSAVE_DEBOUNCE_MS),
  );
  useTeardownFlush(
    saver,
    (value) =>
      workPath
        ? { workPath, filePath: `today-brain-dump-${snapshot?.logicalDay ?? "unknown"}.txt`, content: value }
        : null,
    t,
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
    saver.schedule(capped);
  };

  useEffect(() => onRegisterFlush?.(() => saver.flush()), [onRegisterFlush, saver]);

  const handleUndo = async () => {
    saver.cancel(); // undo supersedes any unsaved typing
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
