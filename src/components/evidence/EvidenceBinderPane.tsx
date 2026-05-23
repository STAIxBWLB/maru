import { CheckCircle2, ClipboardCheck, FileText, Link2, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  evidenceCandidateSummary,
  readEvidenceBinder,
  saveEvidenceBinder,
  type EvidenceBinderCandidate,
  type EvidenceBinderState,
} from "../../lib/evidenceBinder";
import { useTranslation } from "../../lib/i18n";

interface EvidenceBinderPaneProps {
  workspaceRoot: string | null;
  docId: string | null;
  documentPath: string | null;
  onError: (message: string | null) => void;
}

export function EvidenceBinderPane({
  workspaceRoot,
  docId,
  documentPath,
  onError,
}: EvidenceBinderPaneProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<EvidenceBinderState | null>(null);
  const [candidates, setCandidates] = useState<EvidenceBinderCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const linkedIds = useMemo(
    () => new Set(state?.bindings.map((binding) => binding.candidateId) ?? []),
    [state],
  );

  const load = useCallback(async () => {
    if (!workspaceRoot || !docId) {
      setState(null);
      setCandidates([]);
      return;
    }
    setLoading(true);
    try {
      const response = await readEvidenceBinder({
        workPath: workspaceRoot,
        docId,
        documentPath,
      });
      setState(response.state);
      setCandidates(response.candidates);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [docId, documentPath, onError, workspaceRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleCandidate = useCallback(
    async (candidate: EvidenceBinderCandidate) => {
      if (!workspaceRoot || !state) return;
      const now = new Date().toISOString();
      const exists = linkedIds.has(candidate.id);
      const next: EvidenceBinderState = {
        ...state,
        bindings: exists
          ? state.bindings.filter((binding) => binding.candidateId !== candidate.id)
          : [
              ...state.bindings,
              {
                candidateId: candidate.id,
                note: candidate.summary ?? null,
                verified:
                  candidate.validationChecks.length > 0 &&
                  candidate.validationChecks.every((check) => check.status === "pass"),
                linkedAt: now,
              },
            ],
        updatedAt: now,
      };
      setState(next);
      setSaving(true);
      try {
        setState(await saveEvidenceBinder(workspaceRoot, next));
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [linkedIds, onError, state, workspaceRoot],
  );

  if (!workspaceRoot || !docId) {
    return (
      <div className="evidence-binder evidence-binder--empty">
        <ClipboardCheck size={20} />
        <strong>{t("rightPane.evidence.noDocument")}</strong>
      </div>
    );
  }

  return (
    <section className="evidence-binder" aria-label={t("rightPane.tab.evidence")}>
      <header className="evidence-binder__header">
        <div>
          <span className="evidence-binder__kicker">{t("rightPane.evidence.kicker")}</span>
          <h3>{t("rightPane.tab.evidence")}</h3>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => void load()}
          title={t("rightPane.evidence.refresh")}
          aria-label={t("rightPane.evidence.refresh")}
        >
          <RefreshCcw size={14} />
        </button>
      </header>

      <div className="evidence-binder__meta">
        <span>{t("rightPane.evidence.candidates", { count: candidates.length })}</span>
        <span>{t("rightPane.evidence.linked", { count: state?.bindings.length ?? 0 })}</span>
        {saving ? <span>{t("rightPane.evidence.saving")}</span> : null}
      </div>

      {loading ? <div className="outline-empty">{t("rightPane.evidence.loading")}</div> : null}
      {!loading && candidates.length === 0 ? (
        <div className="outline-empty">{t("rightPane.evidence.empty")}</div>
      ) : null}

      <div className="evidence-binder__list">
        {candidates.map((candidate) => {
          const linked = linkedIds.has(candidate.id);
          const failedChecks = candidate.validationChecks.filter((check) => check.status === "fail");
          return (
            <article
              key={candidate.id}
              className={linked ? "evidence-card linked" : "evidence-card"}
            >
              <button
                type="button"
                className="evidence-card__main"
                onClick={() => void toggleCandidate(candidate)}
                title={candidate.relPath}
              >
                <span className="evidence-card__icon">
                  {linked ? <CheckCircle2 size={16} /> : <FileText size={16} />}
                </span>
                <span className="evidence-card__copy">
                  <strong>{candidate.title}</strong>
                  <small>{candidate.relPath}</small>
                </span>
              </button>
              <div className="evidence-card__meta">
                <span>{candidate.source}</span>
                <span>{evidenceCandidateSummary(candidate)}</span>
                {candidate.businessUnit ? <span>{candidate.businessUnit}</span> : null}
              </div>
              {candidate.hwpFieldLabels.length > 0 ? (
                <div className="evidence-card__fields">
                  {candidate.hwpFieldLabels.map((label) => (
                    <span key={label}>{label}</span>
                  ))}
                </div>
              ) : null}
              {candidate.summary ? <p>{candidate.summary}</p> : null}
              {failedChecks.length > 0 ? (
                <div className="evidence-card__warning">
                  {failedChecks.map((check) => check.reason ?? check.name).join(" · ")}
                </div>
              ) : null}
              {linked ? (
                <div className="evidence-card__linked">
                  <Link2 size={12} />
                  <span>{t("rightPane.evidence.bound")}</span>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
