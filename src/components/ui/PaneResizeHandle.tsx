import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";

interface PaneResizeHandleProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  orientation?: "vertical" | "horizontal";
  direction?: 1 | -1;
  disabled?: boolean;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}

interface ActiveDrag {
  handle: HTMLDivElement;
  pointerId: number;
  startValue: number;
  latestValue: number;
  done: boolean;
  cleanup: () => void;
  finish: (interrupted: boolean) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function PaneResizeHandle({
  label,
  value,
  min,
  max,
  defaultValue,
  orientation = "vertical",
  direction = 1,
  disabled = false,
  onChange,
  onCommit,
}: PaneResizeHandleProps) {
  const activeDragRef = useRef<ActiveDrag | null>(null);
  const mountedRef = useRef(true);
  const optionsRef = useRef({ min, max, onChange, onCommit });
  optionsRef.current = { min, max, onChange, onCommit };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = activeDragRef.current;
      if (!active) return;
      active.done = true;
      activeDragRef.current = null;
      active.cleanup();
    };
  }, []);

  const apply = (next: number, commit: boolean) => {
    if (!mountedRef.current) return;
    const { min: currentMin, max: currentMax, onChange: change, onCommit: commitValue } =
      optionsRef.current;
    const clamped = clamp(next, currentMin, currentMax);
    change(clamped);
    if (commit) commitValue(clamped);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const previousDrag = activeDragRef.current;
    previousDrag?.finish(true);
    const pointerId = event.pointerId;
    const startPosition = orientation === "vertical" ? event.clientX : event.clientY;
    // A replacement pointerdown interrupts the old transaction first. Use its
    // restored start value for the new transaction even before React has had a
    // chance to render the interruption's onChange state update.
    const startValue = previousDrag?.startValue ?? value;

    const drag: ActiveDrag = {
      handle,
      pointerId,
      startValue,
      latestValue: startValue,
      done: false,
      cleanup: () => {},
      finish: (_interrupted: boolean) => {},
    };

    const onMove = (move: globalThis.PointerEvent) => {
      if (drag.done || activeDragRef.current !== drag || move.pointerId !== pointerId) return;
      const position = orientation === "vertical" ? move.clientX : move.clientY;
      const { min: currentMin, max: currentMax } = optionsRef.current;
      const next = clamp(
        startValue + direction * (position - startPosition),
        currentMin,
        currentMax,
      );
      drag.latestValue = next;
      apply(next, false);
    };

    const onEnd = (end: globalThis.PointerEvent) => {
      if (end.pointerId !== pointerId) return;
      drag.finish(false);
    };

    const onCancel = (cancel: globalThis.PointerEvent) => {
      if (cancel.pointerId !== pointerId) return;
      drag.finish(true);
    };

    const onLostPointerCapture = (lost: Event) => {
      const lostPointerId = (lost as globalThis.PointerEvent).pointerId;
      if (typeof lostPointerId === "number" && lostPointerId !== pointerId) return;
      drag.finish(true);
    };

    const onBlur = () => drag.finish(true);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") drag.finish(true);
    };
    const onPageHide = () => drag.finish(true);

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      handle.removeEventListener("lostpointercapture", onLostPointerCapture);
      try {
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      } catch {
        // Pointer capture can already be gone when the browser reports an
        // interruption or the component is being removed.
      }
    };

    drag.cleanup = cleanup;
    drag.finish = (interrupted: boolean) => {
      if (drag.done || activeDragRef.current !== drag) return;
      drag.done = true;
      activeDragRef.current = null;
      cleanup();
      if (!mountedRef.current) return;
      if (interrupted) {
        apply(startValue, true);
      } else {
        optionsRef.current.onCommit(drag.latestValue);
      }
    };

    activeDragRef.current = drag;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    handle.addEventListener("lostpointercapture", onLostPointerCapture);
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // Window-level pointer listeners still complete the transaction when
      // capture is unavailable or the pointer has already been cancelled.
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = event.shiftKey ? 48 : 12;
    let next: number | null = null;
    if (orientation === "vertical" && event.key === "ArrowLeft") {
      next = value - direction * step;
    }
    if (orientation === "vertical" && event.key === "ArrowRight") {
      next = value + direction * step;
    }
    if (orientation === "horizontal" && event.key === "ArrowUp") {
      next = value - direction * step;
    }
    if (orientation === "horizontal" && event.key === "ArrowDown") {
      next = value + direction * step;
    }
    if (event.key === "Home") next = min;
    if (event.key === "End") next = max;
    if (next === null) return;
    event.preventDefault();
    apply(next, true);
  };

  return (
    <div
      className="pane-resize-handle"
      data-orientation={orientation}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => {
        if (!disabled) apply(defaultValue, true);
      }}
    >
      <span aria-hidden="true" />
    </div>
  );
}
