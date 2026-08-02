// SettingsRow — label + description on the left, control on the right.

import { useId, type ReactNode } from "react";

interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  control: ReactNode;
  /** Stack the control below the copy (for textarea-scale controls). */
  wide?: boolean;
}

export function SettingsRow({ label, description, htmlFor, control, wide }: SettingsRowProps) {
  const autoId = useId();
  const labelId = `settings-row-label-${autoId}`;
  return (
    <div className={wide ? "settings-row wide" : "settings-row"}>
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
