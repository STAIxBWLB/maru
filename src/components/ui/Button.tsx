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
  ...props
}: ButtonProps) {
  return (
    <button className={`button button-${variant} button-${size} ${className}`} {...props}>
      {icon ? <span className="button-icon">{icon}</span> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}
