import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  moveForInsertion,
  sameOrder,
  type InsertionEdge,
} from "../../lib/pointerReorder";

interface ReorderCommit<T> {
  items: T[];
  draggedId: string;
  targetId: string;
  fromIndex: number;
  toIndex: number;
}

interface PointerReorderOptions<T> {
  items: T[];
  getId: (item: T) => string;
  onCommit: (result: ReorderCommit<T>) => void;
  hysteresis?: number;
}

interface Indicator {
  id: string;
  edge: InsertionEdge;
}

interface DragSession<T> {
  pointerId: number;
  draggedId: string;
  startX: number;
  startY: number;
  active: boolean;
  origin: T[];
  targetId: string;
  targetEdge: InsertionEdge;
}

export function usePointerReorder<T>({
  items,
  getId,
  onCommit,
  hysteresis = 8,
}: PointerReorderOptions<T>) {
  const itemsRef = useRef(items);
  const getIdRef = useRef(getId);
  const onCommitRef = useRef(onCommit);
  itemsRef.current = items;
  getIdRef.current = getId;
  onCommitRef.current = onCommit;

  const sessionRef = useRef<DragSession<T> | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [offsetY, setOffsetY] = useState(0);
  const [indicator, setIndicator] = useState<Indicator | null>(null);

  // The pointer listeners live on the handle node and die with it, but the
  // Escape listener is on window — unmounting mid-drag would strand it.
  const teardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => teardownRef.current?.(), []);

  const begin = (
    event: ReactPointerEvent<HTMLElement>,
    draggedId: string,
  ) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const origin = [...itemsRef.current];
    if (!origin.some((item) => getIdRef.current(item) === draggedId)) return;

    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture(pointerId);
    sessionRef.current = {
      pointerId,
      draggedId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      origin,
      targetId: draggedId,
      targetEdge: "before",
    };
    setOffsetY(0);

    const cleanup = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown, true);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      teardownRef.current = null;
      sessionRef.current = null;
      setDraggingId(null);
      setIndicator(null);
      setOffsetY(0);
    };

    const onMove = (move: globalThis.PointerEvent) => {
      const session = sessionRef.current;
      if (!session || move.pointerId !== session.pointerId) return;
      const dx = move.clientX - session.startX;
      const dy = move.clientY - session.startY;
      if (!session.active && Math.hypot(dx, dy) < hysteresis) return;
      if (!session.active) {
        // Lift the row only once the gesture clears the threshold. Committing
        // on pointer-down makes every plain click flash the dragging state.
        session.active = true;
        setDraggingId(session.draggedId);
      }
      setOffsetY(dy);

      // The lifted row follows the pointer and is therefore the top hit.
      // Walk the full hit stack to resolve the stationary row underneath it.
      const row = document
        .elementsFromPoint(move.clientX, move.clientY)
        .map((element) => element.closest<HTMLElement>("[data-reorder-id]"))
        .find((candidate) => (
          candidate?.dataset.reorderId &&
          candidate.dataset.reorderId !== session.draggedId
        ));
      const targetId = row?.dataset.reorderId;
      if (!targetId || !session.origin.some((item) => getIdRef.current(item) === targetId)) {
        return;
      }
      const rect = row.getBoundingClientRect();
      const edge: InsertionEdge = move.clientY < rect.top + rect.height / 2
        ? "before"
        : "after";
      session.targetId = targetId;
      session.targetEdge = edge;
      setIndicator({ id: targetId, edge });
    };

    const onEnd = (end: globalThis.PointerEvent) => {
      const session = sessionRef.current;
      if (!session || end.pointerId !== session.pointerId) return;
      if (session.active) {
        const fromIndex = session.origin.findIndex(
          (item) => getIdRef.current(item) === session.draggedId,
        );
        const targetIndex = session.origin.findIndex(
          (item) => getIdRef.current(item) === session.targetId,
        );
        const next = moveForInsertion(
          session.origin,
          fromIndex,
          targetIndex,
          session.targetEdge,
        );
        if (!sameOrder(session.origin, next, getIdRef.current)) {
          onCommitRef.current({
            items: next,
            draggedId: session.draggedId,
            targetId: session.targetId,
            fromIndex,
            toIndex: next.findIndex(
              (item) => getIdRef.current(item) === session.draggedId,
            ),
          });
        }
      }
      cleanup();
    };

    const onCancel = (cancel: globalThis.PointerEvent) => {
      if (cancel.pointerId !== pointerId) return;
      cleanup();
    };

    // Escape abandons the drag without committing — the standard escape hatch
    // for a reorder the user changed their mind about mid-gesture.
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cleanup();
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown, true);
    teardownRef.current = cleanup;
  };

  const rowState = (id: string) => ({
    dragging: draggingId === id,
    indicator:
      indicator?.id === id
        ? (`reorder-indicator-${indicator.edge}` as const)
        : null,
    style:
      draggingId === id
        ? ({ transform: `translate3d(0, ${offsetY}px, 0)` } as CSSProperties)
        : undefined,
  });

  return { begin, draggingId, rowState };
}
