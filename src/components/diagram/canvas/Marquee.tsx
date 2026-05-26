import type { Rect } from "../../../lib/diagram/geometry";

export interface MarqueeProps {
  rect: Rect | null;
}

export function Marquee({ rect }: MarqueeProps) {
  if (!rect) return null;
  return (
    <rect
      x={rect.x}
      y={rect.y}
      width={rect.w}
      height={rect.h}
      fill="rgba(37,99,235,0.05)"
      stroke="#2563eb"
      strokeDasharray="4 3"
      strokeWidth={1.25}
      pointerEvents="none"
    />
  );
}
