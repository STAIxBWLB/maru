import {
  Copy,
  ExternalLink,
  FolderSearch,
  Globe,
  GripVertical,
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
import { usePointerReorder } from "../ui/usePointerReorder";
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
  const [announcement, setAnnouncement] = useState("");
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
  const visibleIndexById = useMemo(
    () => new Map(visible.map((site, index) => [site.id, index])),
    [visible],
  );

  const announceMove = (site: SiteEntry, rank: number) => {
    setAnnouncement(t("sites.moved", { title: site.label, rank }));
  };

  const pointerReorder = usePointerReorder({
    items: visible,
    getId: (site) => site.id,
    onCommit: ({ items, draggedId, targetId, toIndex }) => {
      const moved = sites.find((site) => site.id === draggedId);
      const target = sites.find((site) => site.id === targetId);
      const visibleIds = new Set(items.map((site) => site.id));
      const orderedVisible = items.map((site) => (
        site.id === draggedId ? { ...site, category: target?.category ?? null } : site
      ));
      let visibleIndex = 0;
      const next = sites
        .map((site) => (
          visibleIds.has(site.id) ? orderedVisible[visibleIndex++] : site
        ))
        .map((site, index) => ({ ...site, order: index }));
      onReorder(next);
      if (moved) announceMove(moved, toIndex + 1);
    },
  });

  const moveWithKeyboard = (site: SiteEntry, direction: -1 | 1) => {
    const index = visibleIndexById.get(site.id);
    if (index === undefined) return;
    const target = visible[index + direction];
    if (!target) return;
    onReorder(reorderSites(sites, site.id, target.id));
    announceMove(site, index + direction + 1);
  };

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
        <div className="today-sr-only" aria-live="polite">
          {announcement}
        </div>
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
              {group.sites.map((site) => {
                const reorderState = pointerReorder.rowState(site.id);
                const index = visibleIndexById.get(site.id) ?? 0;
                return (
                  <SiteRow
                    key={site.id}
                    site={site}
                    active={site.id === activeSiteId}
                    dragging={reorderState.dragging}
                    indicator={reorderState.indicator}
                    dragStyle={reorderState.style}
                    onSelect={onSelect}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu({ x: event.clientX, y: event.clientY, site });
                    }}
                    onReorderPointerDown={(event) => pointerReorder.begin(event, site.id)}
                    onMoveUp={index > 0 ? () => moveWithKeyboard(site, -1) : undefined}
                    onMoveDown={
                      index < visible.length - 1
                        ? () => moveWithKeyboard(site, 1)
                        : undefined
                    }
                  />
                );
              })}
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

// The row is structural; its primary action and reorder handle are real buttons.
function SiteRow({
  site,
  active,
  dragging,
  indicator,
  dragStyle,
  onSelect,
  onEdit,
  onDelete,
  onContextMenu,
  onReorderPointerDown,
  onMoveUp,
  onMoveDown,
}: {
  site: SiteEntry;
  active: boolean;
  dragging: boolean;
  indicator: "reorder-indicator-before" | "reorder-indicator-after" | null;
  dragStyle?: React.CSSProperties;
  onSelect: (site: SiteEntry) => void;
  onEdit: (site: SiteEntry) => void;
  onDelete: (site: SiteEntry) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onReorderPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const { t } = useTranslation();
  const [faviconFailed, setFaviconFailed] = useState(false);
  const favicon = faviconUrlFor(site);
  return (
    <div
      className={[
        "sites-item",
        active ? "active" : "",
        dragging ? "dragging is-dragging" : "",
        indicator ?? "",
      ].filter(Boolean).join(" ")}
      data-reorder-id={site.id}
      style={dragStyle}
      title={`${site.label} - ${site.url}`}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        className="sites-item-grip"
        aria-label={t("sites.reorder")}
        title={t("sites.reorder")}
        onPointerDown={onReorderPointerDown}
      >
        <GripVertical size={13} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="sites-item-primary"
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect(site)}
        onKeyDown={(event) => {
          if (!event.altKey) return;
          if (event.key === "ArrowUp" && onMoveUp) {
            event.preventDefault();
            onMoveUp();
          } else if (event.key === "ArrowDown" && onMoveDown) {
            event.preventDefault();
            onMoveDown();
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
      </button>
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
