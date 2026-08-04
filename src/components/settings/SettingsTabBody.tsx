// SettingsTabBody — maru's `.maru/` operations surface.
//
// One pane for workspace settings and `.maru/` operations. Workspace-local
// JSON stays under `<work>/.maru/`; skill management also talks to the
// global `~/.maru/skills` registry.

import { useTranslation } from "../../lib/i18n";
import type { MaruSettings } from "../../lib/settings";
import type { SettingsTabId } from "./settingsNav";
import type { InboxRuntimeConfig } from "../../lib/types";
import { AgentsSettingsTab } from "../agents/AgentsSettingsTab";
import { JobsTab } from "../jobs/JobsTab";
import { AiSettingsTab } from "./tabs/AiSettingsTab";
import { AppearanceTab } from "./tabs/AppearanceTab";
import { CommsSettingsSystemTab } from "./tabs/CommsSettingsSystemTab";
import { ConnectorsTab } from "./tabs/ConnectorsTab";
import { GeneralTab } from "./tabs/GeneralTab";
import { IgnoreTab } from "./tabs/IgnoreTab";
import { InboxRuntimeConfigTab } from "./tabs/InboxRuntimeConfigTab";
import { MeetingsSettingsSystemTab } from "./tabs/MeetingsSettingsSystemTab";
import { McpTab } from "./tabs/McpTab";
import { ProjectsTab } from "./tabs/ProjectsTab";
import { RulesTab } from "./tabs/RulesTab";
import { SecretsTab } from "./tabs/SecretsTab";
import { SkillsTab } from "./tabs/SkillsTab";
import { TasksSettingsSystemTab } from "./tabs/TasksSettingsSystemTab";
import { TemplatesTab } from "./tabs/TemplatesTab";
import { TerminalTab } from "./tabs/TerminalTab";

interface SettingsTabBodyProps {
  workPath: string | null;
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
  onInboxRuntimeConfigChange?: (config: InboxRuntimeConfig) => void;
  tab: SettingsTabId;
  onTabChange: (tab: SettingsTabId) => void;
}

export function SettingsTabBody({
  workPath,
  settings,
  onSettingsChange,
  onInboxRuntimeConfigChange,
  tab,
  onTabChange,
}: SettingsTabBodyProps) {
  const { t } = useTranslation();

  if (!workPath) {
    return (
      <div className="system-empty">
        <div className="empty-document-plate">
          <h2>{t("system.title")}</h2>
          <p>{t("system.empty")}</p>
        </div>
      </div>
    );
  }

  return (
      <section className="system-body">
        {tab === "preferences" ? (
          <GeneralTab settings={settings} onSettingsChange={onSettingsChange} />
        ) : null}
        {tab === "appearance" ? (
          <AppearanceTab settings={settings} onSettingsChange={onSettingsChange} />
        ) : null}
        {tab === "ai" ? (
          <AiSettingsTab settings={settings} onSettingsChange={onSettingsChange} />
        ) : null}
        {tab === "agents" ? (
          <AgentsSettingsTab
            workPath={workPath}
            settings={settings}
            onSettingsChange={onSettingsChange}
          />
        ) : null}
        {tab === "terminal" ? (
          <TerminalTab settings={settings} onSettingsChange={onSettingsChange} />
        ) : null}
        {tab === "comms" ? (
          <CommsSettingsSystemTab
            workPath={workPath}
            settings={settings}
            onSettingsChange={onSettingsChange}
            onSaved={onInboxRuntimeConfigChange}
            onOpenSkills={() => onTabChange("skills")}
          />
        ) : null}
        {tab === "meetings" ? (
          <MeetingsSettingsSystemTab
            workPath={workPath}
            settings={settings}
            onSettingsChange={onSettingsChange}
          />
        ) : null}
        {tab === "tasks" ? (
          <TasksSettingsSystemTab
            workPath={workPath}
            settings={settings}
            onSettingsChange={onSettingsChange}
          />
        ) : null}
        {tab === "inbox-channels" ? (
          <InboxRuntimeConfigTab
            workPath={workPath}
            settings={settings}
            onSettingsChange={onSettingsChange}
            onSaved={onInboxRuntimeConfigChange}
          />
        ) : null}
        {tab === "secrets" ? <SecretsTab workPath={workPath} /> : null}
        {tab === "connectors" ? (
          <ConnectorsTab settings={settings} onSettingsChange={onSettingsChange} />
        ) : null}
        {tab === "rules" ? <RulesTab workPath={workPath} /> : null}
        {tab === "ignore" ? <IgnoreTab workPath={workPath} /> : null}
        {tab === "templates" ? <TemplatesTab workPath={workPath} /> : null}
        {tab === "mcp" ? <McpTab workPath={workPath} /> : null}
        {tab === "projects" ? <ProjectsTab workPath={workPath} /> : null}
        {tab === "skills" ? <SkillsTab workPath={workPath} /> : null}
        {tab === "jobs" ? <JobsTab workPath={workPath} /> : null}
      </section>
  );
}
