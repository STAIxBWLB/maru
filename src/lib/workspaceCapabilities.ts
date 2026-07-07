import type {
  ProviderPermissionSummary,
  WorkspaceCapabilities,
  WorkspaceProvider,
  WorkspaceRootEntry,
  WorkspaceWritePolicy,
} from "./types";

export const READONLY_CAPABILITIES: WorkspaceCapabilities = {
  canRead: true,
  canCreate: false,
  canModify: false,
  canDelete: false,
  canRenameMove: false,
  canShare: false,
  canManageMembers: false,
};

export const EMPTY_CAPABILITIES: WorkspaceCapabilities = {
  canRead: false,
  canCreate: false,
  canModify: false,
  canDelete: false,
  canRenameMove: false,
  canShare: false,
  canManageMembers: false,
};

export const FULL_CAPABILITIES: WorkspaceCapabilities = {
  canRead: true,
  canCreate: true,
  canModify: true,
  canDelete: true,
  canRenameMove: true,
  canShare: true,
  canManageMembers: true,
};

export type WorkspaceAction =
  | "create"
  | "modify"
  | "delete"
  | "renameMove"
  | "share"
  | "manageMembers";

/** Managed vault (maru-vault-graph-spec §2.4): create+modify through the
 *  Rust vault_guard schema gate; delete stays MCP-only, rename/move out of
 *  V2 scope. Mirrors vault_list.rs::compute_permission_summary. */
export const MANAGED_CAPABILITIES: WorkspaceCapabilities = {
  canRead: true,
  canCreate: true,
  canModify: true,
  canDelete: false,
  canRenameMove: false,
  canShare: false,
  canManageMembers: false,
};

export function workspaceCapabilities(
  workspace: WorkspaceRootEntry | null | undefined,
): WorkspaceCapabilities {
  if (!workspace) return EMPTY_CAPABILITIES;
  if (workspace.writePolicy === "managed") return MANAGED_CAPABILITIES;
  if (workspace.writePolicy === "readOnly" || workspace.writePolicy === "delegated") {
    return READONLY_CAPABILITIES;
  }
  if (workspace.externalWriter) return READONLY_CAPABILITIES;
  if (
    workspace.visibility === "public" &&
    workspace.provider !== "local" &&
    workspace.permissionSummary &&
    !workspace.permissionSummary.checkedAt
  ) {
    return READONLY_CAPABILITIES;
  }
  const summary = workspace.permissionSummary?.capabilities;
  if (summary) return summary;
  if (workspace.visibility === "public" && workspace.provider !== "local") {
    return READONLY_CAPABILITIES;
  }
  if (workspace.provider === "local") return FULL_CAPABILITIES;
  return READONLY_CAPABILITIES;
}

export function workspaceCan(
  workspace: WorkspaceRootEntry | null | undefined,
  action: WorkspaceAction,
): boolean {
  const caps = workspaceCapabilities(workspace);
  switch (action) {
    case "create":
      return caps.canCreate;
    case "modify":
      return caps.canModify;
    case "delete":
      return caps.canDelete;
    case "renameMove":
      return caps.canRenameMove;
    case "share":
      return caps.canShare;
    case "manageMembers":
      return caps.canManageMembers;
  }
}

export function providerLabel(provider: WorkspaceProvider | string | null | undefined): string {
  switch (provider) {
    case "googleDrive":
      return "Google Drive";
    case "oneDrive":
      return "OneDrive";
    case "sharePoint":
      return "SharePoint";
    case "nextcloud":
      return "Nextcloud";
    case "obsidian":
      return "Obsidian";
    case "local":
      return "Local";
    default:
      return "Unknown";
  }
}

export function writePolicyLabel(policy: WorkspaceWritePolicy | string | null | undefined): string {
  switch (policy) {
    case "direct":
      return "Direct";
    case "delegated":
      return "Delegated";
    case "managed":
      return "Managed";
    case "readOnly":
      return "Read-only";
    default:
      return "Read-only";
  }
}

export function workspaceWriteStatus(
  workspace: WorkspaceRootEntry | null | undefined,
): "writable" | "limited" | "readOnly" {
  if (!workspace) return "readOnly";
  const caps = workspaceCapabilities(workspace);
  if (caps.canCreate && caps.canModify && caps.canDelete && caps.canRenameMove) return "writable";
  if (caps.canCreate || caps.canModify || caps.canDelete || caps.canRenameMove) return "limited";
  return "readOnly";
}

export function workspaceWriteReason(
  workspace: WorkspaceRootEntry | null | undefined,
  action: WorkspaceAction = "modify",
): string | null {
  if (!workspace || workspaceCan(workspace, action)) return null;
  if (workspace.externalWriter) return workspace.externalWriter;
  if (workspace.writePolicy === "delegated") return "external writer";
  if (workspace.writePolicy === "readOnly") return "read-only policy";
  if (workspace.permissionSummary?.warning) return workspace.permissionSummary.warning;
  if (workspace.visibility === "public" && !workspace.permissionSummary) {
    return "unverified provider capabilities";
  }
  return "workspace capabilities";
}

export function manualPermissionSummary(
  role: string,
): ProviderPermissionSummary {
  return {
    role,
    source: "manual",
    checkedAt: null,
    capabilities: READONLY_CAPABILITIES,
    warning: null,
  };
}
