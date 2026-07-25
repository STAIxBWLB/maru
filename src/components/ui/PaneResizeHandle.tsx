import { useRef, type KeyboardEvent, type PointerEvent } from "react";

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
  const latestValueRef = useRef(value);
  latestValueRef.current = value;

  const apply = (next: number, commit: boolean) => {
    const clamped = clamp(next, min, max);
    latestValueRef.current = clamped;
    onChange(clamped);
    if (commit) onCommit(clamped);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startPosition = orientation === "vertical" ? event.clientX : event.clientY;
    const startValue = value;
    handle.setPointerCapture(pointerId);

    const onMove = (move: globalThis.PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const position = orientation === "vertical" ? move.clientX : move.clientY;
      apply(startValue + direction * (position - startPosition), false);
    };
    const cleanup = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onCancel);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    };
    const onEnd = (end: globalThis.PointerEvent) => {
      if (end.pointerId !== pointerId) return;
      const committed = latestValueRef.current;
      cleanup();
      onCommit(committed);
    };
    const onCancel = (cancel: globalThis.PointerEvent) => {
      if (cancel.pointerId !== pointerId) return;
      cleanup();
      apply(startValue, true);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onCancel);
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
