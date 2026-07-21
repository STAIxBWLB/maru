// Maru Today — minimal panel for the secondary routes (calendar / capture /
// upcoming / log). Shows the section title plus any existing-data count the
// caller already has. TODO(G2b+): replace with the real sub-screens.

import { useTranslation } from "../../lib/i18n";

interface TodaySubPanelProps {
  title: string;
  /** Numeric badge (e.g. inbox/upcoming counts). Rendered when defined. */
  count?: number;
  /** Preformatted count copy (e.g. "연결된 일정 N개"). Rendered when defined. */
  countText?: string;
}

export function TodaySubPanel({ title, count, countText }: TodaySubPanelProps) {
  const { t } = useTranslation();
  return (
    <section className="today-sub-panel">
      <header className="today-sub-panel-header">
        <h3 className="today-panel-title">{title}</h3>
        {count !== undefined ? <span className="today-nav-count">{count}</span> : null}
        {countText ? <span className="today-nav-meta">{countText}</span> : null}
      </header>
      <p className="today-panel-empty">{t("today.placeholder.empty")}</p>
    </section>
  );
}
