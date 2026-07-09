// Convex hull (Andrew's monotone chain, O(n log n)) + a padded closed SVG path.
// Used to draw translucent community "areas" behind the graph. No dependencies.

export type Point = [number, number];

/** Monotone-chain convex hull. Returns hull vertices; <3 unique points → input. */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point, a: Point, b: Point) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  // All points collinear → monotone chain yields a degenerate 2-point loop.
  return hull.length >= 3 ? hull : points.slice();
}

/** Closed SVG path for a community area: the hull expanded outward from its
 *  centroid by `pad`. 1-2 nodes (or collinear) fall back to a padded circle. */
export function hullPath(points: Point[], pad = 26): string {
  if (points.length === 0) return "";
  const cx0 = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy0 = points.reduce((s, p) => s + p[1], 0) / points.length;
  const hull = convexHull(points);
  if (hull.length < 3) {
    const r = pad + 14;
    return `M ${(cx0 - r).toFixed(1)} ${cy0.toFixed(1)} a ${r} ${r} 0 1 0 ${(r * 2).toFixed(1)} 0 a ${r} ${r} 0 1 0 ${(-r * 2).toFixed(1)} 0 Z`;
  }
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  const expanded = hull.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return `${(x + (dx / len) * pad).toFixed(1)} ${(y + (dy / len) * pad).toFixed(1)}`;
  });
  return `M ${expanded.join(" L ")} Z`;
}
