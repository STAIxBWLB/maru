import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { assetUrlForPath, formatBytes, INLINE_DOCX_MAX_BYTES } from "../../lib/binaryViewer";
import { useTranslation } from "../../lib/i18n";
import type { WorkspaceFileEntry } from "../../lib/types";

interface Props {
  entry: WorkspaceFileEntry;
}

export function DocxViewer({ entry }: Props) {
  const { t } = useTranslation();
  const [html, setHtml] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setWarnings([]);
    setError(null);
    if (entry.sizeBytes > INLINE_DOCX_MAX_BYTES) return () => {
      cancelled = true;
    };

    (async () => {
      try {
        const response = await fetch(assetUrlForPath(entry.path));
        if (!response.ok) {
          throw new Error(`Failed to fetch DOCX: HTTP ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        if (cancelled) return;
        // Mammoth ships a self-contained browser bundle that avoids node-only deps.
        const mammothModule = (await import("mammoth/mammoth.browser.js")) as unknown as {
          default?: { convertToHtml: typeof import("mammoth").convertToHtml };
          convertToHtml?: typeof import("mammoth").convertToHtml;
        };
        if (cancelled) return;
        const mammoth = mammothModule.default ?? mammothModule;
        const convertToHtml = mammoth.convertToHtml;
        if (!convertToHtml) throw new Error("mammoth.convertToHtml unavailable");
        const result = await convertToHtml(
          { arrayBuffer },
          { includeDefaultStyleMap: true },
        );
        if (cancelled) return;
        const sanitized = DOMPurify.sanitize(result.value, {
          USE_PROFILES: { html: true },
        });
        setHtml(sanitized);
        setWarnings(result.messages.map((m) => m.message));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [entry.path, entry.sizeBytes]);

  if (entry.sizeBytes > INLINE_DOCX_MAX_BYTES) {
    return (
      <div className="binary-viewer binary-viewer--docx">
        <div className="binary-viewer-error">
          {t("binaryViewer.largeFileInline", {
            size: formatBytes(entry.sizeBytes),
            limit: formatBytes(INLINE_DOCX_MAX_BYTES),
          })}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="binary-viewer-error">
        {t("binaryViewer.loadError", { message: error })}
      </div>
    );
  }
  if (html === null) {
    return <div className="binary-viewer-loading">{t("binaryViewer.loading")}</div>;
  }
  return (
    <div className="binary-viewer binary-viewer--docx">
      <div className="binary-viewer-toolbar binary-viewer-toolbar--meta">
        <span>{t("binaryViewer.docxWarning")}</span>
        {warnings.length > 0 ? (
          <span className="binary-viewer-meta-warning">{warnings.length}</span>
        ) : null}
      </div>
      <div
        className="binary-viewer-canvas binary-viewer-canvas--docx markdown-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
