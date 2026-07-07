import { describe, expect, it } from "vitest";
import type { WorkspaceRootEntry } from "./types";
import { workspaceCan, workspaceCapabilities, workspaceWriteStatus } from "./workspaceCapabilities";

function workspace(patch: Partial<WorkspaceRootEntry> = {}): WorkspaceRootEntry {
  return {
    label: "Workspace",
    path: "/workspace",
    visibility: "private",
    provider: "local",
    providerId: null,
    externalWriter: null,
    writePolicy: "direct",
    permissionSummary: null,
    ...patch,
  };
}

describe("workspace capability helpers", () => {
  it("treats a private local direct workspace as writable without summary data", () => {
    const entry = workspace();

    expect(workspaceCan(entry, "create")).toBe(true);
    expect(workspaceCan(entry, "modify")).toBe(true);
    expect(workspaceWriteStatus(entry)).toBe("writable");
  });

  it("defaults unverified public provider workspaces to read-only", () => {
    const entry = workspace({
      visibility: "public",
      provider: "googleDrive",
      permissionSummary: null,
    });

    expect(workspaceCapabilities(entry).canRead).toBe(true);
    expect(workspaceCan(entry, "modify")).toBe(false);
    expect(workspaceWriteStatus(entry)).toBe("readOnly");
  });

  it("uses provider permission summaries for action availability", () => {
    const entry = workspace({
      visibility: "public",
      provider: "googleDrive",
      permissionSummary: {
        role: "writer",
        source: "manual",
        checkedAt: "2026-04-27T09:00:00+09:00",
        capabilities: {
          canRead: true,
          canCreate: true,
          canModify: true,
          canDelete: false,
          canRenameMove: false,
          canShare: false,
          canManageMembers: false,
        },
      },
    });

    expect(workspaceCan(entry, "create")).toBe(true);
    expect(workspaceCan(entry, "modify")).toBe(true);
    expect(workspaceCan(entry, "delete")).toBe(false);
    expect(workspaceWriteStatus(entry)).toBe("limited");
  });

  it("blocks delegated direct writes even with a writable summary", () => {
    const entry = workspace({
      writePolicy: "delegated",
      externalWriter: "gdrive",
      permissionSummary: {
        role: "contentManager",
        source: "manual",
        checkedAt: null,
        capabilities: {
          canRead: true,
          canCreate: true,
          canModify: true,
          canDelete: true,
          canRenameMove: true,
          canShare: true,
          canManageMembers: true,
        },
      },
    });

    expect(workspaceCan(entry, "create")).toBe(false);
    expect(workspaceCan(entry, "modify")).toBe(false);
  });

  it("managed policy grants create+modify but not delete/renameMove, despite externalWriter", () => {
    // Mirrors vault_list.rs::compute_permission_summary (spec §5.3 matrix).
    const entry = workspace({
      visibility: "public",
      provider: "obsidian",
      externalWriter: "mcp-obsidian",
      writePolicy: "managed",
    });

    const caps = workspaceCapabilities(entry);
    expect(caps.canRead).toBe(true);
    expect(caps.canCreate).toBe(true);
    expect(caps.canModify).toBe(true);
    expect(caps.canDelete).toBe(false); // delete stays MCP-only
    expect(caps.canRenameMove).toBe(false); // out of V2 scope
    expect(workspaceWriteStatus(entry)).toBe("limited");
  });

  it("treats stale public provider summaries as read-only", () => {
    const entry = workspace({
      visibility: "public",
      provider: "googleDrive",
      permissionSummary: {
        role: "contentManager",
        source: "manual",
        checkedAt: null,
        capabilities: {
          canRead: true,
          canCreate: true,
          canModify: true,
          canDelete: true,
          canRenameMove: true,
          canShare: true,
          canManageMembers: false,
        },
      },
    });

    expect(workspaceCan(entry, "create")).toBe(false);
    expect(workspaceWriteStatus(entry)).toBe("readOnly");
  });
});
