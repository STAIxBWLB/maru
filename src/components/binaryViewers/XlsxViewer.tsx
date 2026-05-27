import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import {
  assetUrlForPath,
  formatBytes,
  INLINE_XLSX_MAX_BYTES,
  XLSX_MAX_COLS,
  XLSX_MAX_ROWS,
  XLSX_MAX_SHEETS,
} from "../../lib/binaryViewer";
import { useTranslation } from "../../lib/i18n";
import type { WorkspaceFileEntry } from "../../lib/types";

interface Props {
  entry: WorkspaceFileEntry;
}

interface SheetPreview {
  name: string;
  html: string;
  truncated: boolean;
}

export function XlsxViewer({ entry }: Props) {
  const { t } = useTranslation();
  const [sheets, setSheets] = useState<SheetPreview[] | null>(null);
  const [active, setActive] = useState(0);
  const [sheetLimitReached, setSheetLimitReached] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    setActive(0);
    setSheetLimitReached(false);
    setError(null);
    if (entry.sizeBytes > INLINE_XLSX_MAX_BYTES) return () => {
      cancelled = true;
    };

    (async () => {
      try {
        const response = await fetch(assetUrlForPath(entry.path));
        if (!response.ok) {
          throw new Error(`Failed to fetch spreadsheet: HTTP ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        if (cancelled) return;
        const xlsx = await import("xlsx");
        if (cancelled) return;
        const workbook = xlsx.read(arrayBuffer, { type: "array" });
        const sheetLimit = workbook.SheetNames.length > XLSX_MAX_SHEETS;
        const previews: SheetPreview[] = workbook.SheetNames.slice(0, XLSX_MAX_SHEETS).map((name) => {
          const sheet = workbook.Sheets[name];
          if (!sheet) return { name, html: "", truncated: false };
          const range = xlsx.utils.decode_range(sheet["!ref"] ?? "A1:A1");
          const cappedRange = {
            s: range.s,
            e: {
              r: Math.min(range.e.r, range.s.r + XLSX_MAX_ROWS - 1),
              c: Math.min(range.e.c, range.s.c + XLSX_MAX_COLS - 1),
            },
          };
          const truncated = range.e.r > cappedRange.e.r || range.e.c > cappedRange.e.c;
          const raw = xlsx.utils.sheet_to_html(sheet, {
            id: name,
            range: xlsx.utils.encode_range(cappedRange),
          } as Parameters<typeof xlsx.utils.sheet_to_html>[1] & { range: string });
          const sanitized = DOMPurify.sanitize(raw, {
            USE_PROFILES: { html: true },
          });
          return { name, html: sanitized, truncated };
        });
        if (!cancelled) {
          setSheetLimitReached(sheetLimit);
          setSheets(previews);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [entry.path, entry.sizeBytes]);

  if (entry.sizeBytes > INLINE_XLSX_MAX_BYTES) {
    return (
      <div className="binary-viewer binary-viewer--xlsx">
        <div className="binary-viewer-error">
          {t("binaryViewer.largeFileInline", {
            size: formatBytes(entry.sizeBytes),
            limit: formatBytes(INLINE_XLSX_MAX_BYTES),
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
  if (sheets === null) {
    return <div className="binary-viewer-loading">{t("binaryViewer.loading")}</div>;
  }
  if (sheets.length === 0) {
    return <div className="binary-viewer-empty">{t("binaryViewer.empty")}</div>;
  }
  const current = sheets[Math.min(active, sheets.length - 1)] ?? sheets[0];

  return (
    <div className="binary-viewer binary-viewer--xlsx">
      <div className="binary-viewer-toolbar binary-viewer-tabs" role="tablist" aria-label={t("binaryViewer.sheets")}>
        {sheets.map((sheet, index) => (
          <button
            type="button"
            key={sheet.name + index}
            role="tab"
            aria-selected={index === active}
            className={index === active ? "is-active" : undefined}
            onClick={() => setActive(index)}
          >
            {sheet.name}
          </button>
        ))}
        {sheetLimitReached || sheets.some((sheet) => sheet.truncated) ? (
          <span className="binary-viewer-toolbar-note">
            {t("binaryViewer.spreadsheetTruncated", {
              sheets: XLSX_MAX_SHEETS,
              rows: XLSX_MAX_ROWS,
              cols: XLSX_MAX_COLS,
            })}
          </span>
        ) : null}
      </div>
      <div
        key={current.name + active}
        className="binary-viewer-canvas binary-viewer-canvas--xlsx"
        dangerouslySetInnerHTML={{ __html: current.html }}
      />
    </div>
  );
}
