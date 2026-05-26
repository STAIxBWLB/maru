/**
 * Diagram templates — pre-built layouts for common structures.
 *
 * Source HTML editor (`concept-map-diagram.html` lines 9784–10187) ships ~22
 * templates, including Korean-government-vocab specific ones like `jh-roadmap`
 * and `jh-pdca-grid`. Those are renamed to neutral generics here so that ko/en
 * both make sense and any user can fill in their own content.
 *
 * Each template builder takes a center anchor `(cx, cy)` and returns a partial
 * `DiagramDoc` (nodes + edges). All strings go through {@link t} so callers can
 * pre-translate to the active locale.
 */

import { defaultEdge } from "./edgeRouting";
import { mkNode } from "./nodeKinds";
import type {
  DiagramEdge,
  DiagramNode,
  EdgePort,
  NodeKind,
} from "./types";

export type Translator = (key: string, vars?: Record<string, string>) => string;

export interface TemplateBundle {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface TemplateDefinition {
  id: string;
  /** i18n key for the human label. */
  labelKey: string;
  /** i18n key for the one-line description shown in the picker. */
  descriptionKey: string;
  /** Builder — given a center anchor and the active translator. */
  build: (cx: number, cy: number, t: Translator) => TemplateBundle;
  /** Optional thumbnail viewBox (px) for the picker preview. */
  preview: { w: number; h: number };
}

let _seq = 0;
function id(prefix: string): string {
  _seq += 1;
  return `${prefix}-${_seq.toString(36)}`;
}

function makeNode(
  kind: NodeKind,
  x: number,
  y: number,
  w: number,
  h: number,
  title: string,
  style?: DiagramNode["style"],
): DiagramNode {
  return mkNode(kind, x, y, { w, h, title, style });
}

function makeEdge(
  from: string,
  fromPort: EdgePort,
  to: string,
  toPort: EdgePort,
  overrides: Partial<DiagramEdge> = {},
): DiagramEdge {
  return defaultEdge(id("edge"), from, fromPort, to, toPort, overrides);
}

const PALETTE = {
  ink: "#1A1A1A",
  dark: "#444444",
  mid: "#888888",
  light: "#EEEEEE",
  white: "#FFFFFF",
  outline: "#1F2937",
  accent: "#2563EB",
} as const;

// ---------------------------------------------------------------------------
// Template builders
// ---------------------------------------------------------------------------

function tBlank(): TemplateBundle {
  return { nodes: [], edges: [] };
}

function tPdcaCycle(cx: number, cy: number, t: Translator): TemplateBundle {
  const w = 150;
  const h = 100;
  const dx = 200;
  const dy = 140;
  const styleFor = (bg: string, fc: string): DiagramNode["style"] => ({
    bg,
    border: bg,
    fc,
    fs: 16,
    fw: 700,
  });
  const p = makeNode("simple", cx - dx / 2 - w / 2, cy - dy / 2 - h / 2, w, h,
    t("diagram.template.pdcaCycle.plan"), styleFor(PALETTE.ink, "#fff"));
  const d = makeNode("simple", cx + dx / 2 - w / 2, cy - dy / 2 - h / 2, w, h,
    t("diagram.template.pdcaCycle.do"), styleFor(PALETTE.dark, "#fff"));
  const c = makeNode("simple", cx - dx / 2 - w / 2, cy + dy / 2 - h / 2, w, h,
    t("diagram.template.pdcaCycle.check"), styleFor(PALETTE.mid, "#fff"));
  const a = makeNode("simple", cx + dx / 2 - w / 2, cy + dy / 2 - h / 2, w, h,
    t("diagram.template.pdcaCycle.act"), styleFor(PALETTE.light, "#333"));
  const nodes = [p, d, c, a];
  const edges = [
    makeEdge(p.id, "e", d.id, "w", { color: "#555" }),
    makeEdge(d.id, "s", a.id, "n", { color: "#555" }),
    makeEdge(a.id, "w", c.id, "e", { color: "#555" }),
    makeEdge(c.id, "n", p.id, "s", { color: "#555" }),
  ];
  return { nodes, edges };
}

function tPdcaGrid(cx: number, cy: number, t: Translator): TemplateBundle {
  const colW = 130;
  const labelW = 90;
  const rowH = 90;
  const rows = ["row1", "row2", "row3"];
  const x0 = cx - (labelW + colW * 4) / 2;
  const y0 = cy - (rowH * (rows.length + 1)) / 2;

  const header = makeNode("simple", x0, y0, labelW + colW * 4, 36,
    t("diagram.template.pdcaGrid.title"),
    { bg: "#333", border: "#333", fc: "#fff", fs: 13, fw: 700 });

  const corner = makeNode("simple", x0, y0 + 36, labelW, 30,
    t("diagram.template.pdcaGrid.corner"),
    { bg: PALETTE.ink, border: PALETTE.ink, fc: "#fff", fs: 11, fw: 700 });

  const headers = ["plan", "do", "check", "act"].map((step, i) =>
    makeNode("simple", x0 + labelW + i * colW, y0 + 36, colW, 30,
      t(`diagram.template.pdcaGrid.${step}`),
      { bg: PALETTE.dark, border: PALETTE.dark, fc: "#fff", fs: 11, fw: 600 }),
  );

  const rowNodes: DiagramNode[] = [];
  rows.forEach((rowKey, rIdx) => {
    const rowY = y0 + 66 + rIdx * rowH;
    rowNodes.push(makeNode("simple", x0, rowY, labelW, rowH,
      t(`diagram.template.pdcaGrid.${rowKey}`),
      { bg: PALETTE.mid, border: PALETTE.mid, fc: "#fff", fs: 11, fw: 600 }));
    for (let i = 0; i < 4; i += 1) {
      rowNodes.push(makeNode("simple", x0 + labelW + i * colW, rowY, colW, rowH,
        t(`diagram.template.pdcaGrid.cell`),
        { bg: "#fff", border: "#ccc", fc: "#333", fs: 10, align: "left", bw: 1 }));
    }
  });

  return { nodes: [header, corner, ...headers, ...rowNodes], edges: [] };
}

function tSwot(cx: number, cy: number, t: Translator): TemplateBundle {
  const w = 200;
  const h = 140;
  const gap = 12;
  const styleFor = (bg: string, fc: string, hdbg: string): DiagramNode["style"] => ({
    bg, border: PALETTE.outline, fc, fs: 11,
  });
  void styleFor;
  const sec = (x: number, y: number, key: string, headerBg: string): DiagramNode =>
    mkNode("section", x, y, {
      w, h,
      title: t(`diagram.template.swot.${key}`),
      bullets: [
        t(`diagram.template.swot.${key}.point1`),
        t(`diagram.template.swot.${key}.point2`),
      ],
      style: { bg: "#fff", border: PALETTE.outline, fc: "#1A1A1A", bw: 1.2 },
    });
  const s = sec(cx - w - gap / 2, cy - h - gap / 2, "strengths", "#22c55e");
  const we = sec(cx + gap / 2, cy - h - gap / 2, "weaknesses", "#ef4444");
  const o = sec(cx - w - gap / 2, cy + gap / 2, "opportunities", "#3b82f6");
  const tt = sec(cx + gap / 2, cy + gap / 2, "threats", "#f59e0b");
  return { nodes: [s, we, o, tt], edges: [] };
}

function tFishbone(cx: number, cy: number, t: Translator): TemplateBundle {
  const head = makeNode("oval", cx + 220, cy - 35, 160, 70,
    t("diagram.template.fishbone.head"),
    { bg: PALETTE.ink, border: PALETTE.ink, fc: "#fff", fs: 13, fw: 700 });
  const spine = makeNode("text", cx - 250, cy - 12, 480, 24, "", { fc: "#888", fs: 8 });
  const offshoots: DiagramNode[] = [];
  const labels = ["people", "process", "tools", "environment"];
  labels.forEach((key, idx) => {
    const x = cx - 250 + idx * 120;
    const y = idx % 2 === 0 ? cy - 130 : cy + 70;
    offshoots.push(makeNode("simple", x, y, 110, 50,
      t(`diagram.template.fishbone.${key}`),
      { bg: PALETTE.light, border: PALETTE.dark, fc: "#333", fs: 11, fw: 600 }));
  });
  const edges: DiagramEdge[] = offshoots.map((n, idx) =>
    makeEdge(n.id, idx % 2 === 0 ? "s" : "n", spine.id, "n", {
      routeMode: "straight", color: "#888", arrowEnd: "none",
    }),
  );
  edges.push(makeEdge(spine.id, "e", head.id, "w", { color: PALETTE.ink, width: 2 }));
  return { nodes: [spine, head, ...offshoots], edges };
}

function tMindMap(cx: number, cy: number, t: Translator): TemplateBundle {
  const center = makeNode("oval", cx - 90, cy - 35, 180, 70,
    t("diagram.template.mindMap.center"),
    { bg: PALETTE.accent, border: PALETTE.accent, fc: "#fff", fs: 14, fw: 700 });
  const branches: DiagramNode[] = [];
  const positions = [
    { dx: -260, dy: -80, key: "branchA" },
    { dx: 220, dy: -80, key: "branchB" },
    { dx: -260, dy: 60, key: "branchC" },
    { dx: 220, dy: 60, key: "branchD" },
  ];
  positions.forEach((p) => {
    branches.push(makeNode("simple", cx + p.dx, cy + p.dy, 160, 50,
      t(`diagram.template.mindMap.${p.key}`),
      { bg: PALETTE.light, border: PALETTE.dark, fc: "#1A1A1A", fs: 12, fw: 600 }));
  });
  const edges: DiagramEdge[] = branches.map((b, idx) =>
    makeEdge(center.id, idx % 2 === 0 ? "w" : "e", b.id, idx % 2 === 0 ? "e" : "w", {
      arrowEnd: "none", color: "#6b7280",
    }),
  );
  return { nodes: [center, ...branches], edges };
}

function tOrgChart(cx: number, cy: number, t: Translator): TemplateBundle {
  const root = makeNode("simple", cx - 90, cy - 110, 180, 60,
    t("diagram.template.orgChart.lead"),
    { bg: PALETTE.ink, border: PALETTE.ink, fc: "#fff", fs: 13, fw: 700 });
  const sub: DiagramNode[] = [];
  ["team1", "team2", "team3"].forEach((key, idx) => {
    sub.push(makeNode("simple", cx - 240 + idx * 180, cy + 30, 160, 60,
      t(`diagram.template.orgChart.${key}`),
      { bg: PALETTE.light, border: PALETTE.dark, fc: "#1A1A1A", fs: 12, fw: 600 }));
  });
  const edges = sub.map((s) => makeEdge(root.id, "s", s.id, "n", {
    routeMode: "auto", color: "#374151",
  }));
  return { nodes: [root, ...sub], edges };
}

function tRoadmap(cx: number, cy: number, t: Translator): TemplateBundle {
  const items = ["q1", "q2", "q3", "q4"];
  const w = 150;
  const gap = 24;
  const totalW = items.length * w + (items.length - 1) * gap;
  const startX = cx - totalW / 2;
  const y = cy - 35;
  const nodes = items.map((key, idx) =>
    makeNode("simple", startX + idx * (w + gap), y, w, 70,
      t(`diagram.template.roadmap.${key}`),
      {
        bg: idx % 2 === 0 ? PALETTE.dark : PALETTE.mid,
        border: idx % 2 === 0 ? PALETTE.dark : PALETTE.mid,
        fc: "#fff", fs: 12, fw: 700,
      }),
  );
  const edges = nodes.slice(0, -1).map((n, idx) =>
    makeEdge(n.id, "e", nodes[idx + 1]!.id, "w", {
      arrowEnd: "filled", color: "#374151", routeMode: "straight",
    }),
  );
  return { nodes, edges };
}

function tKanban(cx: number, cy: number, t: Translator): TemplateBundle {
  const cols = ["todo", "doing", "done"];
  const w = 180;
  const h = 220;
  const gap = 16;
  const totalW = cols.length * w + (cols.length - 1) * gap;
  const startX = cx - totalW / 2;
  const top = cy - h / 2;
  const colors = ["#EEEEEE", "#FEF3C7", "#DCFCE7"];
  const nodes = cols.map((key, idx) =>
    mkNode("section", startX + idx * (w + gap), top, {
      w, h,
      title: t(`diagram.template.kanban.${key}`),
      bullets: [
        t(`diagram.template.kanban.${key}.item1`),
        t(`diagram.template.kanban.${key}.item2`),
      ],
      style: { bg: colors[idx] ?? "#fff", border: PALETTE.outline, fc: "#1A1A1A", bw: 1.2 },
    }),
  );
  return { nodes, edges: [] };
}

function tKeywordGrid(cx: number, cy: number, t: Translator): TemplateBundle {
  const keys = ["keep", "expand", "improve"];
  const w = 180;
  const h = 120;
  const gap = 14;
  const totalW = keys.length * w + (keys.length - 1) * gap;
  const startX = cx - totalW / 2;
  const top = cy - 110;
  const sections = keys.map((key, idx) =>
    mkNode("section", startX + idx * (w + gap), top, {
      w, h,
      title: t(`diagram.template.keywordGrid.${key}`),
      bullets: [
        t(`diagram.template.keywordGrid.${key}.point1`),
        t(`diagram.template.keywordGrid.${key}.point2`),
      ],
      style: { bg: "#fff", border: PALETTE.outline, fc: "#1A1A1A", bw: 1.2 },
    }),
  );
  const banner = makeNode("simple", startX, top + h + 24, totalW, 40,
    t("diagram.template.keywordGrid.goal"),
    { bg: PALETTE.ink, border: PALETTE.ink, fc: "#fff", fs: 13, fw: 700 });
  return { nodes: [...sections, banner], edges: [] };
}

function tProcessFlow(cx: number, cy: number, t: Translator): TemplateBundle {
  const steps = ["start", "process", "decision", "finish"];
  const w = 130;
  const h = 70;
  const gap = 28;
  const totalW = steps.length * w + (steps.length - 1) * gap;
  const startX = cx - totalW / 2;
  const y = cy - h / 2;
  const kinds: NodeKind[] = ["oval", "simple", "diamond", "oval"];
  const nodes = steps.map((key, idx) =>
    mkNode(kinds[idx] ?? "simple", startX + idx * (w + gap), y, {
      w, h,
      title: t(`diagram.template.processFlow.${key}`),
      style: { bg: PALETTE.light, border: PALETTE.outline, fc: "#1A1A1A", fs: 12, fw: 600 },
    }),
  );
  const edges = nodes.slice(0, -1).map((n, idx) =>
    makeEdge(n.id, "e", nodes[idx + 1]!.id, "w", { color: "#374151" }),
  );
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TEMPLATE_LIST: TemplateDefinition[] = [
  {
    id: "blank",
    labelKey: "diagram.template.blank.label",
    descriptionKey: "diagram.template.blank.description",
    build: tBlank,
    preview: { w: 200, h: 120 },
  },
  {
    id: "pdca-cycle",
    labelKey: "diagram.template.pdcaCycle.label",
    descriptionKey: "diagram.template.pdcaCycle.description",
    build: tPdcaCycle,
    preview: { w: 360, h: 240 },
  },
  {
    id: "pdca-grid",
    labelKey: "diagram.template.pdcaGrid.label",
    descriptionKey: "diagram.template.pdcaGrid.description",
    build: tPdcaGrid,
    preview: { w: 520, h: 360 },
  },
  {
    id: "swot",
    labelKey: "diagram.template.swot.label",
    descriptionKey: "diagram.template.swot.description",
    build: tSwot,
    preview: { w: 420, h: 300 },
  },
  {
    id: "fishbone",
    labelKey: "diagram.template.fishbone.label",
    descriptionKey: "diagram.template.fishbone.description",
    build: tFishbone,
    preview: { w: 560, h: 280 },
  },
  {
    id: "mind-map",
    labelKey: "diagram.template.mindMap.label",
    descriptionKey: "diagram.template.mindMap.description",
    build: tMindMap,
    preview: { w: 540, h: 220 },
  },
  {
    id: "org-chart",
    labelKey: "diagram.template.orgChart.label",
    descriptionKey: "diagram.template.orgChart.description",
    build: tOrgChart,
    preview: { w: 520, h: 220 },
  },
  {
    id: "roadmap",
    labelKey: "diagram.template.roadmap.label",
    descriptionKey: "diagram.template.roadmap.description",
    build: tRoadmap,
    preview: { w: 680, h: 120 },
  },
  {
    id: "kanban",
    labelKey: "diagram.template.kanban.label",
    descriptionKey: "diagram.template.kanban.description",
    build: tKanban,
    preview: { w: 580, h: 260 },
  },
  {
    id: "keyword-grid",
    labelKey: "diagram.template.keywordGrid.label",
    descriptionKey: "diagram.template.keywordGrid.description",
    build: tKeywordGrid,
    preview: { w: 580, h: 260 },
  },
  {
    id: "process-flow",
    labelKey: "diagram.template.processFlow.label",
    descriptionKey: "diagram.template.processFlow.description",
    build: tProcessFlow,
    preview: { w: 680, h: 120 },
  },
];

export function getTemplateById(id: string): TemplateDefinition | undefined {
  return TEMPLATE_LIST.find((tpl) => tpl.id === id);
}
