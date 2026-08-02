// Settings navigation — the single declarative source for the settings
// sidebar. Replaces the hand-duplicated SystemTab union / isSystemTab
// validator pair that used to live in SystemPane.tsx.

import {
  Bot,
  CalendarClock,
  CalendarDays,
  FolderKanban,
  Inbox,
  KeyRound,
  LayoutTemplate,
  ListTodo,
  MessagesSquare,
  Network,
  Plug,
  Puzzle,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
  Terminal,
} from "lucide-react";

export const SETTINGS_NAV_GROUPS = [
  "ai",
  "general",
  "workflows",
  "workspace",
  "connections",
  "privacy",
] as const;

export type SettingsNavGroup = (typeof SETTINGS_NAV_GROUPS)[number];

export const SETTINGS_NAV = [
  {
    id: "ai",
    group: "ai",
    icon: Sparkles,
    labelKey: "system.tab.ai",
    keywords: ["ai", "runtime", "model", "provider", "llm"],
  },
  {
    id: "agents",
    group: "ai",
    icon: Bot,
    labelKey: "system.tab.agents",
    keywords: ["agents", "에이전트", "login", "usage", "provider"],
  },
  {
    id: "preferences",
    group: "general",
    icon: SlidersHorizontal,
    labelKey: "system.tab.preferences",
    keywords: ["general", "일반", "appearance", "theme", "workspace", "files"],
  },
  {
    id: "terminal",
    group: "general",
    icon: Terminal,
    labelKey: "system.tab.terminal",
    keywords: ["terminal", "터미널", "shell", "dock", "shortcuts"],
  },
  {
    id: "comms",
    group: "workflows",
    icon: MessagesSquare,
    labelKey: "system.tab.comms",
    keywords: ["comms", "messages", "메시지", "telegram", "kakao"],
  },
  {
    id: "inbox-channels",
    group: "workflows",
    icon: Inbox,
    labelKey: "system.tab.inboxChannels",
    keywords: ["inbox", "channels", "gmail", "outlook"],
  },
  {
    id: "meetings",
    group: "workflows",
    icon: CalendarDays,
    labelKey: "system.tab.meetings",
    keywords: ["meetings", "회의", "calendar", "notes"],
  },
  {
    id: "tasks",
    group: "workflows",
    icon: ListTodo,
    labelKey: "system.tab.tasks",
    keywords: ["tasks", "태스크", "todo", "today"],
  },
  {
    id: "jobs",
    group: "workflows",
    icon: CalendarClock,
    labelKey: "system.tab.jobs",
    keywords: ["jobs", "schedule", "launchd", "cron", "예약"],
  },
  {
    id: "projects",
    group: "workspace",
    icon: FolderKanban,
    labelKey: "system.tab.projects",
    keywords: ["projects", "프로젝트", "workspaces"],
  },
  {
    id: "rules",
    group: "workspace",
    icon: ScrollText,
    labelKey: "system.tab.rules",
    keywords: ["rules", "규칙", "policies"],
  },
  {
    id: "templates",
    group: "workspace",
    icon: LayoutTemplate,
    labelKey: "system.tab.templates",
    keywords: ["templates", "템플릿", "documents"],
  },
  {
    id: "skills",
    group: "workspace",
    icon: Puzzle,
    labelKey: "system.tab.skills",
    keywords: ["skills", "스킬", "plugins"],
  },
  {
    id: "connectors",
    group: "connections",
    icon: Plug,
    labelKey: "system.tab.connectors",
    keywords: ["connectors", "커넥터", "integrations"],
  },
  {
    id: "mcp",
    group: "connections",
    icon: Network,
    labelKey: "system.tab.mcp",
    keywords: ["mcp", "servers", "tools"],
  },
  {
    id: "secrets",
    group: "privacy",
    icon: KeyRound,
    labelKey: "system.tab.secrets",
    keywords: ["secrets", "시크릿", "keys", "tokens", "security"],
  },
] as const;

export type SettingsTabId = (typeof SETTINGS_NAV)[number]["id"];

export function isSettingsTabId(value: unknown): value is SettingsTabId {
  return SETTINGS_NAV.some((item) => item.id === value);
}
