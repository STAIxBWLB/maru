import { memo } from "react";

import { ARROW_MARKER_ID } from "../../../lib/diagram/edgeRouting";
import {
  ENGINE_PRIMITIVE_PAINT,
  type CanvasGeometryPoint,
  type CanvasGeometryPrimitive,
  type CanvasGeometryPrimitiveShape,
} from "../../../lib/diagram/engineCanvasGeometry";

/**
 * The engine's own shapes that no member, container or route covers: the
 * lifelines under a sequence's messages, a workflow's phase spans, a
 * lifecycle's initial markers, band and rail, a state's final border.
 *
 * They come from the geometry report in canvas pixels and in painter order, so
 * this component draws them and never derives one from node boxes. Nothing here
 * takes the pointer: these are scenery under the members and the routes, and a
 * lifeline that swallowed a click would make the canvas unselectable.
 */
function pointsAttr(points: readonly CanvasGeometryPoint[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

function shapeElement(
  key: string,
  shape: CanvasGeometryPrimitiveShape,
  paint: { fill: string; stroke: string },
  primitive: CanvasGeometryPrimitive,
) {
  const color = {
    fill: paint.fill,
    stroke: paint.stroke,
    strokeWidth: primitive.stroke,
    strokeDasharray: primitive.dash ? primitive.dash.join(" ") : undefined,
    markerEnd: primitive.arrow ? `url(#${ARROW_MARKER_ID.filled})` : undefined,
  };
  const kind = primitive.kind;
  const owner = primitive.owner;
  switch (shape.kind) {
    case "rect":
      return (
        <rect
          key={key}
          data-engine-primitive={kind}
          data-engine-primitive-owner={owner}
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          rx={shape.radius}
          {...color}
        />
      );
    case "line":
      return (
        <line
          key={key}
          data-engine-primitive={kind}
          data-engine-primitive-owner={owner}
          x1={shape.from.x}
          y1={shape.from.y}
          x2={shape.to.x}
          y2={shape.to.y}
          {...color}
        />
      );
    case "circle":
      return (
        <circle
          key={key}
          data-engine-primitive={kind}
          data-engine-primitive-owner={owner}
          cx={shape.center.x}
          cy={shape.center.y}
          r={shape.radius}
          {...color}
        />
      );
    case "polygon":
      return (
        <polygon
          key={key}
          data-engine-primitive={kind}
          data-engine-primitive-owner={owner}
          points={pointsAttr(shape.points)}
          {...color}
        />
      );
    default:
      return (
        <polyline
          key={key}
          data-engine-primitive={kind}
          data-engine-primitive-owner={owner}
          points={pointsAttr(shape.points)}
          {...color}
        />
      );
  }
}

function EnginePrimitivesBase({ primitives, layer }: {
  primitives: readonly CanvasGeometryPrimitive[];
  layer: "underlay" | "overlay";
}) {
  const drawn = primitives.filter((primitive) => primitive.layer === layer);
  if (drawn.length === 0) return null;
  return (
    <g data-engine-primitive-layer={layer} pointerEvents="none">
      {drawn.map((primitive) => shapeElement(
        `${primitive.kind}:${primitive.owner}`,
        primitive.shape,
        ENGINE_PRIMITIVE_PAINT[primitive.paint] ?? { fill: "none", stroke: "#1f2937" },
        primitive,
      ))}
    </g>
  );
}

export const EnginePrimitives = memo(EnginePrimitivesBase);
