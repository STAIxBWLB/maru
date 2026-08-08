import {
  CheckCircle2,
  ClipboardCheck,
  FileQuestion,
  FileText,
  Link2,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  Unlink2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bindingCanBeIncluded,
  candidateCanBeLocallyVerified,
  evidenceCandidateSummary,
  evidenceTargetSuggestions,
  mutateEvidenceBinder,
  readEvidenceBinder,
  splitEvidenceTargets,
  type EvidenceBinderCandidate,
  type EvidenceBinderMutation,
  type EvidenceBinderResponse,
  type EvidenceBinderState,
  type EvidenceBinding,
  type EvidenceTargetSuggestions,
} from "../../lib/evidenceBinder";
import { setError } from "../../lib/errorStore";
import { useTranslation } from "../../lib/i18n";

interface EvidenceBinderPaneProps {
  workspaceRoot: string | null;
  docId: string | null;
  documentPath: string | null;
  documentMarkdown: string;
}

type OptimisticUpdate = (state: EvidenceBinderState) => EvidenceBinderState;
type InverseFactory = (
  response: EvidenceBinderResponse,
  previous: EvidenceBinderState,
) => EvidenceBinderMutation | null;

export function EvidenceBinderPane({
  workspaceRoot,
  docId,
  documentPath,
  documentMarkdown,
}: EvidenceBinderPaneProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<EvidenceBinderState | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<EvidenceBinderCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [undoMutation, setUndoMutation] = useState<EvidenceBinderMutation | null>(null);
  const loadSeqRef = useRef(0);
  const mutationSeqRef = useRef(0);
  const savingRef = useRef(false);

  const candidateByBinding = useMemo(() => {
    const byCandidateId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const byRelPath = new Map(candidates.map((candidate) => [candidate.relPath, candidate]));
    return (binding: EvidenceBinding) =>
      (binding.candidateId ? byCandidateId.get(binding.candidateId) : undefined) ??
      byRelPath.get(binding.relPath) ??
      null;
  }, [candidates]);

  const bindingByCandidateId = useMemo(
    () =>
      new Map(
        (state?.bindings ?? [])
          .filter((binding) => binding.candidateId)
          .map((binding) => [binding.candidateId as string, binding]),
      ),
    [state],
  );
  const suggestions = useMemo(
    () => evidenceTargetSuggestions(documentMarkdown, candidates),
    [candidates, documentMarkdown],
  );
  const orphanBindings = useMemo(
    () => (state?.bindings ?? []).filter((binding) => !candidateByBinding(binding)),
    [candidateByBinding, state],
  );

  const load = useCallback(async () => {
    const loadSeq = loadSeqRef.current + 1;
    loadSeqRef.current = loadSeq;
    mutationSeqRef.current += 1;
    savingRef.current = false;
    setUndoMutation(null);
    if (!workspaceRoot || !docId) {
      setState(null);
      setRevision(null);
      setCandidates([]);
      setSaving(false);
      setLoading(false);
      return;
    }
    setState(null);
    setRevision(null);
    setCandidates([]);
    setSaving(false);
    setLoading(true);
    try {
      const response = await readEvidenceBinder({
        workPath: workspaceRoot,
        docId,
        documentPath,
      });
      if (loadSeqRef.current === loadSeq) {
        setState(response.state);
        setRevision(response.revision);
        setCandidates(response.candidates);
      }
    } catch (err) {
      if (loadSeqRef.current === loadSeq) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (loadSeqRef.current === loadSeq) setLoading(false);
    }
  }, [docId, documentPath, workspaceRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const performMutation = useCallback(
    async (
      mutation: EvidenceBinderMutation,
      optimistic?: OptimisticUpdate,
      inverseFactory?: InverseFactory,
    ) => {
      if (
        !workspaceRoot ||
        !docId ||
        !state ||
        !revision ||
        loading ||
        savingRef.current
      ) {
        return;
      }
      const previousState = state;
      const previousRevision = revision;
      const mutationSeq = mutationSeqRef.current + 1;
      mutationSeqRef.current = mutationSeq;
      savingRef.current = true;
      setSaving(true);
      if (optimistic) setState(optimistic(previousState));
      try {
        const response = await mutateEvidenceBinder({
          workPath: workspaceRoot,
          docId,
          documentPath,
          expectedRevision: previousRevision,
          mutation,
        });
        if (mutationSeqRef.current === mutationSeq) {
          setState(response.state);
          setRevision(response.revision);
          setCandidates(response.candidates);
          setUndoMutation(inverseFactory?.(response, previousState) ?? null);
        }
      } catch (err) {
        if (mutationSeqRef.current === mutationSeq) {
          setState(previousState);
          setRevision(previousRevision);
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          if (message.includes("evidence_binder_revision_conflict")) void load();
        }
      } finally {
        if (mutationSeqRef.current === mutationSeq) {
          savingRef.current = false;
          setSaving(false);
        }
      }
    },
    [docId, documentPath, load, loading, revision, state, workspaceRoot],
  );

  const bindCandidate = useCallback(
    (candidate: EvidenceBinderCandidate) =>
      performMutation(
        { type: "link", candidateId: candidate.id },
        undefined,
        (response) => {
          const binding = response.state.bindings.find(
            (item) => item.candidateId === candidate.id || item.relPath === candidate.relPath,
          );
          return binding ? { type: "unlink", bindingId: binding.bindingId } : null;
        },
      ),
    [performMutation],
  );

  const unlinkBinding = useCallback(
    (binding: EvidenceBinding) =>
      performMutation(
        { type: "unlink", bindingId: binding.bindingId },
        (current) => ({
          ...current,
          bindings: current.bindings.filter((item) => item.bindingId !== binding.bindingId),
        }),
      ),
    [performMutation],
  );

  const updateBinding = useCallback(
    (
      mutation: Exclude<EvidenceBinderMutation, { type: "link" | "unlink" }>,
      nextBinding: EvidenceBinding,
      inverse: EvidenceBinderMutation,
    ) =>
      performMutation(
        mutation,
        (current) => ({
          ...current,
          bindings: current.bindings.map((item) =>
            item.bindingId === nextBinding.bindingId ? nextBinding : item,
          ),
        }),
        () => inverse,
      ),
    [performMutation],
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
        <div className="evidence-binder__header-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              if (!undoMutation) return;
              const mutation = undoMutation;
              setUndoMutation(null);
              void performMutation(mutation);
            }}
            title={t("rightPane.evidence.undo")}
            aria-label={t("rightPane.evidence.undo")}
            disabled={!undoMutation || saving}
          >
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void load()}
            title={t("rightPane.evidence.refresh")}
            aria-label={t("rightPane.evidence.refresh")}
            disabled={saving}
          >
            <RefreshCcw size={14} />
          </button>
        </div>
      </header>

      <div className="evidence-binder__meta">
        <span>{t("rightPane.evidence.candidates", { count: candidates.length })}</span>
        <span>{t("rightPane.evidence.linked", { count: state?.bindings.length ?? 0 })}</span>
        {orphanBindings.length > 0 ? (
          <span>{t("rightPane.evidence.orphans", { count: orphanBindings.length })}</span>
        ) : null}
        {saving ? <span>{t("rightPane.evidence.saving")}</span> : null}
      </div>

      {loading ? <div className="outline-empty">{t("rightPane.evidence.loading")}</div> : null}
      {!loading && candidates.length === 0 && orphanBindings.length === 0 ? (
        <div className="outline-empty">{t("rightPane.evidence.empty")}</div>
      ) : null}

      <div className="evidence-binder__list">
        {candidates.map((candidate) => {
          const binding = bindingByCandidateId.get(candidate.id) ?? null;
          return (
            <EvidenceCard
              key={candidate.id}
              candidate={candidate}
              binding={binding}
              suggestions={suggestions}
              disabled={saving || loading}
              onBind={() => void bindCandidate(candidate)}
              onUnlink={unlinkBinding}
              onUpdate={updateBinding}
            />
          );
        })}
        {orphanBindings.map((binding) => (
          <EvidenceCard
            key={binding.bindingId}
            candidate={null}
            binding={binding}
            suggestions={suggestions}
            disabled={saving || loading}
            onBind={() => undefined}
            onUnlink={unlinkBinding}
            onUpdate={updateBinding}
          />
        ))}
      </div>
    </section>
  );
}

interface EvidenceCardProps {
  candidate: EvidenceBinderCandidate | null;
  binding: EvidenceBinding | null;
  suggestions: EvidenceTargetSuggestions;
  disabled: boolean;
  onBind: () => void;
  onUnlink: (binding: EvidenceBinding) => void;
  onUpdate: (
    mutation: Exclude<EvidenceBinderMutation, { type: "link" | "unlink" }>,
    nextBinding: EvidenceBinding,
    inverse: EvidenceBinderMutation,
  ) => void;
}

function EvidenceCard({
  candidate,
  binding,
  suggestions,
  disabled,
  onBind,
  onUnlink,
  onUpdate,
}: EvidenceCardProps) {
  const { t } = useTranslation();
  const failedChecks = candidate?.validationChecks.filter((check) => check.status === "fail") ?? [];
  const locallyVerified = binding?.localVerificationStatus === "verified";
  const canVerify = Boolean(
    candidate && candidateCanBeLocallyVerified(candidate, binding),
  );
  const canInclude = Boolean(binding && bindingCanBeIncluded(binding, candidate));
  const title =
    candidate?.title ?? binding?.relPath ?? t("rightPane.evidence.orphanTitle");
  const relPath = candidate?.relPath ?? binding?.relPath ?? "";

  return (
    <article className={binding ? "evidence-card linked" : "evidence-card"}>
      <div className="evidence-card__main" title={relPath}>
        <span className="evidence-card__icon">
          {candidate ? (
            binding ? (
              <CheckCircle2 size={16} />
            ) : (
              <FileText size={16} />
            )
          ) : (
            <FileQuestion size={16} />
          )}
        </span>
        <span className="evidence-card__copy">
          <strong>{title}</strong>
          <small>{relPath}</small>
        </span>
      </div>

      {candidate ? (
        <>
          <div className="evidence-card__meta">
            <span>{candidate.source}</span>
            <span>{evidenceCandidateSummary(candidate)}</span>
            <span>{t(`rightPane.evidence.sidecar.${candidate.sidecarStatus}`)}</span>
            {candidate.businessUnit ? <span>{candidate.businessUnit}</span> : null}
          </div>
          {candidate.hwpFieldLabels.length > 0 ? (
            <div className="evidence-card__fields">
              {candidate.hwpFieldLabels.map((label, index) => (
                <span key={`${label}-${index}`}>{label}</span>
              ))}
            </div>
          ) : null}
          {candidate.summary ? <p>{candidate.summary}</p> : null}
          {failedChecks.length > 0 ? (
            <div className="evidence-card__warning">
              {failedChecks.map((check) => check.reason ?? check.name).join(" · ")}
            </div>
          ) : null}
        </>
      ) : (
        <div className="evidence-card__warning">{t("rightPane.evidence.orphanHelp")}</div>
      )}

      {!binding ? (
        <div className="evidence-card__actions">
          <button type="button" onClick={onBind} disabled={disabled}>
            <Link2 size={12} />
            {t("rightPane.evidence.bind")}
          </button>
        </div>
      ) : (
        <>
          <BindingEditor
            binding={binding}
            suggestions={suggestions}
            disabled={disabled}
            onUpdate={onUpdate}
          />
          <div className="evidence-card__actions">
            <button
              type="button"
              onClick={() => {
                const verified = !locallyVerified;
                onUpdate(
                  { type: "setLocalVerified", bindingId: binding.bindingId, verified },
                  {
                    ...binding,
                    localVerificationStatus: verified ? "verified" : "unverified",
                    verifiedAt: verified ? new Date().toISOString() : null,
                    includeInSubmission: verified ? binding.includeInSubmission : false,
                    submissionSelectedAt: verified ? binding.submissionSelectedAt : null,
                  },
                  {
                    type: "setLocalVerified",
                    bindingId: binding.bindingId,
                    verified: locallyVerified,
                  },
                );
              }}
              disabled={disabled || (!locallyVerified && !canVerify)}
              aria-pressed={locallyVerified}
            >
              <ShieldCheck size={12} />
              {locallyVerified
                ? t("rightPane.evidence.unverify")
                : t("rightPane.evidence.verify")}
            </button>
            <button
              type="button"
              onClick={() => {
                const include = !binding.includeInSubmission;
                onUpdate(
                  {
                    type: "setIncludeInSubmission",
                    bindingId: binding.bindingId,
                    include,
                  },
                  {
                    ...binding,
                    includeInSubmission: include,
                    submissionSelectedAt: include ? new Date().toISOString() : null,
                  },
                  {
                    type: "setIncludeInSubmission",
                    bindingId: binding.bindingId,
                    include: binding.includeInSubmission,
                  },
                );
              }}
              disabled={disabled || (!binding.includeInSubmission && !canInclude)}
              aria-pressed={binding.includeInSubmission}
            >
              <ClipboardCheck size={12} />
              {binding.includeInSubmission
                ? t("rightPane.evidence.excludeSubmission")
                : t("rightPane.evidence.includeSubmission")}
            </button>
            <button type="button" onClick={() => onUnlink(binding)} disabled={disabled}>
              <Unlink2 size={12} />
              {candidate ? t("rightPane.evidence.unbind") : t("rightPane.evidence.remove")}
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function BindingEditor({
  binding,
  suggestions,
  disabled,
  onUpdate,
}: Pick<EvidenceCardProps, "suggestions" | "disabled" | "onUpdate"> & {
  binding: EvidenceBinding;
}) {
  const { t } = useTranslation();
  const [sections, setSections] = useState(binding.sectionBindings.join(", "));
  const [kpis, setKpis] = useState(binding.kpiBindings.join(", "));
  const [checklist, setChecklist] = useState(
    binding.submissionChecklistBindings.join(", "),
  );
  const [note, setNote] = useState(binding.note ?? "");

  useEffect(() => {
    setSections(binding.sectionBindings.join(", "));
    setKpis(binding.kpiBindings.join(", "));
    setChecklist(binding.submissionChecklistBindings.join(", "));
    setNote(binding.note ?? "");
  }, [binding]);

  const nextTargets = {
    sectionBindings: splitEvidenceTargets(sections),
    kpiBindings: splitEvidenceTargets(kpis),
    submissionChecklistBindings: splitEvidenceTargets(checklist),
  };
  const targetsDirty =
    JSON.stringify(nextTargets.sectionBindings) !== JSON.stringify(binding.sectionBindings) ||
    JSON.stringify(nextTargets.kpiBindings) !== JSON.stringify(binding.kpiBindings) ||
    JSON.stringify(nextTargets.submissionChecklistBindings) !==
      JSON.stringify(binding.submissionChecklistBindings);
  const noteDirty = note.trim() !== (binding.note ?? "");
  const listPrefix = binding.bindingId.replace(/[^A-Za-z0-9_-]/g, "-");

  return (
    <div className="evidence-card__editor">
      <TargetInput
        label={t("rightPane.evidence.sections")}
        value={sections}
        onChange={setSections}
        suggestions={suggestions.sections}
        listId={`${listPrefix}-sections`}
        disabled={disabled}
      />
      <TargetInput
        label={t("rightPane.evidence.kpis")}
        value={kpis}
        onChange={setKpis}
        suggestions={suggestions.kpis}
        listId={`${listPrefix}-kpis`}
        disabled={disabled}
      />
      <TargetInput
        label={t("rightPane.evidence.checklist")}
        value={checklist}
        onChange={setChecklist}
        suggestions={suggestions.checklist}
        listId={`${listPrefix}-checklist`}
        disabled={disabled}
      />
      <label>
        <span>{t("rightPane.evidence.note")}</span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={disabled}
          maxLength={2000}
          rows={2}
        />
      </label>
      <div className="evidence-card__editor-actions">
        <button
          type="button"
          disabled={disabled || !targetsDirty}
          onClick={() =>
            onUpdate(
              { type: "setTargets", bindingId: binding.bindingId, ...nextTargets },
              { ...binding, ...nextTargets },
              {
                type: "setTargets",
                bindingId: binding.bindingId,
                sectionBindings: binding.sectionBindings,
                kpiBindings: binding.kpiBindings,
                submissionChecklistBindings: binding.submissionChecklistBindings,
              },
            )
          }
        >
          {t("rightPane.evidence.saveTargets")}
        </button>
        <button
          type="button"
          disabled={disabled || !noteDirty}
          onClick={() =>
            onUpdate(
              { type: "setNote", bindingId: binding.bindingId, note },
              { ...binding, note: note.trim() || null },
              { type: "setNote", bindingId: binding.bindingId, note: binding.note },
            )
          }
        >
          {t("rightPane.evidence.saveNote")}
        </button>
      </div>
    </div>
  );
}

function TargetInput({
  label,
  value,
  onChange,
  suggestions,
  listId,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  listId: string;
  disabled: boolean;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        list={listId}
        disabled={disabled}
      />
      <datalist id={listId}>
        {suggestions.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>
    </label>
  );
}
