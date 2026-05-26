import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useState } from "react";

import { diagramExportBlob } from "../../../lib/diagram";
import {
  blobToUint8Array,
  exportJpg,
  exportJson,
  exportPdf,
  exportPng,
  exportPngTransparent,
  exportSvg,
  suggestedFileName,
  type ExportResult,
} from "../../../lib/diagram/export";
import { docToMermaid } from "../../../lib/diagram/mermaid";
import type { DiagramDoc } from "../../../lib/diagram/types";
import { useTranslation } from "../../../lib/i18n";

export interface ExportDialogProps {
  open: boolean;
  doc: DiagramDoc;
  workspace: string | null;
  /** Live svg element used for rasterisation. */
  getSvg: () => SVGSVGElement | null;
  onClose: () => void;
}

type FormatId = "png" | "pngTransparent" | "jpg" | "svg" | "json" | "pdf" | "mermaid";

const FORMATS: Array<{ id: FormatId; labelKey: string }> = [
  { id: "png", labelKey: "diagram.dialog.export.png" },
  { id: "pngTransparent", labelKey: "diagram.dialog.export.pngTransparent" },
  { id: "jpg", labelKey: "diagram.dialog.export.jpg" },
  { id: "svg", labelKey: "diagram.dialog.export.svg" },
  { id: "json", labelKey: "diagram.dialog.export.json" },
  { id: "pdf", labelKey: "diagram.dialog.export.pdf" },
  { id: "mermaid", labelKey: "diagram.dialog.export.mermaid" },
];

function exportMermaid(doc: DiagramDoc): ExportResult {
  const text = docToMermaid(doc);
  const blob = new Blob([text], { type: "text/markdown" });
  return { blob, width: 0, height: 0, mimeType: "text/markdown", extension: "mmd" };
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

async function runExport(
  id: FormatId,
  doc: DiagramDoc,
  svg: SVGSVGElement,
): Promise<ExportResult | null> {
  switch (id) {
    case "png":
      return exportPng(svg, doc);
    case "pngTransparent":
      return exportPngTransparent(svg, doc);
    case "jpg":
      return exportJpg(svg, doc);
    case "svg":
      return exportSvg(svg, doc);
    case "json":
      return exportJson(doc);
    case "pdf":
      await exportPdf(svg, doc);
      return null;
    case "mermaid":
      return exportMermaid(doc);
  }
}

export function ExportDialog({ open, doc, workspace, getSvg, onClose }: ExportDialogProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "busy" } | { kind: "done"; path: string } | { kind: "error"; message: string }
  >({ kind: "idle" });

  const handleClick = async (id: FormatId) => {
    setStatus({ kind: "busy" });
    try {
      const svg = getSvg();
      if (!svg) throw new Error("canvas_not_ready");
      const result = await runExport(id, doc, svg);
      if (!result) {
        setStatus({ kind: "done", path: "—" });
        return;
      }
      const fileName = suggestedFileName(doc, result.extension);
      if (workspace) {
        const bytes = await blobToUint8Array(result.blob);
        const path = await diagramExportBlob(
          workspace,
          fileName.replace(/\.[^.]+$/, ""),
          result.extension as "png" | "jpg" | "svg" | "json" | "pdf" | "mmd",
          bytes,
        );
        setStatus({ kind: "done", path });
      } else {
        downloadBlob(result.blob, fileName);
        setStatus({ kind: "done", path: fileName });
      }
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message ?? "unknown" });
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content anchor-diagram-export-dialog">
          <div className="dialog-header">
            <Dialog.Title>{t("diagram.dialog.export.title")}</Dialog.Title>
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
          <div className="anchor-diagram-export-grid">
            {FORMATS.map((fmt) => (
              <button
                key={fmt.id}
                type="button"
                onClick={() => void handleClick(fmt.id)}
                disabled={status.kind === "busy"}
              >
                {t(fmt.labelKey)}
              </button>
            ))}
          </div>
          {status.kind === "busy" ? (
            <p className="anchor-diagram-export-status">{t("diagram.dialog.export.busy")}</p>
          ) : null}
          {status.kind === "done" ? (
            <p className="anchor-diagram-export-status is-ok">
              {t("diagram.dialog.export.done", { path: status.path })}
            </p>
          ) : null}
          {status.kind === "error" ? (
            <p className="anchor-diagram-export-status is-err">
              {t("diagram.dialog.export.failed", { message: status.message })}
            </p>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
