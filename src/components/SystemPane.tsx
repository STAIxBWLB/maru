// SystemPane — anchor's `.anchor/` operations surface.
//
// One pane, six tabs (Rules / Templates / MCP / Projects / Skills /
// Import). Reads exclusively from `<work>/.anchor/`; the external
// `_sys/` tree is only touched through the Import tab.

import { AlertTriangle, Check, Plus, RefreshCcw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applySysImport,
  deleteAnchorRule,
  deleteAnchorTemplate,
  listAnchorRules,
  listAnchorTemplates,
  planSysImport,
  readAnchorMcp,
  readAnchorProjects,
  readAnchorRule,
  readAnchorSkills,
  readAnchorTemplate,
  saveAnchorMcp,
  saveAnchorRule,
  saveAnchorTemplate,
} from "../lib/anchorDir";
import { useTranslation } from "../lib/i18n";
import type {
  ImportItem,
  ImportPlan,
  RuleEntry,
  TemplateEntry,
} from "../lib/types";
import { Button } from "./ui/Button";

type SystemTab = "rules" | "templates" | "mcp" | "projects" | "skills" | "import";

interface SystemPaneProps {
  workPath: string | null;
}

export function SystemPane({ workPath }: SystemPaneProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SystemTab>("rules");

  if (!workPath) {
    return (
      <main className="system-pane system-empty">
        <div className="empty-document-plate">
          <h2>{t("system.title")}</h2>
          <p>{t("system.empty")}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="system-pane">
      <header className="system-header">
        <div>
          <h2>{t("system.title")}</h2>
          <p className="muted">{t("system.subtitle")}</p>
        </div>
      </header>
      <nav className="system-tabs" role="tablist">
        {(
          [
            ["rules", "system.tab.rules"],
            ["templates", "system.tab.templates"],
            ["mcp", "system.tab.mcp"],
            ["projects", "system.tab.projects"],
            ["skills", "system.tab.skills"],
            ["import", "system.tab.import"],
          ] as Array<[SystemTab, string]>
        ).map(([id, key]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? "system-tab active" : "system-tab"}
            onClick={() => setTab(id)}
            role="tab"
            aria-selected={tab === id}
          >
            {t(key)}
          </button>
        ))}
      </nav>
      <section className="system-body">
        {tab === "rules" ? <RulesTab workPath={workPath} /> : null}
        {tab === "templates" ? <TemplatesTab workPath={workPath} /> : null}
        {tab === "mcp" ? <McpTab workPath={workPath} /> : null}
        {tab === "projects" ? <ProjectsTab workPath={workPath} /> : null}
        {tab === "skills" ? <SkillsTab workPath={workPath} /> : null}
        {tab === "import" ? <ImportTab workPath={workPath} /> : null}
      </section>
    </main>
  );
}

// =============================== Rules ===============================

function RulesTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<RuleEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [pristine, setPristine] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await listAnchorRules(workPath);
      setEntries(list);
      if (selected && !list.some((e) => e.name === selected)) {
        setSelected(null);
        setContent("");
        setPristine("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, selected]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSelect = useCallback(
    async (name: string) => {
      setError(null);
      try {
        const doc = await readAnchorRule(workPath, name);
        setSelected(name);
        setContent(doc.content);
        setPristine(doc.content);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workPath],
  );

  const onSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await saveAnchorRule(workPath, selected, content);
      setPristine(content);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [workPath, selected, content, refresh]);

  const onDelete = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(t("system.rules.delete.confirm"))) return;
    try {
      await deleteAnchorRule(workPath, selected);
      setSelected(null);
      setContent("");
      setPristine("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, selected, t, refresh]);

  const onNew = useCallback(async () => {
    const raw = window.prompt("Rule name (lowercase-with-dashes):", "new-rule");
    if (!raw) return;
    const name = raw.trim();
    if (!name) return;
    const stub = `---\nenabled: true\n---\n# ${name}\n\n`;
    try {
      await saveAnchorRule(workPath, name, stub);
      await refresh();
      await onSelect(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, refresh, onSelect]);

  const dirty = content !== pristine;

  return (
    <div className="system-split">
      <aside className="system-list">
        <div className="system-list-actions">
          <Button variant="secondary" size="sm" onClick={onNew} icon={<Plus size={13} />}>
            {t("system.rules.new")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} icon={<RefreshCcw size={13} />} aria-label={t("app.refresh")} />
        </div>
        {entries.length === 0 ? (
          <p className="muted system-list-empty">{t("system.rules.empty")}</p>
        ) : (
          <ul>
            {entries.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className={selected === entry.name ? "system-list-item active" : "system-list-item"}
                  onClick={() => void onSelect(entry.name)}
                >
                  <span className="system-list-item-title">{entry.title}</span>
                  <span className="system-list-item-name muted">{entry.name}</span>
                  {!entry.enabled ? <span className="chip chip-warn">off</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <section className="system-detail">
        {selected ? (
          <>
            <div className="system-detail-actions">
              <span className={dirty ? "save-state dirty" : "save-state saved"}>
                {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
              </span>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void onSave()}
                disabled={saving || !dirty}
                icon={<Save size={14} />}
              >
                {saving ? t("editor.saving") : t("system.rules.save")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onDelete()}
                icon={<Trash2 size={14} />}
              >
                {t("system.rules.delete")}
              </Button>
            </div>
            <textarea
              className="source-editor"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
            />
          </>
        ) : (
          <p className="muted">{t("system.rules.empty")}</p>
        )}
        {error ? (
          <div className="toast">
            <AlertTriangle size={13} />
            <span>{error}</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}

// ============================ Templates ============================

function TemplatesTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<TemplateEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [pristine, setPristine] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listAnchorTemplates(workPath);
      setEntries(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSelect = useCallback(
    async (name: string) => {
      try {
        const c = await readAnchorTemplate(workPath, name);
        setSelected(name);
        setContent(c);
        setPristine(c);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workPath],
  );

  const onSave = useCallback(async () => {
    if (!selected) return;
    try {
      await saveAnchorTemplate(workPath, selected, content);
      setPristine(content);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, selected, content, refresh]);

  const onDelete = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(t("system.rules.delete.confirm"))) return;
    try {
      await deleteAnchorTemplate(workPath, selected);
      setSelected(null);
      setContent("");
      setPristine("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, selected, t, refresh]);

  const onNew = useCallback(async () => {
    const raw = window.prompt("Template name (lowercase-with-dashes):", "new-template");
    if (!raw) return;
    const name = raw.trim();
    if (!name) return;
    const stub = `---\ntype: note\n---\n# ${name}\n\n`;
    try {
      await saveAnchorTemplate(workPath, name, stub);
      await refresh();
      await onSelect(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, refresh, onSelect]);

  const dirty = content !== pristine;

  return (
    <div className="system-split">
      <aside className="system-list">
        <div className="system-list-actions">
          <Button variant="secondary" size="sm" onClick={onNew} icon={<Plus size={13} />}>
            {t("system.templates.new")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} icon={<RefreshCcw size={13} />} aria-label={t("app.refresh")} />
        </div>
        {entries.length === 0 ? (
          <p className="muted system-list-empty">{t("system.templates.empty")}</p>
        ) : (
          <ul>
            {entries.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className={selected === entry.name ? "system-list-item active" : "system-list-item"}
                  onClick={() => void onSelect(entry.name)}
                >
                  <span className="system-list-item-title">{entry.title}</span>
                  <span className="system-list-item-name muted">{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <section className="system-detail">
        {selected ? (
          <>
            <div className="system-detail-actions">
              <span className={dirty ? "save-state dirty" : "save-state saved"}>
                {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
              </span>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void onSave()}
                disabled={!dirty}
                icon={<Save size={14} />}
              >
                {t("system.rules.save")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onDelete()}
                icon={<Trash2 size={14} />}
              >
                {t("system.rules.delete")}
              </Button>
            </div>
            <textarea
              className="source-editor"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
            />
          </>
        ) : (
          <p className="muted">{t("system.templates.empty")}</p>
        )}
        {error ? (
          <div className="toast">
            <AlertTriangle size={13} />
            <span>{error}</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}

// ================================ MCP ================================

function McpTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState<string>("");
  const [pristine, setPristine] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const value = await readAnchorMcp(workPath);
      const json = JSON.stringify(value ?? {}, null, 2);
      setText(json);
      setPristine(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSave = useCallback(async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError(t("system.mcp.invalidJson"));
      return;
    }
    try {
      await saveAnchorMcp(workPath, parsed);
      setPristine(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, text, t]);

  const dirty = text !== pristine;

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      <div className="system-detail-actions">
        <span className={dirty ? "save-state dirty" : "save-state saved"}>
          {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
        </span>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void onSave()}
          disabled={!dirty}
          icon={<Save size={14} />}
        >
          {t("system.mcp.save")}
        </Button>
      </div>
      <textarea
        className="source-editor"
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
      />
      {error ? (
        <div className="toast">
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

// ============================== Projects ==============================

function ProjectsTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [value, setValue] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setValue(await readAnchorProjects(workPath));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [workPath]);

  const json = useMemo(() => JSON.stringify(value ?? {}, null, 2), [value]);
  const isEmpty = useMemo(() => {
    if (!value || typeof value !== "object") return true;
    const obj = value as Record<string, unknown>;
    const registry = obj.registry as Record<string, unknown> | undefined;
    if (!registry) return Object.keys(obj).length <= 1; // only "version"
    const cats = (registry as { categories?: unknown[] }).categories;
    return !Array.isArray(cats) || cats.length === 0;
  }, [value]);

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      {isEmpty ? (
        <p className="muted">{t("system.projects.empty")}</p>
      ) : (
        <pre className="system-json-view">{json}</pre>
      )}
      {error ? (
        <div className="toast">
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

// =============================== Skills ===============================

function SkillsTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [value, setValue] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setValue(await readAnchorSkills(workPath));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [workPath]);

  const skills = useMemo(() => {
    if (!value || typeof value !== "object") return [];
    const arr = (value as { skills?: unknown[] }).skills;
    if (!Array.isArray(arr)) return [];
    return arr as Array<{
      name?: string;
      description?: string;
      runtime?: string;
      category?: string;
      source?: string;
    }>;
  }, [value]);

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      {skills.length === 0 ? (
        <p className="muted">{t("system.skills.empty")}</p>
      ) : (
        <ul className="system-skill-list">
          {skills.map((skill, i) => (
            <li className="system-skill-card" key={`${skill.name ?? "skill"}-${i}`}>
              <div className="system-skill-name">{skill.name ?? "(unnamed)"}</div>
              {skill.description ? <div className="muted">{skill.description}</div> : null}
              <div className="system-skill-meta">
                <span>
                  {t("system.skills.runtime")}: <code>{skill.runtime ?? "—"}</code>
                </span>
                {skill.category ? (
                  <span>
                    {t("system.skills.category")}: <code>{skill.category}</code>
                  </span>
                ) : null}
                {skill.source ? (
                  <span>
                    {t("system.skills.source")}: <code>{skill.source}</code>
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <div className="toast">
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

// ============================== Import ==============================

function ImportTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const next = await planSysImport(workPath);
      setPlan(next);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const allItems: ImportItem[] = useMemo(() => {
    if (!plan) return [];
    const out: ImportItem[] = [];
    out.push(...plan.rules);
    out.push(...plan.templates);
    if (plan.mcp) out.push(plan.mcp);
    if (plan.projects) out.push(plan.projects);
    if (plan.skills) out.push(plan.skills);
    return out;
  }, [plan]);

  const toggle = useCallback((origin: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(origin)) next.delete(origin);
      else next.add(origin);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(allItems.map((i) => i.originRel)));
  }, [allItems]);

  const selectChanged = useCallback(() => {
    setSelected(
      new Set(
        allItems.filter((i) => i.status !== "unchanged").map((i) => i.originRel),
      ),
    );
  }, [allItems]);

  const apply = useCallback(async () => {
    if (!plan) return;
    setApplying(true);
    setError(null);
    try {
      const receipt = await applySysImport(workPath, plan, Array.from(selected));
      setAppliedCount(receipt.applied.length);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }, [workPath, plan, selected, refresh]);

  if (!plan) {
    return <p className="muted">{t("inbox.loading")}</p>;
  }
  if (!plan.sysPresent) {
    return <p className="muted">{t("system.import.empty")}</p>;
  }

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      <p className="muted">{t("system.import.subtitle")}</p>
      <div className="system-detail-actions">
        <Button variant="ghost" size="sm" onClick={selectAll}>
          {t("system.import.selectAll")}
        </Button>
        <Button variant="ghost" size="sm" onClick={selectChanged}>
          {t("system.import.selectChanges")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} icon={<RefreshCcw size={13} />}>
          {t("app.refresh")}
        </Button>
        <span style={{ flex: 1 }} />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void apply()}
          disabled={applying || selected.size === 0}
          icon={<Check size={14} />}
        >
          {applying ? t("system.import.applying") : t("system.import.apply")}
        </Button>
      </div>

      {appliedCount !== null ? (
        <div className="toast notice">
          <Check size={13} />
          <span>{t("system.import.applied", { count: appliedCount })}</span>
        </div>
      ) : null}
      {error ? (
        <div className="toast">
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      ) : null}

      <ImportSection title={t("system.import.section.rules")} items={plan.rules} selected={selected} onToggle={toggle} t={t} />
      <ImportSection
        title={t("system.import.section.templates")}
        items={plan.templates}
        selected={selected}
        onToggle={toggle}
        t={t}
      />
      <ImportSection
        title={t("system.import.section.mcp")}
        items={plan.mcp ? [plan.mcp] : []}
        selected={selected}
        onToggle={toggle}
        t={t}
      />
      <ImportSection
        title={t("system.import.section.projects")}
        items={plan.projects ? [plan.projects] : []}
        selected={selected}
        onToggle={toggle}
        t={t}
      />
      <ImportSection
        title={t("system.import.section.skills")}
        items={plan.skills ? [plan.skills] : []}
        selected={selected}
        onToggle={toggle}
        t={t}
      />
    </div>
  );
}

interface ImportSectionProps {
  title: string;
  items: ImportItem[];
  selected: Set<string>;
  onToggle: (origin: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

function ImportSection({ title, items, selected, onToggle, t }: ImportSectionProps) {
  if (items.length === 0) return null;
  return (
    <section className="system-import-section">
      <h4>{title}</h4>
      <ul>
        {items.map((item) => (
          <li key={item.originRel} className="system-import-item">
            <label>
              <input
                type="checkbox"
                checked={selected.has(item.originRel)}
                onChange={() => onToggle(item.originRel)}
              />
              <span className="system-import-label">{item.label}</span>
              <span className="muted system-import-rel">{item.originRel}</span>
              <span className={`chip chip-${item.status}`}>
                {t(`system.import.status.${item.status}`)}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
