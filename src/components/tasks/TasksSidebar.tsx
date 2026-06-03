import { Activity, AlertTriangle, CalendarClock, CalendarDays, CheckCircle2, Inbox, ListTodo } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "../../lib/i18n";
import {
  taskFilterCounts,
  type TaskEntry,
  type TaskScheduleFilterView,
} from "../../lib/tasks";

export type TasksFilterView = TaskScheduleFilterView;
export type TasksSection = "tasks" | "progress";

interface TasksSidebarProps {
  entries: TaskEntry[];
  activeView: TasksFilterView;
  selectedProject: string;
  activeSection: TasksSection;
  progressCount: number;
  onViewChange: (view: TasksFilterView) => void;
  onProjectChange: (project: string) => void;
  onSectionChange: (section: TasksSection) => void;
  today: string;
}

export function TasksSidebar({
  entries,
  activeView,
  selectedProject,
  activeSection,
  progressCount,
  onViewChange,
  onProjectChange,
  onSectionChange,
  today,
}: TasksSidebarProps) {
  const { t } = useTranslation();
  const counts = taskFilterCounts(entries, today);
  const projects = Array.from(
    new Set(entries.map((entry) => entry.project).filter((value): value is string => Boolean(value))),
  ).sort((a, b) => a.localeCompare(b));
  const views: Array<{
    id: TasksFilterView;
    label: string;
    count: number;
    icon: ReactNode;
  }> = [
    {
      id: "scheduled",
      label: t("tasks.filter.scheduled"),
      count: counts.scheduled,
      icon: <CalendarClock size={14} />,
    },
    {
      id: "today",
      label: t("tasks.filter.today"),
      count: counts.today,
      icon: <CalendarDays size={14} />,
    },
    {
      id: "overdue",
      label: t("tasks.filter.overdue"),
      count: counts.overdue,
      icon: <AlertTriangle size={14} />,
    },
    {
      id: "unscheduled",
      label: t("tasks.filter.unscheduled"),
      count: counts.unscheduled,
      icon: <ListTodo size={14} />,
    },
    {
      id: "backlog",
      label: t("tasks.filter.backlog"),
      count: counts.backlog,
      icon: <Inbox size={14} />,
    },
    {
      id: "done",
      label: t("tasks.filter.done"),
      count: counts.done,
      icon: <CheckCircle2 size={14} />,
    },
  ];

  const tasksActive = activeSection === "tasks";
  return (
    <aside className="tasks-sidebar">
      <div className="tasks-sidebar-section">
        <span className="tasks-sidebar-label">{t("tasks.sidebar.status")}</span>
        {views.map((view) => (
          <button
            type="button"
            key={view.id}
            className={tasksActive && activeView === view.id ? "tasks-filter active" : "tasks-filter"}
            onClick={() => onViewChange(view.id)}
          >
            <span className="tasks-filter-copy">
              {view.icon}
              <span>{view.label}</span>
            </span>
            <span className="tasks-count">{view.count}</span>
          </button>
        ))}
      </div>
      <div className="tasks-sidebar-section">
        <span className="tasks-sidebar-label">{t("tasks.sidebar.projects")}</span>
        <button
          type="button"
          className={tasksActive && selectedProject === "all" ? "tasks-filter active" : "tasks-filter"}
          onClick={() => onProjectChange("all")}
        >
          <span>{t("tasks.project.all")}</span>
          <span className="tasks-count">{entries.length}</span>
        </button>
        {projects.map((project) => (
          <button
            type="button"
            key={project}
            className={tasksActive && selectedProject === project ? "tasks-filter active" : "tasks-filter"}
            onClick={() => onProjectChange(project)}
          >
            <span>{project}</span>
            <span className="tasks-count">
              {entries.filter((entry) => entry.project === project).length}
            </span>
          </button>
        ))}
      </div>
      <div className="tasks-sidebar-section">
        <span className="tasks-sidebar-label">{t("tasks.sidebar.progress")}</span>
        <button
          type="button"
          className={activeSection === "progress" ? "tasks-filter active" : "tasks-filter"}
          onClick={() => onSectionChange("progress")}
        >
          <span className="tasks-filter-copy">
            <Activity size={14} />
            <span>{t("tasks.progress.allRuns")}</span>
          </span>
          {progressCount > 0 ? <span className="tasks-count">{progressCount}</span> : null}
        </button>
      </div>
    </aside>
  );
}
