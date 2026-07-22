// Position validation for the graph canvas. Disk-cached and worker-computed
// coordinates can go non-finite (NaN/Infinity from a degenerate FA2 run) or
// absurdly large (a node flung out by an unstable layout); both silently break
// rendering and camera fitting. These guards keep bad values out of the
// renderer and out of the cache.

/** Coordinates beyond this magnitude are treated as corrupt. */
export const MAX_POSITION_MAGNITUDE = 1e6;

/** A usable graph coordinate: finite and within the sanity bound. */
export function isUsableCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_POSITION_MAGNITUDE
  );
}

/** True when every coordinate in the buffer is finite. Used to gate the
 *  debounced disk-cache save — a single NaN would poison the whole cache. */
export function isFinitePositions(positions: Float64Array): boolean {
  for (let i = 0; i < positions.length; i += 1) {
    if (!Number.isFinite(positions[i])) return false;
  }
  return true;
}

/** Drop entries with non-finite or out-of-bounds coordinates. Returns a new
 *  record; the input is not mutated. */
export function sanitizePositions(
  positions: Record<string, [number, number]>,
): Record<string, [number, number]> {
  const clean: Record<string, [number, number]> = {};
  for (const [id, point] of Object.entries(positions)) {
    if (!Array.isArray(point)) continue;
    const [x, y] = point;
    if (isUsableCoordinate(x) && isUsableCoordinate(y)) clean[id] = [x, y];
  }
  return clean;
}
