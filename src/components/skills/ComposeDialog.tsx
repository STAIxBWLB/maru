import {
  ArrowRight,
  Code2,
  FileText,
  FolderOpen,
  Info,
  Loader2,
  Play,
  Search,
  SquareTerminal,
  Workflow,
  X,
} from "lucide-react";
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
import { chooseFiles } from "../../lib/api";
import { appendSourceBlock } from "../../lib/meetingNotesPrompt";
import { Button } from "../ui/Button";

type ComposeMode = "terminal" | "background" | "structured";
const EMPTY_RUNTIME_COMMANDS: Partial<Record<SkillDispatchRuntime, string | null>> = {};

const MEETING_NOTES_SKILL = "meeting-notes";
// Skills that accept a pasted/dropped transcript-like source in the dialog.
// Today this is a fixed set; a future frontmatter flag can extend it.
const SOURCE_INPUT_SKILLS = new Set<string>([MEETING_NOTES_SKILL]);

function skillAcceptsSource(skill: SkillRecord | null): boolean {
  return Boolean(skill && SOURCE_INPUT_SKILLS.has(skill.name));
}

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
  terminalRuntimeCommands?: Partial<Record<SkillDispatchRuntime, string | null>>;
  aiRuntimeCommands?: Partial<Record<SkillDispatchRuntime, string | null>>;
  defaultRuntime?: SkillDispatchRuntime;
  permissionMode?: string;
  /**
   * Workspace root the Meetings pane reads run events from. Meeting-notes runs
   * launched here are pinned to it so the review panel can find their events.
   */
  meetingsWorkspacePath?: string | null;
  /** Switch the app to the Meetings transcript workbench (nudge action). */
  onOpenMeetingsWorkbench?: () => void;
  onError: (message: string | null) => void;
}

export function ComposeDialog({
  open,
  skills,
  seed,
  onClose,
  onTerminalDispatch,
  onBackgroundDispatch,
  terminalRuntimeCommands = EMPTY_RUNTIME_COMMANDS,
  aiRuntimeCommands = EMPTY_RUNTIME_COMMANDS,
  defaultRuntime,
  permissionMode,
  meetingsWorkspacePath,
  onOpenMeetingsWorkbench,
  onError,
}: ComposeDialogProps) {
  const { t } = useTranslation();
  const [skillId, setSkillId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [sourceFiles, setSourceFiles] = useState<string[]>([]);
  const [skillQuery, setSkillQuery] = useState("");
  const [runtime, setRuntime] = useState<SkillDispatchRuntime>(defaultRuntime ?? "claude");
  const [mode, setMode] = useState<ComposeMode>("background");
  const [preview, setPreview] = useState<DispatchComposition | null>(null);
  const [busy, setBusy] = useState(false);
  const [runtimeStatuses, setRuntimeStatuses] = useState<
    Partial<Record<SkillDispatchRuntime, SkillRuntimeStatus>>
  >({});
  const [runtimeStatusLoading, setRuntimeStatusLoading] = useState(false);
  const runtimeStatusCommands = mode === "terminal" ? terminalRuntimeCommands : aiRuntimeCommands;

  useEffect(() => {
    if (!open) return;
    setSkillId(seed?.skill?.id ?? skills[0]?.id ?? "");
    setPrompt(seed?.prompt ?? "");
    setSourceText("");
    setSourceFiles([]);
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
          commandOverride: runtimeStatusCommands[candidate] ?? null,
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
  }, [open, onError, runtimeStatusCommands]);

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
  const acceptsSource = skillAcceptsSource(selectedSkill);
  const isMeetingNotes = selectedSkill?.name === MEETING_NOTES_SKILL;
  // Fold the pasted source text into the prompt and the picked files into the
  // context, so the preview, all dispatch paths, and tracking metadata see the
  // same composition. The backend wraps the prompt verbatim and renders context
  // files in <selected_context>, so no backend change is needed.
  const effectivePrompt = useMemo(() => {
    if (!acceptsSource || !sourceText.trim()) return prompt;
    return appendSourceBlock(prompt, sourceText);
  }, [acceptsSource, prompt, sourceText]);
  const effectiveContext = useMemo<SkillContextItem[]>(() => {
    const base = seed?.context ?? [];
    if (!acceptsSource || sourceFiles.length === 0) return base;
    const seen = new Set(base.map((item) => item.path));
    const extra = sourceFiles
      .filter((path) => !seen.has(path))
      .map((path) => ({ path, kind: "file" as const }));
    return extra.length > 0 ? [...base, ...extra] : base;
  }, [acceptsSource, seed?.context, sourceFiles]);
  const skillValid = selectedSkill?.valid ?? true;
  const selectedRuntimeStatus = runtimeStatuses[runtime] ?? null;
  const runtimeReady = selectedRuntimeStatus?.available === true;
  const canRun = Boolean(selectedSkill && skillValid && effectivePrompt.trim() && runtimeReady);

  useEffect(() => {
    if (!open || !selectedSkill || !skillValid || !effectivePrompt.trim()) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void skillsDispatchCompose({
        skillId: selectedSkill.id,
        prompt: effectivePrompt,
        cwd: seed?.cwd ?? null,
        context: effectiveContext,
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
  }, [effectiveContext, open, effectivePrompt, seed?.cwd, selectedSkill, skillValid]);

  if (!open) return null;

  async function run() {
    if (!selectedSkill || !effectivePrompt.trim() || !runtimeReady) return;
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
        // Compose the full directive (SKILL.md body + selected context + user
        // prompt) the same way terminal/background dispatch does, so the loop
        // sees the skill's actual instructions, not just its name.
        const composition = await skillsDispatchCompose({
          skillId: selectedSkill.id,
          prompt: effectivePrompt,
          cwd: seed.cwd,
          context: effectiveContext,
        });
        const runId = await agentRunStructuredLoop({
          provider: runtime,
          directive: composition.prompt,
          cwd: seed.cwd,
          commandOverride: aiRuntimeCommands[runtime] ?? null,
          permissionMode: permissionMode ?? null,
        });
        onBackgroundDispatch?.(runId);
        dispatchEvent = { mode: "structured", runtime, invocationId: runId };
      } else if (mode === "terminal") {
        const spec = await skillsDispatchTerminal({
          skillId: selectedSkill.id,
          runtime,
          prompt: effectivePrompt,
          cwd: seed?.cwd ?? null,
          context: effectiveContext,
          commandOverride: terminalRuntimeCommands[runtime] ?? null,
        });
        onTerminalDispatch(spec);
        dispatchEvent = { mode: "terminal", runtime, invocationId: null };
      } else {
        // Meeting-notes runs are tracked as reviewable missions in the Meetings
        // pane. Pin cwd to the meetings workspace root so the review panel can
        // read this run's events, and tag the metadata so isMeetingsMission
        // surfaces it under Transcript/External.
        const backgroundCwd = isMeetingNotes
          ? meetingsWorkspacePath ?? seed?.cwd ?? null
          : seed?.cwd ?? null;
        if (isMeetingNotes && !backgroundCwd) {
          onError(t("skills.compose.meetingNeedsWorkspace"));
          setBusy(false);
          return;
        }
        const invocationId = await skillsDispatchBackground({
          skillId: selectedSkill.id,
          runtime,
          prompt: effectivePrompt,
          cwd: backgroundCwd,
          context: effectiveContext,
          commandOverride: aiRuntimeCommands[runtime] ?? null,
          permissionMode: permissionMode ?? null,
          metadata: isMeetingNotes
            ? {
                origin: "meetingNotesFromTranscript",
                skillName: selectedSkill.name,
                runtime,
                reviewFlow: true,
                sourceKind: "transcript",
                workspacePath: backgroundCwd,
                inputPaths: effectiveContext.map((item) => item.path),
              }
            : {
                origin: "skillCompose",
                skillName: selectedSkill.name,
                runtime,
                workspacePath: backgroundCwd,
                inputPaths: effectiveContext.map((item) => item.path),
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
                    {isMeetingNotes ? ` ${t("skills.compose.meetingTerminalWarning")}` : ""}
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
            {acceptsSource ? (
              <div className="compose-source">
                <label className="field">
                  <span>{t("skills.compose.source")}</span>
                  <textarea
                    className="compose-source-text"
                    value={sourceText}
                    onChange={(event) => setSourceText(event.target.value)}
                    placeholder={t("skills.compose.sourcePlaceholder")}
                  />
                </label>
                <div className="compose-source-controls">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void chooseFiles(t("skills.compose.sourcePick")).then(setSourceFiles)}
                  >
                    <FolderOpen size={14} />
                    {t("skills.compose.sourcePick")}
                  </button>
                  <div className="compose-context compose-source-files">
                    {sourceFiles.length > 0 ? (
                      sourceFiles.map((path) => (
                        <span key={path} title={path}>
                          <FileText size={12} />
                          {path.split("/").pop() ?? path}
                        </span>
                      ))
                    ) : (
                      <span>{t("skills.compose.sourceFilesEmpty")}</span>
                    )}
                  </div>
                </div>
                {isMeetingNotes ? (
                  <div className="compose-nudge">
                    <Info size={14} />
                    <span>{t("skills.compose.meetingTrackedNudge")}</span>
                    {onOpenMeetingsWorkbench ? (
                      <button type="button" onClick={onOpenMeetingsWorkbench}>
                        {t("skills.compose.openMeetingsWorkbench")}
                        <ArrowRight size={13} />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

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
