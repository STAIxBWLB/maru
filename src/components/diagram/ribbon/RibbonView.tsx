import { Magnet, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, type ChangeEvent } from "react";

import {
  setSnapSize,
  toggleSmartGuides,
  toggleSnap,
} from "../../../lib/diagram/actions";
import { useDiagram, useDiagramStore } from "../DiagramStoreContext";
import { useTranslation } from "../../../lib/i18n";
import { RibbonButton, RibbonGroup, RibbonSeparator } from "./ribbonPrimitives";

export interface RibbonViewProps {
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
  leftPaneOpen: boolean;
  rightPaneOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onSnapSizePersist?: (size: number) => void;
}

export function RibbonView({
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onFitView,
  leftPaneOpen,
  rightPaneOpen,
  onToggleLeft,
  onToggleRight,
  onSnapSizePersist,
}: RibbonViewProps) {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const snapOn = useDiagram((s) => s.ephemeral.ui.snapOn);
  const snapSize = useDiagram((s) => s.ephemeral.ui.snapSize);
  const smartGuideOn = useDiagram((s) => s.ephemeral.ui.smartGuideOn);

  const onSizeChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = parseInt(event.target.value, 10);
      if (!Number.isFinite(next)) return;
      store.setState(setSnapSize(next));
      onSnapSizePersist?.(next);
    },
    [onSnapSizePersist, store],
  );

  return (
    <>
      <RibbonGroup labelKey="diagram.ribbon.group.display">
        <RibbonButton
          labelKey="diagram.toolbar.snapSize"
          onClick={() => store.setState(toggleSnap())}
          active={snapOn}
          icon={<Magnet size={14} />}
        />
        <RibbonButton
          labelKey="diagram.toolbar.smartGuides"
          onClick={() => store.setState(toggleSmartGuides())}
          active={smartGuideOn}
        >🎯</RibbonButton>
        <label className="anchor-diagram-snap-input" title={t("diagram.toolbar.snapSize")}>
          <span>{t("diagram.toolbar.snapSize")}</span>
          <input
            type="number"
            min={1}
            max={200}
            step={1}
            value={snapSize}
            onChange={onSizeChange}
          />
        </label>
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.group.zoom">
        <RibbonButton labelKey="diagram.toolbar.zoomOut" onClick={onZoomOut} icon={<ZoomOut size={14} />} />
        <span className="anchor-diagram-zoom-label">{zoomPercent}%</span>
        <RibbonButton labelKey="diagram.toolbar.zoomIn" onClick={onZoomIn} icon={<ZoomIn size={14} />} />
        <RibbonButton labelKey="diagram.toolbar.fitView" onClick={onFitView} icon={<Maximize2 size={14} />} />
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.group.panels">
        <RibbonButton
          labelKey={leftPaneOpen ? "diagram.panel.left.hide" : "diagram.panel.left.show"}
          onClick={onToggleLeft}
          active={leftPaneOpen}
        >◧</RibbonButton>
        <RibbonButton
          labelKey={rightPaneOpen ? "diagram.panel.right.hide" : "diagram.panel.right.show"}
          onClick={onToggleRight}
          active={rightPaneOpen}
        >◨</RibbonButton>
      </RibbonGroup>
    </>
  );
}
