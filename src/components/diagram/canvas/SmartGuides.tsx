import type { GuideLine } from "../../../lib/diagram/smartGuides";

export interface SmartGuidesProps {
  guides: GuideLine[];
}

export function SmartGuides({ guides }: SmartGuidesProps) {
  if (guides.length === 0) return null;
  return (
    <g pointerEvents="none" data-export-ignore>
      {guides.map((g, i) => {
        if (g.orientation === "v") {
          return (
            <line
              key={`v-${i}-${g.pos}`}
              x1={g.pos}
              x2={g.pos}
              y1={g.start - 8}
              y2={g.end + 8}
              stroke="#ec4899"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
          );
        }
        return (
          <line
            key={`h-${i}-${g.pos}`}
            x1={g.start - 8}
            x2={g.end + 8}
            y1={g.pos}
            y2={g.pos}
            stroke="#ec4899"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        );
      })}
    </g>
  );
}
