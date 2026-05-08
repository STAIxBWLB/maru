import { Play, RefreshCcw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { SkillRecord } from "../../lib/skills";

interface SkillsQuickPaneProps {
  skills: SkillRecord[];
  loading?: boolean;
  onRefresh: () => void;
  onRunSkill: (skill: SkillRecord) => void;
}

export function SkillsQuickPane({
  skills,
  loading = false,
  onRefresh,
  onRunSkill,
}: SkillsQuickPaneProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills.slice(0, 40);
    return skills
      .filter((skill) =>
        [skill.name, skill.title, skill.description ?? "", skill.sourceId]
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
      .slice(0, 40);
  }, [query, skills]);

  return (
    <section className="skills-quick-pane">
      <div className="list-header compact">
        <div>
          <h2>Skills</h2>
          <span className="workspace-caption">{skills.length} installed catalog item(s)</span>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh skills"
          aria-label="Refresh skills"
        >
          <RefreshCcw size={14} className={loading ? "spin" : ""} />
        </button>
      </div>
      <label className="search-box" title="Search skills">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search skills"
        />
      </label>
      <div className="skills-quick-list">
        {filtered.length === 0 ? (
          <div className="empty-state compact">
            <strong>No skills</strong>
            <p>Open Settings → Skills to add sources or create a managed skill.</p>
          </div>
        ) : (
          filtered.map((skill) => (
            <button
              key={skill.id}
              type="button"
              className="skills-quick-row"
              onClick={() => onRunSkill(skill)}
              title={skill.absPath}
            >
              <span>
                <strong>{skill.name}</strong>
                <small>{skill.description || skill.sourceId}</small>
              </span>
              <Play size={13} />
            </button>
          ))
        )}
      </div>
    </section>
  );
}
