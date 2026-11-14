import { useCallback, useEffect, useId, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../../lib/api";
import type { ApprovalInput } from "../../approval/ApprovalDialog";
import { useTranslation } from "../../lib/i18n";
import {
  finalizeTaskCompletion,
  prepareTaskCompletionAcceptance,
  readTaskCompletion,
  setTaskCompletionPolicy,
  startTaskCompletionReview,
  type TaskCompletionView,
} from "../../lib/taskCompletion";
import { Button } from "../ui/Button";

interface TaskCompletionSectionProps {
  workPath: string;
  taskPath: string;
  onChanged: () => void;
  onConfirmApproval: (input: ApprovalInput) => Promise<string | null>;
  onMissionStarted?: (id: string) => void;
  refreshKey?: string | number;
}

export function TaskCompletionSection({ workPath, taskPath, onChanged, onConfirmApproval, onMissionStarted, refreshKey }: TaskCompletionSectionProps) {
  const { t } = useTranslation();
  const id = useId();
  const [view, setView] = useState<TaskCompletionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const epoch = useRef(0);
  const request = useRef(0);
  const operationBusy = useRef(false);
  const previousRefreshKey = useRef(refreshKey);

  const reload = useCallback(async (generation: number) => {
    const read = ++request.current;
    try {
      const next = await readTaskCompletion(workPath, taskPath);
      if (generation !== epoch.current || read !== request.current) return;
      setView(next);
      setError(null);
    } catch (failure) {
      if (generation === epoch.current && read === request.current) {
        setView(null);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (generation === epoch.current && read === request.current) setLoading(false);
    }
  }, [taskPath, workPath]);

  useEffect(() => {
    const generation = epoch.current + 1;
    epoch.current = generation;
    operationBusy.current = false;
    setBusy(false);
    setLoading(true);
    setView(null);
    setProvider("");
    setNotice(null);
    void reload(generation);
    const refresh = () => { void reload(generation); };
    window.addEventListener("maru-task-completion-changed", refresh);
    let disposed = false;
    const unlisten: UnlistenFn[] = [];
    if (isTauri()) {
      for (const event of ["task-completion://updated", "ai://done", "ai://error"]) {
        void listen(event, refresh).then((stop) => {
          if (disposed) stop();
          else unlisten.push(stop);
        }).catch(() => {
          // TasksPane also refreshes on mission-state changes. A listener
          // registration failure must not discard a readable durable view.
        });
      }
    }
    return () => {
      disposed = true;
      ++epoch.current;
      window.removeEventListener("maru-task-completion-changed", refresh);
      for (const stop of unlisten) stop();
    };
  }, [reload]);

  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    void reload(epoch.current);
  }, [refreshKey, reload]);

  const mutate = async (operation: (generation: number) => Promise<boolean>) => {
    if (operationBusy.current) return;
    const generation = epoch.current;
    operationBusy.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const changed = await operation(generation);
      if (generation !== epoch.current) return;
      if (changed) {
        onChanged();
        await reload(generation);
      }
    } catch (failure) {
      if (generation === epoch.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (generation === epoch.current) {
        operationBusy.current = false;
        setBusy(false);
      }
    }
  };

  const accept = () => {
    if (!view?.canAccept || !view.token || !view.reviewRevision) return;
    const { token, reviewRevision } = view;
    void mutate(async (generation) => {
      const { preparedRequest } = await prepareTaskCompletionAcceptance(workPath, token, reviewRevision);
      if (generation !== epoch.current) return false;
      const approvalId = await onConfirmApproval({
        kind: preparedRequest.kind,
        summary: preparedRequest.summary,
        target: preparedRequest.target,
        payloadPreview: preparedRequest.payloadPreview,
        preparedRequest,
      });
      if (!approvalId || generation !== epoch.current) return false;
      await finalizeTaskCompletion(workPath, token, approvalId, reviewRevision);
      if (generation === epoch.current) setNotice(t("tasks.completion.accepted"));
      return true;
    });
  };

  return (
    <section className="task-detail-section" aria-busy={loading || busy}>
      <h3>{t("tasks.completion.heading")}</h3>
      <label htmlFor={`${id}-required`}>
        <input id={`${id}-required`} type="checkbox" checked={view?.required ?? false}
          disabled={loading || busy || !view}
          onChange={(event) => {
            if (!view) return;
            const required = event.currentTarget.checked;
            const sourceRevision = view.sourceRevision;
            void mutate(async () => {
              await setTaskCompletionPolicy(workPath, taskPath, required, sourceRevision);
              return true;
            });
          }} />
        {t("tasks.completion.required")}
      </label>
      <p>{t("tasks.completion.description")}</p>
      {loading ? <p role="status">{t("tasks.completion.loading")}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {view?.required ? (
        <>
          <dl className="task-detail-meta">
            <div><dt>{t("tasks.completion.source")}</dt><dd><code>{view.sourceRevision}</code></dd></div>
            {view.token ? <div><dt>{t("tasks.completion.run")}</dt><dd><code>{view.token.runId}</code></dd></div> : null}
            {view.reviewRevision ? <div><dt>{t("tasks.completion.reviewRevision")}</dt><dd><code>{view.reviewRevision}</code></dd></div> : null}
          </dl>
          {view.blockedReason ? <p id={`${id}-blocked`} role="status">{view.blockedReason}</p> : null}
          {view.acceptedCurrent ? <p role="status">{t("tasks.completion.accepted")}</p> : null}
          <label htmlFor={`${id}-provider`}>{t("tasks.completion.provider")}</label>
          <select id={`${id}-provider`} value={provider} disabled={busy || !view.canReview}
            onChange={(event) => setProvider(event.currentTarget.value)}>
            <option value="">{t("tasks.completion.chooseProvider")}</option>
            {view.reviewProviders.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <div className="task-detail-actions">
            <Button size="sm" disabled={busy || !view.canReview || !view.token || !view.bindingRevision || !provider || !view.reviewProviders.includes(provider)}
              onClick={() => {
                if (!view.token || !view.bindingRevision || !provider || !view.canReview || !view.reviewProviders.includes(provider)) return;
                const { token, bindingRevision } = view;
                void mutate(async (generation) => {
                  const result = await startTaskCompletionReview(workPath, token, bindingRevision, provider, crypto.randomUUID());
                  if (generation === epoch.current) {
                    onMissionStarted?.(result.reviewRunId);
                    setNotice(t("tasks.completion.reviewStarted"));
                    setProvider("");
                  }
                  return true;
                });
              }}>{t("tasks.completion.review")}</Button>
            <Button size="sm" disabled={busy || !view.canAccept || view.acceptedCurrent}
              aria-describedby={view.blockedReason ? `${id}-blocked` : undefined}
              onClick={accept}>{t("tasks.completion.accept")}</Button>
          </div>
          {view.receipt ? <details><summary>{t("tasks.completion.evidence")}</summary><pre className="approval-preview">{JSON.stringify(view.receipt, null, 2)}</pre></details> : null}
        </>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}
