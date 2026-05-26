/**
 * Smart guides — alignment snap helpers used during node drags.
 *
 * Given a moving rectangle and a set of stationary node rectangles, find
 * alignment candidates (left/center/right and top/center/bottom) within a
 * pixel threshold and return both the snapped delta to apply *and* the
 * guideline coordinates to draw on screen.
 *
 * All inputs are in canvas (pre-zoom) space — the threshold is therefore
 * a screen-space px value divided by the active zoom to keep the snap
 * radius consistent at any zoom level.
 */

import type { Rect } from "./geometry";

export interface GuideLine {
  /** "v" runs vertically (constant x), "h" runs horizontally (constant y). */
  orientation: "v" | "h";
  /** Canvas-space coordinate of the line on its constant axis. */
  pos: number;
  /** Range of the perpendicular axis the guideline should span. */
  start: number;
  end: number;
}

export interface SmartGuideResult {
  /** Snap delta to apply to the proposed dx/dy, in canvas units. */
  dx: number;
  dy: number;
  guides: GuideLine[];
}

export interface SmartGuideInput {
  movingRect: Rect;
  /** Stationary rectangles to align against (must exclude the dragged ids). */
  stationary: Rect[];
  /** Snap threshold in canvas units. */
  threshold: number;
}

interface Candidate {
  delta: number;
  movingKey: number;
  staticKey: number;
  edgeStart: number;
  edgeEnd: number;
}

function pickBest(
  movingKeys: number[],
  staticKeys: number[],
  movingRange: [number, number],
  staticRanges: Array<[number, number]>,
  threshold: number,
): Candidate | null {
  let best: Candidate | null = null;
  for (let i = 0; i < movingKeys.length; i += 1) {
    const m = movingKeys[i]!;
    for (let j = 0; j < staticKeys.length; j += 1) {
      const s = staticKeys[j]!;
      const delta = s - m;
      if (Math.abs(delta) <= threshold) {
        if (best === null || Math.abs(delta) < Math.abs(best.delta)) {
          const [sa, sb] = staticRanges[j]!;
          best = {
            delta,
            movingKey: m,
            staticKey: s,
            edgeStart: Math.min(movingRange[0], sa),
            edgeEnd: Math.max(movingRange[1], sb),
          };
        }
      }
    }
  }
  return best;
}

export function computeSmartGuides(input: SmartGuideInput): SmartGuideResult {
  const { movingRect, stationary, threshold } = input;
  if (stationary.length === 0 || threshold <= 0) {
    return { dx: 0, dy: 0, guides: [] };
  }

  const moveXKeys = [movingRect.x, movingRect.x + movingRect.w / 2, movingRect.x + movingRect.w];
  const moveYKeys = [movingRect.y, movingRect.y + movingRect.h / 2, movingRect.y + movingRect.h];

  const staticXKeys: number[] = [];
  const staticYKeys: number[] = [];
  const staticXRanges: Array<[number, number]> = [];
  const staticYRanges: Array<[number, number]> = [];
  for (const r of stationary) {
    staticXKeys.push(r.x, r.x + r.w / 2, r.x + r.w);
    staticYKeys.push(r.y, r.y + r.h / 2, r.y + r.h);
    const yRange: [number, number] = [r.y, r.y + r.h];
    const xRange: [number, number] = [r.x, r.x + r.w];
    staticXRanges.push(yRange, yRange, yRange);
    staticYRanges.push(xRange, xRange, xRange);
  }

  const moveYRange: [number, number] = [movingRect.y, movingRect.y + movingRect.h];
  const moveXRange: [number, number] = [movingRect.x, movingRect.x + movingRect.w];

  const horizontalGuide = pickBest(moveXKeys, staticXKeys, moveYRange, staticXRanges, threshold);
  const verticalGuide = pickBest(moveYKeys, staticYKeys, moveXRange, staticYRanges, threshold);

  const guides: GuideLine[] = [];
  let dx = 0;
  let dy = 0;
  if (horizontalGuide) {
    dx = horizontalGuide.delta;
    guides.push({
      orientation: "v",
      pos: horizontalGuide.staticKey,
      start: horizontalGuide.edgeStart,
      end: horizontalGuide.edgeEnd,
    });
  }
  if (verticalGuide) {
    dy = verticalGuide.delta;
    guides.push({
      orientation: "h",
      pos: verticalGuide.staticKey,
      start: verticalGuide.edgeStart,
      end: verticalGuide.edgeEnd,
    });
  }
  return { dx, dy, guides };
}
