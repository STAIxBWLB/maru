import {
  Check,
  Clock3,
  ExternalLink,
  FolderOpen,
  RotateCcw,
  Save,
} from "lucide-react";
import { lazy, Suspense, useMemo, useRef } from "react";
import { documentStats } from "../lib/document";
import { isHtmlFileKind } from "../lib/htmlDocument";
import { useTranslation } from "../lib/i18n";
import { renderMarkdown } from "../lib/markdown";
import type { DocumentPayload } from "../lib/types";
import { DocumentModeSurface, type EditorViewMode, type HtmlViewMode } from "./DocumentModeSurface";
import type { HtmlEditorFlushHandle } from "./HtmlVisualEditor";
import { Button } from "./ui/Button";

const LazyRichMarkdownEditor = lazy(() =>
  import("./RichMarkdownEditor").then((module) => ({ default: module.RichMarkdownEditor })),
);
const LazyHtmlVisualEditor = lazy(() =>
  import("./HtmlVisualEditor").then((module) => ({ default: module.HtmlVisualEditor })),
);
const LazyHtmlPreviewFrame = lazy(() =>
  import("./HtmlVisualEditor").then((module) => ({ default: module.HtmlPreviewFrame })),
);

interface InlineDocumentEditorProps {
  document: DocumentPayload;
  content: string;
  mode: EditorViewMode;
  htmlMode: HtmlViewMode;
  dirty: boolean;
  saving: boolean;
  readOnly: boolean;
  readOnlyReason?: string | null;
  error?: string | null;
  vaultPath: string;
  htmlRiskAckDigest?: string | null;
  onChange: (content: string) => void;
  onModeChange: (mode: EditorViewMode) => void;
  onHtmlModeChange: (mode: HtmlViewMode) => void;
  onHtmlRiskAck: (digest: string) => void;
  onSave: (contentOverride?: string) => void | Promise<void>;
  onReload?: () => void;
  onOpenInDocuments?: () => void;
  onReveal?: () => void;
}

export function InlineDocumentEditor({
  document,
  content,
  mode,
  htmlMode,
  dirty,
  saving,
  readOnly,
  readOnlyReason,
  error,
  vaultPath,
  htmlRiskAckDigest,
  onChange,
  onModeChange,
  onHtmlModeChange,
  onHtmlRiskAck,
  onSave,
  onReload,
  onOpenInDocuments,
  onReveal,
}: InlineDocumentEditorProps) {
  const { t, locale } = useTranslation();
  const htmlFlushRef = useRef<HtmlEditorFlushHandle | null>(null);
  const isHtml = isHtmlFileKind(document.fileKind);
  const isMarkdown = /^(md|markdown)$/i.test(document.fileKind);
  const kind = isHtml ? "html" : isMarkdown ? "markdown" : "plain";
  const previewHtml = useMemo(
    () => (isMarkdown ? renderMarkdown(content) : ""),
    [content, isMarkdown],
  );
  const stats = useMemo(() => documentStats(document, content), [content, document]);

  const flushHtml = () => {
    if (!isHtml) return null;
    const flushed = htmlFlushRef.current?.flushNow() ?? null;
    if (flushed != null && flushed !== content) onChange(flushed);
    return flushed;
  };

  const handleSave = () => {
    const flushed = flushHtml();
    void onSave(flushed ?? undefined);
  };

  return (
    <section className="inline-document-editor" aria-label={document.title}>
      <header className="inline-document-editor-header">
        <div className="inline-document-editor-title">
          <strong title={document.title}>{document.title}</strong>
          <span title={document.relPath}>{document.relPath}</span>
        </div>
        <div className="inline-document-editor-actions">
          <span
            className={dirty ? "save-state dirty" : "save-state saved"}
            title={dirty ? t("editor.dirty") : t("editor.saved")}
          >
            {dirty ? <Clock3 size={12} /> : <Check size={12} />}
            {dirty ? t("editor.dirty") : t("editor.saved")}
          </span>
          {readOnly ? (
            <span className="save-state readonly" title={readOnlyReason ?? undefined}>
              {t("editor.readOnly")}
            </span>
          ) : null}
          {onReveal ? (
            <button
              type="button"
              className="icon-button"
              onClick={onReveal}
              title={t("binaryViewer.revealInFinder")}
              aria-label={t("binaryViewer.revealInFinder")}
            >
              <FolderOpen size={14} />
            </button>
          ) : null}
          {onOpenInDocuments ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenInDocuments}
              icon={<ExternalLink size={14} />}
            >
              {t("files.editor.openInDocuments")}
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={readOnly || saving || !dirty}
            icon={<Save size={14} />}
            title={readOnly ? readOnlyReason ?? undefined : undefined}
          >
            {saving ? t("editor.saving") : t("editor.save")}
          </Button>
        </div>
      </header>

      {error ? (
        <div className="inline-document-editor-error" role="alert">
          <span>{error}</span>
          <div>
            {onReload ? (
              <button type="button" onClick={onReload}>
                <RotateCcw size={13} />
                {t("files.editor.reload")}
              </button>
            ) : null}
            {onOpenInDocuments ? (
              <button type="button" onClick={onOpenInDocuments}>
                <ExternalLink size={13} />
                {t("files.editor.openInDocuments")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <DocumentModeSurface
        t={t}
        kind={kind}
        mode={isHtml ? htmlMode : mode}
        onModeChange={(next) => {
          if (isHtml) {
            flushHtml();
            onHtmlModeChange(next as HtmlViewMode);
          } else {
            onModeChange(next as EditorViewMode);
          }
        }}
        richPanel={
          <Suspense fallback={<div className="editor-loading" role="status">…</div>}>
            {isHtml ? (
              <LazyHtmlVisualEditor
                key={document.path}
                ref={htmlFlushRef}
                value={content}
                onChange={onChange}
                readOnly={readOnly}
                readOnlyReason={readOnlyReason}
                vaultPath={vaultPath}
                documentPath={document.path}
                riskAckDigest={htmlRiskAckDigest}
                onRiskAck={onHtmlRiskAck}
                onRequestSourceMode={() => onHtmlModeChange("source")}
              />
            ) : (
              <LazyRichMarkdownEditor value={content} onChange={onChange} readOnly={readOnly} />
            )}
          </Suspense>
        }
        sourcePanel={
          <div className="source-editor-wrap">
            <textarea
              className="source-editor"
              value={content}
              onChange={(event) => onChange(event.target.value)}
              readOnly={readOnly}
              spellCheck={false}
            />
          </div>
        }
        previewPanel={
          isHtml ? (
            <Suspense fallback={<div className="editor-loading" role="status">…</div>}>
              <LazyHtmlPreviewFrame
                value={content}
                vaultPath={vaultPath}
                documentPath={document.path}
                title={document.title}
              />
            </Suspense>
          ) : (
            <article
              className="preview-surface"
              tabIndex={0}
              onClick={(event) => event.currentTarget.focus()}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          )
        }
      />

      <footer className="editor-status">
        <span>{t("editor.status.lines", { count: stats.lines.toLocaleString(locale) })}</span>
        <span>{t("editor.status.words", { count: stats.words.toLocaleString(locale) })}</span>
        <span>{t("editor.status.chars", { count: stats.chars.toLocaleString(locale) })}</span>
        <span className="spacer" />
        <span>{document.fileKind.toUpperCase()}</span>
      </footer>
    </section>
  );
}
