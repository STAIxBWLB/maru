import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Hash, Search } from "lucide-react";
import { useTranslation } from "../lib/i18n";
import { frontmatterScalar } from "../lib/document";
import { getCommandPaletteDocs, type DocumentIndex } from "../lib/documentIndex";
import type { VaultEntry } from "../lib/types";

interface CommandPaletteProps {
  open: boolean;
  documentIndex: DocumentIndex;
  onClose: () => void;
  onSelectEntry: (entry: VaultEntry) => boolean | Promise<boolean>;
  onRunCommand: (id: string) => void;
}

interface CommandAction {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
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
      { id: "new-document", label: t("cmdk.action.newDocument"), shortcut: "⌘ N" },
      { id: "save", label: t("cmdk.action.save"), shortcut: "⌘ S" },
      { id: "snapshot", label: t("cmdk.action.snapshot"), shortcut: "⌘ ⇧ S" },
      { id: "toggle-preview", label: t("cmdk.action.togglePreview"), shortcut: "⌘ P" },
      { id: "toggle-outline", label: t("cmdk.action.toggleOutline"), shortcut: "⌘ \\" },
      { id: "toggle-locale", label: t("cmdk.action.toggleLocale"), shortcut: "⌘ ⇧ L" },
      { id: "refresh-workspace", label: t("cmdk.action.refresh"), shortcut: "⌘ R" },
      { id: "open-inbox", label: t("cmdk.action.openInbox") },
      { id: "open-docs", label: t("cmdk.action.openDocs") },
      { id: "open-settings", label: t("cmdk.action.openSettings"), shortcut: "⌘ ," },
      { id: "add-workspace", label: t("cmdk.action.addWorkspace") },
    ],
    [t],
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

  const actionItems = useMemo(
    () =>
      (query.trim() ? filteredActions : actions).map((action) => ({
      kind: "action" as const,
      action,
    })),
    [actions, filteredActions, query],
  );

  const groups = useMemo(() => {
    const actionGroup = {
      id: "actions",
      label: t("cmdk.section.commands"),
      items: actionItems as PaletteItem[],
    };
    const docGroup = {
      id: "documents",
      label: t("cmdk.section.documents"),
      items: docItems as PaletteItem[],
    };
    const ordered = query.trim() ? [docGroup, actionGroup] : [actionGroup, docGroup];
    return ordered.filter((group) => group.items.length > 0);
  }, [actionItems, docItems, query, t]);

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
        <label className="cmdk-input">
          <Search size={16} style={{ color: "var(--faint)" }} />
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
                      >
                        <span className="cmdk-icon">
                          <FileText size={14} />
                        </span>
                        <span className="cmdk-copy">
                          <strong>{item.entry.title}</strong>
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
