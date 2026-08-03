import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Cloud,
  Download,
  Eye,
  Laptop,
  Pause,
  Play,
  RefreshCcw,
  Save,
  Square,
  Upload,
  Wrench,
} from "lucide-react";

import {
  dotSyncOverview,
  dotSyncRun,
  type DotSyncActionRequest,
  type DotSyncMode,
  type DotSyncOverview,
  type DotSyncProfileStatus,
} from "../../lib/api";
import { deriveDotSyncBadge } from "../../lib/dotSync";
import { useTranslation } from "../../lib/i18n";
import { SettingsSection } from "../settings/SettingsSection";

const POLL_INTERVAL_MS = 30_000;

interface MirrorForm {
  target: string;
  owner: string;
  filterMode: "include" | "exclude";
  create: boolean;
  update: boolean;
  delete: boolean;
  maxDelete: number;
  pushIntervalSeconds: number;
  pullIntervalSeconds: number;
  pushMode: DotSyncMode;
  pullMode: DotSyncMode;
}

interface PeerForm {
  host: string;
  remotePath: string;
  intervalSeconds: number;
  allowPatterns: string;
  homePaths: string;
}

const emptyMirrorForm: MirrorForm = {
  target: "",
  owner: "",
  filterMode: "include",
  create: true,
  update: true,
  delete: false,
  maxDelete: 1000,
  pushIntervalSeconds: 600,
  pullIntervalSeconds: 0,
  pushMode: "clean",
  pullMode: "clean",
};

const emptyPeerForm: PeerForm = {
  host: "",
  remotePath: "",
  intervalSeconds: 900,
  allowPatterns: "",
  homePaths: "",
};

const intervalOptions = [0, 300, 600, 900, 1_800, 3_600, 21_600, 86_400];

function jobInterval(profile: DotSyncProfileStatus, action: string): number {
  return profile.jobs.find((job) => job.action === action)?.intervalSeconds ?? 0;
}

function jobMode(profile: DotSyncProfileStatus, action: string): DotSyncMode {
  return profile.jobs.find((job) => job.action === action)?.mode === "force"
    ? "force"
    : "clean";
}

function mirrorFormFrom(status: DotSyncProfileStatus | null): MirrorForm {
  if (!status?.configured) return emptyMirrorForm;
  return {
    target: status.target.spec,
    owner: status.owner ?? status.machineNames[0] ?? "",
    filterMode: status.filterMode === "exclude" ? "exclude" : "include",
    create: status.propagation.create,
    update: status.propagation.update,
    delete: status.propagation.delete,
    maxDelete: status.maxDelete,
    pushIntervalSeconds: jobInterval(status, "push"),
    pullIntervalSeconds: jobInterval(status, "pull"),
    pushMode: jobMode(status, "push"),
    pullMode: jobMode(status, "pull"),
  };
}

function peerFormFrom(overview: DotSyncOverview): PeerForm {
  const peer = overview.peer;
  return {
    ...emptyPeerForm,
    host: peer?.profile.target.host ?? "",
    remotePath: peer?.profile.target.path || overview.mirror?.workspacePath || "",
    intervalSeconds: peer?.job.intervalSeconds || emptyPeerForm.intervalSeconds,
  };
}

function displayTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function DotSyncPanel() {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<DotSyncOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string>("");
  const [mirrorOpen, setMirrorOpen] = useState(false);
  const [peerOpen, setPeerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [mirrorDirty, setMirrorDirty] = useState(false);
  const [peerDirty, setPeerDirty] = useState(false);
  const [mirrorForm, setMirrorForm] = useState<MirrorForm>(emptyMirrorForm);
  const [peerForm, setPeerForm] = useState<PeerForm>(emptyPeerForm);
  const [advancedProfile, setAdvancedProfile] = useState<"sync" | "peer">("sync");
  const [advancedKind, setAdvancedKind] = useState<"include" | "exclude" | "ignore" | "allow">("ignore");
  const [advancedContent, setAdvancedContent] = useState("");
  const [homePathsContent, setHomePathsContent] = useState("");

  const applyOverview = useCallback(
    (next: DotSyncOverview) => {
      setOverview(next);
      if (!mirrorDirty) setMirrorForm(mirrorFormFrom(next.mirror));
      if (!peerDirty) setPeerForm(peerFormFrom(next));
    },
    [mirrorDirty, peerDirty],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await dotSyncOverview();
      applyOverview(next);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [applyOverview]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const execute = useCallback(
    async (request: DotSyncActionRequest, confirmation?: string) => {
      if (confirmation && !window.confirm(confirmation)) return null;
      setBusy(request.type);
      setError(null);
      try {
        const result = await dotSyncRun(request);
        applyOverview(result.overview);
        setOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));
        return result;
      } catch (err) {
        setError(String(err));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [applyOverview],
  );

  const badge = useMemo(() => deriveDotSyncBadge(overview), [overview]);
  const mirror = overview?.mirror ?? null;
  const peer = overview?.peer ?? null;
  const ready = Boolean(overview?.cli.available && overview.cli.compatible);

  const saveMirror = async () => {
    const destructive = mirrorForm.delete || mirrorForm.pushMode === "force" || mirrorForm.pullMode === "force";
    const result = await execute(
      { type: "configureMirror", ...mirrorForm },
      destructive ? t("system.dotSync.confirm.riskyMirror") : undefined,
    );
    if (result) {
      setMirrorDirty(false);
      setMirrorOpen(false);
    }
  };

  const savePeer = async () => {
    const carriesSecrets = peerForm.allowPatterns.trim().length > 0;
    const result = await execute(
      { type: "configurePeer", ...peerForm, acknowledgeSecrets: carriesSecrets },
      t("system.dotSync.confirm.peerSecrets"),
    );
    if (result) {
      setPeerDirty(false);
      setPeerOpen(false);
    }
  };

  const readAdvanced = async () => {
    const result = await execute({
      type: "readFilter",
      profile: advancedProfile,
      kind: advancedKind,
    });
    if (result) setAdvancedContent(result.stdout);
  };

  const saveAdvanced = async () => {
    const isAllow = advancedKind === "allow";
    await execute(
      {
        type: "saveFilter",
        profile: advancedProfile,
        kind: advancedKind,
        content: advancedContent,
        acknowledgeSecrets: isAllow,
      },
      isAllow ? t("system.dotSync.confirm.allow") : t("system.dotSync.confirm.saveFilter"),
    );
  };

  const readHomePaths = async () => {
    const result = await execute({ type: "readPeerHomePaths" });
    if (result) setHomePathsContent(result.stdout);
  };

  return (
    <SettingsSection
      title={t("system.dotSync.title")}
      description={t("system.dotSync.description")}
      actions={
        <button type="button" className="secondary-button" onClick={() => void refresh()} disabled={busy !== null}>
          <RefreshCcw size={14} className={loading ? "spin" : undefined} />
          <span>{t("system.dotSync.refresh")}</span>
        </button>
      }
      padded
    >
      {error ? <p className="jobs-error" role="alert">{error}</p> : null}
      {loading && !overview ? <p className="muted">{t("system.dotSync.loading")}</p> : null}

      {overview && !overview.cli.available ? (
        <div className="dot-sync-setup">
          <Download size={20} />
          <div>
            <strong>{t("system.dotSync.cliMissing")}</strong>
            <p className="muted">{t("system.dotSync.cliMissingDescription")}</p>
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={busy !== null}
            onClick={() => void execute({ type: "installCli" }, t("system.dotSync.confirm.install"))}
          >
            {t("system.dotSync.install")}
          </button>
        </div>
      ) : null}

      {overview?.cli.available && !overview.cli.compatible ? (
        <div className="dot-sync-setup warning">
          <AlertTriangle size={20} />
          <div>
            <strong>{t("system.dotSync.cliOutdated", { version: overview.cli.version ?? "—" })}</strong>
            <p className="muted">{t("system.dotSync.cliRequired", { version: overview.cli.minimumVersion })}</p>
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={busy !== null}
            onClick={() => void execute({ type: "updateCli" }, t("system.dotSync.confirm.update"))}
          >
            {t("system.dotSync.update")}
          </button>
        </div>
      ) : null}

      {ready ? (
        <>
          <div className="dot-sync-summary">
            <span className={`status-pill dot-sync-health ${badge.state === "attention" ? "attention" : ""}`}>
              {t(`system.dotSync.state.${badge.state}`, { count: badge.scheduledJobs })}
            </span>
            <span className="muted">dot {overview?.cli.version}</span>
          </div>

          <SyncProfileCard
            icon={<Cloud size={17} />}
            title={t("system.dotSync.mirror.title")}
            configured={Boolean(mirror?.configured)}
            path={mirror?.workspacePath}
            target={mirror?.target.spec}
            jobs={mirror?.jobs ?? []}
            lastSync={mirror?.lastPushAt ?? mirror?.lastPullAt ?? null}
            status={mirror?.paused ? t("system.dotSync.state.paused", { count: 0 }) : undefined}
            t={t}
          >
            <button type="button" className="secondary-button" disabled={busy !== null || !mirror?.configured} onClick={() => void execute({ type: "runMirror", direction: "push", mode: "clean", dryRun: true })}>
              <Eye size={14} /> {t("system.dotSync.previewPush")}
            </button>
            <button type="button" className="secondary-button" disabled={busy !== null || !mirror?.configured} onClick={() => void execute({ type: "runMirror", direction: "push", mode: "clean", dryRun: false }, t("system.dotSync.confirm.push"))}>
              <Upload size={14} /> {t("system.dotSync.push")}
            </button>
            <button type="button" className="secondary-button" disabled={busy !== null || !mirror?.configured} onClick={() => void execute({ type: "runMirror", direction: "pull", mode: "clean", dryRun: true })}>
              <Eye size={14} /> {t("system.dotSync.previewPull")}
            </button>
            <button type="button" className="secondary-button" disabled={busy !== null || !mirror?.configured} onClick={() => void execute({ type: "runMirror", direction: "pull", mode: "clean", dryRun: false }, t("system.dotSync.confirm.pull"))}>
              <Download size={14} /> {t("system.dotSync.pull")}
            </button>
            {mirror?.paused ? (
              <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void execute({ type: "resumeMirror" })}>
                <Play size={14} /> {t("system.dotSync.resume")}
              </button>
            ) : (
              <button type="button" className="secondary-button" disabled={busy !== null || !mirror?.configured} onClick={() => void execute({ type: "pauseMirror" })}>
                <Pause size={14} /> {t("system.dotSync.pause")}
              </button>
            )}
            <button type="button" className="secondary-button" disabled={busy !== null || !mirror?.configured} onClick={() => void execute({ type: "readLog", profile: "sync" })}>
              {t("system.dotSync.logs")}
            </button>
            <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => setMirrorOpen((value) => !value)}>
              {mirrorOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {mirror?.configured ? t("system.dotSync.edit") : t("system.dotSync.configure")}
            </button>
          </SyncProfileCard>

          {mirrorOpen ? (
            <MirrorEditor
              value={mirrorForm}
              disabled={busy !== null}
              t={t}
              onChange={(next) => { setMirrorForm(next); setMirrorDirty(true); }}
              onSave={() => void saveMirror()}
            />
          ) : null}

          <SyncProfileCard
            icon={<Laptop size={17} />}
            title={t("system.dotSync.peer.title")}
            configured={Boolean(peer?.profile.configured)}
            path={peer?.profile.workspacePath}
            target={peer?.profile.target.spec}
            jobs={peer ? [peer.job] : []}
            lastSync={peer?.job.lastRunAt ?? null}
            status={peer?.lastExitCode != null ? t("system.dotSync.lastExit", { code: peer.lastExitCode }) : undefined}
            t={t}
          >
            <button type="button" className="secondary-button" disabled={busy !== null || !peer?.profile.configured} onClick={() => void execute({ type: "runPeer", dryRun: true })}>
              <Eye size={14} /> {t("system.dotSync.preview")}
            </button>
            <button type="button" className="secondary-button" disabled={busy !== null || !peer?.profile.configured} onClick={() => void execute({ type: "runPeer", dryRun: false }, t("system.dotSync.confirm.peerRun"))}>
              <Play size={14} /> {t("system.dotSync.run")}
            </button>
            <button type="button" className="secondary-button" disabled={busy !== null || !peer?.profile.configured} onClick={() => void execute({ type: "peerDoctor" })}>
              <Wrench size={14} /> {t("system.dotSync.doctor")}
            </button>
            <button type="button" className="secondary-button" disabled={busy !== null || !peer?.profile.configured} onClick={() => void execute({ type: "peerDiff" })}>
              {t("system.dotSync.diff")}
            </button>
            <button type="button" className="secondary-button" disabled={busy !== null || !peer?.profile.configured} onClick={() => void execute({ type: "readLog", profile: "peer" })}>
              {t("system.dotSync.logs")}
            </button>
            {peer?.job.intervalSeconds ? (
              <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void execute({ type: "disablePeer" }, t("system.dotSync.confirm.disablePeer"))}>
                <Square size={14} /> {t("system.dotSync.disableJob")}
              </button>
            ) : null}
            <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => setPeerOpen((value) => !value)}>
              {peerOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {peer?.profile.configured ? t("system.dotSync.edit") : t("system.dotSync.configure")}
            </button>
          </SyncProfileCard>

          {peerOpen ? (
            <PeerEditor
              value={peerForm}
              disabled={busy !== null}
              t={t}
              onChange={(next) => { setPeerForm(next); setPeerDirty(true); }}
              onSave={() => void savePeer()}
            />
          ) : null}

          <div className="dot-sync-advanced">
            <button type="button" className="secondary-button" onClick={() => setAdvancedOpen((value) => !value)}>
              {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {t("system.dotSync.advanced")}
            </button>
            {advancedOpen ? (
              <div className="dot-sync-editor">
                <div className="settings-grid two">
                  <label className="field">
                    <span>{t("system.dotSync.profile")}</span>
                    <select value={advancedProfile} onChange={(event) => setAdvancedProfile(event.target.value as "sync" | "peer")}>
                      <option value="sync">{t("system.dotSync.mirror.title")}</option>
                      <option value="peer">{t("system.dotSync.peer.title")}</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>{t("system.dotSync.filter")}</span>
                    <select value={advancedKind} onChange={(event) => setAdvancedKind(event.target.value as typeof advancedKind)}>
                      <option value="include">{t("system.dotSync.filter.include")}</option>
                      <option value="exclude">{t("system.dotSync.filter.exclude")}</option>
                      <option value="ignore">{t("system.dotSync.filter.ignore")}</option>
                      <option value="allow">{t("system.dotSync.filter.allow")}</option>
                    </select>
                  </label>
                </div>
                <div className="comms-settings-actions">
                  <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void readAdvanced()}>{t("system.dotSync.load")}</button>
                  <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void saveAdvanced()}><Save size={14} /> {t("system.dotSync.save")}</button>
                </div>
                <textarea className="settings-textarea dot-sync-textarea" value={advancedContent} onChange={(event) => setAdvancedContent(event.target.value)} spellCheck={false} aria-label={t("system.dotSync.filterEditor")} />
                <div className="dot-sync-home-paths-head">
                  <strong>{t("system.dotSync.homePaths")}</strong>
                  <div className="comms-settings-actions">
                    <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void readHomePaths()}>{t("system.dotSync.load")}</button>
                    <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void execute({ type: "savePeerHomePaths", content: homePathsContent }, t("system.dotSync.confirm.homePaths"))}><Save size={14} /> {t("system.dotSync.save")}</button>
                  </div>
                </div>
                <textarea className="settings-textarea dot-sync-textarea" value={homePathsContent} onChange={(event) => setHomePathsContent(event.target.value)} spellCheck={false} aria-label={t("system.dotSync.homePathsEditor")} />
              </div>
            ) : null}
          </div>

          {output ? (
            <div className="jobs-logs dot-sync-output" aria-live="polite">
              <div className="dot-sync-output-head">
                <strong className="muted">{t("system.dotSync.output")}</strong>
                <button type="button" className="secondary-button" onClick={() => setOutput("")}>{t("system.dotSync.clear")}</button>
              </div>
              <pre>{output}</pre>
            </div>
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}

function SyncProfileCard({ icon, title, configured, path, target, jobs, lastSync, status, children, t }: {
  icon: ReactNode;
  title: string;
  configured: boolean;
  path?: string;
  target?: string;
  jobs: Array<{ id: string; label: string; intervalSeconds: number; state: string }>;
  lastSync: string | null;
  status?: string;
  children: ReactNode;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <article className="dot-sync-card">
      <header className="dot-sync-card-head">
        <div className="dot-sync-card-title">{icon}<strong>{title}</strong></div>
        <div className="jobs-list-badges">
          <span className="status-pill" data-status={configured ? "active" : "draft"}>{configured ? t("system.dotSync.configured") : t("system.dotSync.notConfigured")}</span>
          {status ? <span className="status-pill">{status}</span> : null}
        </div>
      </header>
      {configured ? (
        <dl className="dot-sync-facts">
          <div><dt>{t("system.dotSync.workspace")}</dt><dd title={path}>{path || "—"}</dd></div>
          <div><dt>{t("system.dotSync.target")}</dt><dd title={target}>{target || "—"}</dd></div>
          <div><dt>{t("system.dotSync.lastSync")}</dt><dd>{displayTime(lastSync)}</dd></div>
        </dl>
      ) : <p className="muted">{t("system.dotSync.profileEmpty")}</p>}
      {jobs.length > 0 ? (
        <div className="dot-sync-jobs">
          {jobs.map((job) => (
            <span key={job.id} className="dot-sync-job">
              <span>{job.label}</span>
              <strong>{job.intervalSeconds > 0 ? `${job.intervalSeconds}s` : t("system.dotSync.manual")}</strong>
              <span className={`dot-sync-job-state ${job.state === "running" ? "active" : ""}`}>{job.state}</span>
            </span>
          ))}
        </div>
      ) : null}
      <div className="comms-settings-actions">{children}</div>
    </article>
  );
}

function IntervalField({ label, value, disabled, onChange, t }: { label: string; value: number; disabled: boolean; onChange: (value: number) => void; t: (key: string) => string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))}>
        {intervalOptions.map((seconds) => <option key={seconds} value={seconds}>{seconds === 0 ? t("system.dotSync.off") : `${seconds}s`}</option>)}
      </select>
    </label>
  );
}

function MirrorEditor({ value, disabled, onChange, onSave, t }: { value: MirrorForm; disabled: boolean; onChange: (value: MirrorForm) => void; onSave: () => void; t: (key: string) => string }) {
  const set = <K extends keyof MirrorForm>(key: K, next: MirrorForm[K]) => onChange({ ...value, [key]: next });
  return (
    <div className="dot-sync-editor">
      <div className="settings-grid two">
        <label className="field"><span>{t("system.dotSync.target")}</span><input value={value.target} disabled={disabled} placeholder="local:/path or ssh:user@host:/path" onChange={(event) => set("target", event.target.value)} /></label>
        <label className="field"><span>{t("system.dotSync.owner")}</span><input value={value.owner} disabled={disabled} onChange={(event) => set("owner", event.target.value)} /></label>
        <label className="field"><span>{t("system.dotSync.filterMode")}</span><select value={value.filterMode} disabled={disabled} onChange={(event) => set("filterMode", event.target.value as MirrorForm["filterMode"])}><option value="include">include</option><option value="exclude">exclude</option></select></label>
        <label className="field"><span>{t("system.dotSync.maxDelete")}</span><input type="number" min={1} value={value.maxDelete} disabled={disabled || !value.delete} onChange={(event) => set("maxDelete", Number(event.target.value))} /></label>
        <IntervalField label={t("system.dotSync.pushInterval")} value={value.pushIntervalSeconds} disabled={disabled} onChange={(next) => set("pushIntervalSeconds", next)} t={t} />
        <IntervalField label={t("system.dotSync.pullInterval")} value={value.pullIntervalSeconds} disabled={disabled} onChange={(next) => set("pullIntervalSeconds", next)} t={t} />
        <label className="field"><span>{t("system.dotSync.pushMode")}</span><select value={value.pushMode} disabled={disabled} onChange={(event) => set("pushMode", event.target.value as DotSyncMode)}><option value="clean">clean</option><option value="force">force</option></select></label>
        <label className="field"><span>{t("system.dotSync.pullMode")}</span><select value={value.pullMode} disabled={disabled} onChange={(event) => set("pullMode", event.target.value as DotSyncMode)}><option value="clean">clean</option><option value="force">force</option></select></label>
      </div>
      <div className="dot-sync-checks">
        <label className="checkbox-field"><input type="checkbox" checked={value.create} disabled={disabled} onChange={(event) => set("create", event.target.checked)} />{t("system.dotSync.propagateCreate")}</label>
        <label className="checkbox-field"><input type="checkbox" checked={value.update} disabled={disabled} onChange={(event) => set("update", event.target.checked)} />{t("system.dotSync.propagateUpdate")}</label>
        <label className="checkbox-field danger"><input type="checkbox" checked={value.delete} disabled={disabled} onChange={(event) => set("delete", event.target.checked)} />{t("system.dotSync.propagateDelete")}</label>
      </div>
      <button type="button" className="primary-button" disabled={disabled || !value.target.trim() || !value.owner.trim() || (!value.create && !value.update && !value.delete)} onClick={onSave}><Save size={14} />{t("system.dotSync.saveMirror")}</button>
    </div>
  );
}

function PeerEditor({ value, disabled, onChange, onSave, t }: { value: PeerForm; disabled: boolean; onChange: (value: PeerForm) => void; onSave: () => void; t: (key: string) => string }) {
  const set = <K extends keyof PeerForm>(key: K, next: PeerForm[K]) => onChange({ ...value, [key]: next });
  return (
    <div className="dot-sync-editor">
      <div className="settings-grid two">
        <label className="field"><span>{t("system.dotSync.peerHost")}</span><input value={value.host} disabled={disabled} placeholder={t("system.dotSync.peerHostPlaceholder")} onChange={(event) => set("host", event.target.value)} /></label>
        <label className="field"><span>{t("system.dotSync.remotePath")}</span><input value={value.remotePath} disabled={disabled} onChange={(event) => set("remotePath", event.target.value)} /></label>
        <IntervalField label={t("system.dotSync.peerInterval")} value={value.intervalSeconds} disabled={disabled} onChange={(next) => set("intervalSeconds", next)} t={t} />
      </div>
      <label className="field"><span>{t("system.dotSync.allowPatternsOptional")}</span><textarea className="settings-textarea dot-sync-textarea compact" value={value.allowPatterns} disabled={disabled} spellCheck={false} placeholder={t("system.dotSync.cliDefaults")} onChange={(event) => set("allowPatterns", event.target.value)} /></label>
      <label className="field"><span>{t("system.dotSync.homePathsOptional")}</span><textarea className="settings-textarea dot-sync-textarea compact" value={value.homePaths} disabled={disabled} spellCheck={false} placeholder={t("system.dotSync.cliDefaults")} onChange={(event) => set("homePaths", event.target.value)} /></label>
      <p className="settings-warning">{t("system.dotSync.peerDeleteGuard")}</p>
      <button type="button" className="primary-button" disabled={disabled || !value.host.trim() || !value.remotePath.trim()} onClick={onSave}><Save size={14} />{t("system.dotSync.savePeer")}</button>
    </div>
  );
}
