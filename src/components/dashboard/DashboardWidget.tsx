// Maru Dashboard — shared widget chrome. Header carries the title, an
// optional count badge, and an optional deep-link action into the owning
// mode; the body renders one of loading / error / empty / content.

import type { ReactNode } from "react";
import { ArrowRight, RefreshCcw } from "lucide-react";
import { useTranslation } from "../../lib/i18n";

export interface DashboardWidgetProps {
  /** Widget kind — becomes the `dashboard-widget-<kind>` class hook. */
  kind: string;
  title: string;
  /** Optional count badge in the header. */
  count?: number | null;
  /** Deep link into the owning mode ("전체 보기"). */
  onViewAll?: () => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Render the empty state instead of children. */
  empty?: boolean;
  emptyLabel?: string;
  /**
   * Status-strip form: same chrome and same state machine, tighter box, and the
   * deep-link collapses to its arrow — four "전체 보기 →" links in a row of
   * ambient status is noise.
   */
  compact?: boolean;
  children?: ReactNode;
}

export function DashboardWidget({
  kind,
  title,
  count,
  onViewAll,
  loading = false,
  error = null,
  onRetry,
  empty = false,
  emptyLabel,
  compact = false,
  children,
}: DashboardWidgetProps) {
  const { t } = useTranslation();
  const viewAllLabel = t("dashboard.widget.viewAll");
  return (
    <section
      className={`dashboard-widget dashboard-widget-${kind}${
        compact ? " dashboard-widget-compact" : ""
      }`}
      data-dashboard-widget={kind}
    >
      <header className="dashboard-widget-header">
        <h3 className="dashboard-widget-title">{title}</h3>
        {count !== null && count !== undefined ? (
          <span className="dashboard-widget-count">{count}</span>
        ) : null}
        {onViewAll ? (
          <button
            type="button"
            className="dashboard-widget-action"
            onClick={onViewAll}
            aria-label={compact ? viewAllLabel : undefined}
            title={compact ? viewAllLabel : undefined}
          >
            {compact ? null : viewAllLabel}
            <ArrowRight size={12} strokeWidth={1.9} aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <div className="dashboard-widget-body">
        {loading ? (
          <div className="dashboard-widget-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : error ? (
          <div className="dashboard-widget-error" role="alert">
            <p>{t("dashboard.widget.error")}</p>
            {onRetry ? (
              <button type="button" className="dashboard-widget-retry" onClick={onRetry}>
                <RefreshCcw size={12} strokeWidth={1.9} aria-hidden="true" />
                {t("dashboard.widget.retry")}
              </button>
            ) : null}
          </div>
        ) : empty ? (
          <p className="dashboard-widget-empty">{emptyLabel ?? t("dashboard.widget.empty")}</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
