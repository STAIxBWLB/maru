import type {
  ElementType,
  HTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

interface ModeHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  titleAs?: "h1" | "h2";
}

export function ModeHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  titleAs = "h2",
  className = "",
  ...props
}: ModeHeaderProps) {
  const Title = titleAs as ElementType;
  return (
    <header className={`mode-header ${className}`.trim()} {...props}>
      <div className="mode-header-copy">
        {eyebrow ? <p className="mode-header-eyebrow">{eyebrow}</p> : null}
        <Title className="mode-header-title">{title}</Title>
        {subtitle ? <p className="mode-header-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="mode-header-actions">{actions}</div> : null}
    </header>
  );
}

export function ModeToolbar({
  className = "",
  children,
  role = "toolbar",
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`mode-toolbar ${className}`.trim()}
      role={role}
      {...props}
    >
      {children}
    </div>
  );
}

interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  options: Array<SegmentedOption<T>>;
  label: string;
  onChange: (value: T) => void;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  label,
  onChange,
  className = "",
}: SegmentedControlProps<T>) {
  return (
    <div
      className={`segmented-control ${className}`.trim()}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

interface StatusBannerProps extends HTMLAttributes<HTMLDivElement> {
  tone?: "neutral" | "info" | "warning" | "danger" | "success";
}

export function StatusBanner({
  tone = "neutral",
  className = "",
  children,
  ...props
}: StatusBannerProps) {
  return (
    <div
      className={`status-banner status-banner-${tone} ${className}`.trim()}
      role={tone === "danger" ? "alert" : "status"}
      {...props}
    >
      {children}
    </div>
  );
}

interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
  ...props
}: EmptyStateProps) {
  return (
    <div className={`empty-state ${className}`.trim()} {...props}>
      {icon ? <span className="empty-state-icon" aria-hidden="true">{icon}</span> : null}
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}

export function CompactSelect({
  className = "",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`compact-select ${className}`.trim()} {...props} />;
}
