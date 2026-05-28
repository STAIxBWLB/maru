import { useEffect, useState } from "react";
import { RotateCw, ZoomIn, ZoomOut, Maximize } from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import { assetUrlForPath } from "../../lib/binaryViewer";
import type { WorkspaceFileEntry } from "../../lib/types";

interface Props {
  entry: WorkspaceFileEntry;
}

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export function ImageViewer({ entry }: Props) {
  const { t } = useTranslation();
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    setZoom("fit");
    setRotation(0);
  }, [entry.path]);

  const stepZoom = (direction: 1 | -1) => {
    setZoom((current) => {
      const currentValue = current === "fit" ? 1 : current;
      const idx = ZOOM_STEPS.findIndex((v) => v >= currentValue);
      const baseIdx = idx === -1 ? ZOOM_STEPS.length - 1 : idx;
      const nextIdx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, baseIdx + direction));
      return ZOOM_STEPS[nextIdx];
    });
  };

  const url = assetUrlForPath(entry.path);

  return (
    <div className="binary-viewer binary-viewer--image">
      <div className="binary-viewer-toolbar">
        <button type="button" onClick={() => stepZoom(-1)} aria-label={t("binaryViewer.zoomOut")}>
          <ZoomOut size={14} />
        </button>
        <button type="button" onClick={() => stepZoom(1)} aria-label={t("binaryViewer.zoomIn")}>
          <ZoomIn size={14} />
        </button>
        <button type="button" onClick={() => setZoom("fit")} aria-label={t("binaryViewer.fit")}>
          <Maximize size={14} />
        </button>
        <button
          type="button"
          onClick={() => setRotation((r) => (r + 90) % 360)}
          aria-label={t("binaryViewer.rotate")}
        >
          <RotateCw size={14} />
        </button>
        <span className="binary-viewer-zoom-label">
          {zoom === "fit" ? t("binaryViewer.fit") : `${Math.round(zoom * 100)}%`}
        </span>
      </div>
      <div className="binary-viewer-canvas binary-viewer-canvas--image">
        <img
          src={url}
          alt={entry.name}
          style={{
            transform: `rotate(${rotation}deg) ${zoom === "fit" ? "" : `scale(${zoom})`}`,
            maxWidth: zoom === "fit" ? "100%" : "none",
            maxHeight: zoom === "fit" ? "100%" : "none",
            transformOrigin: "center center",
            transition: "transform 120ms ease",
          }}
        />
      </div>
    </div>
  );
}
