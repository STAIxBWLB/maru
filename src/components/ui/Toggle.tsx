// Toggle — a standalone switch control for boolean settings rows. The row
// supplies the visible label; use aria-labelledby (preferred) or aria-label
// to name the switch.

import type { ButtonHTMLAttributes } from "react";

interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function Toggle({
  checked,
  onChange,
  className = "",
  ...props
}: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`toggle-switch${checked ? " active" : ""}${className ? ` ${className}` : ""}`}
      onClick={() => onChange(!checked)}
      {...props}
    >
      <span className="toggle-thumb" aria-hidden="true" />
    </button>
  );
}
