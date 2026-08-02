// The agent config form. Used both as the detail pane's 설정 tab and, inside a
// dialog, as the "new agent" flow — the fields are identical, so they are one
// component with a `create` flag rather than two forms that drift.

import { useEffect, useMemo, useState } from "react";
import {
  AGENT_RUNTIME_CHOICES,
  agentLabel,
  slugifyAgentId,
  type AgentPermissionChoice,
  type AgentRecord,
  type AgentRuntimeChoice,
} from "../../lib/agents";
import { useTranslation } from "../../lib/i18n";
import type { SkillRecord } from "../../lib/skills";
import { Button } from "../ui/Button";
import { Field, TextArea, TextInput } from "../ui/Field";
import { CompactSelect } from "../ui/ModeChrome";
import { Toggle } from "../ui/Toggle";

const PERMISSION_CHOICES: AgentPermissionChoice[] = [
  "inherit",
  "plan",
  "acceptEdits",
  "default",
  "bypassPermissions",
];

export interface AgentEditorProps {
  agent: AgentRecord;
  skills: SkillRecord[];
  /** New-agent mode: the name drives the id and the skill must be picked. */
  create?: boolean;
  /** Ids already taken, so a duplicate is caught before the round trip. */
  takenIds?: string[];
  busy?: boolean;
  onSave: (agent: AgentRecord) => void | Promise<void>;
  onCancel?: () => void;
}

export function AgentEditor({
  agent,
  skills,
  create = false,
  takenIds = [],
  busy = false,
  onSave,
  onCancel,
}: AgentEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AgentRecord>(agent);

  useEffect(() => setDraft(agent), [agent]);

  const patch = (next: Partial<AgentRecord>) =>
    setDraft((current) => ({ ...current, ...next }));

  // A skill that failed validation cannot be dispatched, so it is not offered.
  const runnableSkills = useMemo(
    () => skills.filter((skill) => skill.valid !== false),
    [skills],
  );

  const name = create ? (draft.label ?? "") : agentLabel(draft, t);
  const id = create ? slugifyAgentId(draft.label ?? "") : draft.id;
  const duplicateId = create && id.length > 0 && takenIds.includes(id);
  const missingId = create && id.length === 0;
  const missingSkill = draft.skillName.trim().length === 0;
  // A builtin without a prompt is feature-bound: its owning surface supplies
  // one per run, so an empty prompt is valid there and only there.
  const missingPrompt = !draft.builtin && draft.prompt.trim().length === 0;
  const blocked = duplicateId || missingId || missingSkill || missingPrompt;

  return (
    <form
      className="agents-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked || busy) return;
        void onSave(create ? { ...draft, id } : draft);
      }}
    >
      {draft.builtin ? null : (
        <Field
          label={t("agents.editor.name")}
          helper={id ? t("agents.editor.idHint", { id }) : undefined}
          error={
            duplicateId
              ? t("agents.editor.idTaken")
              : missingId && (draft.label ?? "").length > 0
                ? t("agents.editor.idInvalid")
                : undefined
          }
        >
          <TextInput
            value={name}
            autoFocus={create}
            onChange={(event) => patch({ label: event.target.value })}
            placeholder={t("agents.editor.namePlaceholder")}
          />
        </Field>
      )}

      <Field label={t("agents.editor.skill")}>
        {draft.builtin ? (
          // A builtin's skill is fixed: its call site depends on that skill's
          // output contract, so repointing it would break the feature rather
          // than customize it.
          <p className="agents-editor-fixed">
            <code>{draft.skillName || t("agents.editor.skillNone")}</code>
            <span>{t("agents.editor.skillLocked")}</span>
          </p>
        ) : (
          <CompactSelect
            value={draft.skillName}
            onChange={(event) => patch({ skillName: event.target.value })}
          >
            <option value="">{t("agents.editor.skillPick")}</option>
            {runnableSkills.map((skill) => (
              <option key={skill.id} value={skill.name}>
                {skill.name}
              </option>
            ))}
          </CompactSelect>
        )}
      </Field>

      <div className="agents-editor-row">
        <Field label={t("agents.editor.runtime")}>
          <CompactSelect
            value={draft.runtime}
            onChange={(event) =>
              patch({ runtime: event.target.value as AgentRuntimeChoice })
            }
          >
            {AGENT_RUNTIME_CHOICES.map((runtime) => (
              <option key={runtime} value={runtime}>
                {runtime === "inherit" ? t("agents.runtime.inherit") : runtime}
              </option>
            ))}
          </CompactSelect>
        </Field>

        <Field label={t("agents.editor.permission")}>
          <CompactSelect
            value={draft.permissionMode}
            onChange={(event) =>
              patch({ permissionMode: event.target.value as AgentPermissionChoice })
            }
          >
            {PERMISSION_CHOICES.map((mode) => (
              <option key={mode} value={mode}>
                {mode === "inherit" ? t("agents.permission.inherit") : mode}
              </option>
            ))}
          </CompactSelect>
        </Field>
      </div>

      {draft.kind === "inline" ? (
        <p className="agents-editor-note">{t("agents.editor.inlineNote")}</p>
      ) : (
        <Field
          label={t("agents.editor.prompt")}
          helper={draft.builtin ? t("agents.editor.promptBuiltinHint") : undefined}
          error={missingPrompt ? t("agents.editor.promptRequired") : undefined}
        >
          <TextArea
            rows={6}
            value={draft.prompt}
            onChange={(event) => patch({ prompt: event.target.value })}
            placeholder={t("agents.editor.promptPlaceholder")}
          />
        </Field>
      )}

      <div className="agents-editor-toggle">
        <span id={`agent-enabled-${draft.id || "new"}`}>{t("agents.editor.enabled")}</span>
        <Toggle
          checked={draft.enabled}
          onChange={(checked) => patch({ enabled: checked })}
          aria-labelledby={`agent-enabled-${draft.id || "new"}`}
        />
      </div>

      <div className="agents-editor-actions">
        <Button type="submit" variant="primary" disabled={blocked || busy}>
          {create ? t("agents.editor.create") : t("agents.editor.save")}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("agents.editor.cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
