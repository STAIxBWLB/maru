/**
 * AI diagram generation dialog (issue #433 P1).
 *
 * Drives the pipeline in `src/lib/diagram/generation.ts` from Diagram mode:
 * build a job with the base memory revision injected, run it through the
 * agent host (`generationHost.ts`), preview the typed proposal (candidate
 * summary + categorized diff + engine receipt + diagnostics), then apply:
 *
 * - New diagram (no selection): project the candidate, reflow with
 *   `layoutDoc`, and hand a fresh `DiagramDoc` to `onImportDoc` (DiagramMode's
 *   `handleImportDoc`, which resets file identity).
 * - Scoped edit (active selection): re-check the base revision and gate
 *   through `prepareProposalApply`; a stale base shows the stale state, an
 *   applied proposal is committed as exactly one `withSnapshot` undo entry.
 *
 * The engine validation step degrades gracefully: an unavailable engine
 * surfaces as the typed ENGINE_UNAVAILABLE diagnostic and the Mermaid paste
 * import path (agent- and engine-free) keeps working.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { isEngineUnavailable } from "../../../lib/archify";
import { diagramRevision } from "../../../lib/diagram";
import { withSnapshot } from "../../../lib/diagram/actions";
import {
  createGenerationJob,
  markStaleIfBaseChanged,
  runGenerationJob,
  type GenerationHost,
  type GenerationJob,
} from "../../../lib/diagram/generation";
import { createGenerationHost } from "../../../lib/diagram/generationHost";
import { layoutDoc } from "../../../lib/diagram/layout";
import { mermaidToDocDetailed } from "../../../lib/diagram/mermaid";
import { serializeDoc } from "../../../lib/diagram/persistence";
import {
  diffProposal,
  isBlockingDiagnostic,
  prepareProposalApply,
  projectSemanticCandidate,
} from "../../../lib/diagram/proposal";
import type { SemanticDiagramType } from "../../../lib/diagram/reportTypes";
import { createDiagramId, createEmptyDoc, type DiagramDoc } from "../../../lib/diagram/types";
import type { ValidationDiagnostic } from "../../../lib/diagram/validation";
import { useTranslation, type Locale } from "../../../lib/i18n";
import { useShellSettings } from "../../../lib/shellSettingsStore";
import { useDiagramCoalescer, useDiagramStore } from "../DiagramStoreContext";

export interface GenerateDiagramDialogProps {
  open: boolean;
  /** Selected node ids at open time; a non-empty list scopes the generation. */
  selectionNodeIds: string[];
  workPath: string | null;
  onImportDoc: (doc: DiagramDoc) => void;
  onClose: () => void;
  /** Test seam: a stubbed host replaces the real agent/engine host. */
  hostOverride?: (GenerationHost & { cancel?: () => void }) | null;
}

type ApplyMessage =
  | { kind: "stale" }
  | { kind: "invalid"; diagnostics: ValidationDiagnostic[] }
  | null;

function specEntryCount(candidate: NonNullable<GenerationJob["candidate"]>, field: string): number {
  const value = candidate.spec[field];
  return Array.isArray(value) ? value.length : 0;
}

function specTitle(candidate: NonNullable<GenerationJob["candidate"]>): string {
  const meta = candidate.spec.meta;
  if (typeof meta === "object" && meta !== null) {
    const title = (meta as Record<string, unknown>).title;
    if (typeof title === "string") return title;
  }
  return "";
}

export function GenerateDiagramDialog({
  open,
  selectionNodeIds,
  workPath,
  onImportDoc,
  onClose,
  hostOverride = null,
}: GenerateDiagramDialogProps) {
  const { t, locale } = useTranslation();
  const store = useDiagramStore();
  const coalescer = useDiagramCoalescer();
  const aiSettings = useShellSettings().ai;

  const scoped = selectionNodeIds.length > 0;

  const [diagramType, setDiagramType] = useState<SemanticDiagramType>("architecture");
  const [requirements, setRequirements] = useState("");
  const [mermaid, setMermaid] = useState("");
  const [outputLocale, setOutputLocale] = useState<Locale>(locale);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [engineUnavailable, setEngineUnavailable] = useState(false);
  const [applyMessage, setApplyMessage] = useState<ApplyMessage>(null);
  const [applying, setApplying] = useState(false);
  const [mermaidPreview, setMermaidPreview] = useState<{
    doc: DiagramDoc;
    diagnostics: ValidationDiagnostic[];
  } | null>(null);

  const cancelledRef = useRef(false);
  const hostRef = useRef<(GenerationHost & { cancel?: () => void }) | null>(null);

  // Clear transient run state whenever the dialog opens; keep the form so a
  // failed run can be retried without retyping.
  useEffect(() => {
    if (!open) return;
    setJob(null);
    setEngineUnavailable(false);
    setApplyMessage(null);
    setApplying(false);
    setMermaidPreview(null);
    cancelledRef.current = false;
    hostRef.current = null;
    setOutputLocale(locale);
  }, [open, locale]);

  const busy = job?.state === "running" || job?.state === "validating";

  const cancelRun = () => {
    cancelledRef.current = true;
    hostRef.current?.cancel?.();
  };

  const handleClose = () => {
    if (busy) cancelRun();
    onClose();
  };

  const handleRun = async () => {
    const doc = store.getState().doc;
    const scope = scoped ? new Set(selectionNodeIds) : null;
    const baseMemoryRevision = scope ? await diagramRevision(serializeDoc(doc)) : "";
    const lockedNodeIds = doc.nodes.filter((node) => node.locked === true).map((node) => node.id);
    const base = createGenerationJob({
      diagramType,
      prompt: {
        requirements,
        ...(mermaid.trim().length > 0 ? { mermaid } : {}),
        locale: outputLocale,
      },
      doc,
      baseMemoryRevision,
      scope,
      lockedNodeIds,
    });
    const host =
      hostOverride ??
      createGenerationHost({
        workPath,
        runtime: aiSettings.defaultRuntime,
        commandOverride: aiSettings.commandOverrides[aiSettings.defaultRuntime],
        permissionMode: aiSettings.permissionMode,
        adaptivePolicy: aiSettings.adaptivePolicy ?? null,
      });
    hostRef.current = host;
    cancelledRef.current = false;
    setEngineUnavailable(false);
    setApplyMessage(null);
    setMermaidPreview(null);
    setJob(base);
    const guardedHost: GenerationHost = {
      runAgent: (promptText) => host.runAgent(promptText),
      validateCandidate: async (type, spec) => {
        try {
          return await host.validateCandidate(type, spec);
        } catch (error) {
          if (isEngineUnavailable(error)) {
            setEngineUnavailable(true);
            return { ok: false, errors: [], warnings: [] };
          }
          throw error;
        }
      },
    };
    const finalJob = await runGenerationJob(base, guardedHost, {
      onUpdate: (next) => setJob(next),
      isCancelled: () => cancelledRef.current,
    });
    setJob(finalJob);
  };

  const candidate = job?.state === "ready" ? job.candidate : undefined;
  const proposal = job?.state === "ready" ? job.proposal : undefined;

  const diff = useMemo(
    () => (job?.state === "ready" && job.proposal ? diffProposal(job.doc, job.proposal) : null),
    [job],
  );

  const blockingDiagnostics = useMemo(
    () => (proposal ? proposal.diagnostics.filter(isBlockingDiagnostic) : []),
    [proposal],
  );

  const applyDisabled = !candidate || !proposal || blockingDiagnostics.length > 0 || applying;

  const handleApplyNew = () => {
    if (!candidate) return;
    const projected = projectSemanticCandidate(candidate);
    const base = createEmptyDoc(createDiagramId("doc"));
    const draft: DiagramDoc = {
      ...base,
      docTitle: specTitle(candidate),
      nodes: projected.nodes,
      edges: projected.edges,
      datasets: [candidate],
    };
    const laidOut = layoutDoc(draft, { scope: new Set(projected.nodes.map((node) => node.id)) });
    onImportDoc(laidOut.doc);
    onClose();
  };

  const handleApplyScoped = async () => {
    if (!job || !proposal) return;
    setApplying(true);
    try {
      const state = store.getState();
      const currentRevision =
        job.meta.baseMemoryRevision === "" ? "" : await diagramRevision(serializeDoc(state.doc));
      const outcome = prepareProposalApply(state, proposal, currentRevision);
      if (outcome.status === "stale") {
        setJob((current) => (current ? markStaleIfBaseChanged(current, outcome.currentRevision) : current));
        setApplyMessage({ kind: "stale" });
        return;
      }
      if (outcome.status === "invalid") {
        setApplyMessage({ kind: "invalid", diagnostics: outcome.diagnostics });
        return;
      }
      store.setState(withSnapshot(outcome.transformer, coalescer));
      onClose();
    } finally {
      setApplying(false);
    }
  };

  const handleMermaidPreview = () => {
    const { doc: parsed, diagnostics } = mermaidToDocDetailed(mermaid);
    setMermaidPreview({ doc: parsed, diagnostics });
  };

  const handleMermaidApply = () => {
    if (!mermaidPreview) return;
    onImportDoc(mermaidPreview.doc);
    onClose();
  };

  const renderDiagnostics = (diagnostics: ValidationDiagnostic[], testid: string) => (
    <ul className="maru-diagram-ie-warnings" data-testid={testid}>
      {diagnostics.map((diagnostic, i) => (
        <li key={`${diagnostic.key}:${i}`}>{t(diagnostic.key, diagnostic.params ?? {})}</li>
      ))}
    </ul>
  );

  const nodeField = diagramType === "architecture" ? "components" : "nodes";
  const edgeField = diagramType === "architecture" ? "connections" : "edges";

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) handleClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content maru-diagram-ie-dialog">
          <div className="dialog-header">
            <Dialog.Title>{t("diagram.generate.title")}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label={t("diagram.generate.close")}
                title={t("diagram.generate.close")}
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>

          <p className="maru-diagram-ie-hint" data-testid="gen-scope">
            {scoped
              ? t("diagram.generate.scopeSelection", { count: selectionNodeIds.length })
              : t("diagram.generate.scopeNew")}
          </p>

          <label className="maru-diagram-ie-field">
            <span>{t("diagram.generate.type")}</span>
            <select
              value={diagramType}
              onChange={(e) => setDiagramType(e.target.value as SemanticDiagramType)}
              data-testid="gen-type-select"
            >
              <option value="architecture">{t("diagram.generate.typeArchitecture")}</option>
              <option value="workflow">{t("diagram.generate.typeWorkflow")}</option>
            </select>
          </label>

          <label className="maru-diagram-ie-field">
            <span>{t("diagram.generate.requirements")}</span>
            <textarea
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
              placeholder={t("diagram.generate.requirementsPlaceholder")}
              rows={4}
              data-testid="gen-requirements"
            />
          </label>

          <label className="maru-diagram-ie-field">
            <span>{t("diagram.generate.mermaidPaste")}</span>
            <textarea
              value={mermaid}
              onChange={(e) => {
                setMermaid(e.target.value);
                setMermaidPreview(null);
              }}
              placeholder={t("diagram.generate.mermaidPlaceholder")}
              rows={4}
              data-testid="gen-mermaid"
            />
          </label>

          <label className="maru-diagram-ie-field">
            <span>{t("diagram.generate.outputLanguage")}</span>
            <select
              value={outputLocale}
              onChange={(e) => setOutputLocale(e.target.value as Locale)}
              data-testid="gen-locale-select"
            >
              <option value="ko">{t("diagram.generate.languageKo")}</option>
              <option value="en">{t("diagram.generate.languageEn")}</option>
            </select>
          </label>

          {job?.state === "running" ? (
            <p className="maru-diagram-export-status" data-testid="gen-status">
              {t("diagram.generate.running")}
            </p>
          ) : null}
          {job?.state === "validating" ? (
            <p className="maru-diagram-export-status" data-testid="gen-status">
              {t("diagram.generate.validating")}
            </p>
          ) : null}
          {busy ? (
            <button type="button" onClick={cancelRun} data-testid="gen-cancel-run">
              {t("diagram.generate.cancel")}
            </button>
          ) : null}
          {job?.state === "cancelled" ? (
            <p className="maru-diagram-export-status" data-testid="gen-status">
              {t("diagram.generate.cancelled")}
            </p>
          ) : null}
          {engineUnavailable ? (
            <p className="maru-diagram-export-status is-err" data-testid="gen-engine-unavailable">
              {t("diagram.generate.engineUnavailable")}
            </p>
          ) : null}
          {job?.state === "failed" && !engineUnavailable ? (
            <p className="maru-diagram-export-status is-err" data-testid="gen-failed">
              {t("diagram.generate.failed", { message: job.error ?? "unknown" })}
            </p>
          ) : null}
          {job?.state === "stale" || applyMessage?.kind === "stale" ? (
            <p className="maru-diagram-export-status is-err" data-testid="gen-stale">
              {t("diagram.generate.stale")}
            </p>
          ) : null}
          {applyMessage?.kind === "invalid"
            ? renderDiagnostics(applyMessage.diagnostics, "gen-apply-diagnostics")
            : null}

          {mermaidPreview ? (
            <div className="maru-diagram-ie-preview" data-testid="gen-mermaid-preview">
              <p>
                {t("diagram.generate.mermaidSummary", {
                  nodes: mermaidPreview.doc.nodes.length,
                  edges: mermaidPreview.doc.edges.length,
                })}
              </p>
              {mermaidPreview.diagnostics.length > 0
                ? renderDiagnostics(mermaidPreview.diagnostics, "gen-mermaid-diagnostics")
                : null}
              <button
                type="button"
                className="maru-diagram-toolbar-primary"
                onClick={handleMermaidApply}
                data-testid="gen-mermaid-apply"
              >
                {t("diagram.generate.mermaidApply")}
              </button>
            </div>
          ) : null}

          {candidate && proposal && diff ? (
            <div className="maru-diagram-ie-preview" data-testid="gen-preview">
              <h3>{t("diagram.generate.preview")}</h3>
              <p data-testid="gen-summary">
                {t("diagram.generate.summary", {
                  type: candidate.diagramType,
                  components: specEntryCount(candidate, nodeField),
                  connections: specEntryCount(candidate, edgeField),
                })}
              </p>
              <div data-testid="gen-diff-added">
                <h4>
                  {t("diagram.generate.diffAdded", {
                    count: diff.semanticSummary.componentsAdded.length,
                  })}
                </h4>
                <ul>
                  {diff.semanticSummary.componentsAdded.map((label) => (
                    <li key={`added:${label}`}>{label}</li>
                  ))}
                </ul>
              </div>
              <div data-testid="gen-diff-removed">
                <h4>
                  {t("diagram.generate.diffRemoved", {
                    count: diff.semanticSummary.componentsRemoved.length,
                  })}
                </h4>
                <ul>
                  {diff.semanticSummary.componentsRemoved.map((label) => (
                    <li key={`removed:${label}`}>{label}</li>
                  ))}
                </ul>
              </div>
              <div data-testid="gen-diff-changed">
                <h4>
                  {t("diagram.generate.diffChanged", {
                    count: diff.semanticSummary.componentsChanged.length,
                  })}
                </h4>
                <ul>
                  {diff.semanticSummary.componentsChanged.map((label) => (
                    <li key={`changed:${label}`}>{label}</li>
                  ))}
                </ul>
              </div>
              <p data-testid="gen-diff-connections">
                {t("diagram.generate.diffConnections", {
                  added: diff.semanticSummary.connectionsAdded,
                  removed: diff.semanticSummary.connectionsRemoved,
                })}
              </p>
              {job && job.diagnostics.length > 0
                ? renderDiagnostics(job.diagnostics, "gen-diagnostics")
                : null}
              {job?.engineReceipt && job.engineReceipt.warnings.length > 0 ? (
                <ul className="maru-diagram-ie-warnings" data-testid="gen-engine-warnings">
                  {job.engineReceipt.warnings.map((warning, i) => (
                    <li key={`engine-warning:${i}`}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              {blockingDiagnostics.length > 0
                ? renderDiagnostics(blockingDiagnostics, "gen-blocking")
                : null}
            </div>
          ) : null}

          <div className="maru-diagram-ie-actions">
            <button type="button" onClick={handleClose}>
              {t("diagram.generate.close")}
            </button>
            {mermaid.trim().length > 0 ? (
              <button
                type="button"
                onClick={handleMermaidPreview}
                disabled={busy || applying}
                data-testid="gen-from-mermaid"
              >
                {t("diagram.generate.fromMermaid")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void handleRun()}
              disabled={busy || applying || requirements.trim().length === 0}
              data-testid="gen-run"
            >
              {t("diagram.generate.run")}
            </button>
            {candidate && proposal ? (
              scoped ? (
                <button
                  type="button"
                  className="maru-diagram-toolbar-primary"
                  onClick={() => void handleApplyScoped()}
                  disabled={applyDisabled}
                  data-testid="gen-apply-scoped"
                >
                  {applying ? t("diagram.generate.applying") : t("diagram.generate.applyScoped")}
                </button>
              ) : (
                <button
                  type="button"
                  className="maru-diagram-toolbar-primary"
                  onClick={handleApplyNew}
                  disabled={applyDisabled}
                  data-testid="gen-apply-new"
                >
                  {t("diagram.generate.applyNew")}
                </button>
              )
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
