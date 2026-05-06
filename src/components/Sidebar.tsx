import { Clock, FileText, Layers, PanelLeftClose, Plus } from "lucide-react";
import { memo, type CSSProperties } from "react";
import { useTranslation } from "../lib/i18n";
import type { VaultEntry } from "../lib/types";

interface SidebarProps {
  contentCount: number;
  typeCounts: Array<[string, number]>;
  recentEntries: VaultEntry[];
  selectedPath: string | null;
  typeFilter: string | null;
  onTypeFilter: (type: string | null) => void;
  onNewDocument: () => void;
  canCreateDocument: boolean;
  onSelectRecent: (entry: VaultEntry) => void;
  onOpenCommandPalette: () => void;
  onClose?: () => void;
}

export const Sidebar = memo(function Sidebar({
  contentCount,
  typeCounts,
  recentEntries,
  selectedPath,
  typeFilter,
  onTypeFilter,
  onNewDocument,
  canCreateDocument,
  onSelectRecent,
  onOpenCommandPalette,
  onClose,
}: SidebarProps) {
  const { t } = useTranslation();

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <strong>{t("sidebar.types")}</strong>
        {onClose ? (
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            title={t("layout.hideDocumentTypes")}
            aria-label={t("layout.hideDocumentTypes")}
          >
            <PanelLeftClose size={14} />
          </button>
        ) : null}
      </div>
      <div className="sidebar-section">
        <button
          type="button"
          className="sidebar-cta"
          onClick={onNewDocument}
          disabled={!canCreateDocument}
          title={t("newDoc.button")}
          aria-label={t("newDoc.button")}
        >
          <Plus size={15} />
          {t("newDoc.button")}
        </button>
      </div>

      <div className="sidebar-section">
        <div className="shortcut-row" onClick={onOpenCommandPalette} title={t("cmdk.openHint")}>
          <span className="shortcut-label">
            <FileText size={13} className="sidebar-inline-icon" />
            {t("sidebar.commandPalette")}
          </span>
          <span className="keys">
            <span className="kbd">⌘</span>
            <span className="kbd">K</span>
          </span>
        </div>
      </div>

      <div className="sidebar-section">
        <h3 title={t("sidebar.types")}>
          <Layers size={11} className="sidebar-section-title-icon" />
          {t("sidebar.types")}
        </h3>
        <div className="type-filters">
          <button
            type="button"
            className={typeFilter == null ? "type-filter active" : "type-filter"}
            onClick={() => onTypeFilter(null)}
          >
            <span className="type-dot" />
            <span>{t("sidebar.types.all")}</span>
            <span className="count">{contentCount}</span>
          </button>
          {typeCounts.map(([type, count]) => {
            const isUntyped = type === "_";
            const dotColor = colorForType(type);
            const dotStyle = {
              "--dot-color": dotColor,
            } as CSSProperties & Record<"--dot-color", string>;
            return (
              <button
                key={type}
                type="button"
                className={typeFilter === type ? "type-filter active" : "type-filter"}
                onClick={() => onTypeFilter(type)}
              >
                <span
                  className="type-dot"
                  style={dotStyle}
                />
                <span>{isUntyped ? t("sidebar.types.untyped") : type}</span>
                <span className="count">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="sidebar-section flex-fill">
        <h3 title={t("sidebar.recent")}>
          <Clock size={11} className="sidebar-section-title-icon" />
          {t("sidebar.recent")}
        </h3>
        <div className="recent-list">
          {recentEntries.length === 0 ? (
            <div className="recent-empty">
              {t("sidebar.recent.empty")}
            </div>
          ) : (
            recentEntries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className={entry.path === selectedPath ? "recent-item selected" : "recent-item"}
                onClick={() => onSelectRecent(entry)}
                title={entry.relPath}
              >
                <FileText size={12} className="sidebar-inline-icon" />
                <span>{entry.title}</span>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="sidebar-footer">
        <span className="dot" />
        <span>{t("footer.tagline")}</span>
      </div>
    </aside>
  );
});

function colorForType(type: string): string {
  switch (type.toLowerCase()) {
    case "meeting":
      return "var(--info)";
    case "project":
      return "var(--accent)";
    case "reference":
      return "var(--warn)";
    case "task":
      return "var(--purple)";
    case "person":
    case "people":
      return "var(--brown)";
    case "version":
      return "var(--faint)";
    default:
      return "var(--line-strong)";
  }
}
