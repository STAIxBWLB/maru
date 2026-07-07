import { Check, ChevronDown, FolderOpen, PenLine, Plus, RefreshCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../lib/i18n";
import type { WorkspaceRegistry, WorkspaceVisibility, WorkspaceWritePolicy } from "../lib/types";
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
  /** Managed-write opt-in toggle (obsidian vaults only — spec §2.4). */
  onSetWritePolicy?: (path: string, policy: WorkspaceWritePolicy) => void;
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
  onSetWritePolicy,
  onUseSample,
}: WorkspaceSwitcherProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const active = registry.workspaces.find((workspace) => workspace.path === activePath);
  const privateWorkspaces = registry.workspaces.filter((workspace) => workspace.visibility === "private");
  const publicWorkspaces = registry.workspaces.filter((workspace) => workspace.visibility === "public");
  const groups = [
    { visibility: "private" as const, label: t("workspace.visibility.private"), items: privateWorkspaces },
    { visibility: "public" as const, label: t("workspace.visibility.public"), items: publicWorkspaces },
  ];

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
    <div ref={containerRef} className="workspace-switcher-wrap">
      <button
        type="button"
        className="workspace-switcher"
        onClick={() => setOpen((value) => !value)}
        title={active?.path ?? t("workspace.switcher.empty")}
        aria-label={active?.label ?? t("workspace.switcher.empty")}
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
        <ChevronDown size={13} className="ws-chevron" />
      </button>

      {open ? (
        <div className="workspace-menu" role="menu">
          {groups.map((group) => (
            <div key={group.visibility}>
              <div className="workspace-menu-group">{group.label}</div>
              {group.items.length === 0 ? (
                <div className="workspace-menu-empty">
                  {t(
                    group.visibility === "public"
                      ? "workspace.switcher.publicNone"
                      : "workspace.switcher.none",
                  )}
                </div>
              ) : (
                group.items.map((workspace) => (
                  <div
                    key={workspace.path}
                    className={
                      workspace.path === activePath
                        ? "workspace-menu-item active"
                        : "workspace-menu-item"
                    }
                    onClick={() => {
                      onSelectWorkspace(workspace.path, workspace.visibility);
                      setOpen(false);
                    }}
                    role="menuitem"
                    title={workspace.path}
                  >
                    {workspace.path === activePath ? (
                      <Check size={14} />
                    ) : (
                      <FolderOpen size={14} className="workspace-menu-icon-muted" />
                    )}
                    <div className="workspace-menu-copy">
                      <strong>{workspace.label}</strong>
                      <span title={workspace.path}>{workspace.path}</span>
                      <div className="workspace-menu-badges">
                        <em>{providerLabel(workspace.provider)}</em>
                        <em>{t(`workspace.writePolicy.${workspace.writePolicy}`)}</em>
                        <em>{t(`workspace.writeStatus.${workspaceWriteStatus(workspace)}`)}</em>
                      </div>
                    </div>
                    {onSetWritePolicy && workspace.provider === "obsidian" ? (
                      <button
                        type="button"
                        className={
                          workspace.writePolicy === "managed"
                            ? "workspace-menu-managed active"
                            : "workspace-menu-managed"
                        }
                        title={t("workspace.managedToggle")}
                        aria-label={t("workspace.managedToggle.label", {
                          label: workspace.label,
                        })}
                        aria-pressed={workspace.writePolicy === "managed"}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSetWritePolicy(
                            workspace.path,
                            workspace.writePolicy === "managed" ? "delegated" : "managed",
                          );
                        }}
                      >
                        <PenLine size={13} />
                      </button>
                    ) : null}
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
            </div>
          ))}

          <div className="workspace-menu-divider" />

          <div
            className="workspace-menu-action"
            onClick={() => {
              onAddWorkspace("private");
              setOpen(false);
            }}
            role="menuitem"
            title={t("workspace.add")}
            aria-label={t("workspace.add")}
          >
            <Plus size={14} />
            <span>{t("workspace.add")}</span>
          </div>
          <div
            className="workspace-menu-action"
            onClick={() => {
              onAddWorkspace("public");
              setOpen(false);
            }}
            role="menuitem"
            title={t("workspace.addPublic")}
            aria-label={t("workspace.addPublic")}
          >
            <Plus size={14} />
            <span>{t("workspace.addPublic")}</span>
          </div>
          <div
            className="workspace-menu-action"
            onClick={() => {
              onUseSample();
              setOpen(false);
            }}
            role="menuitem"
            title={t("workspace.useSample")}
            aria-label={t("workspace.useSample")}
          >
            <FolderOpen size={14} />
            <span>{t("workspace.useSample")}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
