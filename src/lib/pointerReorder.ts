export type InsertionEdge = "before" | "after";

export function moveForInsertion<T>(
  items: readonly T[],
  fromIndex: number,
  targetIndex: number,
  edge: InsertionEdge,
): T[] {
  if (
    fromIndex < 0 ||
    fromIndex >= items.length ||
    targetIndex < 0 ||
    targetIndex >= items.length
  ) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  let insertionIndex = targetIndex + (edge === "after" ? 1 : 0);
  if (fromIndex < insertionIndex) insertionIndex -= 1;
  insertionIndex = Math.max(0, Math.min(next.length, insertionIndex));
  next.splice(insertionIndex, 0, moved);
  return next;
}

export function sameOrder<T>(
  left: readonly T[],
  right: readonly T[],
  getId: (item: T) => string,
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => getId(item) === getId(right[index]))
  );
}
