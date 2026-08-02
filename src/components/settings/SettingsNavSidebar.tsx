// Settings sidebar — "Back to app", search, then grouped tab items.
// Items keep role="tab" inside a vertical tablist so existing e2e
// getByRole("tab") assertions keep working.

import { ArrowLeft, Search } from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import {
  SETTINGS_NAV,
  SETTINGS_NAV_GROUPS,
  type SettingsTabId,
} from "./settingsNav";

interface SettingsNavSidebarProps {
  activeTab: SettingsTabId;
  onTabChange: (tab: SettingsTabId) => void;
  query: string;
  onQueryChange: (query: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onClose: () => void;
}

export function SettingsNavSidebar({
  activeTab,
  onTabChange,
  query,
  onQueryChange,
  searchInputRef,
  onClose,
}: SettingsNavSidebarProps) {
  const { t } = useTranslation();
  const normalizedQuery = query.trim().toLowerCase();

  const matches = (id: SettingsTabId, labelKey: string, keywords: readonly string[]) => {
    if (!normalizedQuery) return true;
    if (t(labelKey).toLowerCase().includes(normalizedQuery)) return true;
    return keywords.some((keyword) => keyword.toLowerCase().includes(normalizedQuery));
  };

  return (
    <aside className="settings-sidebar">
      <div className="settings-sidebar-drag" data-tauri-drag-region />
      <button type="button" className="settings-back" onClick={onClose}>
        <ArrowLeft size={15} strokeWidth={1.9} aria-hidden="true" />
        <span>{t("system.nav.backToApp")}</span>
      </button>
      <label className="settings-search" title={t("system.nav.searchPlaceholder")}>
        <Search size={14} className="settings-search-icon" aria-hidden="true" />
        <input
          ref={searchInputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("system.nav.searchPlaceholder")}
        />
        <span className="kbd">⌘F</span>
      </label>
      <nav
        className="settings-nav"
        role="tablist"
        aria-orientation="vertical"
        aria-label={t("system.title")}
      >
        {SETTINGS_NAV_GROUPS.map((group) => {
          const items = SETTINGS_NAV.filter(
            (item) => item.group === group && matches(item.id, item.labelKey, item.keywords),
          );
          if (items.length === 0) return null;
          return (
            <div className="settings-nav-group" key={group}>
              <p className="settings-nav-group-label">{t(`system.group.${group}`)}</p>
              {items.map(({ id, labelKey, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === id}
                  className={
                    activeTab === id ? "settings-nav-item active" : "settings-nav-item"
                  }
                  onClick={() => onTabChange(id)}
                >
                  <Icon size={15} strokeWidth={1.9} aria-hidden="true" />
                  <span className="settings-nav-label">{t(labelKey)}</span>
                </button>
              ))}
            </div>
          );
        })}
        {normalizedQuery &&
        !SETTINGS_NAV.some((item) => matches(item.id, item.labelKey, item.keywords)) ? (
          <p className="settings-nav-empty">{t("system.nav.empty")}</p>
        ) : null}
      </nav>
    </aside>
  );
}
