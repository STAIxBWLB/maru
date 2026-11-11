import { memo, useCallback, type PointerEvent } from "react";

import {
  ARROW_MARKER_ID,
  routeEdge,
  type RoutedEdge,
} from "../../../lib/diagram/edgeRouting";
import {
  routePathOf,
  type CanvasGeometryLabel,
  type CanvasGeometryRoute,
} from "../../../lib/diagram/engineCanvasGeometry";
import type { DiagramEdge, DiagramNode } from "../../../lib/diagram/types";

/** The engine's own route and label for one semantic edge, in canvas pixels. */
export interface EngineRoute {
  route: CanvasGeometryRoute;
  label: CanvasGeometryLabel | null;
}

export interface EdgeViewProps {
  edge: DiagramEdge;
  fromNode: DiagramNode | undefined;
  toNode: DiagramNode | undefined;
  selected: boolean;
  /**
   * When the engine routed this edge, the canvas draws its points and label
   * box. `routeEdge` stays for free-form, template, pattern and mermaid
   * canvases, which have no engine scene.
   */
  engineRoute?: EngineRoute | null;
  onSelect: (event: PointerEvent<SVGGElement>, edgeId: string) => void;
}

function arrowMarker(kind: DiagramEdge["arrowStart"] | DiagramEdge["arrowEnd"]) {
  if (kind === "filled") return `url(#${ARROW_MARKER_ID.filled})`;
  if (kind === "open") return `url(#${ARROW_MARKER_ID.open})`;
  return undefined;
}

/**
 * The engine's label box and its own line breaks. Nothing here re-measures the
 * text or guesses a label width from the string length.
 */
function EngineRouteLabel({ label, color, selected }: {
  label: CanvasGeometryLabel;
  color: string;
  selected: boolean;
}) {
  return (
    <g
      data-engine-label={label.id}
      data-engine-label-box={`${label.x} ${label.y} ${label.w} ${label.h}`}
      pointerEvents="none"
    >
      <rect
        x={label.x}
        y={label.y}
        width={label.w}
        height={label.h}
        rx={3}
        ry={3}
        fill="#ffffff"
        stroke={selected ? "#2563eb" : color}
        strokeWidth={1}
      />
      <text
        x={label.x}
        y={label.y}
        fill={selected ? "#2563eb" : color}
        fontSize={label.fontSize}
        fontWeight={label.weight}
        dominantBaseline="text-before-edge"
        style={{ fontKerning: "none", fontVariantLigatures: "none", textRendering: "geometricPrecision" }}
      >
        {label.lines.map((line, index) => (
          // WebKit does not inherit `dominant-baseline` into tspans; without it
          // here the first line sits one ascent above the engine's label box.
          <tspan
            key={index}
            x={label.x}
            dy={index === 0 ? 0 : label.fontSize * 1.5}
            dominantBaseline="text-before-edge"
          >
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function EdgeViewBase({ edge, fromNode, toNode, selected, engineRoute, onSelect }: EdgeViewProps) {
  const routed: RoutedEdge | null = engineRoute ? null : routeEdge(edge, fromNode, toNode);
  const path = engineRoute ? routePathOf(engineRoute.route) : routed?.path ?? null;
  const handlePointerDown = useCallback(
    (event: PointerEvent<SVGGElement>) => onSelect(event, edge.id),
    [edge.id, onSelect],
  );
  if (!path) return null;

  const color = edge.color ?? "#1f2937";
  const strokeWidth = edge.width ?? 1.5;
  const dash = edge.dash === "dashed" ? "6 4" : undefined;

  return (
    <g
      className={`maru-diagram-edge${selected ? " is-selected" : ""}`}
      data-edge-id={edge.id}
      data-engine-route={engineRoute ? engineRoute.route.sourceId : undefined}
      onPointerDown={handlePointerDown}
    >
      {/* Wider invisible hit area for easy selection. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={Math.max(strokeWidth + 8, 12)}
        pointerEvents="stroke"
      />
      <path
        d={path}
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
      {engineRoute ? (
        engineRoute.label ? (
          <EngineRouteLabel label={engineRoute.label} color={color} selected={selected} />
        ) : null
      ) : edge.label && routed ? (
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
