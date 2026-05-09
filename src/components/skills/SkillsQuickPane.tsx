import { ChevronRight, Play, RefreshCcw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type { SkillRecord } from "../../lib/skills";

interface SkillsQuickPaneProps {
  skills: SkillRecord[];
  loading?: boolean;
  onRefresh: () => void;
  onRunSkill: (skill: SkillRecord) => void;
}

interface SkillKind {
  id: string;
  label: string;
}

interface SkillGroup extends SkillKind {
  skills: SkillRecord[];
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const KIND_ORDER = [
  "design",
  "documents",
  "decks",
  "io",
  "inbox",
  "vault",
  "workspace",
  "private",
  "general",
];

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function kindFromSkill(skill: SkillRecord, t: Translate): SkillKind {
  const category = skill.category?.trim();
  if (category) {
    const id = category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return {
      id: id || `category:${category}`,
      label: titleCase(category) || t("rightPane.skills.kind.general"),
    };
  }

  const name = skill.name.toLowerCase();
  if (name.startsWith("design-")) {
    return { id: "design", label: t("rightPane.skills.kind.design") };
  }
  if (name.startsWith("vault-")) {
    return { id: "vault", label: t("rightPane.skills.kind.vault") };
  }
  if (name.startsWith("io-")) return { id: "io", label: t("rightPane.skills.kind.io") };
  if (name.startsWith("inbox-")) {
    return { id: "inbox", label: t("rightPane.skills.kind.inbox") };
  }
  if (name.endsWith("-deck") || name.includes("deck")) {
    return { id: "decks", label: t("rightPane.skills.kind.decks") };
  }
  if (
    name.includes("toolkit") ||
    ["gaejosik", "hwpx", "meeting-notes"].includes(name)
  ) {
    return { id: "documents", label: t("rightPane.skills.kind.documents") };
  }
  if (["git-sync", "share-outbox", "skill-mine", "task-management"].includes(name)) {
    return { id: "workspace", label: t("rightPane.skills.kind.workspace") };
  }
  if (skill.sourceId.toLowerCase().includes("private")) {
    return { id: "private", label: t("rightPane.skills.kind.private") };
  }
  return { id: "general", label: t("rightPane.skills.kind.general") };
}

function groupSkills(skills: SkillRecord[], t: Translate): SkillGroup[] {
  const byKind = new Map<string, SkillGroup>();
  skills.forEach((skill) => {
    const kind = kindFromSkill(skill, t);
    const group = byKind.get(kind.id) ?? { ...kind, skills: [] };
    group.skills.push(skill);
    byKind.set(kind.id, group);
  });
  return Array.from(byKind.values()).sort((a, b) => {
    const aIndex = KIND_ORDER.indexOf(a.id);
    const bIndex = KIND_ORDER.indexOf(b.id);
    if (aIndex !== -1 || bIndex !== -1) {
      return (
        (aIndex === -1 ? KIND_ORDER.length : aIndex) -
        (bIndex === -1 ? KIND_ORDER.length : bIndex)
      );
    }
    return a.label.localeCompare(b.label);
  });
}

export function SkillsQuickPane({
  skills,
  loading = false,
  onRefresh,
  onRunSkill,
}: SkillsQuickPaneProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills.slice(0, 40);
    return skills
      .filter((skill) =>
        [
          skill.name,
          skill.title,
          skill.description ?? "",
          skill.sourceId,
          skill.category ?? "",
          skill.runtime ?? "",
          skill.relPath,
        ]
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
      .slice(0, 40);
  }, [query, skills]);
  const groups = useMemo(() => groupSkills(filtered, t), [filtered, t]);

  function toggleGroup(groupId: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  return (
    <section className="skills-quick-pane">
      <div className="skills-quick-head">
        <div>
          <span className="skills-quick-kicker">{t("rightPane.skills.kicker")}</span>
          <h2>{t("rightPane.tab.skills")}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          disabled={loading}
          title={t("rightPane.skills.refresh")}
          aria-label={t("rightPane.skills.refresh")}
        >
          <RefreshCcw size={14} className={loading ? "spin" : ""} />
        </button>
      </div>
      <label className="search-box skills-quick-search" title={t("rightPane.skills.search")}>
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("rightPane.skills.search")}
        />
      </label>
      <div className="skills-quick-meta">
        <span>{t("rightPane.skills.shown", { count: filtered.length })}</span>
        <span>{t("rightPane.skills.groups", { count: groups.length })}</span>
      </div>
      <div className="skills-quick-list">
        {filtered.length === 0 ? (
          <div className="empty-state compact">
            <strong>{t("rightPane.skills.empty")}</strong>
          </div>
        ) : (
          groups.map((group) => {
            const collapsed = collapsedGroups.has(group.id);
            return (
              <section className="skills-quick-group" key={group.id}>
                <button
                  type="button"
                  className={
                    collapsed
                      ? "skills-quick-group-head collapsed"
                      : "skills-quick-group-head"
                  }
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={!collapsed}
                >
                  <ChevronRight size={13} />
                  <span>{group.label}</span>
                  <strong>{group.skills.length}</strong>
                </button>
                <div
                  className={
                    collapsed
                      ? "skills-quick-group-body collapsed"
                      : "skills-quick-group-body"
                  }
                >
                  {group.skills.map((skill) => (
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
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
    </section>
  );
}
