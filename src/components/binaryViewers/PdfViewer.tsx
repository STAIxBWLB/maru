import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { assetUrlForPath } from "../../lib/binaryViewer";
import { useTranslation } from "../../lib/i18n";
import type { WorkspaceFileEntry } from "../../lib/types";

interface Props {
  entry: WorkspaceFileEntry;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

type PdfDocument = {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
  destroy: () => Promise<void>;
};

type PdfPage = {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }) => { promise: Promise<void>; cancel: () => void };
};

let pdfjsReadyPromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsReadyPromise) {
    pdfjsReadyPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return pdfjs;
    })();
  }
  return pdfjsReadyPromise;
}

export function PdfViewer({ entry }: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const docRef = useRef<PdfDocument | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setErrorMessage(null);
    setPageNumber(1);

    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (cancelled) return;
        const loadingTask = pdfjs.getDocument({ url: assetUrlForPath(entry.path) });
        const doc = (await loadingTask.promise) as unknown as PdfDocument;
        if (cancelled) {
          await doc.destroy().catch(() => undefined);
          return;
        }
        if (docRef.current) {
          await docRef.current.destroy().catch(() => undefined);
        }
        docRef.current = doc;
        setTotalPages(doc.numPages);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      if (docRef.current) {
        docRef.current.destroy().catch(() => undefined);
        docRef.current = null;
      }
    };
  }, [entry.path]);

  useEffect(() => {
    if (status !== "ready") return;
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas) return;
    let cancelled = false;

    (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: zoom * (window.devicePixelRatio || 1) });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / (window.devicePixelRatio || 1)}px`;
        canvas.style.height = `${viewport.height / (window.devicePixelRatio || 1)}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        renderTaskRef.current?.cancel();
        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setErrorMessage(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [pageNumber, zoom, status]);

  const setZoomStep = (direction: 1 | -1) => {
    setZoom((current) => {
      const idx = ZOOM_STEPS.findIndex((v) => v >= current);
      const baseIdx = idx === -1 ? ZOOM_STEPS.length - 1 : idx;
      const nextIdx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, baseIdx + direction));
      return ZOOM_STEPS[nextIdx];
    });
  };

  if (status === "loading") {
    return <div className="binary-viewer-loading">{t("binaryViewer.loading")}</div>;
  }
  if (status === "error") {
    return (
      <div className="binary-viewer-error">
        {t("binaryViewer.loadError", { message: errorMessage ?? "" })}
      </div>
    );
  }
  return (
    <div className="binary-viewer binary-viewer--pdf">
      <div className="binary-viewer-toolbar">
        <button
          type="button"
          onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
          disabled={pageNumber <= 1}
          aria-label={t("binaryViewer.prevPage")}
        >
          <ChevronLeft size={14} />
        </button>
        <span className="binary-viewer-page-label">
          {t("binaryViewer.pageOf", { current: pageNumber, total: totalPages })}
        </span>
        <button
          type="button"
          onClick={() => setPageNumber((p) => Math.min(totalPages, p + 1))}
          disabled={pageNumber >= totalPages}
          aria-label={t("binaryViewer.nextPage")}
        >
          <ChevronRight size={14} />
        </button>
        <span className="binary-viewer-toolbar-spacer" />
        <button type="button" onClick={() => setZoomStep(-1)} aria-label={t("binaryViewer.zoomOut")}>
          <ZoomOut size={14} />
        </button>
        <button type="button" onClick={() => setZoom(1)} aria-label={t("binaryViewer.zoomReset")}>
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" onClick={() => setZoomStep(1)} aria-label={t("binaryViewer.zoomIn")}>
          <ZoomIn size={14} />
        </button>
      </div>
      <div className="binary-viewer-canvas binary-viewer-canvas--pdf">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
