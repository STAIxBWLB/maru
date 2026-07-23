import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Save, X } from "lucide-react";
import {
  listenMaruSettingsUpdated,
  readMaruSettings,
} from "../../lib/maruDir";
import { LocaleContext, useLocaleState, useTranslation } from "../../lib/i18n";
import {
  DEFAULT_MARU_SETTINGS,
  normalizeMaruSettings,
  type MaruSettings,
} from "../../lib/settings";
import {
  SKILL_EDITOR_OPEN_EVENT,
  SKILLS_UPDATED_EVENT,
  type SkillEditorOpenPayload,
  type SkillsUpdatedPayload,
} from "../../lib/skillEditorEvents";
import { listenForMenuCommand } from "../../lib/menu";
import {
  skillsListSources,
  skillsReadSkill,
  skillsSaveSkillAs,
  skillsSaveSkillFile,
  type SkillRecord,
  type SkillSource,
} from "../../lib/skills";
import { applyThemePreference, applyThemeVars, buildThemeVars } from "../../lib/theme";
import { Button } from "../ui/Button";

interface SkillEditorWindowRootProps {
  workPath: string | null;
  skillId: string | null;
}

export function SkillEditorWindowRoot({ workPath, skillId }: SkillEditorWindowRootProps) {
  const localeValue = useLocaleState();
  const { t } = localeValue;
  const [settings, setSettings] = useState<MaruSettings>(() =>
    normalizeMaruSettings(DEFAULT_MARU_SETTINGS),
  );
  const [error, setError] = useState<string | null>(null);
  const themeVars = useMemo(() => buildThemeVars(settings), [settings]);

  useEffect(() => {
    applyThemePreference(settings.ui.themeMode);
    applyThemeVars(themeVars);
  }, [settings.ui.themeMode, themeVars]);

  useEffect(() => {
    let cancelled = false;
    if (!workPath) {
      setSettings(normalizeMaruSettings(DEFAULT_MARU_SETTINGS));
      return;
    }
    void readMaruSettings(workPath)
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [workPath]);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    void listenMaruSettingsUpdated((payload) => {
      if (payload.workPath === workPath) {
        setSettings(normalizeMaruSettings(payload.settings));
      } else if (payload.globalChanged && workPath) {
        void readMaruSettings(workPath)
          .then((next) => setSettings(next))
          .catch((err) => setError(err instanceof Error ? err.message : String(err)));
      }
    }).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
  }, [workPath]);

  return (
    <LocaleContext.Provider value={localeValue}>
      <div className="skill-editor-window-shell" style={themeVars}>
        <SkillEditorWindow initialWorkPath={workPath} initialSkillId={skillId} />
        {error ? (
          <div className="toast-stack">
            <div className="toast" title={error}>
              <AlertTriangle size={15} />
              <span>{error}</span>
              <button
                type="button"
                className="icon-button"
                onClick={() => setError(null)}
                aria-label={t("app.errorClose")}
                title={t("app.errorClose")}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </LocaleContext.Provider>
  );
}

interface SkillEditorWindowProps {
  initialWorkPath: string | null;
  initialSkillId: string | null;
}

function SkillEditorWindow({ initialWorkPath, initialSkillId }: SkillEditorWindowProps) {
  const { t } = useTranslation();
  const [workPath, setWorkPath] = useState<string | null>(initialWorkPath);
  const [skillId, setSkillId] = useState<string | null>(initialSkillId);
  const [skill, setSkill] = useState<SkillRecord | null>(null);
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [text, setText] = useState("");
  const [base, setBase] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const skillIdRef = useRef<string | null>(initialSkillId);
  const workPathRef = useRef<string | null>(initialWorkPath);

  const dirty = text !== base;
  const source = useMemo(
    () => sources.find((item) => item.id === skill?.sourceId) ?? null,
    [skill?.sourceId, sources],
  );

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    skillIdRef.current = skillId;
  }, [skillId]);

  useEffect(() => {
    workPathRef.current = workPath;
  }, [workPath]);

  const loadSkill = useCallback(
    async (nextWorkPath: string | null, nextSkillId: string | null) => {
      if (!nextSkillId) {
        setError(t("skillEditor.noSkill"));
        return;
      }
      setLoading(true);
      setError(null);
      setMessage(null);
      try {
        const doc = await skillsReadSkill(nextSkillId);
        const nextSources = await skillsListSources(nextWorkPath).catch(() => []);
        setWorkPath(nextWorkPath);
        setSkillId(doc.skill.id);
        setSkill(doc.skill);
        setSources(nextSources);
        setText(doc.content);
        setBase(doc.content);
      } catch (err) {
        setError(t("skillEditor.loadFailed", {
          message: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void loadSkill(initialWorkPath, initialSkillId);
  }, [initialSkillId, initialWorkPath, loadSkill]);

  useEffect(() => {
    const title = skill ? t("skillEditor.windowTitleWithName", { name: skill.name }) : t("skillEditor.windowTitle");
    document.title = title;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
      .catch(() => {});
  }, [skill, t]);

  const switchSkill = useCallback(
    async (payload: SkillEditorOpenPayload) => {
      if (payload.skillId === skillIdRef.current && payload.workPath === workPathRef.current) {
        return;
      }
      if (dirtyRef.current && !window.confirm(t("skillEditor.switchConfirm"))) return;
      await loadSkill(payload.workPath, payload.skillId);
    },
    [loadSkill, t],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<SkillEditorOpenPayload>(SKILL_EDITOR_OPEN_EVENT, (event) => {
          if (disposed) return;
          void switchSkill(event.payload);
        }),
      )
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [switchSkill]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onCloseRequested((event) => {
          if (disposed) return;
          if (!dirtyRef.current) return;
          if (!window.confirm(t("skillEditor.closeConfirm"))) event.preventDefault();
        }),
      )
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [t]);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    void listenForMenuCommand((id) => {
      if (id !== "file.close_active" && id !== "window.close") return;
      // Routes through onCloseRequested above, so the dirty guard still applies.
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().close())
        .catch(() => {});
    }).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
  }, []);

  const emitUpdated = useCallback(async (payload: SkillsUpdatedPayload) => {
    await import("@tauri-apps/api/event")
      .then(({ emit }) => emit(SKILLS_UPDATED_EVENT, payload))
      .catch(() => {});
  }, []);

  const save = useCallback(async () => {
    if (!skill) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await skillsSaveSkillFile(skill.id, "SKILL.md", text);
      setSkill(saved);
      setBase(text);
      setMessage(t("skillEditor.saved", { name: saved.name }));
      await emitUpdated({ workPath, skillId: saved.id, action: "save" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [emitUpdated, skill, t, text, workPath]);

  const saveAs = useCallback(async () => {
    if (!skill) return;
    const rawName = window.prompt(t("system.skills.saveAsPrompt"), `${skill.name}-copy`);
    const name = rawName?.trim();
    if (!name) return;
    if (!window.confirm(t("system.skills.saveAsConfirm", { name }))) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const created = await skillsSaveSkillAs(skill.id, name, text);
      setSkillId(created.id);
      setSkill(created);
      setBase(text);
      setMessage(t("skillEditor.savedAs", { name: created.name }));
      await emitUpdated({ workPath, skillId: created.id, action: "saveAs" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [emitUpdated, skill, t, text, workPath]);

  const closeWindow = useCallback(async () => {
    await import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().close())
      .catch(() => {});
  }, []);

  const persistedDirtyLabel = skill?.dirty
    ? source?.kind === "builtin"
      ? t("system.skills.builtinSourceDirty")
      : t("system.skills.linkedSourceDirty")
    : null;

  return (
    <main className="skill-editor-window">
      <header className="skill-editor-window-header">
        <div className="skill-editor-window-title">
          <h1>{skill?.name ?? t("skillEditor.windowTitle")}</h1>
          <p title={skill?.absPath ?? undefined}>
            {skill ? `${skill.sourceId} / ${skill.relPath}` : t("skillEditor.loading")}
          </p>
        </div>
        <div className="skill-editor-window-actions">
          {persistedDirtyLabel ? <span className="dirty-pill">{persistedDirtyLabel}</span> : null}
          <span className={dirty ? "save-state dirty" : "save-state saved"}>
            {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void saveAs()}
            disabled={!skill || loading || saving}
            icon={<Save size={14} />}
          >
            {t("system.skills.saveAs")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={!skill || !dirty || loading || saving}
            icon={<Save size={14} />}
          >
            {t("system.mcp.save")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void closeWindow()}
            icon={<X size={14} />}
          >
            {t("skillEditor.close")}
          </Button>
        </div>
      </header>

      {error ? (
        <div className="skill-editor-window-notice warn" title={error}>
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      ) : message ? (
        <div className="skill-editor-window-notice">
          <span>{message}</span>
        </div>
      ) : null}

      <textarea
        className="source-editor skill-editor-window-source"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={loading ? t("skillEditor.loading") : ""}
        disabled={loading || !skill}
        spellCheck={false}
      />
    </main>
  );
}
