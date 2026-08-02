// SettingsSection — a bordered card grouping related settings rows.

import type { ReactNode } from "react";

interface SettingsSectionProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Pad the body for custom (non-SettingsRow) content: grids, lists,
   *  tables, editors. Row children bring their own padding. */
  padded?: boolean;
  children: ReactNode;
}

export function SettingsSection({
  title,
  description,
  actions,
  padded,
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
      <div className={padded ? "settings-section-body padded" : "settings-section-body"}>
        {children}
      </div>
    </section>
  );
}
