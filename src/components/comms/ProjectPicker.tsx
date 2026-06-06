import type { ProjectPickerEntry } from "../../lib/types";
import { useTranslation } from "../../lib/i18n";

interface ProjectPickerProps {
  projects: ProjectPickerEntry[];
  value: string;
  onChange: (projectId: string) => void;
}

export function ProjectPicker({ projects, value, onChange }: ProjectPickerProps) {
  const { t } = useTranslation();
  const selected = projects.find((project) => project.id === value) ?? null;
  return (
    <div className="project-picker">
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t("comms.telegram.chats.pickProject")}</option>
        {projects.map((project) => (
          <option key={`${project.id}:${project.path}`} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <small>{selected?.path ?? t("comms.telegram.chats.noProject")}</small>
    </div>
  );
}
