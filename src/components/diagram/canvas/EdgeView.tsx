import { memo, useCallback, type PointerEvent } from "react";

import {
  ARROW_MARKER_ID,
  routeEdge,
  type RoutedEdge,
} from "../../../lib/diagram/edgeRouting";
import type { DiagramEdge, DiagramNode } from "../../../lib/diagram/types";

export interface EdgeViewProps {
  edge: DiagramEdge;
  fromNode: DiagramNode | undefined;
  toNode: DiagramNode | undefined;
  selected: boolean;
  onSelect: (event: PointerEvent<SVGGElement>, edgeId: string) => void;
}

function arrowMarker(kind: DiagramEdge["arrowStart"] | DiagramEdge["arrowEnd"]) {
  if (kind === "filled") return `url(#${ARROW_MARKER_ID.filled})`;
  if (kind === "open") return `url(#${ARROW_MARKER_ID.open})`;
  return undefined;
}

function EdgeViewBase({ edge, fromNode, toNode, selected, onSelect }: EdgeViewProps) {
  const routed: RoutedEdge | null = routeEdge(edge, fromNode, toNode);
  const handlePointerDown = useCallback(
    (event: PointerEvent<SVGGElement>) => onSelect(event, edge.id),
    [edge.id, onSelect],
  );
  if (!routed) return null;

  const color = edge.color ?? "#1f2937";
  const strokeWidth = edge.width ?? 1.5;
  const dash = edge.dash === "dashed" ? "6 4" : undefined;

  return (
    <g
      className={`anchor-diagram-edge${selected ? " is-selected" : ""}`}
      data-edge-id={edge.id}
      onPointerDown={handlePointerDown}
    >
      {/* Wider invisible hit area for easy selection. */}
      <path
        d={routed.path}
        fill="none"
        stroke="transparent"
        strokeWidth={Math.max(strokeWidth + 8, 12)}
        pointerEvents="stroke"
      />
      <path
        d={routed.path}
        fill="none"
        stroke={selected ? "#2563eb" : color}
        strokeWidth={strokeWidth}
        strokeDasharray={dash}
        strokeLinecap="round"
        strokeLinejoin="round"
        markerStart={arrowMarker(edge.arrowStart)}
        markerEnd={arrowMarker(edge.arrowEnd)}
        pointerEvents="none"
      />
      {edge.label ? (
        <g transform={`translate(${routed.label.x}, ${routed.label.y})`} pointerEvents="none">
          <rect
            x={-Math.max(edge.label.length * 3.5, 16)}
            y={-9}
            width={Math.max(edge.label.length * 7, 32)}
            height={18}
            rx={3}
            ry={3}
            fill="#ffffff"
            stroke={selected ? "#2563eb" : color}
            strokeWidth={1}
          />
          <text
            x={0}
            y={4}
            textAnchor="middle"
            fontSize={11}
            fontWeight={500}
            fill={selected ? "#2563eb" : color}
          >
            {edge.label}
          </text>
        </g>
      ) : null}
    </g>
  );
}

export const EdgeView = memo(EdgeViewBase);
