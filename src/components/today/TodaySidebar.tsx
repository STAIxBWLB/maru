// Maru Today — left sidebar for the Today pane. Stage navigation
// (Prepare/Execute/Review), the calendar sync row, and the "Related"
// section (Inbox / Upcoming / Log / All Tasks). Counts are optional: they
// render only when the caller has real data to show.

import {
  Calendar,
  CalendarClock,
  CircleCheck,
  Inbox,
  ListTodo,
  Play,
  ScrollText,
  Sunrise,
} from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import type { TodayRoute } from "../../lib/today";

interface TodaySidebarProps {
  route: TodayRoute;
  onRouteChange: (route: TodayRoute) => void;
  calendarCount?: number;
  inboxCount?: number;
  upcomingCount?: number;
}

export function TodaySidebar({
  route,
  onRouteChange,
  calendarCount,
  inboxCount,
  upcomingCount,
}: TodaySidebarProps) {
  const { t } = useTranslation();

  const stageItems: Array<{ route: TodayRoute; label: string; icon: typeof Sunrise }> = [
    { route: "prepare", label: t("today.nav.prepare"), icon: Sunrise },
    { route: "execute", label: t("today.nav.execute"), icon: Play },
    { route: "review", label: t("today.nav.review"), icon: CircleCheck },
  ];

  const relatedItems: Array<{
    route: TodayRoute;
    label: string;
    icon: typeof Inbox;
    count?: number;
  }> = [
    { route: "capture", label: t("today.nav.inbox"), icon: Inbox, count: inboxCount },
    { route: "upcoming", label: t("today.nav.upcoming"), icon: CalendarClock, count: upcomingCount },
    { route: "log", label: t("today.nav.log"), icon: ScrollText },
    { route: "all", label: t("today.nav.allTasks"), icon: ListTodo },
  ];

  const itemClass = (itemRoute: TodayRoute) =>
    route === itemRoute ? "today-nav-item active" : "today-nav-item";

  return (
    <aside className="today-sidebar">
      <header className="today-sidebar-header">
        <h2 className="today-sidebar-title">{t("today.sidebar.title")}</h2>
        <p className="today-sidebar-subtitle">{t("today.sidebar.subtitle")}</p>
      </header>

      <nav className="today-sidebar-nav" aria-label={t("today.sidebar.title")}>
        {stageItems.map(({ route: itemRoute, label, icon: Icon }) => (
          <button
            key={itemRoute}
            type="button"
            className={itemClass(itemRoute)}
            aria-current={route === itemRoute ? "page" : undefined}
            aria-label={label}
            onClick={() => onRouteChange(itemRoute)}
          >
            <Icon size={16} strokeWidth={1.9} aria-hidden="true" />
            <span className="today-nav-label">{label}</span>
          </button>
        ))}

        <button
          type="button"
          className={itemClass("calendar")}
          aria-current={route === "calendar" ? "page" : undefined}
          aria-label={t("today.nav.calendarLink")}
          onClick={() => onRouteChange("calendar")}
        >
          <Calendar size={16} strokeWidth={1.9} aria-hidden="true" />
          <span className="today-nav-label">{t("today.nav.calendarLink")}</span>
          {calendarCount !== undefined ? (
            <span className="today-nav-meta">
              {t("today.nav.connectedCount", { count: calendarCount })}
            </span>
          ) : null}
        </button>
      </nav>

      <div className="today-sidebar-section">
        <p className="today-sidebar-label">{t("today.nav.related")}</p>
        <nav className="today-sidebar-nav" aria-label={t("today.nav.related")}>
          {relatedItems.map(({ route: itemRoute, label, icon: Icon, count }) => (
            <button
              key={itemRoute}
              type="button"
              className={itemClass(itemRoute)}
              aria-current={route === itemRoute ? "page" : undefined}
              aria-label={label}
              onClick={() => onRouteChange(itemRoute)}
            >
              <Icon size={16} strokeWidth={1.9} aria-hidden="true" />
              <span className="today-nav-label">{label}</span>
              {count !== undefined ? <span className="today-nav-count">{count}</span> : null}
            </button>
          ))}
        </nav>
      </div>
    </aside>
  );
}
