/**
 * Unified import/export dialog — Report Pattern Studio Phase 3.
 *
 * Replaces the format-specific ExportDialog + ImportMermaidDialog with one
 * registry-driven dialog (`CODEC_LIST`):
 *
 * - Export: pick a codec (tabular codecs require a matrix dataset), inspect
 *   the declared fidelity + computed warnings/ignored fields, then save via
 *   the existing `diagram_export_blob_to_path` bridge (or a browser
 *   download). PDF keeps the platform print flow.
 * - Import: pick a file (`.csv,.tsv,.md,.html,.json,.cmd.json,.mmd,.svg`),
 *   inspect the parse outcome (fidelity badge, warnings, ignored fields,
 *   content preview), then commit — datasets insert as a table at the
 *   pointer, docs replace the current document (dirty-doc confirmation).
 *   Oversized matrices require a row/column range before commit.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { chooseSaveFile } from "../../../lib/api";
import { diagramExportBlobToPath, type DiagramExportKind } from "../../../lib/diagram";
import {
  CODEC_LIST,
  IMPORT_ACCEPT,
  codecForFilename,
  expandMatrixToGrid,
  getCodec,
  matrixExceedsLimits,
  sliceMatrix,
  type CodecParseOutcome,
  type CodecSerializeOutcome,
} from "../../../lib/diagram/codecs";
import { exportPdf, suggestedFileName } from "../../../lib/diagram/export";
import type { MatrixDataset, ReportDataset } from "../../../lib/diagram/reportTypes";
import type { DiagramDoc } from "../../../lib/diagram/types";
import { confirmDialog } from "../../../lib/confirmDialog";
import { useTranslation } from "../../../lib/i18n";

export interface ImportExportDialogProps {
  open: boolean;
  /** Initial direction — the ribbon's Export and Import buttons open the same dialog. */
  mode: "import" | "export";
  doc: DiagramDoc;
  workspace: string | null;
  dirty: boolean;
  onImportDoc: (doc: DiagramDoc) => void;
  onImportDataset: (dataset: ReportDataset) => void;
  onClose: () => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; path: string }
  | { kind: "error"; message: string };

interface ImportState {
  filename: string;
  outcome: CodecParseOutcome;
}

interface RangeInput {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function runningInTauri(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

function matrixOf(result: CodecParseOutcome["result"]): MatrixDataset | null {
  return result.kind === "dataset" && result.dataset.kind === "matrix"
    ? (result.dataset as MatrixDataset)
    : null;
}

const PREVIEW_ROWS = 5;
const PREVIEW_COLS = 6;

function DatasetPreview({ matrix }: { matrix: MatrixDataset }) {
  const grid = expandMatrixToGrid(matrix);
  const rows = grid.slice(0, PREVIEW_ROWS);
  return (
    <table className="maru-diagram-ie-preview-grid" data-testid="ie-preview-grid">
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {row.slice(0, PREVIEW_COLS).map((cell, c) => (
              <td key={c}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ImportExportDialog({
  open,
  mode,
  doc,
  workspace,
  dirty,
  onImportDoc,
  onImportDataset,
  onClose,
}: ImportExportDialogProps) {
  const { t } = useTranslation();
  const [direction, setDirection] = useState<"import" | "export">(mode);
  const [codecId, setCodecId] = useState<string>("maru-json");
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [importState, setImportState] = useState<ImportState | null>(null);
  const [range, setRange] = useState<RangeInput | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const matrices = useMemo(
    () => (doc.datasets ?? []).filter((ds): ds is MatrixDataset => ds.kind === "matrix"),
    [doc.datasets],
  );

  const exportCodecs = useMemo(
    () =>
      CODEC_LIST.filter(
        (codec) => codec.canExport && (codec.dataKind !== "matrix" || matrices.length > 0),
      ),
    [matrices.length],
  );

  // Reset transient state whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setDirection(mode);
    setStatus({ kind: "idle" });
    setImportState(null);
    setRange(null);
    setDatasetId(matrices[0]?.id ?? null);
    setCodecId(mode === "export" ? "maru-svg" : "maru-json");
  }, [open, mode, matrices]);

  const codec = getCodec(codecId);
  const needsDataset = codec?.dataKind === "matrix";
  const effectiveDatasetId = datasetId ?? matrices[0]?.id;

  // Sync text codecs expose their warnings/ignored fields pre-export.
  const exportPreview: CodecSerializeOutcome | null = useMemo(() => {
    if (direction !== "export" || !codec?.serialize || codec.dataKind === "visual") return null;
    try {
      const out = codec.serialize({ doc, ...(needsDataset ? { datasetId: effectiveDatasetId } : {}) });
      return out instanceof Promise ? null : out;
    } catch {
      return null;
    }
  }, [direction, codec, doc, needsDataset, effectiveDatasetId]);

  const importMatrix = importState ? matrixOf(importState.outcome.result) : null;
  const oversized = importMatrix !== null && matrixExceedsLimits(importMatrix);

  useEffect(() => {
    if (!importMatrix || !matrixExceedsLimits(importMatrix)) {
      setRange(null);
      return;
    }
    setRange((prev) =>
      prev ?? {
        r1: 1,
        c1: 1,
        r2: Math.min(importMatrix.rows.length, 200),
        c2: Math.min(importMatrix.columns.length, 50),
      },
    );
  }, [importMatrix]);

  const handleFile = async (file: File) => {
    setStatus({ kind: "idle" });
    const resolved = codecForFilename(file.name);
    if (!resolved?.parse) {
      setImportState(null);
      setStatus({ kind: "error", message: t("diagram.dialog.ie.unsupportedFile") });
      return;
    }
    try {
      const text = await file.text();
      const outcome = resolved.parse(text, file.name);
      setCodecId(resolved.id);
      setImportState({ filename: file.name, outcome });
    } catch (err) {
      setImportState(null);
      setStatus({
        kind: "error",
        message: t("diagram.dialog.ie.parseFailed", {
          message: (err as Error).message ?? "unknown",
        }),
      });
    }
  };

  const handleExport = async () => {
    if (!codec) return;
    setStatus({ kind: "busy" });
    try {
      if (codec.id === "pdf") {
        // PDF keeps the platform print flow — there is no byte sink.
        await exportPdf(null as unknown as SVGSVGElement, doc);
        setStatus({ kind: "done", path: "—" });
        return;
      }
      if (!codec.serialize) throw new Error("codec_not_exportable");
      const outcome = await codec.serialize({
        doc,
        ...(needsDataset ? { datasetId: effectiveDatasetId } : {}),
      });
      const ext = codec.extensions[0]!.replace(/^\./, "");
      const fileName = suggestedFileName(doc, ext);
      const blob =
        typeof outcome.bytes === "string"
          ? new Blob([outcome.bytes])
          : new Blob([outcome.bytes as unknown as BlobPart]);
      if (workspace && runningInTauri()) {
        const defaultPath = `${workspace.replace(/[/\\]+$/, "")}/diagrams/${fileName}`;
        const targetPath = await chooseSaveFile(t("diagram.dialog.export.saveTitle"), defaultPath);
        if (!targetPath) {
          setStatus({ kind: "idle" });
          return;
        }
        const data =
          typeof outcome.bytes === "string"
            ? new TextEncoder().encode(outcome.bytes)
            : outcome.bytes;
        const path = await diagramExportBlobToPath(
          targetPath,
          (codec.exportKind ?? ext) as DiagramExportKind,
          data,
        );
        setStatus({ kind: "done", path });
      } else {
        downloadBlob(blob, fileName);
        setStatus({ kind: "done", path: fileName });
      }
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message ?? "unknown" });
    }
  };

  const handleImportConfirm = async () => {
    if (!importState) return;
    const { outcome } = importState;
    if (outcome.result.kind === "dataset") {
      let dataset = outcome.result.dataset;
      if (dataset.kind === "matrix" && matrixExceedsLimits(dataset as MatrixDataset)) {
        if (!range) return;
        const sliced = sliceMatrix(dataset as MatrixDataset, {
          r1: range.r1 - 1,
          c1: range.c1 - 1,
          r2: range.r2 - 1,
          c2: range.c2 - 1,
        });
        if (matrixExceedsLimits(sliced)) {
          setStatus({ kind: "error", message: t("diagram.dialog.ie.tooLarge") });
          return;
        }
        dataset = sliced;
      }
      onImportDataset(dataset);
    } else {
      if (dirty && !(await confirmDialog(t("diagram.dialog.ie.confirmReplace")))) return;
      onImportDoc(outcome.result.doc);
    }
    onClose();
  };

  const renderWarnings = (warnings: { key: string; params?: Record<string, string | number> }[]) => (
    <ul className="maru-diagram-ie-warnings" data-testid="ie-warnings">
      {warnings.map((warning, i) => (
        <li key={`${warning.key}:${i}`}>{t(warning.key, warning.params ?? {})}</li>
      ))}
    </ul>
  );

  const activeFidelity =
    direction === "export"
      ? (exportPreview?.fidelity ?? codec?.exportFidelity)
      : importState?.outcome.fidelity;
  const activeWarnings =
    direction === "export" ? (exportPreview?.warnings ?? []) : (importState?.outcome.warnings ?? []);
  const activeIgnored =
    direction === "export" ? exportPreview?.ignoredFields : importState?.outcome.ignoredFields;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content maru-diagram-ie-dialog">
          <div className="dialog-header">
            <Dialog.Title>
              {t(direction === "export" ? "diagram.dialog.ie.title.export" : "diagram.dialog.ie.title.import")}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label={t("diagram.dialog.export.close")}
                title={t("diagram.dialog.export.close")}
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>

          <div className="maru-diagram-ie-direction" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={direction === "import"}
              className={direction === "import" ? "is-active" : ""}
              onClick={() => setDirection("import")}
            >
              {t("diagram.dialog.ie.direction.import")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={direction === "export"}
              className={direction === "export" ? "is-active" : ""}
              onClick={() => setDirection("export")}
            >
              {t("diagram.dialog.ie.direction.export")}
            </button>
          </div>

          {direction === "export" ? (
            <>
              <label className="maru-diagram-ie-field">
                <span>{t("diagram.dialog.ie.format")}</span>
                <select
                  value={codecId}
                  onChange={(e) => setCodecId(e.target.value)}
                  data-testid="ie-format-select"
                >
                  {exportCodecs.map((fmt) => (
                    <option key={fmt.id} value={fmt.id}>
                      {t(fmt.labelKey)}
                    </option>
                  ))}
                </select>
              </label>
              {needsDataset && matrices.length > 1 ? (
                <label className="maru-diagram-ie-field">
                  <span>{t("diagram.dialog.ie.dataset")}</span>
                  <select
                    value={effectiveDatasetId ?? ""}
                    onChange={(e) => setDatasetId(e.target.value)}
                    data-testid="ie-dataset-select"
                  >
                    {matrices.map((matrix) => (
                      <option key={matrix.id} value={matrix.id}>
                        {matrix.name || matrix.id}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </>
          ) : (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept={IMPORT_ACCEPT}
                style={{ display: "none" }}
                data-testid="ie-file-input"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                data-testid="ie-pick-file"
              >
                {t("diagram.dialog.ie.pickFile")}
              </button>
              {importState ? (
                <p className="maru-diagram-ie-filename">{importState.filename}</p>
              ) : (
                <p className="maru-diagram-ie-hint">{t("diagram.dialog.ie.noFile")}</p>
              )}
            </>
          )}

          {activeFidelity ? (
            <p className="maru-diagram-ie-fidelity">
              <span
                className={`maru-diagram-ie-badge is-${activeFidelity}`}
                data-testid="ie-fidelity-badge"
              >
                {t(`diagram.codec.fidelity.${activeFidelity}`)}
              </span>
            </p>
          ) : null}
          {activeWarnings.length > 0 ? renderWarnings(activeWarnings) : null}
          {activeIgnored && activeIgnored.length > 0 ? (
            <p className="maru-diagram-ie-ignored" data-testid="ie-ignored">
              {t("diagram.dialog.ie.ignoredFields", { fields: activeIgnored.join(", ") })}
            </p>
          ) : null}

          {direction === "import" && importState ? (
            <div className="maru-diagram-ie-preview" data-testid="ie-preview">
              {importMatrix ? (
                <DatasetPreview matrix={importMatrix} />
              ) : importState.outcome.result.kind === "doc" ? (
                <p>
                  {t("diagram.dialog.ie.docSummary", {
                    nodes: importState.outcome.result.doc.nodes.length,
                    edges: importState.outcome.result.doc.edges.length,
                    datasets: (importState.outcome.result.doc.datasets ?? []).length,
                  })}
                </p>
              ) : null}
            </div>
          ) : null}

          {direction === "import" && oversized && range && importMatrix ? (
            <div className="maru-diagram-ie-range" data-testid="ie-range">
              <p className="maru-diagram-ie-hint">
                {t("diagram.dialog.ie.range.hint", {
                  rows: importMatrix.rows.length,
                  cols: importMatrix.columns.length,
                })}
              </p>
              <div className="maru-diagram-ie-range-inputs">
                <label>
                  <span>{t("diagram.dialog.ie.range.rowsFrom")}</span>
                  <input
                    type="number"
                    min={1}
                    max={importMatrix.rows.length}
                    value={range.r1}
                    data-testid="ie-range-r1"
                    onChange={(e) => setRange({ ...range, r1: Number(e.target.value) || 1 })}
                  />
                </label>
                <label>
                  <span>{t("diagram.dialog.ie.range.rowsTo")}</span>
                  <input
                    type="number"
                    min={1}
                    max={importMatrix.rows.length}
                    value={range.r2}
                    data-testid="ie-range-r2"
                    onChange={(e) => setRange({ ...range, r2: Number(e.target.value) || 1 })}
                  />
                </label>
                <label>
                  <span>{t("diagram.dialog.ie.range.colsFrom")}</span>
                  <input
                    type="number"
                    min={1}
                    max={importMatrix.columns.length}
                    value={range.c1}
                    data-testid="ie-range-c1"
                    onChange={(e) => setRange({ ...range, c1: Number(e.target.value) || 1 })}
                  />
                </label>
                <label>
                  <span>{t("diagram.dialog.ie.range.colsTo")}</span>
                  <input
                    type="number"
                    min={1}
                    max={importMatrix.columns.length}
                    value={range.c2}
                    data-testid="ie-range-c2"
                    onChange={(e) => setRange({ ...range, c2: Number(e.target.value) || 1 })}
                  />
                </label>
              </div>
            </div>
          ) : null}

          {status.kind === "busy" ? (
            <p className="maru-diagram-export-status">{t("diagram.dialog.export.busy")}</p>
          ) : null}
          {status.kind === "done" ? (
            <p className="maru-diagram-export-status is-ok">
              {t("diagram.dialog.export.done", { path: status.path })}
            </p>
          ) : null}
          {status.kind === "error" ? (
            <p className="maru-diagram-export-status is-err">
              {t("diagram.dialog.export.failed", { message: status.message })}
            </p>
          ) : null}

          <div className="maru-diagram-ie-actions">
            <button type="button" onClick={onClose}>
              {t("diagram.dialog.ie.cancel")}
            </button>
            {direction === "export" ? (
              <button
                type="button"
                className="maru-diagram-toolbar-primary"
                onClick={() => void handleExport()}
                disabled={status.kind === "busy" || (needsDataset && !effectiveDatasetId)}
                data-testid="ie-export-confirm"
              >
                {t("diagram.dialog.ie.apply.export")}
              </button>
            ) : (
              <button
                type="button"
                className="maru-diagram-toolbar-primary"
                onClick={() => void handleImportConfirm()}
                disabled={!importState}
                data-testid="ie-import-confirm"
              >
                {t("diagram.dialog.ie.apply.import")}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
