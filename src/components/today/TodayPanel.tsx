// Maru Today — generic panel slot for the stage grids. Real panel content
// (brain dump editor, capture list, Top 3, capacity, yesterday review) is
// filled in by follow-up commit groups; the slot already carries the
// section id the stepper tracks, the title, and an honest empty state.

import type { ReactNode } from "react";
import { useTranslation } from "../../lib/i18n";

interface TodayPanelProps {
  title: string;
  /** Optional helper copy shown under the title. */
  hint?: string;
  /** Workflow section id (`data-today-section`) for stepper tracking. */
  sectionId?: string;
  className?: string;
  children?: ReactNode;
}

export function TodayPanel({ title, hint, sectionId, className, children }: TodayPanelProps) {
  const { t } = useTranslation();
  const classes = className ? `today-panel ${className}` : "today-panel";
  return (
    <section className={classes} data-today-section={sectionId}>
      <header className="today-panel-header">
        <h3 className="today-panel-title">{title}</h3>
      </header>
      {hint ? <p className="today-panel-hint">{hint}</p> : null}
      <div className="today-panel-body">{children ?? <p className="today-panel-empty">{t("today.placeholder.empty")}</p>}</div>
    </section>
  );
}
