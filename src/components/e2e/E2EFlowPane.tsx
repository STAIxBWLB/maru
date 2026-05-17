import {
  CheckCircle2,
  Database,
  Download,
  FileText,
  Loader2,
  Play,
  RefreshCcw,
  Route,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import {
  E2E_FLOW_BASELINE_AVERAGE_MS,
  readE2EFlow,
  runE2EFlow,
  summarizeE2EArtifacts,
  type E2EFlowArtifacts,
} from "../../lib/e2eFlow";
import { Button } from "../ui/Button";

interface E2EFlowPaneProps {
  workPath: string | null;
  onRevealPath?: (path: string) => void;
  onError: (message: string | null) => void;
}

const stepLabels = [
  "e2e.step.sample",
  "e2e.step.confirm",
  "e2e.step.register",
  "e2e.step.edit",
  "e2e.step.execute",
  "e2e.step.report",
  "e2e.step.slides",
  "e2e.step.save",
  "e2e.step.requery",
];

export function E2EFlowPane({ workPath, onRevealPath, onError }: E2EFlowPaneProps) {
  const { t } = useTranslation();
  const [result, setResult] = useState<E2EFlowArtifacts | null>(null);
  const [lookup, setLookup] = useState<E2EFlowArtifacts | null>(null);
  const [busy, setBusy] = useState<"run" | "lookup" | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const summary = useMemo(() => (result ? summarizeE2EArtifacts(result) : null), [result]);
  const canRun = Boolean(workPath) && busy === null;
  const canLookup = Boolean(workPath && result) && busy === null;

  const runFlow = async () => {
    if (!workPath) {
      const message = t("e2e.error.noWorkspace");
      setLocalError(message);
      onError(message);
      return;
    }
    setBusy("run");
    setLocalError(null);
    onError(null);
    try {
      const next = await runE2EFlow({
        workPath,
        baselineAverageMs: E2E_FLOW_BASELINE_AVERAGE_MS,
      });
      setResult(next);
      setLookup(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(null);
    }
  };

  const lookupResult = async () => {
    if (!workPath || !result) return;
    setBusy("lookup");
    setLocalError(null);
    onError(null);
    try {
      setLookup(
        await readE2EFlow({
          workPath,
          runId: result.metadata.localStorageResult.id,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(null);
    }
  };

  const download = (kind: "report" | "slides") => {
    if (!result) return;
    const content = kind === "report" ? result.reportMarkdown : result.slidesHtml;
    const extension = kind === "report" ? "md" : "html";
    const mime = kind === "report" ? "text/markdown" : "text/html";
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${result.metadata.localStorageResult.id}-${kind}.${extension}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="e2e-pane" aria-label={t("e2e.title")} data-testid="e2e-flow-pane">
      <header className="e2e-hero">
        <div>
          <span className="e2e-kicker">{t("e2e.kicker")}</span>
          <h1>{t("e2e.title")}</h1>
          <p>{t("e2e.subtitle")}</p>
        </div>
        <div className="e2e-actions">
          <Button
            variant="primary"
            icon={busy === "run" ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
            onClick={runFlow}
            disabled={!canRun}
            data-testid="e2e-run"
          >
            {t("e2e.run")}
          </Button>
          <Button
            icon={busy === "lookup" ? <Loader2 size={15} className="spin" /> : <RefreshCcw size={15} />}
            onClick={lookupResult}
            disabled={!canLookup}
            data-testid="e2e-lookup"
          >
            {t("e2e.lookup")}
          </Button>
        </div>
      </header>

      <div className="e2e-grid">
        <article className="e2e-card e2e-sample-card">
          <div className="e2e-card-title">
            <FileText size={16} />
            <h2>{t("e2e.sample.title")}</h2>
          </div>
          <p>{t("e2e.sample.description")}</p>
          <dl className="e2e-meta-list">
            <div>
              <dt>{t("e2e.sample.path")}</dt>
              <dd>{result?.metadata.sampleInput.path ?? "anchor-weekly-meeting.md"}</dd>
            </div>
            <div>
              <dt>{t("e2e.sample.kind")}</dt>
              <dd>{result?.metadata.sampleInput.kind ?? "meeting-notes/requirements"}</dd>
            </div>
          </dl>
        </article>

        <article className="e2e-card e2e-steps-card">
          <div className="e2e-card-title">
            <Route size={16} />
            <h2>{t("e2e.sequence.title")}</h2>
          </div>
          <ol className="e2e-step-list">
            {stepLabels.map((key, index) => (
              <li key={key} className={result ? "complete" : index === 0 ? "active" : ""}>
                <span>{index + 1}</span>
                <strong>{t(key)}</strong>
              </li>
            ))}
          </ol>
        </article>

        <article className="e2e-card e2e-skill-card">
          <div className="e2e-card-title">
            <CheckCircle2 size={16} />
            <h2>{t("e2e.skill.title")}</h2>
          </div>
          <dl className="e2e-meta-list compact">
            <div>
              <dt>{t("e2e.skill.name")}</dt>
              <dd>{result?.metadata.skillLifecycle.skillName ?? "anchor-e2e-sample"}</dd>
            </div>
            <div>
              <dt>{t("e2e.skill.status")}</dt>
              <dd>{result ? t("e2e.skill.complete") : t("e2e.skill.pending")}</dd>
            </div>
            <div>
              <dt>{t("e2e.skill.runId")}</dt>
              <dd>{result?.metadata.skillLifecycle.runId ?? "—"}</dd>
            </div>
          </dl>
        </article>

        <article className="e2e-card e2e-preview-card">
          <div className="e2e-card-title">
            <FileText size={16} />
            <h2>{t("e2e.report.title")}</h2>
          </div>
          <pre data-testid="e2e-report-preview">
            {result?.reportMarkdown ?? t("e2e.report.empty")}
          </pre>
          <Button
            size="sm"
            icon={<Download size={14} />}
            onClick={() => download("report")}
            disabled={!result}
            data-testid="e2e-download-report"
          >
            {t("e2e.report.download")}
          </Button>
        </article>

        <article className="e2e-card e2e-preview-card">
          <div className="e2e-card-title">
            <FileText size={16} />
            <h2>{t("e2e.slides.title")}</h2>
          </div>
          <iframe
            title={t("e2e.slides.preview")}
            data-testid="e2e-slide-preview"
            srcDoc={result?.slidesHtml ?? `<p>${t("e2e.slides.empty")}</p>`}
          />
          <Button
            size="sm"
            icon={<Download size={14} />}
            onClick={() => download("slides")}
            disabled={!result}
            data-testid="e2e-download-slides"
          >
            {t("e2e.slides.download")}
          </Button>
        </article>

        <article className="e2e-card e2e-storage-card">
          <div className="e2e-card-title">
            <Database size={16} />
            <h2>{t("e2e.storage.title")}</h2>
          </div>
          <dl className="e2e-meta-list compact">
            <div>
              <dt>{t("e2e.storage.id")}</dt>
              <dd data-testid="e2e-save-id">{summary?.id ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("e2e.storage.status")}</dt>
              <dd>{summary?.status ?? t("e2e.storage.pending")}</dd>
            </div>
            <div>
              <dt>{t("e2e.storage.files")}</dt>
              <dd>{summary?.files.join(", ") ?? "—"}</dd>
            </div>
          </dl>
          {result?.metadata.localStorageResult.directory ? (
            <Button
              size="sm"
              onClick={() => onRevealPath?.(result.metadata.localStorageResult.directory)}
            >
              {t("e2e.storage.reveal")}
            </Button>
          ) : null}
        </article>
      </div>

      <footer className="e2e-footer">
        <div data-testid="e2e-performance-summary">
          <strong>{t("e2e.performance.title")}</strong>
          <span>
            {result
              ? t("e2e.performance.summary", {
                  baseline: result.metadata.performanceBaseline.totalMs.toFixed(2),
                  result: result.timings.totalMs.toFixed(2),
                })
              : t("e2e.performance.pending")}
          </span>
        </div>
        <div data-testid="e2e-lookup-status">
          <strong>{t("e2e.lookup.title")}</strong>
          <span>
            {lookup
              ? t("e2e.lookup.complete", { id: lookup.metadata.localStorageResult.id })
              : t("e2e.lookup.pending")}
          </span>
        </div>
        {localError ? <p className="e2e-error">{localError}</p> : null}
      </footer>
    </section>
  );
}
