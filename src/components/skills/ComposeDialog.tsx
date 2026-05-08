import { Code2, FileText, Play, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  DispatchComposition,
  SkillContextItem,
  SkillDispatchRuntime,
  SkillRecord,
  TerminalDispatchSpec,
} from "../../lib/skills";
import {
  skillsDispatchBackground,
  skillsDispatchCompose,
  skillsDispatchTerminal,
} from "../../lib/skills";
import { Button } from "../ui/Button";

export interface ComposeDialogSeed {
  skill?: SkillRecord | null;
  context?: SkillContextItem[];
  cwd?: string | null;
  prompt?: string;
}

interface ComposeDialogProps {
  open: boolean;
  skills: SkillRecord[];
  seed: ComposeDialogSeed | null;
  onClose: () => void;
  onTerminalDispatch: (spec: TerminalDispatchSpec) => void;
  onBackgroundDispatch?: (invocationId: string) => void;
  onError: (message: string | null) => void;
}

export function ComposeDialog({
  open,
  skills,
  seed,
  onClose,
  onTerminalDispatch,
  onBackgroundDispatch,
  onError,
}: ComposeDialogProps) {
  const [skillId, setSkillId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [runtime, setRuntime] = useState<SkillDispatchRuntime>("claude");
  const [mode, setMode] = useState<"terminal" | "background">("terminal");
  const [preview, setPreview] = useState<DispatchComposition | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSkillId(seed?.skill?.id ?? skills[0]?.id ?? "");
    setPrompt(seed?.prompt ?? "");
    setRuntime("claude");
    setMode("terminal");
    setPreview(null);
  }, [open, seed, skills]);

  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === skillId) ?? null,
    [skillId, skills],
  );
  const context = seed?.context ?? [];
  const canRun = Boolean(selectedSkill && prompt.trim());

  useEffect(() => {
    if (!open || !selectedSkill || !prompt.trim()) {
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
  }, [context, open, prompt, seed?.cwd, selectedSkill]);

  if (!open) return null;

  async function run() {
    if (!selectedSkill || !prompt.trim()) return;
    setBusy(true);
    onError(null);
    try {
      if (mode === "terminal") {
        const spec = await skillsDispatchTerminal({
          skillId: selectedSkill.id,
          runtime,
          prompt,
          cwd: seed?.cwd ?? null,
          context,
        });
        onTerminalDispatch(spec);
      } else {
        const invocationId = await skillsDispatchBackground({
          skillId: selectedSkill.id,
          runtime,
          prompt,
          cwd: seed?.cwd ?? null,
          context,
        });
        onBackgroundDispatch?.(invocationId);
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
            <h2>Apply skill</h2>
            <p>{context.length > 0 ? `${context.length} selected item(s)` : "No selection"}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </header>

        <div className="compose-grid">
          <label className="field">
            <span>Skill</span>
            <select value={skillId} onChange={(event) => setSkillId(event.target.value)}>
              {skills.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.name}
                </option>
              ))}
            </select>
          </label>

          <div className="segmented-control" role="group" aria-label="Run target">
            <button
              type="button"
              className={runtime === "claude" ? "active" : ""}
              onClick={() => setRuntime("claude")}
            >
              <SquareTerminal size={13} />
              <span>Claude</span>
            </button>
            <button
              type="button"
              className={runtime === "codex" ? "active" : ""}
              onClick={() => setRuntime("codex")}
            >
              <Code2 size={13} />
              <span>Codex</span>
            </button>
          </div>

          <div className="segmented-control" role="group" aria-label="Run mode">
            <button
              type="button"
              className={mode === "terminal" ? "active" : ""}
              onClick={() => setMode("terminal")}
            >
              <SquareTerminal size={13} />
              <span>Terminal</span>
            </button>
            <button
              type="button"
              className={mode === "background" ? "active" : ""}
              onClick={() => setMode("background")}
            >
              <Play size={13} />
              <span>Background</span>
            </button>
          </div>
        </div>

        {selectedSkill ? (
          <div className="compose-skill-summary">
            <strong>{selectedSkill.title || selectedSkill.name}</strong>
            <span>{selectedSkill.description || selectedSkill.absPath}</span>
          </div>
        ) : null}

        {context.length > 0 ? (
          <div className="compose-context">
            {context.map((item) => (
              <span key={`${item.kind ?? "path"}-${item.path}`} title={item.path}>
                <FileText size={12} />
                {item.path.split("/").pop() ?? item.path}
              </span>
            ))}
          </div>
        ) : null}

        <label className="field">
          <span>Prompt</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="What should this skill do with the selected context?"
            autoFocus
          />
        </label>

        <details className="compose-preview">
          <summary>Prompt preview</summary>
          <pre>{preview?.prompt ?? ""}</pre>
        </details>

        <footer className="compose-actions">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void run()}
            disabled={!canRun || busy}
            icon={mode === "terminal" ? <SquareTerminal size={14} /> : <Play size={14} />}
          >
            Run
          </Button>
        </footer>
      </section>
    </div>
  );
}
