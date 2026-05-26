import { memo, useCallback, type PointerEvent, type ReactElement } from "react";

import { portPoint } from "../../../lib/diagram/geometry";
import type { DiagramNode, EdgePort, NodeId } from "../../../lib/diagram/types";

export interface NodeViewProps {
  node: DiagramNode;
  selected: boolean;
  showPorts: boolean;
  pendingConnectActive: boolean;
  onPointerDown: (event: PointerEvent<SVGGElement>, nodeId: NodeId) => void;
  onPortPointerDown: (event: PointerEvent<SVGCircleElement>, nodeId: NodeId, port: EdgePort) => void;
}

const PORTS: EdgePort[] = ["n", "e", "s", "w"];

function shapeFor(node: DiagramNode): {
  bg: string;
  border: string;
  fc: string;
  fs: number;
  fw: number;
  br: number;
  bw: number;
} {
  return {
    bg: node.style?.bg ?? (node.kind === "text" ? "transparent" : "#ffffff"),
    border: node.style?.border ?? (node.kind === "text" ? "transparent" : "#1f2937"),
    fc: node.style?.fc ?? "#111827",
    fs: node.style?.fs ?? (node.kind === "text" ? 13 : 12),
    fw: node.style?.fw ?? (node.kind === "text" ? 500 : 600),
    br: node.style?.br ?? 4,
    bw: node.style?.bw ?? (node.kind === "text" ? 0 : 1.5),
  };
}

function polygonPath(points: Array<[number, number]>): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`).join(" ") + " Z";
}

function NodeBody({ node }: { node: DiagramNode }) {
  const s = shapeFor(node);
  const w = node.w;
  const h = node.h;
  const headerH = 26;

  switch (node.kind) {
    case "simple":
    case "numbered":
      return (
        <>
          <rect width={w} height={h} rx={s.br} ry={s.br} fill={s.bg} stroke={s.border} strokeWidth={s.bw} />
          {node.kind === "numbered" ? (
            <g>
              <circle cx={14} cy={14} r={9} fill="#1f2937" />
              <text x={14} y={18} textAnchor="middle" fontSize={10} fontWeight={700} fill="#ffffff">
                {(node.meta?.number as string | number | undefined) ?? "1"}
              </text>
            </g>
          ) : null}
        </>
      );
    case "text":
      return null;
    case "diamond":
      return (
        <path
          d={polygonPath([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]])}
          fill={s.bg}
          stroke={s.border}
          strokeWidth={s.bw}
        />
      );
    case "oval":
      return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} fill={s.bg} stroke={s.border} strokeWidth={s.bw} />;
    case "hexagon": {
      const off = Math.min(w * 0.18, h / 2);
      return (
        <path
          d={polygonPath([
            [off, 0],
            [w - off, 0],
            [w, h / 2],
            [w - off, h],
            [off, h],
            [0, h / 2],
          ])}
          fill={s.bg}
          stroke={s.border}
          strokeWidth={s.bw}
        />
      );
    }
    case "cylinder": {
      const ear = Math.min(14, h * 0.18);
      return (
        <g>
          <path
            d={`M 0 ${ear} A ${w / 2} ${ear} 0 0 1 ${w} ${ear} L ${w} ${h - ear} A ${w / 2} ${ear} 0 0 1 0 ${h - ear} Z`}
            fill={s.bg}
            stroke={s.border}
            strokeWidth={s.bw}
          />
          <path
            d={`M 0 ${ear} A ${w / 2} ${ear} 0 0 0 ${w} ${ear}`}
            fill="none"
            stroke={s.border}
            strokeWidth={s.bw}
          />
        </g>
      );
    }
    case "callout": {
      const tailW = Math.min(20, w * 0.18);
      const tailH = Math.min(18, h * 0.25);
      return (
        <path
          d={`M ${s.br} 0 H ${w - s.br} Q ${w} 0 ${w} ${s.br} V ${h - tailH - s.br} Q ${w} ${h - tailH} ${w - s.br} ${h - tailH} H ${tailW + 16} L ${tailW + 8} ${h} L ${tailW + 4} ${h - tailH} H ${s.br} Q 0 ${h - tailH} 0 ${h - tailH - s.br} V ${s.br} Q 0 0 ${s.br} 0 Z`}
          fill={s.bg}
          stroke={s.border}
          strokeWidth={s.bw}
        />
      );
    }
    case "section":
    case "titled-box":
      return (
        <g>
          <rect width={w} height={h} rx={s.br} ry={s.br} fill={s.bg} stroke={s.border} strokeWidth={s.bw} />
          <rect
            width={w}
            height={headerH}
            rx={s.br}
            ry={s.br}
            fill={node.style?.bg ? "#1f2937" : "#1f2937"}
            stroke={s.border}
            strokeWidth={s.bw}
          />
          <rect width={w} height={headerH - s.br} fill="#1f2937" />
        </g>
      );
    case "split-box": {
      const mid = w / 2;
      return (
        <g>
          <rect width={w} height={h} rx={s.br} ry={s.br} fill={s.bg} stroke={s.border} strokeWidth={s.bw} />
          <line x1={mid} y1={0} x2={mid} y2={h} stroke={s.border} strokeWidth={s.bw} />
        </g>
      );
    }
    case "table": {
      const rows = Math.max(1, Number(node.meta?.rows) || 3);
      const cols = Math.max(1, Number(node.meta?.cols) || 3);
      const cellW = w / cols;
      const cellH = h / rows;
      const lines: ReactElement[] = [];
      for (let i = 1; i < cols; i += 1) {
        lines.push(<line key={`v${i}`} x1={i * cellW} y1={0} x2={i * cellW} y2={h} stroke={s.border} strokeWidth={1} />);
      }
      for (let j = 1; j < rows; j += 1) {
        lines.push(<line key={`h${j}`} x1={0} y1={j * cellH} x2={w} y2={j * cellH} stroke={s.border} strokeWidth={1} />);
      }
      return (
        <g>
          <rect width={w} height={h} rx={s.br} ry={s.br} fill={s.bg} stroke={s.border} strokeWidth={s.bw} />
          {lines}
        </g>
      );
    }
    case "image":
      return (
        <g>
          <rect width={w} height={h} rx={s.br} ry={s.br} fill={s.bg} stroke={s.border} strokeWidth={s.bw} />
          {node.meta?.src ? (
            <image
              href={node.meta.src as string}
              x={0}
              y={0}
              width={w}
              height={h}
              preserveAspectRatio="xMidYMid meet"
            />
          ) : null}
        </g>
      );
    default:
      return <rect width={w} height={h} rx={s.br} ry={s.br} fill={s.bg} stroke={s.border} strokeWidth={s.bw} />;
  }
}

function NodeLabel({ node }: { node: DiagramNode }) {
  if (!node.title && !node.body) return null;
  const s = shapeFor(node);
  const headerH = node.kind === "section" || node.kind === "titled-box" ? 26 : 0;
  const padTop = node.kind === "numbered" ? 24 : 0;
  return (
    <foreignObject
      x={node.kind === "numbered" ? padTop : 0}
      y={headerH}
      width={Math.max(0, node.w - (node.kind === "numbered" ? padTop : 0))}
      height={Math.max(0, node.h - headerH)}
      pointerEvents="none"
    >
      <div
        className="anchor-diagram-node-label"
        style={{
          color: s.fc,
          fontSize: s.fs,
          fontWeight: s.fw,
          textAlign: node.style?.align ?? "center",
        }}
      >
        {node.title ?? ""}
      </div>
    </foreignObject>
  );
}

function SectionHeader({ node }: { node: DiagramNode }) {
  if (node.kind !== "section" && node.kind !== "titled-box") return null;
  return (
    <foreignObject x={0} y={0} width={node.w} height={26} pointerEvents="none">
      <div
        className="anchor-diagram-node-header"
        style={{
          color: node.style?.fc ?? "#ffffff",
          fontSize: (node.style?.fs ?? 12) + 1,
          fontWeight: 700,
          textAlign: "center",
        }}
      >
        {node.title ?? ""}
      </div>
    </foreignObject>
  );
}

function NodeViewBase({
  node,
  selected,
  showPorts,
  pendingConnectActive,
  onPointerDown,
  onPortPointerDown,
}: NodeViewProps) {
  const s = shapeFor(node);
  const handlePointerDown = useCallback(
    (event: PointerEvent<SVGGElement>) => onPointerDown(event, node.id),
    [node.id, onPointerDown],
  );

  const portsVisible = showPorts || pendingConnectActive || selected;

  return (
    <g
      transform={`translate(${node.x},${node.y})`}
      className={`anchor-diagram-node${selected ? " is-selected" : ""}${pendingConnectActive ? " is-connect-target" : ""}`}
      data-node-id={node.id}
      onPointerDown={handlePointerDown}
    >
      <NodeBody node={node} />
      <SectionHeader node={node} />
      <NodeLabel node={node} />
      {selected ? (
        <rect
          x={-3}
          y={-3}
          width={node.w + 6}
          height={node.h + 6}
          rx={(s.br ?? 4) + 2}
          ry={(s.br ?? 4) + 2}
          fill="none"
          stroke="#2563eb"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          pointerEvents="none"
        />
      ) : null}
      {portsVisible
        ? PORTS.map((port) => {
            const pt = portPoint(node, port);
            return (
              <circle
                key={port}
                className="anchor-diagram-port"
                data-port={port}
                data-node-id={node.id}
                cx={pt.x - node.x}
                cy={pt.y - node.y}
                r={6}
                fill="#ffffff"
                stroke="#2563eb"
                strokeWidth={1.6}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  onPortPointerDown(event, node.id, port);
                }}
              />
            );
          })
        : null}
    </g>
  );
}

export const NodeView = memo(NodeViewBase);
