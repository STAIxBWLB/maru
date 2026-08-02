// SettingsRow — label + description on the left, control on the right.

import { useId, type ReactNode } from "react";

interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  control: ReactNode;
}

export function SettingsRow({ label, description, htmlFor, control }: SettingsRowProps) {
  const autoId = useId();
  const labelId = `settings-row-label-${autoId}`;
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        {htmlFor ? (
          <label className="settings-row-label" htmlFor={htmlFor} id={labelId}>
            {label}
          </label>
        ) : (
          <span className="settings-row-label" id={labelId}>
            {label}
          </span>
        )}
        {description ? <p className="settings-row-description">{description}</p> : null}
      </div>
      <div className="settings-row-control">{control}</div>
    </div>
  );
}
