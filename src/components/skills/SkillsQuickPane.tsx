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
      <div className="skills-quick-head">
        <div>
          <span className="skills-quick-kicker">Skill runner</span>
          <h2>Skills</h2>
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
      <label className="search-box skills-quick-search" title="Search skills">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search skills"
        />
      </label>
      <div className="skills-quick-meta">
        <span>{filtered.length} shown</span>
        <span>{skills.length} total</span>
      </div>
      <div className="skills-quick-list">
        {filtered.length === 0 ? (
          <div className="empty-state compact">
            <strong>No skills</strong>
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
              <span className="skills-quick-copy">
                <span className="skills-quick-titleline">
                  <strong>{skill.name}</strong>
                  <span>{skill.sourceId}</span>
                </span>
                <small>{skill.description || skill.relPath}</small>
              </span>
              <span className="skills-quick-run" aria-hidden="true">
                <Play size={12} />
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
