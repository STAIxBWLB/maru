import {
  AlertTriangle,
  Code2,
  Plus,
  RefreshCcw,
  Search,
  ShieldCheck,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../../lib/i18n";
import {
  SKILLS_UPDATED_EVENT,
  type SkillsUpdatedPayload,
} from "../../../lib/skillEditorEvents";
import {
  skillsAddSource,
  skillsAdoptExternalLinks,
  skillsApplyBundleUpdate,
  skillsBundleStatus,
  skillsCheckBundleUpdate,
  skillsCreateSkill,
  skillsEnvBootstrap,
  skillsEnvStatus,
  skillsInstallSkill,
  skillsListInstalls,
  skillsListSkills,
  skillsListSources,
  skillsRemoveSource,
  skillsRescanSource,
  skillsResetRegistry,
  skillsSyncAllSources,
  skillsSyncSource,
  skillsUninstallSkill,
  type SkillBundleStatus,
  type SkillInstall,
  type SkillInstallMode,
  type SkillInstallTarget,
  type SkillProgressEvent,
  type SkillRecord,
  type SkillSource,
  type SkillsEnvStatus,
} from "../../../lib/skills";
import { readDefaultInstallMode, writeDefaultInstallMode } from "../../../lib/skillsInstallMode";
import { formatRelativeDate } from "../../../lib/document";
import { openSkillEditorWindow } from "../../../lib/windowLayout";
import { Button } from "../../ui/Button";
import { ModeHeader } from "../../ui/ModeChrome";

// =============================== Skills ===============================

type SkillBulkTarget = SkillInstallTarget | "both";

interface SkillOperationState {
  active: boolean;
  label: string;
  total: number;
  completed: number;
  message: string | null;
  errors: string[];
  log: string[];
}

interface SkillConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  variant: "primary" | "danger";
}

const EMPTY_SKILL_OPERATION: SkillOperationState = {
  active: false,
  label: "",
  total: 0,
  completed: 0,
  message: null,
  errors: [],
  log: [],
};

function skillTargetLabel(
  target: SkillBulkTarget,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (target === "both") return t("system.skills.targetBoth");
  return target === "claude" ? t("system.skills.targetClaude") : t("system.skills.targetCodex");
}

function skillTargetsFor(target: SkillBulkTarget): SkillInstallTarget[] {
  return target === "both" ? ["claude", "codex"] : [target];
}

function makeSkillProgressId(): string {
  return `skills-op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function progressLogLine(event: SkillProgressEvent): string {
  return `[${event.level}] ${event.message}`;
}

export function SkillsTab({ workPath }: { workPath: string }) {
  const { t, locale } = useTranslation();
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [installs, setInstalls] = useState<SkillInstall[]>([]);
  const [envStatus, setEnvStatus] = useState<SkillsEnvStatus | null>(null);
  const [bundleStatus, setBundleStatus] = useState<SkillBundleStatus | null>(null);
  const [newSkillName, setNewSkillName] = useState("");
  const [newSourceId, setNewSourceId] = useState("");
  const [newSourcePath, setNewSourcePath] = useState("");
  const [newSourceKind, setNewSourceKind] = useState<"linked" | "cloned">("linked");
  const [skillQuery, setSkillQuery] = useState("");
  const [installFilter, setInstallFilter] = useState<"all" | "installed" | "uninstalled" | "dirty">("all");
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(() => new Set());
  const [defaultInstallMode, setDefaultInstallMode] = useState<SkillInstallMode>(() =>
    readDefaultInstallMode(),
  );
  const [installModeOverride, setInstallModeOverride] = useState<SkillInstallMode | "default">(
    "default",
  );
  const effectiveInstallMode: SkillInstallMode =
    installModeOverride === "default" ? defaultInstallMode : installModeOverride;
  useEffect(() => {
    writeDefaultInstallMode(defaultInstallMode);
  }, [defaultInstallMode]);
  const [operation, setOperation] = useState<SkillOperationState>(EMPTY_SKILL_OPERATION);
  const [confirmState, setConfirmState] = useState<SkillConfirmState | null>(null);
  const confirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const nextSources = await skillsListSources(workPath);
      const nextSkills = await skillsListSkills(workPath, { refresh: true });
      const nextInstalls = await skillsListInstalls(workPath);
      const nextEnv = await skillsEnvStatus(workPath);
      setSources(nextSources);
      setSkills(nextSkills);
      setInstalls(nextInstalls);
      setEnvStatus(nextEnv);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<SkillsUpdatedPayload>(SKILLS_UPDATED_EVENT, (event) => {
          if (event.payload.workPath === workPath) void refresh();
        }),
      )
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh, workPath]);

  const installKey = useMemo(() => {
    const set = new Set<string>();
    installs.forEach((install) => set.add(`${install.skillId}:${install.target}`));
    return set;
  }, [installs]);
  const installedSkillIds = useMemo(() => {
    const set = new Set<string>();
    installs.forEach((install) => set.add(install.skillId));
    return set;
  }, [installs]);
  const installTargetsBySkill = useMemo(() => {
    const map = new Map<string, Set<SkillInstallTarget>>();
    installs.forEach((install) => {
      const targets = map.get(install.skillId) ?? new Set<SkillInstallTarget>();
      targets.add(install.target);
      map.set(install.skillId, targets);
    });
    return map;
  }, [installs]);
  const installedSkillCount = useMemo(
    () => skills.filter((skill) => installTargetsBySkill.has(skill.id)).length,
    [installTargetsBySkill, skills],
  );
  const claudeInstallCount = useMemo(
    () => installs.filter((install) => install.target === "claude").length,
    [installs],
  );
  const codexInstallCount = useMemo(
    () => installs.filter((install) => install.target === "codex").length,
    [installs],
  );
  const filteredSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase();
    return skills.filter((skill) => {
      const targets = installTargetsBySkill.get(skill.id);
      const installed = Boolean(targets?.size);
      if (installFilter === "installed" && !installed) return false;
      if (installFilter === "uninstalled" && installed) return false;
      if (installFilter === "dirty" && !skill.dirty) return false;
      if (!q) return true;
      return [skill.name, skill.title, skill.description ?? "", skill.sourceId, skill.relPath]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [installFilter, installTargetsBySkill, skillQuery, skills]);
  const skillFilterOptions: Array<[
    typeof installFilter,
    string,
    number,
  ]> = [
    ["all", t("system.skills.filter.all"), skills.length],
    ["installed", t("system.skills.filter.installed"), installedSkillCount],
    ["uninstalled", t("system.skills.filter.open"), Math.max(skills.length - installedSkillCount, 0)],
    ["dirty", t("system.skills.filter.dirty"), skills.filter((skill) => skill.dirty).length],
  ];
  const selectedSkills = useMemo(
    () => skills.filter((skill) => selectedSkillIds.has(skill.id)),
    [selectedSkillIds, skills],
  );
  const selectedInstalledTaskCount = useMemo(
    () =>
      selectedSkills.reduce(
        (count, skill) => count + (installTargetsBySkill.get(skill.id)?.size ?? 0),
        0,
      ),
    [installTargetsBySkill, selectedSkills],
  );

  useEffect(() => {
    setSelectedSkillIds((prev) => {
      const liveIds = new Set(skills.map((skill) => skill.id));
      const next = new Set([...prev].filter((id) => liveIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [skills]);

  const startOperation = useCallback((label: string, total = 0) => {
    setOperation({
      active: true,
      label,
      total,
      completed: 0,
      message: null,
      errors: [],
      log: [],
    });
  }, []);

  const finishOperation = useCallback((message: string, errors: string[] = []) => {
    setOperation((prev) => ({
      ...prev,
      active: false,
      completed: prev.total,
      message,
      errors,
    }));
  }, []);

  const appendOperationLog = useCallback((message: string) => {
    setOperation((prev) => ({
      ...prev,
      log: [...prev.log.slice(-79), message],
    }));
  }, []);

  const updateOperationProgress = useCallback((completed: number, total: number) => {
    setOperation((prev) => ({
      ...prev,
      completed: Math.min(completed, total),
      total,
    }));
  }, []);

  const recordOperationError = useCallback((message: string) => {
    setOperation((prev) => ({
      ...prev,
      errors: [...prev.errors, message],
    }));
  }, []);

  const stepOperation = useCallback(() => {
    setOperation((prev) => ({
      ...prev,
      completed: Math.min(prev.completed + 1, prev.total),
    }));
  }, []);

  const runOperation = useCallback(
    async <T,>(
      label: string,
      total: number,
      task: () => Promise<T>,
      completeMessage: (result: T) => string,
    ): Promise<T | null> => {
      setBusy(true);
      setError(null);
      startOperation(label, total);
      try {
        const result = await task();
        finishOperation(completeMessage(result));
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        finishOperation(message, [message]);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [finishOperation, startOperation],
  );

  const runBackendProgressOperation = useCallback(
    async <T,>(
      label: string,
      total: number,
      task: (progressId: string) => Promise<T>,
      completeMessage: (result: T) => string,
    ): Promise<T | null> => {
      setBusy(true);
      setError(null);
      startOperation(label, total);
      const progressId = makeSkillProgressId();
      let unlisten: (() => void) | null = null;
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<SkillProgressEvent>("skills-op://progress", (event) => {
          if (event.payload.progressId !== progressId) return;
          appendOperationLog(progressLogLine(event.payload));
          if (
            typeof event.payload.completed === "number" &&
            typeof event.payload.total === "number"
          ) {
            updateOperationProgress(event.payload.completed, event.payload.total);
          }
          if (event.payload.level === "error") recordOperationError(event.payload.message);
        });
        const result = await task(progressId);
        finishOperation(completeMessage(result));
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        finishOperation(message, [message]);
        return null;
      } finally {
        unlisten?.();
        setBusy(false);
      }
    },
    [
      appendOperationLog,
      finishOperation,
      recordOperationError,
      startOperation,
      updateOperationProgress,
    ],
  );

  const refreshWithProgress = useCallback(async () => {
    setBusy(true);
    setError(null);
    startOperation(t("system.skills.refreshing"), 4);
    try {
      appendOperationLog(t("system.skills.log.refreshSources"));
      const nextSources = await skillsListSources(workPath);
      setSources(nextSources);
      stepOperation();

      appendOperationLog(t("system.skills.log.refreshSkills"));
      const nextSkills = await skillsListSkills(workPath, { refresh: true });
      setSkills(nextSkills);
      stepOperation();

      appendOperationLog(t("system.skills.log.refreshInstalls"));
      const nextInstalls = await skillsListInstalls(workPath);
      setInstalls(nextInstalls);
      stepOperation();

      appendOperationLog(t("system.skills.log.refreshEnv"));
      const nextEnv = await skillsEnvStatus(workPath);
      setEnvStatus(nextEnv);
      stepOperation();

      finishOperation(t("system.skills.refreshComplete"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      finishOperation(message, [message]);
    } finally {
      setBusy(false);
    }
  }, [appendOperationLog, finishOperation, startOperation, stepOperation, t, workPath]);

  const toggleSkillSelection = useCallback((skillId: string) => {
    setSelectedSkillIds((prev) => {
      const next = new Set(prev);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return next;
    });
  }, []);

  const selectFilteredSkills = useCallback(() => {
    setSelectedSkillIds(new Set(filteredSkills.map((skill) => skill.id)));
  }, [filteredSkills]);

  const clearSkillSelection = useCallback(() => {
    setSelectedSkillIds(new Set());
  }, []);

  const sourceHasInstalledSkills = useCallback(
    (sourceId: string) =>
      skills.some((skill) => skill.sourceId === sourceId && installedSkillIds.has(skill.id)),
    [installedSkillIds, skills],
  );

  const closeConfirmation = useCallback((confirmed: boolean) => {
    const resolve = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmState(null);
    resolve?.(confirmed);
  }, []);

  const confirmAction = useCallback(
    (
      message: string,
      options: {
        confirmLabel?: string;
        title?: string;
        variant?: "primary" | "danger";
      } = {},
    ) =>
      new Promise<boolean>((resolve) => {
        if (confirmResolverRef.current) {
          resolve(false);
          return;
        }
        confirmResolverRef.current = resolve;
        setConfirmState({
          title: options.title ?? t("system.skills.confirmTitle"),
          message,
          confirmLabel: options.confirmLabel ?? t("system.skills.confirmProceed"),
          variant: options.variant ?? "primary",
        });
      }),
    [t],
  );

  const openSkillEditor = useCallback(async (skill: SkillRecord) => {
    setError(null);
    try {
      await openSkillEditorWindow(workPath, skill.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath]);

  const addSource = useCallback(async () => {
    const id = newSourceId.trim();
    const path = newSourcePath.trim();
    if (!id || !path) return;
    if (!(await confirmAction(t("system.skills.addSourceConfirm", { id })))) return;
    await runOperation(
      t("system.skills.addingSource", { id }),
      3,
      async () => {
        appendOperationLog(t("system.skills.log.addSource", { id }));
        await skillsAddSource({
          id,
          kind: newSourceKind,
          path: newSourceKind === "linked" ? path : null,
          repoUrl: newSourceKind === "cloned" ? path : null,
          skillsSubdir: "skills",
        });
        stepOperation();
        setNewSourceId("");
        setNewSourcePath("");
        appendOperationLog(t("system.skills.log.sourceAdded", { id }));
        stepOperation();
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        stepOperation();
        return id;
      },
      (sourceId) => t("system.skills.addSourceComplete", { id: sourceId }),
    );
  }, [
    appendOperationLog,
    confirmAction,
    newSourceId,
    newSourceKind,
    newSourcePath,
    refresh,
    runOperation,
    stepOperation,
    t,
  ]);

  const rescanSource = useCallback(
    async (source: SkillSource) => {
      if (!(await confirmAction(t("system.skills.rescanConfirm", { id: source.id })))) return;
      await runBackendProgressOperation(
        t("system.skills.rescanningSource", { id: source.id }),
        1,
        async (progressId) => {
          const records = await skillsRescanSource(source.id, progressId);
          appendOperationLog(t("system.skills.log.refreshSkills"));
          await refresh();
          return records;
        },
        (records) =>
          t("system.skills.rescanComplete", { id: source.id, count: records.length }),
      );
    },
    [appendOperationLog, confirmAction, refresh, runBackendProgressOperation, t],
  );

  const syncSource = useCallback(
    async (source: SkillSource) => {
      if (!(await confirmAction(t("system.skills.syncConfirm", { id: source.id })))) return;
      await runBackendProgressOperation(
        t("system.skills.syncingSource", { id: source.id }),
        1,
        async (progressId) => {
          const records = await skillsSyncSource(source.id, progressId);
          appendOperationLog(t("system.skills.log.refreshSkills"));
          await refresh();
          return records;
        },
        (records) => t("system.skills.syncComplete", { id: source.id, count: records.length }),
      );
    },
    [appendOperationLog, confirmAction, refresh, runBackendProgressOperation, t],
  );

  const syncAllSources = useCallback(async () => {
    if (sources.length === 0) return;
    if (!(await confirmAction(t("system.skills.syncAllConfirm", { count: sources.length })))) {
      return;
    }
    await runBackendProgressOperation(
      t("system.skills.syncingAll"),
      sources.length,
      async (progressId) => {
        const outcome = await skillsSyncAllSources(workPath, progressId);
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        return outcome;
      },
      (outcome) =>
        t("system.skills.syncAllComplete", {
          succeeded: outcome.succeeded,
          failed: outcome.failed,
        }),
    );
  }, [appendOperationLog, confirmAction, refresh, runBackendProgressOperation, sources.length, t, workPath]);

  const loadBundleStatus = useCallback(async () => {
    try {
      setBundleStatus(await skillsBundleStatus());
    } catch {
      // Best-effort: the pane works without bundle status.
    }
  }, []);

  useEffect(() => {
    void loadBundleStatus();
  }, [loadBundleStatus]);

  // A bundle applied elsewhere (launch auto-update, CLI) invalidates the
  // skill list and bundle status without any local action.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("skills://updated", () => {
          void refresh();
          void loadBundleStatus();
        }),
      )
      .then((off) => {
        if (disposed) {
          off();
        } else {
          unlisten = off;
        }
      })
      .catch(() => {
        // Non-Tauri shells have no event bus.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadBundleStatus, refresh]);

  const checkBundleUpdate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setBundleStatus(await skillsCheckBundleUpdate());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const applyBundleUpdate = useCallback(async () => {
    const repairEnv = Boolean(bundleStatus?.envUpdateRequired);
    const version = bundleStatus?.available?.displayVersion ?? "";
    if (
      !(await confirmAction(
        repairEnv
          ? t("system.skills.bundleApplyEnvConfirm", { version })
          : t("system.skills.bundleApplyConfirm", { version }),
      ))
    ) {
      return;
    }
    await runBackendProgressOperation(
      t("system.skills.bundleApplying", { version }),
      1,
      async (progressId) => {
        const outcome = await skillsApplyBundleUpdate({ repairEnv, progressId });
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        await loadBundleStatus();
        return outcome;
      },
      (outcome) =>
        outcome
          ? t("system.skills.bundleApplied", {
              version: outcome.current.displayVersion,
              added: outcome.addedSkills.length,
              updated: outcome.updatedSkills.length,
              removed: outcome.removedSkills.length,
            })
          : t("system.skills.bundleApplyFailed"),
    );
  }, [
    appendOperationLog,
    bundleStatus,
    confirmAction,
    loadBundleStatus,
    refresh,
    runBackendProgressOperation,
    t,
  ]);

  const removeSource = useCallback(
    async (source: SkillSource) => {
      if (source.kind === "managed" || source.id === "maru-managed") {
        setError(t("system.skills.removeManagedSourceBlocked"));
        return;
      }
      if (sourceHasInstalledSkills(source.id)) {
        setError(t("system.skills.removeSourceInstalledBlocked", { id: source.id }));
        return;
      }
      if (
        !(await confirmAction(t("system.skills.removeSourceConfirm", { id: source.id }), {
          variant: "danger",
        }))
      ) {
        return;
      }
      const removedSkillIds = new Set(
        skills.filter((skill) => skill.sourceId === source.id).map((skill) => skill.id),
      );
      setBusy(true);
      setError(null);
      startOperation(t("system.skills.removingSource", { id: source.id }), 3);
      appendOperationLog(
        t("system.skills.log.removeSourceStart", {
          id: source.id,
          count: removedSkillIds.size,
        }),
      );
      try {
        await skillsRemoveSource(source.id);
        stepOperation();
        appendOperationLog(t("system.skills.log.optimisticRemove", { id: source.id }));
        setSources((prev) => prev.filter((item) => item.id !== source.id));
        setSkills((prev) => prev.filter((skill) => skill.sourceId !== source.id));
        setSelectedSkillIds((prev) => {
          const next = new Set([...prev].filter((skillId) => !removedSkillIds.has(skillId)));
          return next.size === prev.size ? prev : next;
        });
        stepOperation();
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        stepOperation();
        finishOperation(t("system.skills.removeSourceComplete", { id: source.id }));
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        const message =
          rawMessage === "source_has_installed_skills"
            ? t("system.skills.removeSourceInstalledBlocked", { id: source.id })
            : rawMessage === "source_not_removable"
              ? t("system.skills.removeManagedSourceBlocked")
            : rawMessage;
        setError(message);
        finishOperation(message, [message]);
      } finally {
        setBusy(false);
      }
    },
    [
      appendOperationLog,
      confirmAction,
      finishOperation,
      refresh,
      skills,
      sourceHasInstalledSkills,
      startOperation,
      stepOperation,
      t,
    ],
  );

  const createManagedSkill = useCallback(async () => {
    const name = newSkillName.trim();
    if (!name) return;
    if (!(await confirmAction(t("system.skills.createSkillConfirm", { name })))) return;
    await runOperation(
      t("system.skills.creatingSkill", { name }),
      3,
      async () => {
        appendOperationLog(t("system.skills.log.createSkill", { name }));
        const skill = await skillsCreateSkill(name, null);
        setNewSkillName("");
        stepOperation();
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        stepOperation();
        appendOperationLog(t("system.skills.log.openSkill", { name: skill.name }));
        await openSkillEditor(skill);
        stepOperation();
        return skill;
      },
      (skill) => t("system.skills.createSkillComplete", { name: skill.name }),
    );
  }, [
    appendOperationLog,
    confirmAction,
    newSkillName,
    openSkillEditor,
    refresh,
    runOperation,
    stepOperation,
    t,
  ]);

  const installSkills = useCallback(
    async (
      skillList: SkillRecord[],
      target: SkillBulkTarget,
      mode: SkillInstallMode = effectiveInstallMode,
    ) => {
      const targets = skillTargetsFor(target);
      const tasks = skillList.flatMap((skill) =>
        targets
          .filter((nextTarget) => !installKey.has(`${skill.id}:${nextTarget}`))
          .map((nextTarget) => ({ skill, target: nextTarget })),
      );
      const targetLabel = skillTargetLabel(target, t);
      if (tasks.length === 0) {
        setOperation({
          ...EMPTY_SKILL_OPERATION,
          label: t("system.skills.installing", { target: targetLabel }),
          message: t("system.skills.installComplete", {
            claude: 0,
            codex: 0,
            failed: 0,
          }),
          log: [t("system.skills.log.noInstallTasks")],
        });
        return;
      }
      if (
        !(await confirmAction(
          t("system.skills.installConfirm", {
            count: tasks.length,
            target: targetLabel,
            mode: t(`system.skills.installMode.${mode}`),
          }),
        ))
      ) {
        return;
      }
      setBusy(true);
      setError(null);
      startOperation(t("system.skills.installing", { target: targetLabel }), tasks.length);
      const failures: string[] = [];
      const installed = { claude: 0, codex: 0 };
      try {
        for (const task of tasks) {
          appendOperationLog(
            t("system.skills.log.installStart", {
              name: task.skill.name,
              target: skillTargetLabel(task.target, t),
            }),
          );
          try {
            await skillsInstallSkill(task.skill.id, task.target, task.skill.name, mode);
            installed[task.target] += 1;
            appendOperationLog(
              t("system.skills.log.installDone", {
                name: task.skill.name,
                target: skillTargetLabel(task.target, t),
              }),
            );
          } catch (err) {
            const message = `${task.skill.name} / ${task.target}: ${
              err instanceof Error ? err.message : String(err)
            }`;
            failures.push(message);
            recordOperationError(message);
            appendOperationLog(
              t("system.skills.log.installFailed", {
                name: task.skill.name,
                target: skillTargetLabel(task.target, t),
              }),
            );
          } finally {
            stepOperation();
          }
        }
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        finishOperation(
          t("system.skills.installComplete", {
            claude: installed.claude,
            codex: installed.codex,
            failed: failures.length,
          }),
          failures,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        finishOperation(err instanceof Error ? err.message : String(err), failures);
      } finally {
        setBusy(false);
      }
    },
    [
      appendOperationLog,
      confirmAction,
      effectiveInstallMode,
      finishOperation,
      installKey,
      recordOperationError,
      refresh,
      startOperation,
      stepOperation,
      t,
    ],
  );

  const uninstallInstalls = useCallback(
    async (items: SkillInstall[]) => {
      if (items.length === 0) {
        setOperation({
          ...EMPTY_SKILL_OPERATION,
          label: t("system.skills.uninstalling"),
          message: t("system.skills.uninstallComplete", { count: 0, failed: 0 }),
          log: [t("system.skills.log.noUninstallTasks")],
        });
        return;
      }
      if (
        !(await confirmAction(t("system.skills.uninstallConfirm", { count: items.length }), {
          variant: "danger",
        }))
      ) {
        return;
      }
      setBusy(true);
      setError(null);
      startOperation(t("system.skills.uninstalling"), items.length);
      const failures: string[] = [];
      let removed = 0;
      try {
        for (const item of items) {
          appendOperationLog(
            t("system.skills.log.uninstallStart", {
              name: item.installedAs,
              target: skillTargetLabel(item.target, t),
            }),
          );
          try {
            await skillsUninstallSkill(item.target, item.installedAs);
            removed += 1;
            appendOperationLog(
              t("system.skills.log.uninstallDone", {
                name: item.installedAs,
                target: skillTargetLabel(item.target, t),
              }),
            );
          } catch (err) {
            const message = `${item.installedAs} / ${item.target}: ${
              err instanceof Error ? err.message : String(err)
            }`;
            failures.push(message);
            recordOperationError(message);
            appendOperationLog(
              t("system.skills.log.uninstallFailed", {
                name: item.installedAs,
                target: skillTargetLabel(item.target, t),
              }),
            );
          } finally {
            stepOperation();
          }
        }
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        finishOperation(
          t("system.skills.uninstallComplete", { count: removed, failed: failures.length }),
          failures,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        finishOperation(err instanceof Error ? err.message : String(err), failures);
      } finally {
        setBusy(false);
      }
    },
    [
      appendOperationLog,
      confirmAction,
      finishOperation,
      recordOperationError,
      refresh,
      startOperation,
      stepOperation,
      t,
    ],
  );

  const install = useCallback(
    async (skill: SkillRecord, target: SkillInstallTarget) => {
      await installSkills([skill], target);
    },
    [installSkills],
  );

  const uninstall = useCallback(
    async (skill: SkillRecord, target: SkillInstallTarget) => {
      const existing = installs.find(
        (item) => item.skillId === skill.id && item.target === target,
      );
      if (!existing) return;
      await uninstallInstalls([existing]);
    },
    [installs, uninstallInstalls],
  );

  const uninstallSelected = useCallback(async () => {
    const selected = new Set(selectedSkillIds);
    await uninstallInstalls(installs.filter((installItem) => selected.has(installItem.skillId)));
  }, [installs, selectedSkillIds, uninstallInstalls]);

  const adoptExternalLinks = useCallback(async () => {
    if (!(await confirmAction(t("system.skills.adoptConfirm")))) return;
    await runBackendProgressOperation(
      t("system.skills.adopting"),
      1,
      async (progressId) => {
        const outcome = await skillsAdoptExternalLinks(progressId);
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        return outcome;
      },
      (outcome) =>
        t("system.skills.adoptComplete", {
          adopted: outcome.adopted,
          skipped: outcome.skipped,
        }),
    );
  }, [appendOperationLog, confirmAction, refresh, runBackendProgressOperation, t]);

  const bootstrapEnv = useCallback(async () => {
    if (!(await confirmAction(t("system.skills.bootstrapConfirm")))) return;
    setBusy(true);
    setError(null);
    startOperation(t("system.skills.bootstrapping"), 1);
    let unlistenOutput: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    let invocationId: string | null = null;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      type SkillsEnvDonePayload = {
        invocationId: string;
        success: boolean;
        exitCode: number | null;
      };
      type SkillsEnvOutputPayload = {
        invocationId: string;
        stream: string;
        line: string;
      };
      const pendingDone: SkillsEnvDonePayload[] = [];
      const pendingOutput: SkillsEnvOutputPayload[] = [];
      const handleOutput = (payload: SkillsEnvOutputPayload) => {
        setOperation((prev) => ({
          ...prev,
          log: [...prev.log.slice(-11), `[${payload.stream}] ${payload.line}`],
        }));
      };
      unlistenOutput = await listen<SkillsEnvOutputPayload>("skills-env://output", (event) => {
        if (invocationId === null) {
          pendingOutput.push(event.payload);
          return;
        }
        if (event.payload.invocationId !== invocationId) return;
        handleOutput(event.payload);
      });
      let resolveDone: () => void = () => {};
      const donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const handleDone = (payload: SkillsEnvDonePayload) => {
        if (payload.success) {
          stepOperation();
          finishOperation(t("system.skills.bootstrapComplete"));
        } else {
          const message = t("system.skills.bootstrapFailed", {
            code: payload.exitCode ?? "unknown",
          });
          setError(message);
          finishOperation(message, [message]);
        }
        resolveDone();
      };
      unlistenDone = await listen<SkillsEnvDonePayload>("skills-env://done", (event) => {
        if (invocationId === null) {
          pendingDone.push(event.payload);
          return;
        }
        if (event.payload.invocationId !== invocationId) return;
        handleDone(event.payload);
      });
      invocationId = await skillsEnvBootstrap(workPath);
      pendingOutput
        .filter((payload) => payload.invocationId === invocationId)
        .forEach(handleOutput);
      const earlyDone = pendingDone.find((payload) => payload.invocationId === invocationId);
      if (earlyDone) {
        handleDone(earlyDone);
      }
      await donePromise;
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      finishOperation(message, [message]);
    } finally {
      unlistenOutput?.();
      unlistenDone?.();
      setBusy(false);
    }
  }, [confirmAction, finishOperation, refresh, startOperation, stepOperation, t, workPath]);

  const resetRegistry = useCallback(async () => {
    if (
      !(await confirmAction(t("system.skills.resetConfirm"), {
        variant: "danger",
      }))
    ) {
      return;
    }
    await runBackendProgressOperation(
      t("system.skills.resetting"),
      1,
      async (progressId) => {
        const outcome = await skillsResetRegistry(workPath, progressId);
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        return outcome;
      },
      (outcome) =>
        t("system.skills.resetComplete", {
          sources: outcome.sources,
          skills: outcome.skills,
        }),
    );
  }, [appendOperationLog, confirmAction, refresh, runBackendProgressOperation, t, workPath]);

  return (
    <div className="settings-tab wide system-detail skills-system-detail" style={{ width: "100%" }}>
      <ModeHeader title={t("system.tab.skills")} subtitle={t("system.skills.globalStore")} />
      <div className="skills-overview">
        <div className="skills-metrics" aria-label={t("system.skills.summary")}>
          <span className="skills-metric">
            <strong>{sources.length}</strong>
            <span>{t("system.skills.sources")}</span>
          </span>
          <span className="skills-metric">
            <strong>{skills.length}</strong>
            <span>{t("system.skills.skills")}</span>
          </span>
          <span className="skills-metric">
            <strong>{claudeInstallCount}</strong>
            <span>Claude</span>
          </span>
          <span className="skills-metric">
            <strong>{codexInstallCount}</strong>
            <span>Codex</span>
          </span>
        </div>
        <div className="skills-overview-actions">
          <span className={envStatus?.healthy ? "skill-status-pill installed" : "skill-status-pill warn"}>
            <ShieldCheck size={12} />
            {envStatus?.healthy ? t("system.skills.envReady") : t("system.skills.envSetup")}
          </span>
          <span
            className={
              bundleStatus?.updateAvailable
                ? "skill-status-pill warn"
                : "skill-status-pill installed"
            }
            title={
              bundleStatus?.dirtySkills.length
                ? t("system.skills.bundleDirtyHint", {
                    skills: bundleStatus.dirtySkills.join(", "),
                  })
                : undefined
            }
          >
            {t("system.skills.bundleActive", {
              version: bundleStatus?.active?.displayVersion ?? "-",
            })}
          </span>
          {bundleStatus?.updateAvailable ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void applyBundleUpdate()}
              disabled={
                busy ||
                bundleStatus.dirtySkills.length > 0 ||
                !bundleStatus.minAppOk
              }
              title={
                bundleStatus.dirtySkills.length > 0
                  ? t("system.skills.bundleDirtyHint", {
                      skills: bundleStatus.dirtySkills.join(", "),
                    })
                  : !bundleStatus.minAppOk
                    ? t("system.skills.bundleAppTooOld", {
                        version: bundleStatus.available?.minAppVersion ?? "",
                      })
                    : undefined
              }
            >
              {t("system.skills.bundleApply", {
                version: bundleStatus.available?.displayVersion ?? "",
              })}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void checkBundleUpdate()}
              disabled={busy}
            >
              {t("system.skills.bundleCheck")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refreshWithProgress()}
            disabled={busy}
            icon={<RefreshCcw size={14} className={busy ? "spin" : ""} />}
          >
            {t("system.skills.refresh")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void syncAllSources()}
            disabled={busy || sources.length === 0}
            icon={<RefreshCcw size={14} />}
          >
            {t("system.skills.syncAll")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void adoptExternalLinks()}
            disabled={busy}
          >
            {t("system.skills.adopt")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void bootstrapEnv()}
            disabled={busy}
            icon={<Wrench size={14} />}
          >
            {t("system.skills.bootstrap")}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => void resetRegistry()}
            disabled={busy}
          >
            {t("system.skills.reset")}
          </Button>
        </div>
        <div className="skills-install-mode">
          <span className="skills-install-mode-label">
            {t("system.skills.installMode.label")}
          </span>
          <div
            className="skills-source-kind skills-install-mode-toggle"
            role="group"
            aria-label={t("system.skills.installMode.label")}
          >
            <button
              type="button"
              aria-pressed={defaultInstallMode === "symlink"}
              className={defaultInstallMode === "symlink" ? "active" : ""}
              onClick={() => setDefaultInstallMode("symlink")}
            >
              {t("system.skills.installMode.symlink")}
            </button>
            <button
              type="button"
              aria-pressed={defaultInstallMode === "copy"}
              className={defaultInstallMode === "copy" ? "active" : ""}
              onClick={() => setDefaultInstallMode("copy")}
            >
              {t("system.skills.installMode.copy")}
            </button>
          </div>
          {defaultInstallMode === "copy" ? (
            <span className="skills-install-mode-note">
              {t("system.skills.installMode.copyWarning")}
            </span>
          ) : null}
        </div>
      </div>
      {operation.active || operation.message || operation.errors.length > 0 ? (
        <div className={operation.errors.length > 0 ? "skills-operation warn" : "skills-operation"}>
          <div className="skills-operation-head">
            <strong>{operation.label || t("system.skills.operation")}</strong>
            <span>
              {operation.total > 0
                ? t("system.skills.progress", {
                    completed: operation.completed,
                    total: operation.total,
                  })
                : null}
            </span>
          </div>
          {operation.message ? <p>{operation.message}</p> : null}
          {operation.log.length > 0 ? (
            <pre>{operation.log.join("\n")}</pre>
          ) : null}
          {operation.errors.length > 0 ? (
            <ul>
              {operation.errors.slice(0, 6).map((item, index) => (
                <li key={`${index}:${item}`}>{item}</li>
              ))}
              {operation.errors.length > 6 ? (
                <li>{t("system.skills.moreErrors", { count: operation.errors.length - 6 })}</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="skills-manager-grid">
        <section className="skills-manager-section sources">
          <div className="skills-section-heading">
            <h3>{t("system.skills.sources")}</h3>
            <span>{sources.length}</span>
          </div>
          <div className="system-card source-add-card">
            <div className="skills-source-kind">
              <button
                type="button"
                className={newSourceKind === "linked" ? "active" : ""}
                onClick={() => setNewSourceKind("linked")}
              >
                {t("system.skills.sourceKind.linked")}
              </button>
              <button
                type="button"
                className={newSourceKind === "cloned" ? "active" : ""}
                onClick={() => setNewSourceKind("cloned")}
              >
                {t("system.skills.sourceKind.cloned")}
              </button>
            </div>
            <label className="field">
              <span>{t("system.skills.sourceId")}</span>
              <input
                value={newSourceId}
                onChange={(event) => setNewSourceId(event.target.value)}
                placeholder={t("system.skills.sourceIdPlaceholder")}
              />
            </label>
            <label className="field">
              <span>
                {newSourceKind === "linked"
                  ? t("system.skills.path")
                  : t("system.skills.repoUrl")}
              </span>
              <input
                value={newSourcePath}
                onChange={(event) => setNewSourcePath(event.target.value)}
                placeholder={
                  newSourceKind === "linked"
                    ? t("system.skills.linkedPathPlaceholder")
                    : t("system.skills.repoUrlPlaceholder")
                }
              />
            </label>
            <Button
              variant="secondary"
              size="sm"
              disabled={!newSourceId.trim() || !newSourcePath.trim() || busy}
              onClick={() => void addSource()}
            >
              {t("system.skills.addSource")}
            </Button>
          </div>
          <ul className="system-skill-list compact">
            {sources.map((source) => {
              const sourceRemovable =
                source.kind !== "managed" &&
                source.kind !== "builtin" &&
                source.id !== "maru-managed";
              const sourceHasInstalls = sourceHasInstalledSkills(source.id);
              const removeTitle = sourceHasInstalls
                  ? t("system.skills.removeSourceInstalledBlocked", { id: source.id })
                  : t("system.skills.removeSource");
              return (
                <li className="system-skill-card source-card" key={source.id}>
                  <div className="source-card-top">
                    <div>
                      <div className="system-skill-name">{source.id}</div>
                      <div className="system-skill-meta">
                        <span className="skill-status-pill subtle">{source.kind}</span>
                        <span>
                          <code>{source.skillsSubdir}</code>
                        </span>
                        <span title={source.lastSyncedAt ?? ""}>
                          {source.lastSyncedAt
                            ? t("system.skills.lastSynced", {
                                when: formatRelativeDate(source.lastSyncedAt, locale),
                              })
                            : t("system.skills.neverSynced")}
                        </span>
                      </div>
                    </div>
                    <div className="source-card-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void rescanSource(source)}
                        disabled={busy}
                      >
                        {t("system.skills.rescan")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void syncSource(source)}
                        disabled={busy}
                      >
                        {t("system.skills.sync")}
                      </Button>
                      {sourceRemovable ? (
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => void removeSource(source)}
                          disabled={busy || sourceHasInstalls}
                          title={removeTitle}
                        >
                          {t("system.skills.removeSource")}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div className="skill-path" title={source.path ?? source.repoUrl ?? ""}>
                    {source.path ?? source.repoUrl ?? t("system.skills.managedSource")}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="system-card skill-env-card">
            <div className="skills-section-heading">
              <h3>{t("system.skills.env")}</h3>
              <span className={envStatus?.healthy ? "skill-status-pill installed" : "skill-status-pill warn"}>
                {envStatus?.healthy ? t("system.skills.healthy") : t("system.skills.setup")}
              </span>
            </div>
            {envStatus ? (
              <>
                <div className="skill-path" title={envStatus.root}>{envStatus.root}</div>
                <div className="system-skill-meta">
                  <span>
                    {envStatus.venvExists
                      ? t("system.skills.venvReady")
                      : t("system.skills.venvMissing")}
                  </span>
                  <span>
                    {envStatus.nodeModulesExists
                      ? t("system.skills.nodeReady")
                      : t("system.skills.nodeMissing")}
                  </span>
                </div>
                {envStatus.lastError ? <p className="inline-error">{envStatus.lastError}</p> : null}
              </>
            ) : (
              <p className="muted">{t("system.skills.envUnavailable")}</p>
            )}
          </div>
        </section>

        <section className="skills-manager-section wide">
          <div className="skills-catalog-head">
            <div className="skills-section-heading">
              <h3>{t("system.skills.skills")}</h3>
              <span>{filteredSkills.length}/{skills.length}</span>
            </div>
            <div className="skills-create-row">
              <label className="field">
                <span>{t("system.skills.newManaged")}</span>
                <input
                  value={newSkillName}
                  onChange={(event) => setNewSkillName(event.target.value)}
                  placeholder={t("system.skills.skillNamePlaceholder")}
                />
              </label>
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus size={14} />}
                disabled={!newSkillName.trim() || busy}
                onClick={() => void createManagedSkill()}
              >
                {t("system.skills.create")}
              </Button>
            </div>
            <div className="skills-list-controls">
              <label className="search-box skills-search" title={t("system.skills.search")}>
                <Search size={14} />
                <input
                  value={skillQuery}
                  onChange={(event) => setSkillQuery(event.target.value)}
                  placeholder={t("system.skills.searchPlaceholder")}
                />
              </label>
              <div
                className="segmented-control compact skills-filter"
                role="group"
                aria-label={t("system.skills.installFilter")}
              >
                {skillFilterOptions.map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    className={installFilter === id ? "active" : ""}
                    onClick={() => setInstallFilter(id)}
                  >
                    <span>{label}</span>
                    <strong>{count}</strong>
                  </button>
                ))}
              </div>
            </div>
            <div className="skills-bulk-toolbar">
              <span>
                {t("system.skills.selected", {
                  count: selectedSkillIds.size,
                })}
              </span>
              <div
                className="skills-source-kind skills-install-mode-toggle"
                role="group"
                aria-label={t("system.skills.installMode.override")}
                title={t("system.skills.installMode.override")}
              >
                <button
                  type="button"
                  aria-pressed={installModeOverride === "default"}
                  className={installModeOverride === "default" ? "active" : ""}
                  onClick={() => setInstallModeOverride("default")}
                >
                  {t("system.skills.installMode.default")}
                </button>
                <button
                  type="button"
                  aria-pressed={installModeOverride === "symlink"}
                  className={installModeOverride === "symlink" ? "active" : ""}
                  onClick={() => setInstallModeOverride("symlink")}
                >
                  {t("system.skills.installMode.symlink")}
                </button>
                <button
                  type="button"
                  aria-pressed={installModeOverride === "copy"}
                  className={installModeOverride === "copy" ? "active" : ""}
                  onClick={() => setInstallModeOverride("copy")}
                >
                  {t("system.skills.installMode.copy")}
                </button>
              </div>
              <Button variant="ghost" size="sm" onClick={selectFilteredSkills} disabled={busy}>
                {t("system.skills.selectVisible")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={clearSkillSelection}
                disabled={busy || selectedSkillIds.size === 0}
              >
                {t("system.skills.clearSelection")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void installSkills(selectedSkills, "claude")}
                disabled={busy || selectedSkillIds.size === 0}
              >
                {t("system.skills.installSelectedTarget", { target: "Claude" })}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void installSkills(selectedSkills, "codex")}
                disabled={busy || selectedSkillIds.size === 0}
              >
                {t("system.skills.installSelectedTarget", { target: "Codex" })}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void installSkills(selectedSkills, "both")}
                disabled={busy || selectedSkillIds.size === 0}
              >
                {t("system.skills.installSelectedTarget", { target: skillTargetLabel("both", t) })}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void uninstallSelected()}
                disabled={busy || selectedInstalledTaskCount === 0}
              >
                {t("system.skills.removeSelected")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void installSkills(skills, "claude")}
                disabled={busy || skills.length === 0}
              >
                {t("system.skills.installAllTarget", { target: "Claude" })}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void installSkills(skills, "codex")}
                disabled={busy || skills.length === 0}
              >
                {t("system.skills.installAllTarget", { target: "Codex" })}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void installSkills(skills, "both")}
                disabled={busy || skills.length === 0}
              >
                {t("system.skills.installAllTarget", { target: skillTargetLabel("both", t) })}
              </Button>
            </div>
          </div>

          {skills.length === 0 ? (
            <div className="empty-state compact">
              <strong>{t("system.skills.empty")}</strong>
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="empty-state compact">
              <strong>{t("system.skills.noMatching")}</strong>
            </div>
          ) : (
            <ul className="system-skill-list">
              {filteredSkills.map((skill) => {
                const claudeInstalled = installKey.has(`${skill.id}:claude`);
                const codexInstalled = installKey.has(`${skill.id}:codex`);
                return (
                  <li
                    className="system-skill-card skill-card"
                    key={skill.id}
                  >
                    <div className="skill-card-top">
                      <label className="skill-select" title={t("system.skills.selectSkill")}>
                        <input
                          type="checkbox"
                          checked={selectedSkillIds.has(skill.id)}
                          onChange={() => toggleSkillSelection(skill.id)}
                        />
                        <span>{t("system.skills.selectSkill")}</span>
                      </label>
                      <button
                        type="button"
                        className="skill-card-title"
                        onClick={() => void openSkillEditor(skill)}
                      >
                        <span>
                          {skill.name}
                          {skill.dirty ? (
                            <span className="dirty-pill">{t("system.skills.dirty")}</span>
                          ) : null}
                        </span>
                        <small>{skill.description || skill.title || skill.sourceId}</small>
                      </button>
                      <div className="skill-card-badges">
                        <span
                          className={claudeInstalled ? "skill-status-pill installed" : "skill-status-pill"}
                        >
                          <SquareTerminal size={12} />
                          Claude
                        </span>
                        <span
                          className={codexInstalled ? "skill-status-pill installed" : "skill-status-pill"}
                        >
                          <Code2 size={12} />
                          Codex
                        </span>
                      </div>
                    </div>
                    <div className="system-skill-meta">
                      <span>
                        {t("system.skills.source")}: <code>{skill.sourceId}</code>
                      </span>
                      <span>
                        {t("system.skills.runtime")}:{" "}
                        <code>{skill.runtime ?? t("system.skills.none")}</code>
                      </span>
                      <span title={skill.absPath}>
                        <code>{skill.relPath}</code>
                      </span>
                    </div>
                    <div className="skill-card-actions">
                      <Button variant="secondary" size="sm" onClick={() => void openSkillEditor(skill)}>
                        {t("system.skills.edit")}
                      </Button>
                      <Button
                        variant={claudeInstalled ? "ghost" : "primary"}
                        size="sm"
                        onClick={() =>
                          claudeInstalled
                            ? void uninstall(skill, "claude")
                            : void install(skill, "claude")
                        }
                        disabled={busy}
                      >
                        {claudeInstalled
                          ? t("system.skills.removeTarget", { target: "Claude" })
                          : t("system.skills.installTarget", { target: "Claude" })}
                      </Button>
                      <Button
                        variant={codexInstalled ? "ghost" : "primary"}
                        size="sm"
                        onClick={() =>
                          codexInstalled
                            ? void uninstall(skill, "codex")
                            : void install(skill, "codex")
                        }
                        disabled={busy}
                      >
                        {codexInstalled
                          ? t("system.skills.removeTarget", { target: "Codex" })
                          : t("system.skills.installTarget", { target: "Codex" })}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      <Dialog.Root
        open={confirmState !== null}
        onOpenChange={(open) => {
          if (!open) closeConfirmation(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content skills-confirm-dialog">
            <div className="dialog-header">
              <div>
                <Dialog.Title>{confirmState?.title ?? t("system.skills.confirmTitle")}</Dialog.Title>
                <Dialog.Description>
                  {confirmState?.message ?? t("system.skills.confirmFallback")}
                </Dialog.Description>
              </div>
            </div>
            <div className="dialog-actions">
              <Button variant="ghost" onClick={() => closeConfirmation(false)}>
                {t("dialog.cancel")}
              </Button>
              <Button
                variant={confirmState?.variant ?? "primary"}
                onClick={() => closeConfirmation(true)}
              >
                {confirmState?.confirmLabel ?? t("system.skills.confirmProceed")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {error ? (
        <div className="toast" title={error}>
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
