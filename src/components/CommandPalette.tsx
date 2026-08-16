import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Hash, Search } from "lucide-react";
import { useTranslation } from "../lib/i18n";
import { documentDisplayName, frontmatterScalar } from "../lib/document";
import { getCommandPaletteDocs, type DocumentIndex } from "../lib/documentIndex";
import type { DocumentLabelMode } from "../lib/settings";
import type { VaultEntry } from "../lib/types";

interface CommandPaletteProps {
  open: boolean;
  documentIndex: DocumentIndex;
  onClose: () => void;
  onSelectEntry: (entry: VaultEntry) => boolean | Promise<boolean>;
  onRunCommand: (id: string) => void;
  documentLabelMode: DocumentLabelMode;
  skillActions?: CommandAction[];
  diagramEnabled?: boolean;
}

/** Section order in the palette. Actions without a group fall into `skills`,
 *  which is where the dynamically supplied skill commands belong. */
const ACTION_GROUPS = [
  "navigate",
  "create",
  "document",
  "layout",
  "agent",
  "workspace",
  "skills",
] as const;

type ActionGroup = (typeof ACTION_GROUPS)[number];

interface CommandAction {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  group?: ActionGroup;
}

type PaletteItem =
  | { kind: "doc"; entry: VaultEntry }
  | { kind: "action"; action: CommandAction };

export const CommandPalette = memo(function CommandPalette({
  open,
  documentIndex,
  onClose,
  onSelectEntry,
  onRunCommand,
  documentLabelMode,
  skillActions = [],
  diagramEnabled = false,
}: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [picking, setPicking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const deferredQuery = useDeferredValue(query);

  const actions: CommandAction[] = useMemo(
    () => [
      { id: "open-catalog", label: t("cmdk.action.openCatalog"), group: "navigate" },
      { id: "open-studio", label: t("cmdk.action.openStudio"), group: "navigate" },
      ...(diagramEnabled
        ? [
            {
              id: "open-diagram",
              label: t("cmdk.action.openDiagram"),
              group: "navigate" as const,
            },
          ]
        : []),
      { id: "open-graph", label: t("cmdk.action.openGraph"), group: "navigate" },
      { id: "open-graph-right", label: t("cmdk.action.openGraphRight"), group: "navigate" },
      { id: "open-scratchpad", label: t("cmdk.action.openScratchpad"), group: "navigate" },
      { id: "open-inbox", label: t("cmdk.action.openInbox"), group: "navigate" },
      {
        id: "open-comms",
        label: t("cmdk.action.openComms"),
        shortcut: "⌘ ⇧ M",
        group: "navigate",
      },
      { id: "open-meetings", label: t("cmdk.action.openMeetings"), group: "navigate" },
      { id: "open-today", label: t("cmdk.action.openToday"), group: "navigate" },
      {
        id: "open-tasks",
        label: t("cmdk.action.openTasks"),
        shortcut: "⌘ ⇧ T",
        group: "navigate",
      },
      { id: "open-dashboard", label: t("cmdk.action.openDashboard"), group: "navigate" },
      {
        id: "open-sites",
        label: t("cmdk.action.openSites"),
        shortcut: "⌘ ⇧ B",
        group: "navigate",
      },
      { id: "open-docs", label: t("cmdk.action.openDocs"), group: "navigate" },

      {
        id: "new-document",
        label: t("cmdk.action.newDocument"),
        shortcut: "⌘ N",
        group: "create",
      },
      {
        id: "new-document-from-template",
        label: t("cmdk.action.newDocumentFromTemplate"),
        group: "create",
      },
      { id: "new-scratchpad-memo", label: t("cmdk.action.newScratchpadMemo"), group: "create" },
      { id: "new-scratchpad-idea", label: t("cmdk.action.newScratchpadIdea"), group: "create" },

      { id: "save", label: t("cmdk.action.save"), shortcut: "⌘ S", group: "document" },
      {
        id: "snapshot",
        label: t("cmdk.action.snapshot"),
        shortcut: "⌘ ⇧ S",
        group: "document",
      },
      { id: "export-bundle", label: t("cmdk.action.exportBundle"), group: "document" },
      { id: "export-validate", label: t("cmdk.action.exportValidate"), group: "document" },

      { id: "split-right", label: t("cmdk.action.splitRight"), shortcut: "⌘ D", group: "layout" },
      {
        id: "toggle-preview",
        label: t("cmdk.action.togglePreview"),
        shortcut: "⌘ P",
        group: "layout",
      },
      {
        id: "toggle-outline",
        label: t("cmdk.action.toggleOutline"),
        shortcut: "⌘ \\",
        group: "layout",
      },
      { id: "dock-terminal-right", label: t("cmdk.action.dockTerminalRight"), group: "layout" },
      { id: "dock-terminal-bottom", label: t("cmdk.action.dockTerminalBottom"), group: "layout" },
      { id: "close-all-tabs", label: t("cmdk.action.closeAllTabs"), group: "layout" },

      { id: "attach-active-item", label: t("cmdk.action.attachActiveItem"), group: "agent" },
      { id: "toggle-agent-hooks", label: t("cmdk.action.toggleAgentHooks"), group: "agent" },
      { id: "write-context-hint", label: t("cmdk.action.writeContextHint"), group: "agent" },
      { id: "remove-context-hint", label: t("cmdk.action.removeContextHint"), group: "agent" },

      {
        id: "refresh-workspace",
        label: t("cmdk.action.refresh"),
        shortcut: "⌘ R",
        group: "workspace",
      },
      {
        id: "review-scratchpad-temp",
        label: t("cmdk.action.reviewScratchpadTemp"),
        group: "workspace",
      },
      { id: "add-workspace", label: t("cmdk.action.addWorkspace"), group: "workspace" },
      {
        id: "toggle-locale",
        label: t("cmdk.action.toggleLocale"),
        shortcut: "⌘ ⇧ L",
        group: "workspace",
      },
      {
        id: "open-settings",
        label: t("cmdk.action.openSettings"),
        shortcut: "⌘ ,",
        group: "workspace",
      },
      { id: "check-updates", label: t("cmdk.action.checkUpdates"), group: "workspace" },

      {
        id: "open-skill-compose",
        label: t("cmdk.action.skillCompose"),
        shortcut: "⌘ ⇧ K",
        group: "skills",
      },
      ...skillActions,
    ],
    [diagramEnabled, skillActions, t],
  );

  const filteredDocs = useMemo(
    () => getCommandPaletteDocs(documentIndex, deferredQuery, deferredQuery.trim() ? 24 : 12),
    [documentIndex, deferredQuery],
  );
  const filteredActions = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.trim().toLowerCase();
    return actions.filter((a) => a.label.toLowerCase().includes(q));
  }, [actions, query]);

  const docItems = useMemo(
    () => filteredDocs.map((entry) => ({ kind: "doc" as const, entry })),
    [filteredDocs],
  );

  const groupLabels: Record<ActionGroup, string> = useMemo(
    () => ({
      navigate: t("cmdk.group.navigate"),
      create: t("cmdk.group.create"),
      document: t("cmdk.group.document"),
      layout: t("cmdk.group.layout"),
      agent: t("cmdk.group.agent"),
      workspace: t("cmdk.group.workspace"),
      skills: t("cmdk.group.skills"),
    }),
    [t],
  );

  const groups = useMemo(() => {
    const visibleActions = query.trim() ? filteredActions : actions;
    const actionGroups = ACTION_GROUPS.map((group) => ({
      id: group,
      label: groupLabels[group],
      items: visibleActions
        .filter((action) => (action.group ?? "skills") === group)
        .map((action) => ({ kind: "action" as const, action })) as PaletteItem[],
    }));
    const docGroup = {
      id: "documents",
      label: t("cmdk.section.documents"),
      items: docItems as PaletteItem[],
    };
    // Searching is a lookup, so matching documents lead; browsing is a menu, so
    // the grouped commands lead.
    const ordered = query.trim() ? [docGroup, ...actionGroups] : [...actionGroups, docGroup];
    return ordered.filter((group) => group.items.length > 0);
  }, [actions, docItems, filteredActions, groupLabels, query, t]);

  const indexedGroups = useMemo(() => {
    let index = 0;
    return groups.map((group) => ({
      ...group,
      items: group.items.map((item) => ({ item, index: index++ })),
    }));
  }, [groups]);

  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      setPicking(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  async function pick(idx: number) {
    if (picking) return;
    const it = items[idx];
    if (!it) return;
    if (it.kind === "doc") {
      setPicking(true);
      try {
        const selected = await onSelectEntry(it.entry);
        if (selected) onClose();
      } finally {
        setPicking(false);
      }
      return;
    }
    onRunCommand(it.action.id);
    onClose();
  }

  return (
    <div
      className="cmdk-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="cmdk-shell"
        role="dialog"
        aria-modal="true"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            void pick(cursor);
          }
        }}
      >
        <label className="cmdk-input" title={t("cmdk.placeholder")}>
          <Search size={16} className="cmdk-search-icon" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("cmdk.placeholder")}
          />
          <span className="kbd">esc</span>
        </label>

        <div className="cmdk-list">
          {items.length === 0 ? (
            <div className="cmdk-empty">{t("cmdk.empty")}</div>
          ) : (
            indexedGroups.map((group) => (
              <section className="cmdk-section" key={group.id}>
                <div className="cmdk-section-label">
                  <span>{group.label}</span>
                  <span>{group.items.length}</span>
                </div>
                {group.items.map(({ item, index }) => {
                  const active = index === cursor;
                  if (item.kind === "doc") {
                    const fmType = frontmatterScalar(item.entry.frontmatter, "type");
                    return (
                      <button
                        key={`d-${item.entry.path}`}
                        ref={active ? activeItemRef : undefined}
                        type="button"
                        disabled={picking}
                        className={active ? "cmdk-item active" : "cmdk-item"}
                        onMouseEnter={() => setCursor(index)}
                        onClick={() => void pick(index)}
                        title={item.entry.relPath}
                      >
                        <span className="cmdk-icon">
                          <FileText size={14} />
                        </span>
                        <span className="cmdk-copy">
                          <strong>{documentDisplayName(item.entry, documentLabelMode)}</strong>
                          <span>{item.entry.relPath}</span>
                        </span>
                        {fmType ? (
                          <span className="cmdk-badge" data-type={fmType.toLowerCase()}>
                            {fmType}
                          </span>
                        ) : (
                          <span />
                        )}
                      </button>
                    );
                  }
                  return (
                    <button
                      key={`a-${item.action.id}`}
                      ref={active ? activeItemRef : undefined}
                      type="button"
                      disabled={picking}
                      className={active ? "cmdk-item active" : "cmdk-item"}
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => void pick(index)}
                      title={item.action.label}
                    >
                      <span className="cmdk-icon">
                        <Hash size={14} />
                      </span>
                      <span className="cmdk-copy">
                        <strong>{item.action.label}</strong>
                      </span>
                      {item.action.shortcut ? (
                        <span className="kbd">{item.action.shortcut}</span>
                      ) : (
                        <span />
                      )}
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
});
