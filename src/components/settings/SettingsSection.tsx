// SettingsSection — a bordered card grouping related settings rows.

import type { ReactNode } from "react";

interface SettingsSectionProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export function SettingsSection({
  title,
  description,
  actions,
  children,
}: SettingsSectionProps) {
  return (
    <section className="settings-section">
      <header className="settings-section-header">
        <div className="settings-section-copy">
          <h3 className="settings-section-title">{title}</h3>
          {description ? (
            <p className="settings-section-description">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="settings-section-actions">{actions}</div> : null}
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}
