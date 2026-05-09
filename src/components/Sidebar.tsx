import * as Dialog from "@radix-ui/react-dialog";
import {
  Archive,
  Clock,
  FileText,
  Inbox,
  Layers,
  PanelLeftClose,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { memo, useMemo, useState, type CSSProperties } from "react";
import {
  documentFilterDefaultDocType,
  documentFilterKey,
  type BuiltInDocumentView,
  type DocumentFilter,
} from "../lib/documentIndex";
import { useTranslation } from "../lib/i18n";
import type { DocumentViewDefinition } from "../lib/settings";
import type { VaultEntry } from "../lib/types";
import { Button } from "./ui/Button";
import { Field, TextInput } from "./ui/Field";

interface SidebarProps {
  contentCount: number;
  typeCounts: Array<[string, number]>;
  documentViews: DocumentViewDefinition[];
  viewCounts: Record<BuiltInDocumentView, number>;
  customViewCounts: Record<string, number>;
  recentEntries: VaultEntry[];
  selectedPath: string | null;
  documentFilter: DocumentFilter;
  onDocumentFilter: (filter: DocumentFilter) => void;
  onDocumentViewsChange: (views: DocumentViewDefinition[]) => void;
  onNewDocument: (docType?: string) => void;
  canCreateDocument: boolean;
  onSelectRecent: (entry: VaultEntry) => void;
  onOpenCommandPalette: () => void;
  onClose?: () => void;
}

export const Sidebar = memo(function Sidebar({
  contentCount,
  typeCounts,
  documentViews,
  viewCounts,
  customViewCounts,
  recentEntries,
  selectedPath,
  documentFilter,
  onDocumentFilter,
  onDocumentViewsChange,
  onNewDocument,
  canCreateDocument,
  onSelectRecent,
  onOpenCommandPalette,
  onClose,
}: SidebarProps) {
  const { t } = useTranslation();
  const activeFilterKey = documentFilterKey(documentFilter);
  const seededDocType = documentFilterDefaultDocType(documentFilter, documentViews) ?? undefined;
  const [editingView, setEditingView] = useState<DocumentViewDefinition | null>(null);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [form, setForm] = useState({
    label: "",
    type: "",
    status: "",
    pathPrefix: "",
    query: "",
    color: "#8f4a80",
  });
  const formHasCriteria = Boolean(
    form.type.trim() || form.status.trim() || form.pathPrefix.trim() || form.query.trim(),
  );
  const canSaveView = Boolean(form.label.trim() && formHasCriteria);
  const builtInViews = useMemo(
    () =>
      [
        { view: "inbox" as const, icon: <Inbox size={12} /> },
        { view: "drafts" as const, icon: <FileText size={12} /> },
        { view: "archive" as const, icon: <Archive size={12} /> },
        { view: "recentlyUpdated" as const, icon: <Clock size={12} /> },
      ],
    [],
  );

  const openNewView = () => {
    setEditingView(null);
    setForm({
      label: "",
      type: "",
      status: "",
      pathPrefix: "",
      query: "",
      color: "#8f4a80",
    });
    setViewDialogOpen(true);
  };

  const openEditView = (view: DocumentViewDefinition) => {
    setEditingView(view);
    setForm({
      label: view.label,
      type: view.type ?? "",
      status: view.status ?? "",
      pathPrefix: view.pathPrefix ?? "",
      query: view.query ?? "",
      color: view.color,
    });
    setViewDialogOpen(true);
  };

  const saveView = () => {
    if (!canSaveView) return;
    const id = editingView?.id ?? makeViewId(form.label, documentViews);
    const nextView: DocumentViewDefinition = {
      id,
      label: form.label.trim(),
      color: form.color,
      type: form.type.trim() || null,
      status: form.status.trim() || null,
      pathPrefix: normalizePathPrefix(form.pathPrefix),
      query: form.query.trim() || null,
    };
    const nextViews = editingView
      ? documentViews.map((view) => (view.id === editingView.id ? nextView : view))
      : [...documentViews, nextView];
    onDocumentViewsChange(nextViews);
    onDocumentFilter({ kind: "custom", viewId: id });
    setViewDialogOpen(false);
  };

  const deleteView = (view: DocumentViewDefinition) => {
    if (!window.confirm(t("sidebar.view.deleteConfirm", { name: view.label }))) return;
    const nextViews = documentViews.filter((item) => item.id !== view.id);
    onDocumentViewsChange(nextViews);
    if (activeFilterKey === `custom:${view.id}`) onDocumentFilter({ kind: "all" });
  };

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
          onClick={() => onNewDocument(seededDocType)}
          disabled={!canCreateDocument}
          title={t("newDoc.button")}
          aria-label={t("newDoc.button")}
        >
          <Plus size={15} />
          {t("newDoc.button")}
        </button>
      </div>

      <div className="sidebar-section">
        <button
          type="button"
          className="shortcut-row"
          onClick={onOpenCommandPalette}
          title={t("cmdk.openHint")}
        >
          <span className="shortcut-label">
            <FileText size={13} className="sidebar-inline-icon" />
            {t("sidebar.commandPalette")}
          </span>
          <span className="keys">
            <span className="kbd">⌘</span>
            <span className="kbd">K</span>
          </span>
        </button>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-heading">
          <h3 title={t("sidebar.views")}>
            <Layers size={11} className="sidebar-section-title-icon" />
            {t("sidebar.views")}
          </h3>
          <button
            type="button"
            className="sidebar-section-tool"
            onClick={openNewView}
            title={t("sidebar.view.add")}
            aria-label={t("sidebar.view.add")}
          >
            <Plus size={12} />
          </button>
        </div>
        <div className="type-filters">
          <button
            type="button"
            className={activeFilterKey === "all" ? "type-filter active" : "type-filter"}
            onClick={() => onDocumentFilter({ kind: "all" })}
          >
            <span className="type-dot" />
            <span>{t("sidebar.types.all")}</span>
            <span className="count">{contentCount}</span>
          </button>
          {builtInViews.map(({ view, icon }) => (
            <button
              key={view}
              type="button"
              className={
                activeFilterKey === `view:${view}` ? "type-filter active" : "type-filter"
              }
              onClick={() => onDocumentFilter({ kind: "view", view })}
            >
              <span className="sidebar-inline-icon">{icon}</span>
              <span>{t(`sidebar.view.${view}`)}</span>
              <span className="count">{viewCounts[view]}</span>
            </button>
          ))}
          {documentViews.map((view) => {
            const dotStyle = {
              "--dot-color": view.color,
            } as CSSProperties & Record<"--dot-color", string>;
            return (
              <div className="custom-view-row" key={view.id}>
                <button
                  type="button"
                  className={
                    activeFilterKey === `custom:${view.id}`
                      ? "type-filter custom-view-main active"
                      : "type-filter custom-view-main"
                  }
                  onClick={() => onDocumentFilter({ kind: "custom", viewId: view.id })}
                >
                  <span className="type-dot" style={dotStyle} />
                  <span>{view.label}</span>
                  <span className="count">{customViewCounts[view.id] ?? 0}</span>
                </button>
                <button
                  type="button"
                  className="type-filter-tool"
                  onClick={() => openEditView(view)}
                  title={t("sidebar.view.edit")}
                  aria-label={t("sidebar.view.edit")}
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  className="type-filter-tool"
                  onClick={() => deleteView(view)}
                  title={t("sidebar.view.delete")}
                  aria-label={t("sidebar.view.delete")}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
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
            className={activeFilterKey === "untyped" ? "type-filter active" : "type-filter"}
            onClick={() => onDocumentFilter({ kind: "untyped" })}
          >
            <span className="type-dot" />
            <span>{t("sidebar.types.untyped")}</span>
            <span className="count">{typeCounts.find(([type]) => type === "_")?.[1] ?? 0}</span>
          </button>
          {typeCounts.map(([type, count]) => {
            const isUntyped = type === "_";
            if (isUntyped) return null;
            const dotColor = colorForType(type);
            const dotStyle = {
              "--dot-color": dotColor,
            } as CSSProperties & Record<"--dot-color", string>;
            return (
              <button
                key={type}
                type="button"
                className={
                  activeFilterKey === `type:${type}` ? "type-filter active" : "type-filter"
                }
                onClick={() => onDocumentFilter({ kind: "type", type })}
              >
                <span className="type-dot" style={dotStyle} />
                <span>{type}</span>
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
      <Dialog.Root open={viewDialogOpen} onOpenChange={setViewDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <div className="dialog-header">
              <Dialog.Title>
                {editingView ? t("sidebar.view.editTitle") : t("sidebar.view.addTitle")}
              </Dialog.Title>
            </div>
            <Field label={t("sidebar.view.field.label")}>
              <TextInput
                value={form.label}
                onChange={(event) => setForm((prev) => ({ ...prev, label: event.target.value }))}
              />
            </Field>
            <Field label={t("sidebar.view.field.type")}>
              <TextInput
                value={form.type}
                onChange={(event) => setForm((prev) => ({ ...prev, type: event.target.value }))}
              />
            </Field>
            <Field label={t("sidebar.view.field.status")}>
              <TextInput
                value={form.status}
                onChange={(event) => setForm((prev) => ({ ...prev, status: event.target.value }))}
              />
            </Field>
            <Field label={t("sidebar.view.field.pathPrefix")}>
              <TextInput
                value={form.pathPrefix}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, pathPrefix: event.target.value }))
                }
              />
            </Field>
            <Field label={t("sidebar.view.field.query")}>
              <TextInput
                value={form.query}
                onChange={(event) => setForm((prev) => ({ ...prev, query: event.target.value }))}
              />
            </Field>
            <Field label={t("sidebar.view.field.color")}>
              <TextInput
                type="color"
                value={form.color}
                onChange={(event) => setForm((prev) => ({ ...prev, color: event.target.value }))}
              />
            </Field>
            <div className="dialog-actions">
              <Dialog.Close asChild>
                <Button variant="ghost">{t("newDoc.cancel")}</Button>
              </Dialog.Close>
              <Button variant="primary" onClick={saveView} disabled={!canSaveView}>
                {t("system.mcp.save")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </aside>
  );
});

function normalizePathPrefix(value: string): string | null {
  const cleaned = value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return cleaned || null;
}

function makeViewId(label: string, views: readonly DocumentViewDefinition[]): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "view";
  const used = new Set(views.map((view) => view.id));
  let id = base;
  let index = 2;
  while (used.has(id)) {
    id = `${base}-${index}`;
    index += 1;
  }
  return id;
}

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
