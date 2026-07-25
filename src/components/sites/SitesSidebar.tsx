import {
  Copy,
  ExternalLink,
  FolderSearch,
  Globe,
  Pencil,
  Plus,
  Search,
  SquarePlus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import { clampMenuPosition } from "../../lib/menu";
import { useContextMenuKeyboard } from "../../lib/useContextMenuKeyboard";
import {
  faviconUrlFor,
  filterSitesByQuery,
  groupSitesByCategory,
  reorderSites,
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
  onOpenInNewTab: (site: SiteEntry) => void;
  onOpenExternal: (site: SiteEntry) => void;
  onCopyUrl: (site: SiteEntry) => void;
  onReorder: (sites: SiteEntry[]) => void;
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
  onOpenInNewTab,
  onOpenExternal,
  onCopyUrl,
  onReorder,
  onAdd,
  onEdit,
  onDelete,
  onImport,
}: SitesSidebarProps) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number; site: SiteEntry } | null>(
    null,
  );
  const [dragId, setDragId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const handleMenuKeyDown = useContextMenuKeyboard(menuRef, !!menu, () => setMenu(null));

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const node = menuRef.current;
    const next = clampMenuPosition(
      { x: menu.x, y: menu.y },
      { width: node.offsetWidth, height: node.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (next.x === menu.x && next.y === menu.y) return;
    setMenu({ ...menu, ...next });
  }, [menu]);
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
                  dragging={dragId === site.id}
                  onSelect={onSelect}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ x: event.clientX, y: event.clientY, site });
                  }}
                  onDragStart={() => setDragId(site.id)}
                  onDragEnd={() => setDragId(null)}
                  onDropOn={(target) => {
                    if (!dragId || dragId === target.id) return;
                    onReorder(reorderSites(sites, dragId, target.id));
                    setDragId(null);
                  }}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {menu ? (
        <div
          ref={menuRef}
          className="context-menu"
          role="menu"
          tabIndex={-1}
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={handleMenuKeyDown}
          onClick={() => setMenu(null)}
        >
          <button type="button" role="menuitem" onClick={() => onSelect(menu.site)}>
            <Globe size={13} />
            {t("sites.menu.open")}
          </button>
          <button type="button" role="menuitem" onClick={() => onOpenInNewTab(menu.site)}>
            <SquarePlus size={13} />
            {t("sites.menu.openInNewTab")}
          </button>
          <button type="button" role="menuitem" onClick={() => onOpenExternal(menu.site)}>
            <ExternalLink size={13} />
            {t("sites.menu.openExternal")}
          </button>
          <button type="button" role="menuitem" onClick={() => onCopyUrl(menu.site)}>
            <Copy size={13} />
            {t("sites.menu.copyUrl")}
          </button>
          <div className="context-menu-separator" role="separator" />
          <button type="button" role="menuitem" onClick={() => onEdit(menu.site)}>
            <Pencil size={13} />
            {t("sites.edit")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => onDelete(menu.site)}
          >
            <Trash2 size={13} />
            {t("sites.delete")}
          </button>
        </div>
      ) : null}
    </aside>
  );
}

// Row is a div role="button" rather than <button> because it nests buttons.
function SiteRow({
  site,
  active,
  dragging,
  onSelect,
  onEdit,
  onDelete,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDropOn,
}: {
  site: SiteEntry;
  active: boolean;
  dragging: boolean;
  onSelect: (site: SiteEntry) => void;
  onEdit: (site: SiteEntry) => void;
  onDelete: (site: SiteEntry) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropOn: (site: SiteEntry) => void;
}) {
  const { t } = useTranslation();
  const [faviconFailed, setFaviconFailed] = useState(false);
  const favicon = faviconUrlFor(site);
  return (
    <div
      className={`sites-item${active ? " active" : ""}${dragging ? " dragging" : ""}`}
      role="button"
      tabIndex={0}
      title={site.url}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDropOn(site);
      }}
      onContextMenu={onContextMenu}
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
