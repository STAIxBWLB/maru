import { Clock, FileText, Layers, PanelLeftClose, Plus } from "lucide-react";
import { memo } from "react";
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
        <button type="button" className="sidebar-cta" onClick={onNewDocument}>
          <Plus size={15} />
          {t("newDoc.button")}
        </button>
      </div>

      <div className="sidebar-section">
        <div className="shortcut-row" onClick={onOpenCommandPalette} title={t("cmdk.openHint")}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <FileText size={13} style={{ opacity: 0.6 }} />
            {t("sidebar.commandPalette")}
          </span>
          <span className="keys">
            <span className="kbd">⌘</span>
            <span className="kbd">K</span>
          </span>
        </div>
      </div>

      <div className="sidebar-section">
        <h3>
          <Layers size={11} style={{ display: "inline-block", verticalAlign: "-1px", marginRight: 5 }} />
          {t("sidebar.types")}
        </h3>
        <div className="type-filters">
          <button
            type="button"
            className={typeFilter == null ? "type-filter active" : "type-filter"}
            onClick={() => onTypeFilter(null)}
          >
            <span style={{ width: 6, height: 6, borderRadius: 3, background: "var(--faint)" }} />
            <span>{t("sidebar.types.all")}</span>
            <span className="count">{contentCount}</span>
          </button>
          {typeCounts.map(([type, count]) => {
            const isUntyped = type === "_";
            const dotColor = colorForType(type);
            return (
              <button
                key={type}
                type="button"
                className={typeFilter === type ? "type-filter active" : "type-filter"}
                onClick={() => onTypeFilter(type)}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    background: dotColor,
                  }}
                />
                <span>{isUntyped ? t("sidebar.types.untyped") : type}</span>
                <span className="count">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="sidebar-section flex-fill">
        <h3>
          <Clock size={11} style={{ display: "inline-block", verticalAlign: "-1px", marginRight: 5 }} />
          {t("sidebar.recent")}
        </h3>
        <div className="recent-list">
          {recentEntries.length === 0 ? (
            <div style={{ padding: "10px 8px", color: "var(--faint)", fontSize: 11.5 }}>
              {t("sidebar.recent.empty")}
            </div>
          ) : (
            recentEntries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="recent-item"
                onClick={() => onSelectRecent(entry)}
                style={
                  entry.path === selectedPath
                    ? { background: "var(--panel)", color: "var(--ink)" }
                    : undefined
                }
                title={entry.relPath}
              >
                <FileText size={12} style={{ opacity: 0.55 }} />
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
      return "#7d3f7a";
    case "person":
    case "people":
      return "#8a6f3e";
    case "version":
      return "var(--faint)";
    default:
      return "var(--line-strong)";
  }
}
