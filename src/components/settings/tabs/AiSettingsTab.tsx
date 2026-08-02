// ================================ AI =================================

import { useEffect, useState } from "react";
import { useTranslation } from "../../../lib/i18n";
import type {
  AiClassifierRuntime,
  AiPermissionMode,
  AiRuntime,
  MaruSettings,
} from "../../../lib/settings";
import { normalizeMaruSettings } from "../../../lib/settings";
import { CompactSelect, ModeHeader } from "../../ui/ModeChrome";
import { SettingsSection } from "../SettingsSection";
import { SettingsRow } from "../SettingsRow";

export function AiSettingsTab({
  settings,
  onSettingsChange,
}: {
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
}) {
  const { t } = useTranslation();
  const ai = settings.ai;
  const [claudeOverride, setClaudeOverride] = useState(() => ai.commandOverrides.claude ?? "");
  const [codexOverride, setCodexOverride] = useState(() => ai.commandOverrides.codex ?? "");

  useEffect(() => {
    setClaudeOverride(ai.commandOverrides.claude ?? "");
    setCodexOverride(ai.commandOverrides.codex ?? "");
  }, [ai.commandOverrides.claude, ai.commandOverrides.codex]);

  const commitAi = (patch: Partial<MaruSettings["ai"]>) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ai: { ...settings.ai, ...patch },
      }),
    );
  };

  const commitOverride = (runtime: AiRuntime, value: string) => {
    const trimmed = value.trim();
    commitAi({
      commandOverrides: {
        ...ai.commandOverrides,
        [runtime]: trimmed ? trimmed : null,
      },
    });
  };

  const permissionModes: AiPermissionMode[] = [
    "plan",
    "acceptEdits",
    "default",
    "bypassPermissions",
  ];

  return (
    <div className="settings-tab">
      <ModeHeader title={t("system.tab.ai")} subtitle={t("system.ai.title")} />
      <SettingsSection title={t("system.ai.title")}>
        <SettingsRow
          label={t("system.ai.defaultRuntime")}
          htmlFor="ai-default-runtime"
          control={
            <CompactSelect
              id="ai-default-runtime"
              value={ai.defaultRuntime}
              onChange={(event) => commitAi({ defaultRuntime: event.target.value as AiRuntime })}
            >
              <option value="claude">{t("system.ai.runtime.claude")}</option>
              <option value="codex">{t("system.ai.runtime.codex")}</option>
              <option value="kimi">{t("system.ai.runtime.kimi")}</option>
              <option value="kiro">{t("system.ai.runtime.kiro")}</option>
            </CompactSelect>
          }
        />
        <SettingsRow
          label={t("system.ai.classifierRuntime")}
          htmlFor="ai-classifier-runtime"
          control={
            <CompactSelect
              id="ai-classifier-runtime"
              value={ai.classifierRuntime}
              onChange={(event) =>
                commitAi({ classifierRuntime: event.target.value as AiClassifierRuntime })
              }
            >
              <option value="inherit">{t("system.ai.classifierRuntime.inherit")}</option>
              <option value="claude">{t("system.ai.runtime.claude")}</option>
              <option value="codex">{t("system.ai.runtime.codex")}</option>
              <option value="kimi">{t("system.ai.runtime.kimi")}</option>
              <option value="kiro">{t("system.ai.runtime.kiro")}</option>
            </CompactSelect>
          }
        />
        <SettingsRow
          label={t("system.ai.permissionMode")}
          htmlFor="ai-permission-mode"
          control={
            <CompactSelect
              id="ai-permission-mode"
              value={ai.permissionMode}
              onChange={(event) =>
                commitAi({ permissionMode: event.target.value as AiPermissionMode })
              }
            >
              {permissionModes.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`system.ai.permissionMode.${mode}`)}
                </option>
              ))}
            </CompactSelect>
          }
        />
        <SettingsRow
          label={t("system.ai.commandClaude")}
          description={t("system.ai.commandOverride.help")}
          htmlFor="ai-command-claude"
          wide
          control={
            <input
              id="ai-command-claude"
              type="text"
              value={claudeOverride}
              placeholder={t("system.ai.commandOverride.help")}
              onChange={(event) => setClaudeOverride(event.target.value)}
              onBlur={(event) => commitOverride("claude", event.target.value)}
            />
          }
        />
        <SettingsRow
          label={t("system.ai.commandCodex")}
          description={t("system.ai.commandOverride.help")}
          htmlFor="ai-command-codex"
          wide
          control={
            <input
              id="ai-command-codex"
              type="text"
              value={codexOverride}
              placeholder={t("system.ai.commandOverride.help")}
              onChange={(event) => setCodexOverride(event.target.value)}
              onBlur={(event) => commitOverride("codex", event.target.value)}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
