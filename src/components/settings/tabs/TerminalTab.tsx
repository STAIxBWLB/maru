// ============================ Terminal ============================

import { RefreshCcw } from "lucide-react";
import { useTranslation } from "../../../lib/i18n";
import type {
  MaruSettings,
  TerminalDock,
  TerminalTheme,
  TerminalLauncherId,
} from "../../../lib/settings";
import { normalizeMaruSettings } from "../../../lib/settings";
import {
  DEFAULT_TERMINAL_SHORTCUTS,
  TERMINAL_SHORTCUT_ACTIONS,
  type TerminalShortcutAction,
} from "../../../lib/terminalShortcuts";
import { CompactSelect, ModeHeader, SegmentedControl } from "../../ui/ModeChrome";
import { Toggle } from "../../ui/Toggle";
import { SettingsSection } from "../SettingsSection";
import { SettingsRow } from "../SettingsRow";

export function TerminalTab({
  settings,
  onSettingsChange,
}: {
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
}) {
  const { t } = useTranslation();

  const updateTerminal = (patch: Partial<MaruSettings["terminal"]>) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        terminal: { ...settings.terminal, ...patch },
      }),
    );
  };

  const updateTerminalDock = (terminalDock: TerminalDock) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: {
          ...settings.ui,
          layout: { ...settings.ui.layout, terminalDock },
        },
      }),
    );
  };

  const updateTerminalShortcut = (action: TerminalShortcutAction, value: string) => {
    updateTerminal({
      shortcuts: {
        ...settings.terminal.shortcuts,
        [action]: value.trim() ? value.trim() : null,
      },
    });
  };

  const resetTerminalShortcut = (action: TerminalShortcutAction) => {
    updateTerminalShortcut(action, DEFAULT_TERMINAL_SHORTCUTS[action] ?? "");
  };

  return (
    <div className="settings-tab">
      <ModeHeader
        title={t("system.tab.terminal")}
        subtitle={t("system.terminal.title")}
      />
      <SettingsSection title={t("system.terminal.section.panel")}>
        <SettingsRow
          label={t("system.preferences.terminalAutoLaunch")}
          htmlFor="terminal-auto-launch"
          control={
            <CompactSelect
              id="terminal-auto-launch"
              value={settings.terminal.autoLaunch ?? "none"}
              onChange={(event) =>
                updateTerminal({
                  autoLaunch:
                    event.target.value === "none"
                      ? null
                      : (event.target.value as TerminalLauncherId),
                })
              }
            >
              <option value="shell">{t("terminal.launcher.shell")}</option>
              <option value="claude">{t("terminal.launcher.claude")}</option>
              <option value="codex">{t("terminal.launcher.codex")}</option>
              <option value="kimi">{t("terminal.launcher.kimi")}</option>
              <option value="kiro">{t("terminal.launcher.kiro")}</option>
              <option value="none">{t("system.preferences.terminalAutoLaunch.none")}</option>
            </CompactSelect>
          }
        />
        <SettingsRow
          label={t("system.preferences.terminalDock")}
          control={
            <SegmentedControl<TerminalDock>
              label={t("system.preferences.terminalDock")}
              value={settings.ui.layout.terminalDock}
              onChange={updateTerminalDock}
              options={[
                { value: "bottom", label: t("terminal.dock.bottom") },
                { value: "right", label: t("terminal.dock.right") },
              ]}
            />
          }
        />
        <SettingsRow
          label={t("system.preferences.terminalTheme")}
          htmlFor="terminal-theme"
          control={
            <CompactSelect
              id="terminal-theme"
              value={settings.terminal.theme}
              onChange={(event) =>
                updateTerminal({ theme: event.target.value as TerminalTheme })
              }
            >
              <option value="dark">{t("terminal.theme.dark")}</option>
              <option value="light">{t("terminal.theme.light")}</option>
              <option value="solarized">{t("terminal.theme.solarized")}</option>
            </CompactSelect>
          }
        />
        <SettingsRow
          label={t("system.preferences.terminalCopyOnSelect")}
          control={
            <Toggle
              checked={settings.terminal.copyOnSelect}
              onChange={(copyOnSelect) => updateTerminal({ copyOnSelect })}
              aria-label={t("system.preferences.terminalCopyOnSelect")}
            />
          }
        />
      </SettingsSection>
      <SettingsSection
        title={t("system.terminal.section.shortcuts")}
        description={t("system.preferences.terminalShortcuts.help")}
      >
        <div className="terminal-shortcut-grid">
          {TERMINAL_SHORTCUT_ACTIONS.map((action) => {
            const value = settings.terminal.shortcuts[action] ?? "";
            return (
              <div key={action} className="terminal-shortcut-row">
                <label htmlFor={`terminal-shortcut-${action}`}>
                  {t(`system.preferences.terminalShortcut.${action}`)}
                </label>
                <input
                  key={`${action}:${value}`}
                  id={`terminal-shortcut-${action}`}
                  defaultValue={value}
                  placeholder={t("system.preferences.terminalShortcut.unbound")}
                  onBlur={(event) => updateTerminalShortcut(action, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="terminal-shortcut-reset"
                  onClick={() => resetTerminalShortcut(action)}
                  aria-label={t("system.preferences.terminalShortcut.reset")}
                  title={t("system.preferences.terminalShortcut.reset")}
                >
                  <RefreshCcw size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </SettingsSection>
    </div>
  );
}
