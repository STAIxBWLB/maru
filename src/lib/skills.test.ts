import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture invoke calls so wrapper argument shaping can be asserted without Rust.
const invoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

import { skillsInstallSkill, skillsListSkills, skillsSyncAllSources } from "./skills";

function enterTauri() {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
}

describe("skills invoke wrappers", () => {
  beforeEach(() => {
    invoke.mockClear();
    invoke.mockResolvedValue(undefined as unknown);
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("threads the install mode through to skills_install_skill", async () => {
    enterTauri();
    await skillsInstallSkill("anchor-managed::x", "claude", "x", "copy");
    expect(invoke).toHaveBeenCalledWith("skills_install_skill", {
      skillId: "anchor-managed::x",
      target: "claude",
      installedAs: "x",
      mode: "copy",
    });
  });

  it("defaults the install mode to symlink", async () => {
    enterTauri();
    await skillsInstallSkill("anchor-managed::x", "codex");
    expect(invoke).toHaveBeenCalledWith("skills_install_skill", {
      skillId: "anchor-managed::x",
      target: "codex",
      installedAs: null,
      mode: "symlink",
    });
  });

  it("invokes skills_sync_all_sources with workPath and progressId", async () => {
    enterTauri();
    invoke.mockResolvedValue({ total: 1, succeeded: 1, failed: 0, results: [] });
    const outcome = await skillsSyncAllSources("/work", "pid-1");
    expect(invoke).toHaveBeenCalledWith("skills_sync_all_sources", {
      workPath: "/work",
      progressId: "pid-1",
    });
    expect(outcome.succeeded).toBe(1);
  });

  it("lists skills from the cached registry by default", async () => {
    enterTauri();
    invoke.mockResolvedValue([]);
    await skillsListSkills("/work");
    expect(invoke).toHaveBeenCalledWith("skills_list_skills", {
      workPath: "/work",
      refresh: false,
    });
  });

  it("can request a full skills refresh explicitly", async () => {
    enterTauri();
    invoke.mockResolvedValue([]);
    await skillsListSkills("/work", { refresh: true });
    expect(invoke).toHaveBeenCalledWith("skills_list_skills", {
      workPath: "/work",
      refresh: true,
    });
  });

  it("returns an empty sync outcome outside Tauri without invoking", async () => {
    const outcome = await skillsSyncAllSources();
    expect(invoke).not.toHaveBeenCalled();
    expect(outcome).toEqual({ total: 0, succeeded: 0, failed: 0, results: [] });
  });

  it("throws for install outside the Tauri shell", async () => {
    await expect(skillsInstallSkill("x", "claude")).rejects.toThrow(/Tauri shell/);
    expect(invoke).not.toHaveBeenCalled();
  });
});
