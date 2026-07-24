import type { Attributes } from "graphology-types";
import type { Settings } from "sigma/settings";
import type { NodeDisplayData, PartialButFor } from "sigma/types";
import { graphTheme } from "./graphStyle";

type NodeLabelData = PartialButFor<NodeDisplayData, "x" | "y" | "size" | "label" | "color">;

// Obsidian-style zoom-linked fade: labels are invisible while a node renders
// small, ramp in as it grows on screen (zoom-in or high degree).
const FADE_START = 6;
const FADE_END = 12;

export function labelAlpha(renderedSize: number, forced: boolean): number {
  if (forced) return 1;
  if (renderedSize <= FADE_START) return 0;
  if (renderedSize >= FADE_END) return 0.3;
  return ((renderedSize - FADE_START) / (FADE_END - FADE_START)) * 0.3;
}

function drawLabelText<
  N extends Attributes = Attributes,
  E extends Attributes = Attributes,
  G extends Attributes = Attributes,
>(
  context: CanvasRenderingContext2D,
  data: NodeLabelData,
  settings: Settings<N, E, G>,
  alpha: number,
  sizePx: number,
  weight: string,
): void {
  if (!data.label || alpha <= 0) return;
  const theme = graphTheme();
  context.save();
  context.globalAlpha = alpha;
  context.font = `${weight} ${sizePx}px ${settings.labelFont}`;
  context.textAlign = "center";
  context.textBaseline = "top";
  // bg-colored stroke halo keeps labels readable over edges (cheaper than shadowBlur)
  context.lineJoin = "round";
  context.lineWidth = 3;
  context.strokeStyle = theme.bg;
  const x = data.x;
  const y = data.y + data.size + 3;
  context.strokeText(data.label, x, y);
  context.fillStyle = theme.labelColor;
  context.fillText(data.label, x, y);
  context.restore();
}

export function drawMaruNodeLabel<
  N extends Attributes = Attributes,
  E extends Attributes = Attributes,
  G extends Attributes = Attributes,
>(context: CanvasRenderingContext2D, data: NodeLabelData, settings: Settings<N, E, G>): void {
  const forced = data.forceLabel === true || data.highlighted === true;
  drawLabelText(context, data, settings, labelAlpha(data.size, forced), settings.labelSize, settings.labelWeight);
}

export function drawMaruNodeHover<
  N extends Attributes = Attributes,
  E extends Attributes = Attributes,
  G extends Attributes = Attributes,
>(context: CanvasRenderingContext2D, data: NodeLabelData, settings: Settings<N, E, G>): void {
  // Hovered node: always-on, slightly larger label; no white box (Obsidian look).
  drawLabelText(context, data, settings, 1, settings.labelSize + 1, "600");
}
