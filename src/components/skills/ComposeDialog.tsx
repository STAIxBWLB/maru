import { Code2, FileText, Loader2, Play, Search, SquareTerminal, Workflow, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  DispatchComposition,
  SkillContextItem,
  SkillDispatchRuntime,
  SkillRuntimeStatus,
  SkillRecord,
  TerminalDispatchSpec,
} from "../../lib/skills";
import { useTranslation } from "../../lib/i18n";
import {
  agentRunStructuredLoop,
  skillsDispatchBackground,
  skillsDispatchCompose,
  skillsDispatchTerminal,
  skillsRuntimeStatus,
} from "../../lib/skills";
import { Button } from "../ui/Button";

type ComposeMode = "terminal" | "background" | "structured";

export interface ComposeDialogSeed {
  skill?: SkillRecord | null;
  context?: SkillContextItem[];
  cwd?: string | null;
  prompt?: string;
  onDispatched?: (event: ComposeDialogDispatchEvent) => void | Promise<void>;
}

export interface ComposeDialogDispatchEvent {
  mode: ComposeMode;
  runtime: SkillDispatchRuntime;
  invocationId: string | null;
}

interface ComposeDialogProps {
  open: boolean;
  skills: SkillRecord[];
  seed: ComposeDialogSeed | null;
  onClose: () => void;
  onTerminalDispatch: (spec: TerminalDispatchSpec) => void;
  onBackgroundDispatch?: (invocationId: string) => void;
  runtimeCommands?: Partial<Record<SkillDispatchRuntime, string | null>>;
  defaultRuntime?: SkillDispatchRuntime;
  onError: (message: string | null) => void;
}

export function ComposeDialog({
  open,
  skills,
  seed,
  onClose,
  onTerminalDispatch,
  onBackgroundDispatch,
  runtimeCommands = {},
  defaultRuntime,
  onError,
}: ComposeDialogProps) {
  const { t } = useTranslation();
  const [skillId, setSkillId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const [runtime, setRuntime] = useState<SkillDispatchRuntime>(defaultRuntime ?? "claude");
  const [mode, setMode] = useState<ComposeMode>("background");
  const [preview, setPreview] = useState<DispatchComposition | null>(null);
  const [busy, setBusy] = useState(false);
  const [runtimeStatuses, setRuntimeStatuses] = useState<
    Partial<Record<SkillDispatchRuntime, SkillRuntimeStatus>>
  >({});
  const [runtimeStatusLoading, setRuntimeStatusLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSkillId(seed?.skill?.id ?? skills[0]?.id ?? "");
    setPrompt(seed?.prompt ?? "");
    setSkillQuery("");
    setRuntime(readLastSkillRuntime() ?? defaultRuntime ?? "claude");
    setMode("background");
    setPreview(null);
  }, [open, seed, skills, defaultRuntime]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRuntimeStatusLoading(true);
    Promise.all(
      (["claude", "codex"] as SkillDispatchRuntime[]).map(async (candidate) => {
        const status = await skillsRuntimeStatus({
          runtime: candidate,
          commandOverride: runtimeCommands[candidate] ?? null,
        });
        return [candidate, status] as const;
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        const next = Object.fromEntries(entries) as Partial<
          Record<SkillDispatchRuntime, SkillRuntimeStatus>
        >;
        setRuntimeStatuses(next);
        setRuntime((current) => {
          if (next[current]?.available) return current;
          if (next.claude?.available) return "claude";
          if (next.codex?.available) return "codex";
          return current;
        });
      })
      .catch((err) => {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setRuntimeStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, onError, runtimeCommands]);

  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === skillId) ?? null,
    [skillId, skills],
  );
  const visibleSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase();
    const matches = q
      ? skills.filter((skill) =>
          [skill.name, skill.title, skill.description ?? "", skill.sourceId]
            .join(" ")
            .toLowerCase()
            .includes(q),
        )
      : skills;
    if (selectedSkill && !matches.some((skill) => skill.id === selectedSkill.id)) {
      return [selectedSkill, ...matches];
    }
    return matches;
  }, [selectedSkill, skillQuery, skills]);
  const context = seed?.context ?? [];
  const skillValid = selectedSkill?.valid ?? true;
  const selectedRuntimeStatus = runtimeStatuses[runtime] ?? null;
  const runtimeReady = selectedRuntimeStatus?.available === true;
  const canRun = Boolean(selectedSkill && skillValid && prompt.trim() && runtimeReady);

  useEffect(() => {
    if (!open || !selectedSkill || !skillValid || !prompt.trim()) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void skillsDispatchCompose({
        skillId: selectedSkill.id,
        prompt,
        cwd: seed?.cwd ?? null,
        context,
      })
        .then((composition) => {
          if (!cancelled) setPreview(composition);
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [context, open, prompt, seed?.cwd, selectedSkill, skillValid]);

  if (!open) return null;

  async function run() {
    if (!selectedSkill || !prompt.trim() || !runtimeReady) return;
    setBusy(true);
    onError(null);
    try {
      let dispatchEvent: ComposeDialogDispatchEvent;
      if (mode === "structured") {
        if (!seed?.cwd) {
          onError(t("skills.compose.structuredNeedsCwd"));
          setBusy(false);
          return;
        }
        const directive = `[skill: ${selectedSkill.name}]\n\n${prompt}`;
        const runId = await agentRunStructuredLoop({
          provider: runtime,
          directive,
          cwd: seed.cwd,
          commandOverride: runtimeCommands[runtime] ?? null,
        });
        onBackgroundDispatch?.(runId);
        dispatchEvent = { mode: "structured", runtime, invocationId: runId };
      } else if (mode === "terminal") {
        const spec = await skillsDispatchTerminal({
          skillId: selectedSkill.id,
          runtime,
          prompt,
          cwd: seed?.cwd ?? null,
          context,
          commandOverride: runtimeCommands[runtime] ?? null,
        });
        onTerminalDispatch(spec);
        dispatchEvent = { mode: "terminal", runtime, invocationId: null };
      } else {
        const invocationId = await skillsDispatchBackground({
          skillId: selectedSkill.id,
          runtime,
          prompt,
          cwd: seed?.cwd ?? null,
          context,
          commandOverride: runtimeCommands[runtime] ?? null,
          metadata: {
            origin: "skillCompose",
            skillName: selectedSkill.name,
            runtime,
            workspacePath: seed?.cwd ?? null,
            inputPaths: context.map((item) => item.path),
          },
        });
        onBackgroundDispatch?.(invocationId);
        dispatchEvent = { mode: "background", runtime, invocationId };
      }
      writeLastSkillRuntime(runtime);
      try {
        await seed?.onDispatched?.(dispatchEvent);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="compose-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="compose-dialog" role="dialog" aria-modal="true">
        <header className="compose-header">
          <div>
            <h2>{t("skills.compose.title")}</h2>
            <p>
              {context.length > 0
                ? t("skills.compose.selectedCount", { count: context.length })
                : t("skills.compose.noSelection")}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={t("dialog.close")}
          >
            <X size={14} />
          </button>
        </header>

        <div className="compose-body">
          <aside className="compose-run-panel">
            <label className="search-box compose-skill-search" title={t("skills.compose.search")}>
              <Search size={14} />
              <input
                value={skillQuery}
                onChange={(event) => setSkillQuery(event.target.value)}
                placeholder={t("skills.compose.search")}
              />
            </label>
            <label className="field">
              <span>{t("skills.compose.skill")}</span>
              {visibleSkills.length > 0 ? (
                <select value={skillId} onChange={(event) => setSkillId(event.target.value)}>
                  {visibleSkills.map((skill) => (
                    <option key={skill.id} value={skill.id}>
                      {skill.name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="compose-empty-select">{t("skills.compose.noSkillsAvailable")}</div>
              )}
            </label>

            {selectedSkill ? (
              <div className={`compose-skill-summary ${skillValid ? "" : "invalid"}`}>
                <strong>{selectedSkill.title || selectedSkill.name}</strong>
                <span>{selectedSkill.description || selectedSkill.absPath}</span>
                {!skillValid ? (
                  <small>
                    Invalid frontmatter: {(selectedSkill.validationErrors ?? []).join(", ")}
                  </small>
                ) : null}
              </div>
            ) : (
              <div className="compose-skill-summary muted">
                <strong>{t("skills.compose.noSkillSelected")}</strong>
              </div>
            )}

            <div className="compose-run-groups">
              <div>
                <span className="compose-label">{t("skills.compose.target")}</span>
                <div
                  className="segmented-control"
                  role="group"
                  aria-label={t("skills.compose.runTarget")}
                >
                  <button
                    type="button"
                    className={runtime === "claude" ? "active" : ""}
                    onClick={() => setRuntime("claude")}
                    disabled={runtimeStatuses.claude?.available === false}
                  >
                    <SquareTerminal size={13} />
                    <span>Claude</span>
                  </button>
                  <button
                    type="button"
                    className={runtime === "codex" ? "active" : ""}
                    onClick={() => setRuntime("codex")}
                    disabled={runtimeStatuses.codex?.available === false}
                  >
                    <Code2 size={13} />
                    <span>Codex</span>
                  </button>
                </div>
                <div
                  className="compose-runtime-status"
                  data-state={runtimeStatusState(selectedRuntimeStatus, runtimeStatusLoading)}
                >
                  {runtimeStatusLoading && !selectedRuntimeStatus ? (
                    <>
                      <Loader2 size={12} className="spin" />
                      <span>{t("skills.runtime.checking")}</span>
                    </>
                  ) : selectedRuntimeStatus?.available ? (
                    <span>
                      {t("skills.runtime.ready", {
                        runtime: runtimeLabel(runtime),
                        version: selectedRuntimeStatus.version ?? "",
                      })}
                    </span>
                  ) : (
                    <span>
                      {selectedRuntimeStatus?.message ?? t("skills.runtime.unavailable")}
                    </span>
                  )}
                  {selectedRuntimeStatus?.suggestedAction ? (
                    <small>{selectedRuntimeStatus.suggestedAction}</small>
                  ) : null}
                </div>
              </div>

              <div>
                <span className="compose-label">{t("skills.compose.mode")}</span>
                <div
                  className="segmented-control"
                  role="group"
                  aria-label={t("skills.compose.runMode")}
                >
                  <button
                    type="button"
                    className={mode === "terminal" ? "active" : ""}
                    onClick={() => setMode("terminal")}
                  >
                    <SquareTerminal size={13} />
                    <span>{t("skills.compose.terminal")}</span>
                  </button>
                  <button
                    type="button"
                    className={mode === "background" ? "active" : ""}
                    onClick={() => setMode("background")}
                  >
                    <Play size={13} />
                    <span>{t("skills.compose.background")}</span>
                  </button>
                  <button
                    type="button"
                    className={mode === "structured" ? "active" : ""}
                    onClick={() => setMode("structured")}
                  >
                    <Workflow size={13} />
                    <span>{t("skills.compose.structured")}</span>
                  </button>
                </div>
                {mode === "terminal" ? (
                  <p className="compose-mode-note">
                    {t("skills.compose.terminalFreeRun")}
                  </p>
                ) : mode === "structured" ? (
                  <p className="compose-mode-note">
                    {t("skills.compose.structuredNote")}
                  </p>
                ) : (
                  <p className="compose-mode-note">
                    {t("skills.compose.backgroundTracked")}
                  </p>
                )}
              </div>
            </div>

            <div className="compose-context">
              {context.length > 0 ? (
                context.map((item) => (
                  <span key={`${item.kind ?? "path"}-${item.path}`} title={item.path}>
                    <FileText size={12} />
                    {item.path.split("/").pop() ?? item.path}
                  </span>
                ))
              ) : (
                <span>{t("skills.compose.noContext")}</span>
              )}
            </div>
          </aside>

          <section className="compose-main">
            <label className="field">
              <span>{t("skills.compose.prompt")}</span>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={t("skills.compose.promptPlaceholder")}
                autoFocus
              />
            </label>

            <details className="compose-preview">
              <summary>{t("skills.compose.preview")}</summary>
              <pre>{preview?.prompt ?? t("skills.compose.previewEmpty")}</pre>
            </details>
          </section>
        </div>

        <footer className="compose-actions">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void run()}
            disabled={!canRun || busy}
            icon={mode === "terminal" ? <SquareTerminal size={14} /> : <Play size={14} />}
          >
            {busy ? t("skills.compose.running") : t("skills.compose.run")}
          </Button>
        </footer>
      </section>
    </div>
  );
}

function runtimeLabel(runtime: SkillDispatchRuntime): string {
  return runtime === "codex" ? "Codex" : "Claude";
}

function runtimeStatusState(
  status: SkillRuntimeStatus | null,
  loading: boolean,
): "loading" | "ready" | "blocked" {
  if (loading && !status) return "loading";
  return status?.available ? "ready" : "blocked";
}

function readLastSkillRuntime(): SkillDispatchRuntime | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem("anchor:last-skill-runtime");
  return value === "claude" || value === "codex" ? value : null;
}

function writeLastSkillRuntime(runtime: SkillDispatchRuntime) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem("anchor:last-skill-runtime", runtime);
  } catch {
    // Best-effort preference only.
  }
}
