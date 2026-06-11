import { FolderSearch, Globe, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import {
  faviconUrlFor,
  filterSitesByQuery,
  groupSitesByCategory,
  type SiteEntry,
} from "../../lib/sites";

interface SitesSidebarProps {
  sites: SiteEntry[];
  query: string;
  categoryFilter: string; // "all" or a category name
  activeSiteId: string | null;
  loaded: boolean;
  onQueryChange: (query: string) => void;
  onCategoryFilterChange: (category: string) => void;
  onSelect: (site: SiteEntry) => void;
  onAdd: () => void;
  onEdit: (site: SiteEntry) => void;
  onDelete: (site: SiteEntry) => void;
  onImport: () => void;
}

export function SitesSidebar({
  sites,
  query,
  categoryFilter,
  activeSiteId,
  loaded,
  onQueryChange,
  onCategoryFilterChange,
  onSelect,
  onAdd,
  onEdit,
  onDelete,
  onImport,
}: SitesSidebarProps) {
  const { t } = useTranslation();
  const categories = useMemo(
    () =>
      Array.from(
        new Set(
          sites
            .map((site) => site.category)
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [sites],
  );
  const visible = useMemo(() => {
    const filtered = filterSitesByQuery(sites, query);
    if (categoryFilter === "all") return filtered;
    return filtered.filter((site) => (site.category ?? "") === categoryFilter);
  }, [sites, query, categoryFilter]);
  const groups = useMemo(() => groupSitesByCategory(visible), [visible]);

  return (
    <aside className="sites-sidebar">
      <div className="sites-sidebar-header">
        <h2>{t("sites.sidebar.title")}</h2>
        <div className="sites-sidebar-actions">
          <button
            type="button"
            className="icon-button"
            onClick={onImport}
            title={t("sites.import.open")}
            aria-label={t("sites.import.open")}
          >
            <FolderSearch size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onAdd}
            title={t("sites.add")}
            aria-label={t("sites.add")}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>

      <label className="sites-search" title={t("sites.search.placeholder")}>
        <Search size={13} />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("sites.search.placeholder")}
        />
      </label>

      {categories.length > 0 ? (
        <label className="field">
          <select
            value={categoryFilter}
            onChange={(event) => onCategoryFilterChange(event.target.value)}
            aria-label={t("sites.dialog.field.category")}
          >
            <option value="all">{t("sites.category.all")}</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="sites-list">
        {!loaded ? (
          <div className="sites-empty-hint">{t("sites.loading")}</div>
        ) : sites.length === 0 ? (
          <div className="sites-empty-hint">{t("sites.empty")}</div>
        ) : (
          groups.map((group) => (
            <div className="sites-group" key={group.category ?? "__uncategorized__"}>
              <span className="sites-group-label">
                {group.category ?? t("sites.category.uncategorized")}
              </span>
              {group.sites.map((site) => (
                <SiteRow
                  key={site.id}
                  site={site}
                  active={site.id === activeSiteId}
                  onSelect={onSelect}
                  onEdit={onEdit}
                  onDelete={onDelete}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

// Row is a div role="button" rather than <button> because it nests buttons.
function SiteRow({
  site,
  active,
  onSelect,
  onEdit,
  onDelete,
}: {
  site: SiteEntry;
  active: boolean;
  onSelect: (site: SiteEntry) => void;
  onEdit: (site: SiteEntry) => void;
  onDelete: (site: SiteEntry) => void;
}) {
  const { t } = useTranslation();
  const [faviconFailed, setFaviconFailed] = useState(false);
  const favicon = faviconUrlFor(site);
  return (
    <div
      className={active ? "sites-item active" : "sites-item"}
      role="button"
      tabIndex={0}
      title={site.url}
      onClick={() => onSelect(site)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(site);
        }
      }}
    >
      {favicon && !faviconFailed ? (
        <img
          className="sites-item-favicon"
          src={favicon}
          alt=""
          loading="lazy"
          onError={() => setFaviconFailed(true)}
        />
      ) : (
        <Globe size={14} strokeWidth={1.8} />
      )}
      <span className="sites-item-label">{site.label}</span>
      <span className="sites-item-actions">
        <button
          type="button"
          className="icon-button"
          onClick={(event) => {
            event.stopPropagation();
            onEdit(site);
          }}
          title={t("sites.edit")}
          aria-label={t("sites.edit")}
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(site);
          }}
          title={t("sites.delete")}
          aria-label={t("sites.delete")}
        >
          <Trash2 size={13} />
        </button>
      </span>
    </div>
  );
}
