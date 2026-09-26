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
  SKILL_EDITOR_QUIT_CHECK_ACK_EVENT,
  SKILL_EDITOR_QUIT_CHECK_EVENT,
  SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT,
  SKILLS_UPDATED_EVENT,
  type SkillEditorOpenPayload,
  type SkillEditorQuitCheckResponse,
  type SkillsUpdatedPayload,
} from "../../lib/skillEditorEvents";
import { listenForMenuCommand } from "../../lib/menu";
import { lazyImport } from "../../lib/lazyModule";
import {
  skillsListSources,
  skillsReadSkill,
  skillsSaveSkillAs,
  skillsSaveSkillFile,
  type SkillRecord,
  type SkillSource,
} from "../../lib/skills";
import {
  applyThemePreference,
  applyThemeVars,
  buildThemeVars,
  subscribeToSystemTheme,
} from "../../lib/theme";
import { Button } from "../ui/Button";

// Memoized, not raw dynamic import()s: this component's several effects
// each reach for the same handful of Tauri modules on every mount (all
// firing in the same React commit), which can race in some Vite/Vitest
// dev/test module loaders when nothing has resolved that specifier yet —
// see lazyModule.ts's doc comment. Sharing one in-flight promise per
// module sidesteps that and is also strictly cheaper at runtime.
const loadWindowModule = lazyImport(() => import("@tauri-apps/api/window"));
const loadEventModule = lazyImport(() => import("@tauri-apps/api/event"));
const loadDialogModule = lazyImport(() => import("@tauri-apps/plugin-dialog"));
const loadProcessModule = lazyImport(() => import("@tauri-apps/plugin-process"));

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
  useEffect(() => {
    const apply = () => {
      applyThemePreference(settings.ui.themeMode);
      applyThemeVars(buildThemeVars(settings));
    };
    apply();
    return subscribeToSystemTheme(settings.ui.themeMode, apply);
  }, [settings]);

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

  // Same lazy-dictionary gate as the main window: never render raw keys.
  if (!localeValue.ready) return null;

  return (
    <LocaleContext.Provider value={localeValue}>
      <div className="skill-editor-window-shell">
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

export interface SkillEditorWindowProps {
  initialWorkPath: string | null;
  initialSkillId: string | null;
}

/**
 * Asks the native confirm dialog plugin, not `window.confirm` (review
 * finding #2, round 2, owner-observed regression): in this app's WKWebView,
 * `window.confirm` is not a reliable blocking gate — a dirty edit was lost
 * with no dialog ever appearing. `@tauri-apps/plugin-dialog`'s `confirm()`
 * is the SDK's own documented pattern for exactly this
 * (`onCloseRequested`'s doc comment in `@tauri-apps/api/window` uses it as
 * the canonical example).
 */
async function confirmDestructive(message: string): Promise<boolean> {
  const { confirm } = await loadDialogModule();
  return confirm(message, { kind: "warning" });
}

export function SkillEditorWindow({ initialWorkPath, initialSkillId }: SkillEditorWindowProps) {
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
    void loadWindowModule()
      .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
      .catch(() => {});
  }, [skill, t]);

  const switchSkill = useCallback(
    async (payload: SkillEditorOpenPayload) => {
      if (payload.skillId === skillIdRef.current && payload.workPath === workPathRef.current) {
        return;
      }
      if (dirtyRef.current && !(await confirmDestructive(t("skillEditor.switchConfirm")))) return;
      await loadSkill(payload.workPath, payload.skillId);
    },
    [loadSkill, t],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void loadEventModule()
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
    void loadWindowModule()
      .then(({ getCurrentWindow }) =>
        // async is required here, not incidental: onCloseRequested's own
        // wrapper (@tauri-apps/api/window.js) awaits this handler before
        // deciding whether to destroy the window, which is what makes an
        // awaited confirmDestructive() a reliable gate — a synchronous
        // window.confirm() was not (review finding #2, round 2).
        getCurrentWindow().onCloseRequested(async (event) => {
          if (disposed) return;
          if (!dirtyRef.current) return;
          const proceed = await confirmDestructive(t("skillEditor.closeConfirm"));
          if (disposed) return;
          if (!proceed) event.preventDefault();
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
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void loadEventModule()
      .then(({ listen, emit }) =>
        listen(SKILL_EDITOR_QUIT_CHECK_EVENT, () => {
          if (disposed) return;
          // Ack immediately, before any dirty check or dialog: lets
          // requestSkillEditorQuitCheck (windowLayout.ts) tell "this
          // listener wasn't registered yet" (window still initializing —
          // the owner-observed round-2 regression) apart from "listening
          // and now awaiting a real user decision" (only the former is
          // safe to time out).
          void emit(SKILL_EDITOR_QUIT_CHECK_ACK_EVENT, undefined);
          void (async () => {
            // Same guard as onCloseRequested above (same confirm copy),
            // but this only answers whether we're clear to quit — it never
            // closes/destroys the window itself. main only does that once
            // every open window's own guard has passed.
            const proceed = !dirtyRef.current || (await confirmDestructive(t("skillEditor.closeConfirm")));
            if (disposed) return;
            const response: SkillEditorQuitCheckResponse = { proceed };
            void emit(SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT, response);
          })();
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
    let disposed = false;
    let dispose: (() => void) | null = null;
    void listenForMenuCommand((id) => {
      if (id === "file.close_active" || id === "window.close") {
        // Routes through onCloseRequested above, so the dirty guard still applies.
        void loadWindowModule()
          .then(({ getCurrentWindow }) => getCurrentWindow().close())
          .catch(() => {});
        return;
      }
      if (id === "app.quit") {
        // Fallback path (review finding #2, round 2): Rust routes app.quit
        // here only when "main" no longer exists (e.g. it was closed
        // directly, orphaning this window) — quit the whole app through
        // this window's own guard instead of leaving Cmd+Q dead.
        void (async () => {
          if (disposed) return;
          if (dirtyRef.current && !(await confirmDestructive(t("skillEditor.closeConfirm")))) {
            return;
          }
          if (disposed) return;
          const { exit } = await loadProcessModule();
          await exit(0);
        })();
      }
    }).then((off) => {
      if (disposed) off();
      else dispose = off;
    });
    return () => {
      disposed = true;
      dispose?.();
    };
  }, [t]);

  const emitUpdated = useCallback(async (payload: SkillsUpdatedPayload) => {
    await loadEventModule()
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
    if (!(await confirmDestructive(t("system.skills.saveAsConfirm", { name })))) return;
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
    await loadWindowModule()
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
