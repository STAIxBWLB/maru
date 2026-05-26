import { BarChart3, Gauge, ListChecks } from "lucide-react";

import { defaultCoalescer, withSnapshot } from "../../../lib/diagram/actions";
import { mkNode } from "../../../lib/diagram/nodeKinds";
import type { DiagramNode, DiagramStateRoot } from "../../../lib/diagram/types";
import { useTranslation } from "../../../lib/i18n";
import { useDiagram, useDiagramStore } from "../DiagramStoreContext";
import { RibbonButton, RibbonGroup, RibbonSeparator } from "./ribbonPrimitives";

function appendNodes(nodes: DiagramNode[]) {
  return (state: DiagramStateRoot): DiagramStateRoot => ({
    ...state,
    doc: {
      ...state.doc,
      nodes: [...state.doc.nodes, ...nodes],
    },
    ephemeral: {
      ...state.ephemeral,
      selection: { nodes: new Set(nodes.map((node) => node.id)), edges: new Set() },
    },
  });
}

export function RibbonInfographic() {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const existingCount = useDiagram((s) => s.doc.nodes.length);
  const viewport = useDiagram((s) => s.ephemeral.viewport);

  const origin = () => {
    const offset = (existingCount % 8) * 18;
    return {
      x: (-viewport.px + 160) / viewport.zoom + offset,
      y: (-viewport.py + 140) / viewport.zoom + offset,
    };
  };

  const insertStatus = () => {
    const { x, y } = origin();
    const node = mkNode("titled-box", x, y, {
      title: t("diagram.info.status.title"),
      body: t("diagram.info.status.body"),
      meta: { status: "doing" },
      style: { bg: "#f8fafc", border: "#2563eb", fc: "#0f172a", br: 6 },
    });
    store.setState(withSnapshot(appendNodes([node]), defaultCoalescer()));
  };

  const insertProgress = () => {
    const { x, y } = origin();
    const node = mkNode("simple", x, y, {
      w: 220,
      h: 86,
      title: t("diagram.info.progress.title"),
      meta: { progress: 65, status: "doing" },
      style: { bg: "#ecfdf5", border: "#059669", fc: "#064e3b", br: 8 },
    });
    store.setState(withSnapshot(appendNodes([node]), defaultCoalescer()));
  };

  const insertKpi = () => {
    const { x, y } = origin();
    const nodes = [
      mkNode("titled-box", x, y, {
        w: 170,
        h: 96,
        title: t("diagram.info.kpi.one"),
        body: "72%",
        meta: { progress: 72, status: "doing" },
        style: { bg: "#eff6ff", border: "#2563eb", fc: "#1e3a8a", br: 8 },
      }),
      mkNode("titled-box", x + 190, y, {
        w: 170,
        h: 96,
        title: t("diagram.info.kpi.two"),
        body: "18",
        meta: { status: "done" },
        style: { bg: "#f0fdf4", border: "#16a34a", fc: "#14532d", br: 8 },
      }),
      mkNode("titled-box", x + 380, y, {
        w: 170,
        h: 96,
        title: t("diagram.info.kpi.three"),
        body: "4",
        meta: { status: "blocked" },
        style: { bg: "#fef2f2", border: "#dc2626", fc: "#7f1d1d", br: 8 },
      }),
    ];
    store.setState(withSnapshot(appendNodes(nodes), defaultCoalescer()));
  };

  return (
    <>
      <RibbonGroup labelKey="diagram.ribbon.group.infographic">
        <RibbonButton
          labelKey="diagram.info.status"
          onClick={insertStatus}
          icon={<ListChecks size={14} />}
        />
        <RibbonButton
          labelKey="diagram.info.progress"
          onClick={insertProgress}
          icon={<Gauge size={14} />}
        />
        <RibbonButton
          labelKey="diagram.info.kpi"
          onClick={insertKpi}
          icon={<BarChart3 size={14} />}
        />
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.group.tableMeta">
        <span className="anchor-diagram-ribbon-hint">{t("diagram.info.insertHint")}</span>
      </RibbonGroup>
    </>
  );
}
