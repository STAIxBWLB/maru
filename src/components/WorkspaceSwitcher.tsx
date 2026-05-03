import { Check, ChevronDown, FolderOpen, Plus, RefreshCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../lib/i18n";
import type { WorkspaceRegistry, WorkspaceVisibility } from "../lib/types";
import {
  providerLabel,
  workspaceWriteStatus,
} from "../lib/workspaceCapabilities";

interface WorkspaceSwitcherProps {
  registry: WorkspaceRegistry;
  activePath: string | null;
  visibility: WorkspaceVisibility;
  onSelectWorkspace: (path: string, visibility: WorkspaceVisibility) => void;
  onAddWorkspace: (visibility: WorkspaceVisibility) => void;
  onRemoveWorkspace: (path: string) => void;
  onRefreshCapabilities: (path: string) => void;
  onUseSample: () => void;
}

export function WorkspaceSwitcher({
  registry,
  activePath,
  visibility,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onRefreshCapabilities,
  onUseSample,
}: WorkspaceSwitcherProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const workspaces = registry.workspaces.filter((workspace) => workspace.visibility === visibility);
  const active = registry.workspaces.find((workspace) => workspace.path === activePath);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="workspace-switcher"
        onClick={() => setOpen((value) => !value)}
        title={active?.path ?? ""}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className={`ws-dot ${visibility}`} aria-hidden />
        {active ? (
          <>
            <span className="ws-label">{active.label}</span>
            <span className={`ws-status ${workspaceWriteStatus(active)}`}>
              {providerLabel(active.provider)}
            </span>
          </>
        ) : (
          <span className="ws-label ws-empty">{t("workspace.switcher.empty")}</span>
        )}
        <ChevronDown size={13} style={{ opacity: 0.55 }} />
      </button>

      {open ? (
        <div className="workspace-menu" role="menu">
          {workspaces.length === 0 ? (
            <div style={{ padding: "12px 14px", color: "var(--faint)", fontSize: 12 }}>
              {t(
                visibility === "public"
                  ? "workspace.switcher.publicNone"
                  : "workspace.switcher.none",
              )}
            </div>
          ) : (
            workspaces.map((workspace) => (
              <div
                key={workspace.path}
                className={
                  workspace.path === activePath
                    ? "workspace-menu-item active"
                    : "workspace-menu-item"
                }
                onClick={() => {
                  onSelectWorkspace(workspace.path, visibility);
                  setOpen(false);
                }}
                role="menuitem"
              >
                {workspace.path === activePath ? (
                  <Check size={14} />
                ) : (
                  <FolderOpen size={14} style={{ opacity: 0.6 }} />
                )}
                <div style={{ minWidth: 0 }}>
                  <strong>{workspace.label}</strong>
                  <span title={workspace.path}>{workspace.path}</span>
                  <div className="workspace-menu-badges">
                    <em>{providerLabel(workspace.provider)}</em>
                    <em>{t(`workspace.writePolicy.${workspace.writePolicy}`)}</em>
                    <em>{t(`workspace.writeStatus.${workspaceWriteStatus(workspace)}`)}</em>
                  </div>
                </div>
                <button
                  type="button"
                  className="workspace-menu-refresh"
                  title={t("workspace.refreshCapabilities")}
                  aria-label={t("workspace.refreshCapabilities.label", {
                    label: workspace.label,
                  })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRefreshCapabilities(workspace.path);
                  }}
                >
                  <RefreshCcw size={13} />
                </button>
                <button
                  type="button"
                  className="workspace-menu-remove"
                  title={t("workspace.remove")}
                  aria-label={t("workspace.remove.label", { label: workspace.label })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveWorkspace(workspace.path);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}

          <div className="workspace-menu-divider" />

          <div
            className="workspace-menu-action"
            onClick={() => {
              onAddWorkspace(visibility);
              setOpen(false);
            }}
            role="menuitem"
          >
            <Plus size={14} />
            <span>
              {t(visibility === "public" ? "workspace.addPublic" : "workspace.add")}
            </span>
          </div>
          <div
            className="workspace-menu-action"
            onClick={() => {
              onUseSample();
              setOpen(false);
            }}
            role="menuitem"
          >
            <FolderOpen size={14} />
            <span>{t("workspace.useSample")}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
