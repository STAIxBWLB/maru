import {
  forwardRef,
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bold,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Underline,
  Undo2,
  Unlink,
} from "lucide-react";
import { prepareHtmlEditorAssets } from "../lib/api";
import { assetUrlForPath } from "../lib/binaryViewer";
import {
  HTML_VISUAL_MAX_BYTES,
  HTML_VISUAL_MAX_NODES,
  analyzeHtmlEnvelope,
  bodyHasUnpreservableMarkup,
  buildRuntimeDocument,
  checkVisualLimits,
  detectRiskyMarkup,
  digestSource,
  restoreSerializedBody,
  sanitizeEditableFragment,
  serializeVisualBody,
  type HtmlEnvelope,
} from "../lib/htmlDocument";
import { useTranslation } from "../lib/i18n";
import { splitFrontmatter } from "../lib/wikilinks";

export interface HtmlEditorFlushHandle {
  /** Synchronously serialize the iframe body and emit onChange. Returns the
   *  serialized full document, or null when the iframe is not available. */
  flushNow: () => string | null;
}

export interface HtmlVisualEditorProps {
  value: string;
  onChange: (content: string) => void;
  readOnly?: boolean;
  readOnlyReason?: string | null;
  vaultPath: string;
  documentPath: string;
  riskAckDigest?: string | null;
  onRiskAck: (digest: string) => void;
  onRequestSourceMode: () => void;
}

const EDIT_COMMANDS = [
  "undo",
  "redo",
  "bold",
  "italic",
  "underline",
  "strikeThrough",
  "insertOrderedList",
  "insertUnorderedList",
  "createLink",
  "unlink",
  "removeFormat",
  "formatBlock",
] as const;

const LINK_URL_RE = /^(https?:|mailto:)/i;

function isAllowedLinkUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("//")) return false;
  if (LINK_URL_RE.test(trimmed)) return true;
  // Relative URL: no scheme allowed.
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

/** Loads the canonical document directory for runtime asset resolution. */
function useHtmlAssetDirectory(vaultPath: string, documentPath: string) {
  const [documentDirectory, setDocumentDirectory] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setFailed(false);
    setDocumentDirectory(null);
    prepareHtmlEditorAssets(vaultPath, documentPath)
      .then((result) => {
        if (cancelled) return;
        setDocumentDirectory(result.documentDirectory || null);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath, documentPath]);

  return { documentDirectory, ready, failed };
}

export const HtmlVisualEditor = forwardRef<HtmlEditorFlushHandle, HtmlVisualEditorProps>(
  function HtmlVisualEditor(
    {
      value,
      onChange,
      readOnly = false,
      readOnlyReason = null,
      vaultPath,
      documentPath,
      riskAckDigest = null,
      onRiskAck,
      onRequestSourceMode,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const latestValueRef = useRef(value);
    const lastEmittedRef = useRef<string | null>(null);
    const loadedValueRef = useRef<string | null>(null);
    const envelopeRef = useRef<HtmlEnvelope | null>(null);
    const dirtyRef = useRef(false);
    const serializeTimerRef = useRef<number | null>(null);
    const sessionAckedRef = useRef(false);

    const { documentDirectory, ready: assetsReady, failed: assetsFailed } =
      useHtmlAssetDirectory(vaultPath, documentPath);

    const [runtimeDoc, setRuntimeDoc] = useState<{
      html: string;
      blockedAssets: number;
    } | null>(null);
    const [buildError, setBuildError] = useState(false);
    const [supported, setSupported] = useState<Record<string, boolean>>({});

    useEffect(() => {
      latestValueRef.current = value;
    }, [value]);

    // (Re)build the runtime document only when the value changes externally —
    // never in response to our own serialized output, or the iframe would
    // reload on every keystroke.
    useEffect(() => {
      if (!assetsReady) return;
      if (value === loadedValueRef.current) return;
      if (value === lastEmittedRef.current) {
        loadedValueRef.current = value;
        return;
      }
      const [, bodyContent] = splitFrontmatter(value);
      envelopeRef.current = analyzeHtmlEnvelope(bodyContent);
      dirtyRef.current = false;
      sessionAckedRef.current = false;
      try {
        const built = buildRuntimeDocument(bodyContent, {
          documentDirectory,
          toAssetUrl: assetUrlForPath,
        });
        setRuntimeDoc({ html: built.html, blockedAssets: built.blockedAssets });
        setBuildError(false);
      } catch {
        setRuntimeDoc(null);
        setBuildError(true);
      }
      loadedValueRef.current = value;
    }, [value, assetsReady, documentDirectory]);

    const envelope = envelopeRef.current;
    const limits = useMemo(() => checkVisualLimits(value), [value]);
    const risks = useMemo(() => detectRiskyMarkup(value), [value]);
    // Body markup the runtime pipeline strips destructively (scripts, frames,
    // handlers, forms, ...) cannot survive a Visual round-trip — editing would
    // silently delete it, so those documents are Source-only.
    const bodyUnpreservable = useMemo(
      () => (envelope ? bodyHasUnpreservableMarkup(envelope.bodyInner) : false),
      [envelope],
    );

    const acked =
      sessionAckedRef.current ||
      (riskAckDigest != null &&
        loadedValueRef.current != null &&
        riskAckDigest === digestSource(loadedValueRef.current));
    const needsRiskConfirm = risks.length > 0 && !acked;

    // No editing until the risk overlay is acknowledged. A ref lets the (once-
    // per-load) iframe handler read the current value, and the effect flips the
    // live body the moment the user acks (which does not reload the iframe).
    const editable = !readOnly && !needsRiskConfirm;
    const editableRef = useRef(editable);
    useEffect(() => {
      editableRef.current = editable;
      const body = iframeRef.current?.contentDocument?.body;
      if (body) body.contentEditable = editable ? "true" : "false";
    }, [editable]);

    const serializeNow = useCallback((): string | null => {
      const body = iframeRef.current?.contentDocument?.body;
      const currentEnvelope = envelopeRef.current;
      const loaded = loadedValueRef.current;
      if (!body || !currentEnvelope || loaded == null) return null;
      const clone = body.cloneNode(true) as HTMLElement;
      restoreSerializedBody(clone);
      const [frontmatter] = splitFrontmatter(latestValueRef.current);
      const next = serializeVisualBody({
        originalDraft: loaded,
        envelope: currentEnvelope,
        frontmatter,
        dirty: dirtyRef.current,
        bodyInner: clone.innerHTML,
      });
      lastEmittedRef.current = next;
      onChange(next);
      return next;
    }, [onChange]);

    useImperativeHandle(ref, () => ({ flushNow: serializeNow }), [serializeNow]);

    // Latest serializeNow for the unmount cleanup, which runs with []-deps and
    // would otherwise capture a stale closure.
    const serializeNowRef = useRef(serializeNow);
    useEffect(() => {
      serializeNowRef.current = serializeNow;
    }, [serializeNow]);

    const scheduleSerialize = useCallback(() => {
      if (serializeTimerRef.current != null) {
        window.clearTimeout(serializeTimerRef.current);
      }
      serializeTimerRef.current = window.setTimeout(() => {
        serializeTimerRef.current = null;
        serializeNow();
      }, 300);
    }, [serializeNow]);

    useEffect(
      () => () => {
        // A pending debounced edit would otherwise be lost on unmount (tab
        // switch, document change) — flush it synchronously first.
        if (serializeTimerRef.current != null) {
          window.clearTimeout(serializeTimerRef.current);
          serializeTimerRef.current = null;
          serializeNowRef.current();
        }
      },
      [],
    );

    const handleBodyInput = useCallback(() => {
      dirtyRef.current = true;
      scheduleSerialize();
    }, [scheduleSerialize]);

    const handleIframeLoad = useCallback(() => {
      const doc = iframeRef.current?.contentDocument;
      if (!doc?.body) return;
      doc.body.contentEditable = editableRef.current ? "true" : "false";
      const map: Record<string, boolean> = {};
      for (const command of EDIT_COMMANDS) {
        try {
          map[command] = Boolean(doc.queryCommandSupported?.(command));
        } catch {
          map[command] = false;
        }
      }
      setSupported(map);
      doc.body.addEventListener("input", handleBodyInput);
      // Sanitize pasted HTML before it enters the editable body: strip on*
      // handlers, javascript:/vbscript:/data:text/html URLs, and <script> so
      // hostile markup can never be persisted (inert in-app, but the saved
      // .html opens elsewhere). Plain-text pastes fall through untouched.
      doc.body.addEventListener("paste", (event) => {
        const clip = (event as ClipboardEvent).clipboardData;
        const html = clip?.getData("text/html");
        if (!html) return;
        event.preventDefault();
        const holder = doc.createElement("div");
        holder.innerHTML = html;
        sanitizeEditableFragment(holder);
        doc.execCommand("insertHTML", false, holder.innerHTML);
        handleBodyInput();
      });
      // Never navigate the editing surface: links and forms stay inert.
      doc.addEventListener("click", (event) => {
        const anchor = (event.target as HTMLElement | null)?.closest?.("a");
        if (anchor) event.preventDefault();
      });
      doc.addEventListener("submit", (event) => event.preventDefault());
    }, [handleBodyInput]);

    const exec = useCallback(
      (command: string, arg?: string) => {
        const doc = iframeRef.current?.contentDocument;
        if (!doc || readOnly) return;
        try {
          doc.execCommand(command, false, arg);
        } catch {
          return;
        }
        dirtyRef.current = true;
        scheduleSerialize();
      },
      [readOnly, scheduleSerialize],
    );

    const handleCreateLink = useCallback(() => {
      const url = window.prompt(t("editor.html.link.prompt"));
      if (url == null) return;
      if (!isAllowedLinkUrl(url)) {
        window.alert(t("editor.html.link.invalid"));
        return;
      }
      exec("createLink", url.trim());
    }, [exec, t]);

    if (!assetsReady) {
      return (
        <div className="html-editor-state" data-testid="html-editor-loading" role="status">
          {t("editor.html.state.loading")}
        </div>
      );
    }

    if (buildError) {
      return (
        <div className="html-editor-state" data-testid="html-editor-error" role="alert">
          <p>{t("editor.html.state.error")}</p>
          <button type="button" className="html-editor-state-action" onClick={onRequestSourceMode}>
            {t("editor.html.openInSource")}
          </button>
        </div>
      );
    }

    if (envelope?.kind === "malformed") {
      return (
        <div className="html-editor-state" data-testid="html-editor-malformed" role="alert">
          <p>{t("editor.html.state.malformed")}</p>
          <button type="button" className="html-editor-state-action" onClick={onRequestSourceMode}>
            {t("editor.html.openInSource")}
          </button>
        </div>
      );
    }

    if (bodyUnpreservable) {
      return (
        <div className="html-editor-state" data-testid="html-editor-unpreservable" role="alert">
          <p>{t("editor.html.state.unpreservable")}</p>
          <button type="button" className="html-editor-state-action" onClick={onRequestSourceMode}>
            {t("editor.html.openInSource")}
          </button>
        </div>
      );
    }

    if (!limits.ok) {
      const limitLabel =
        limits.reason === "bytes"
          ? `${Math.round(HTML_VISUAL_MAX_BYTES / (1024 * 1024))} MiB`
          : `${HTML_VISUAL_MAX_NODES.toLocaleString()} nodes`;
      return (
        <div className="html-editor-state" data-testid="html-editor-over-limit" role="alert">
          <p>{t("editor.html.state.overLimit", { limit: limitLabel })}</p>
          <button type="button" className="html-editor-state-action" onClick={onRequestSourceMode}>
            {t("editor.html.openInSource")}
          </button>
        </div>
      );
    }

    const isEmpty = (envelope?.bodyInner ?? "").trim() === "";

    return (
      <div className="html-editor" data-testid="html-visual-editor">
        <div className="html-editor-toolbar" role="toolbar" aria-label={t("editor.html.toolbar.format")}>
          <ToolbarButton
            icon={<Undo2 size={14} />}
            label={t("editor.html.toolbar.undo")}
            disabled={readOnly || !supported.undo}
            onClick={() => exec("undo")}
          />
          <ToolbarButton
            icon={<Redo2 size={14} />}
            label={t("editor.html.toolbar.redo")}
            disabled={readOnly || !supported.redo}
            onClick={() => exec("redo")}
          />
          <select
            className="html-editor-format"
            aria-label={t("editor.html.toolbar.format")}
            disabled={readOnly || !supported.formatBlock}
            defaultValue="p"
            onMouseDown={(event) => event.stopPropagation()}
            onChange={(event) => {
              const tag = event.target.value;
              exec("formatBlock", tag === "p" ? "<p>" : `<${tag}>`);
            }}
          >
            <option value="p">{t("editor.html.format.paragraph")}</option>
            <option value="h1">{t("editor.html.format.heading1")}</option>
            <option value="h2">{t("editor.html.format.heading2")}</option>
            <option value="h3">{t("editor.html.format.heading3")}</option>
            <option value="blockquote">{t("editor.html.format.quote")}</option>
          </select>
          <ToolbarButton
            icon={<Bold size={14} />}
            label={t("editor.html.toolbar.bold")}
            disabled={readOnly || !supported.bold}
            onClick={() => exec("bold")}
          />
          <ToolbarButton
            icon={<Italic size={14} />}
            label={t("editor.html.toolbar.italic")}
            disabled={readOnly || !supported.italic}
            onClick={() => exec("italic")}
          />
          <ToolbarButton
            icon={<Underline size={14} />}
            label={t("editor.html.toolbar.underline")}
            disabled={readOnly || !supported.underline}
            onClick={() => exec("underline")}
          />
          <ToolbarButton
            icon={<Strikethrough size={14} />}
            label={t("editor.html.toolbar.strike")}
            disabled={readOnly || !supported.strikeThrough}
            onClick={() => exec("strikeThrough")}
          />
          <ToolbarButton
            icon={<ListOrdered size={14} />}
            label={t("editor.html.toolbar.orderedList")}
            disabled={readOnly || !supported.insertOrderedList}
            onClick={() => exec("insertOrderedList")}
          />
          <ToolbarButton
            icon={<List size={14} />}
            label={t("editor.html.toolbar.unorderedList")}
            disabled={readOnly || !supported.insertUnorderedList}
            onClick={() => exec("insertUnorderedList")}
          />
          <ToolbarButton
            icon={<LinkIcon size={14} />}
            label={t("editor.html.toolbar.link")}
            disabled={readOnly || !supported.createLink}
            onClick={handleCreateLink}
          />
          <ToolbarButton
            icon={<Unlink size={14} />}
            label={t("editor.html.toolbar.unlink")}
            disabled={readOnly || !supported.unlink}
            onClick={() => exec("unlink")}
          />
          <ToolbarButton
            icon={<RemoveFormatting size={14} />}
            label={t("editor.html.toolbar.removeFormat")}
            disabled={readOnly || !supported.removeFormat}
            onClick={() => exec("removeFormat")}
          />
        </div>

        {assetsFailed || (runtimeDoc?.blockedAssets ?? 0) > 0 ? (
          <div className="html-editor-asset-warning" data-testid="html-editor-asset-warning" role="status">
            {t("editor.html.state.assetWarning", { count: runtimeDoc?.blockedAssets ?? 0 })}
          </div>
        ) : null}
        {isEmpty ? (
          <div className="html-editor-asset-warning" data-testid="html-editor-empty" role="status">
            {t("editor.html.state.empty")}
          </div>
        ) : null}

        <div className="html-editor-frame-wrap">
          {runtimeDoc ? (
            <iframe
              ref={iframeRef}
              className="html-editor-frame"
              data-testid="html-editor-frame"
              sandbox="allow-same-origin"
              srcDoc={runtimeDoc.html}
              title={documentPath}
              onLoad={handleIframeLoad}
            />
          ) : null}

          {needsRiskConfirm ? (
            <div className="html-editor-risk-overlay" data-testid="html-editor-risk" role="alertdialog">
              <div className="html-editor-risk-card">
                <h3>{t("editor.html.risk.title")}</h3>
                <p>
                  {t("editor.html.risk.body", {
                    items: risks.map((risk) => t(`editor.html.risk.item.${risk}`)).join(", "),
                  })}
                </p>
                <div className="html-editor-risk-actions">
                  <button
                    type="button"
                    className="html-editor-state-action"
                    onClick={() => {
                      sessionAckedRef.current = true;
                      onRiskAck(digestSource(latestValueRef.current));
                    }}
                  >
                    {t("editor.html.risk.confirm")}
                  </button>
                  <button
                    type="button"
                    className="html-editor-state-action secondary"
                    onClick={onRequestSourceMode}
                  >
                    {t("editor.html.risk.cancel")}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {readOnly && readOnlyReason ? (
          <div className="html-editor-readonly-note">{readOnlyReason}</div>
        ) : null}
      </div>
    );
  },
);

function ToolbarButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="html-editor-tool"
      title={label}
      aria-label={label}
      disabled={disabled}
      // Keep the iframe selection alive while the toolbar is used.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

export interface HtmlPreviewFrameProps {
  value: string;
  vaultPath: string;
  documentPath: string;
  title: string;
}

/** Read-only sandboxed render of an HTML draft. Reuses the same runtime
 *  safety pipeline as Visual mode (scripts/handlers stripped, CSP injected),
 *  but with a fully locked-down sandbox and no editing surface. */
export function HtmlPreviewFrame({ value, vaultPath, documentPath, title }: HtmlPreviewFrameProps) {
  const { t } = useTranslation();
  const deferredValue = useDeferredValue(value);
  const { documentDirectory, ready } = useHtmlAssetDirectory(vaultPath, documentPath);

  const built = useMemo(() => {
    if (!ready) return null;
    const [, bodyContent] = splitFrontmatter(deferredValue);
    try {
      return buildRuntimeDocument(bodyContent, {
        documentDirectory,
        toAssetUrl: assetUrlForPath,
      });
    } catch {
      return null;
    }
  }, [deferredValue, ready, documentDirectory]);

  if (!built) {
    return (
      <div className="html-editor-state" data-testid="html-preview-loading" role="status">
        {t("editor.html.state.loading")}
      </div>
    );
  }

  return (
    <iframe
      className="html-editor-frame html-preview-frame"
      data-testid="html-preview-frame"
      sandbox=""
      srcDoc={built.html}
      title={title}
    />
  );
}
