import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

export function Button({
  className = "",
  variant = "secondary",
  size = "md",
  icon,
  children,
  title,
  ...props
}: ButtonProps) {
  const ariaLabel = props["aria-label"];
  const tooltip =
    title ??
    (typeof ariaLabel === "string" ? ariaLabel : undefined) ??
    (icon && typeof children === "string" ? children : undefined);

  return (
    <button
      className={`button button-${variant} button-${size} ${className}`}
      title={tooltip}
      {...props}
    >
      {icon ? <span className="button-icon">{icon}</span> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}
