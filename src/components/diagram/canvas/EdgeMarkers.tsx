import { ARROW_MARKER_ID } from "../../../lib/diagram/edgeRouting";

/**
 * Shared `<defs>` providing the arrowhead markers every {@link EdgeView}
 * references. Mounted once per canvas at the top of the SVG so we don't
 * thrash markers on every drag.
 */
export function EdgeMarkers() {
  return (
    <defs>
      <marker
        id={ARROW_MARKER_ID.filled}
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerUnits="strokeWidth"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
      </marker>
      <marker
        id={ARROW_MARKER_ID.open}
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerUnits="strokeWidth"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path
          d="M 0 0 L 10 5 L 0 10"
          fill="none"
          stroke="context-stroke"
          strokeWidth="1.2"
        />
      </marker>
    </defs>
  );
}
