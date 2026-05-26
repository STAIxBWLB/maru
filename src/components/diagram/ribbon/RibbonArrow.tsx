import { defaultCoalescer, updateEdge, withSnapshot } from "../../../lib/diagram/actions";
import type { DiagramEdge } from "../../../lib/diagram/types";
import { useTranslation } from "../../../lib/i18n";
import { useDiagram, useDiagramStore } from "../DiagramStoreContext";
import { RibbonButton, RibbonGroup, RibbonSeparator } from "./ribbonPrimitives";

export function RibbonArrow() {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const selection = useDiagram((s) => s.ephemeral.selection);
  const edges = useDiagram((s) => s.doc.edges);
  const edgeId = [...selection.edges][0] ?? null;
  const edge = edgeId ? edges.find((item) => item.id === edgeId) : null;
  const disabled = !edge;

  const patch = (next: Partial<DiagramEdge>) => {
    if (!edge) return;
    store.setState(withSnapshot(updateEdge(edge.id, next), defaultCoalescer()));
  };

  return (
    <>
      <RibbonGroup labelKey="diagram.ribbon.group.edgeRoute">
        <RibbonButton
          labelKey="diagram.edge.routeAuto"
          disabled={disabled}
          active={edge?.routeMode !== "straight"}
          onClick={() => patch({ routeMode: "auto" })}
        />
        <RibbonButton
          labelKey="diagram.edge.routeStraight"
          disabled={disabled}
          active={edge?.routeMode === "straight"}
          onClick={() => patch({ routeMode: "straight" })}
        />
        <RibbonButton
          labelKey="diagram.edge.dash.solid"
          disabled={disabled}
          active={edge?.dash !== "dashed"}
          onClick={() => patch({ dash: "solid" })}
        />
        <RibbonButton
          labelKey="diagram.edge.dash.dashed"
          disabled={disabled}
          active={edge?.dash === "dashed"}
          onClick={() => patch({ dash: "dashed" })}
        />
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.group.edgeArrows">
        <label className="anchor-diagram-ribbon-field" title={t("diagram.edge.arrowStart")}>
          <span>{t("diagram.edge.arrowStart")}</span>
          <select
            disabled={disabled}
            value={edge?.arrowStart ?? "none"}
            onChange={(event) => patch({ arrowStart: event.target.value as DiagramEdge["arrowStart"] })}
          >
            <option value="none">{t("diagram.edge.arrow.none")}</option>
            <option value="filled">{t("diagram.edge.arrow.filled")}</option>
            <option value="open">{t("diagram.edge.arrow.open")}</option>
          </select>
        </label>
        <label className="anchor-diagram-ribbon-field" title={t("diagram.edge.arrowEnd")}>
          <span>{t("diagram.edge.arrowEnd")}</span>
          <select
            disabled={disabled}
            value={edge?.arrowEnd ?? "filled"}
            onChange={(event) => patch({ arrowEnd: event.target.value as DiagramEdge["arrowEnd"] })}
          >
            <option value="none">{t("diagram.edge.arrow.none")}</option>
            <option value="filled">{t("diagram.edge.arrow.filled")}</option>
            <option value="open">{t("diagram.edge.arrow.open")}</option>
          </select>
        </label>
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.group.edgeStyle">
        <label className="anchor-diagram-ribbon-field" title={t("diagram.edge.width")}>
          <span>{t("diagram.edge.width")}</span>
          <input
            type="number"
            min={1}
            max={12}
            step={0.5}
            disabled={disabled}
            value={edge?.width ?? 1.5}
            onChange={(event) => patch({ width: Number(event.target.value) || 1.5 })}
          />
        </label>
        <label className="anchor-diagram-ribbon-field" title={t("diagram.edge.color")}>
          <span>{t("diagram.edge.color")}</span>
          <input
            type="color"
            disabled={disabled}
            value={edge?.color ?? "#475569"}
            onChange={(event) => patch({ color: event.target.value })}
          />
        </label>
      </RibbonGroup>
    </>
  );
}
