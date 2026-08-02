import { AlertTriangle, Plus, RefreshCcw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_INBOX_RUNTIME_CONFIG,
  readInboxRuntimeConfig,
  saveInboxRuntimeConfig,
} from "../../../lib/api";
import { useTranslation } from "../../../lib/i18n";
import type { MaruSettings } from "../../../lib/settings";
import { normalizeMaruSettings, normalizeDotFolderIncludes } from "../../../lib/settings";
import type { InboxChannelConfig, InboxRuntimeConfig } from "../../../lib/types";
import { Button } from "../../ui/Button";
import { CompactSelect, ModeHeader } from "../../ui/ModeChrome";
import { SettingsSection } from "../SettingsSection";
import { SettingsRow } from "../SettingsRow";
import { cloneInboxConfig } from "./shared";

// ============================ Inbox Runtime ============================

export function InboxRuntimeConfigTab({
  workPath,
  settings,
  onSettingsChange,
  onSaved,
}: {
  workPath: string;
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
  onSaved?: (config: InboxRuntimeConfig) => void;
}) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<InboxRuntimeConfig>(() =>
    cloneInboxConfig(DEFAULT_INBOX_RUNTIME_CONFIG),
  );
  const [pristine, setPristine] = useState<InboxRuntimeConfig>(() =>
    cloneInboxConfig(DEFAULT_INBOX_RUNTIME_CONFIG),
  );
  const [selectedKey, setSelectedKey] = useState<string>("incoming");
  const [channelKeyDraft, setChannelKeyDraft] = useState<string>("incoming");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dotIncludesText, setDotIncludesText] = useState(() =>
    settings.scan.includeDotFolders.join("\n"),
  );

  const channelKeys = useMemo(() => Object.keys(config.channels).sort(), [config.channels]);
  const selectedChannel = config.channels[selectedKey] ?? null;
  const fileDrop = config.file_drop ?? DEFAULT_INBOX_RUNTIME_CONFIG.file_drop;
  const fileDropChannel = config.channels[fileDrop.channel] ?? null;
  const dirty = JSON.stringify(config) !== JSON.stringify(pristine);

  useEffect(() => {
    setChannelKeyDraft(selectedKey);
  }, [selectedKey]);

  useEffect(() => {
    setDotIncludesText(settings.scan.includeDotFolders.join("\n"));
  }, [settings.scan.includeDotFolders]);

  const load = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const runtime = await readInboxRuntimeConfig(workPath);
      setConfig(runtime);
      setPristine(runtime);
      setSelectedKey((current) => runtime.channels[current] ? current : Object.keys(runtime.channels).sort()[0] ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateConfig = (patch: Partial<InboxRuntimeConfig>) => {
    setConfig((current) => ({ ...current, ...patch }));
    setStatus(null);
  };

  const updatePath = (key: keyof InboxRuntimeConfig["paths"], value: string) => {
    setConfig((current) => ({
      ...current,
      paths: {
        ...current.paths,
        [key]: value,
      },
    }));
    setStatus(null);
  };

  const updateNaming = (key: keyof InboxRuntimeConfig["naming"], value: string) => {
    setConfig((current) => ({
      ...current,
      naming: {
        ...current.naming,
        [key]: value,
      },
    }));
    setStatus(null);
  };

  const updateFileDrop = (patch: Partial<InboxRuntimeConfig["file_drop"]>) => {
    setConfig((current) => ({
      ...current,
      file_drop: {
        ...(current.file_drop ?? DEFAULT_INBOX_RUNTIME_CONFIG.file_drop),
        ...patch,
        operation: "copy",
      },
    }));
    setStatus(null);
  };

  const updateDotFolderIncludes = (text: string) => {
    const includeDotFolders = normalizeDotFolderIncludes(text.split(/\r?\n/));
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        scan: {
          ...settings.scan,
          includeDotFolders,
        },
      }),
    );
  };

  const updateChannel = (key: string, patch: Partial<InboxChannelConfig>) => {
    setConfig((current) => {
      const channel = current.channels[key];
      if (!channel) return current;
      return {
        ...current,
        channels: {
          ...current.channels,
          [key]: {
            ...channel,
            ...patch,
          },
        },
      };
    });
    setStatus(null);
  };

  const renameChannel = (from: string, toRaw: string) => {
    const to = toRaw.trim();
    if (!to || to === from) return;
    if (!/^[a-z0-9_-]+$/.test(to)) {
      setError(t("system.inboxChannels.channel.keyInvalid"));
      return;
    }
    if (config.channels[to]) {
      setError(t("system.inboxChannels.channel.exists", { key: to }));
      return;
    }
    setConfig((current) => {
      const { [from]: channel, ...rest } = current.channels;
      if (!channel) return current;
      return {
        ...current,
        channels: {
          ...rest,
          [to]: channel,
        },
      };
    });
    setSelectedKey(to);
    setError(null);
    setStatus(null);
  };

  const addChannel = () => {
    const key = uniqueChannelKey(config, "incoming");
    setConfig((current) => ({
      ...current,
      channels: {
        ...current.channels,
        [key]: {
          provider: "local",
          skill: null,
          kind: "file",
          drop_paths: [`${current.paths.drop}/${key}`],
          source_kinds: {},
          dedupe: "sha256",
        },
      },
    }));
    setSelectedKey(key);
    setStatus(null);
  };

  const duplicateChannel = () => {
    if (!selectedChannel) return;
    const key = uniqueChannelKey(config, `${selectedKey}-copy`);
    setConfig((current) => ({
      ...current,
      channels: {
        ...current.channels,
        [key]: cloneChannel(selectedChannel),
      },
    }));
    setSelectedKey(key);
    setStatus(null);
  };

  const deleteChannel = () => {
    if (!selectedKey) return;
    setConfig((current) => {
      const { [selectedKey]: _deleted, ...channels } = current.channels;
      return { ...current, channels };
    });
    const nextKey = channelKeys.filter((key) => key !== selectedKey)[0] ?? "";
    setSelectedKey(nextKey);
    setStatus(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await saveInboxRuntimeConfig(workPath, config);
      setConfig(saved);
      setPristine(saved);
      setSelectedKey((current) => saved.channels[current] ? current : Object.keys(saved.channels).sort()[0] ?? "");
      onSaved?.(saved);
      setStatus(t("system.rules.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-tab wide">
      <ModeHeader
        title={t("system.tab.inboxChannels")}
        subtitle={t("system.inboxChannels.title")}
        actions={
          <>
            <span className={dirty ? "save-state dirty" : "save-state saved"}>
              {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void load()} icon={<RefreshCcw size={14} />}>
              {t("system.skills.refresh")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
              icon={<Save size={14} />}
            >
              {t("system.rules.save")}
            </Button>
          </>
        }
      />

      <SettingsSection
        title={t("system.inboxChannels.overview.title")}
        description={t("system.inboxChannels.overview.subtitle")}
      >
        <SettingsRow
          label={t("system.inboxChannels.inboxRoot")}
          htmlFor="inbox-runtime-root"
          control={
            <input
              id="inbox-runtime-root"
              value={config.root}
              onChange={(event) => updateConfig({ root: event.target.value })}
              spellCheck={false}
            />
          }
        />
        <SettingsRow
          label={t("system.inboxChannels.fileDropChannel")}
          htmlFor="inbox-filedrop-channel"
          control={
            <CompactSelect
              id="inbox-filedrop-channel"
              value={fileDrop.channel}
              onChange={(event) => {
                const channel = event.target.value;
                const dropPath =
                  config.channels[channel]?.drop_paths[0] ?? `${config.paths.drop}/${channel}`;
                updateFileDrop({ channel, drop_path: dropPath });
              }}
            >
              {channelKeys.map((key) => (
                <option key={key} value={key}>{key}</option>
              ))}
            </CompactSelect>
          }
        />
        <SettingsRow
          label={t("system.inboxChannels.fileDropPath")}
          htmlFor="inbox-filedrop-path"
          control={
            <CompactSelect
              id="inbox-filedrop-path"
              value={fileDrop.drop_path}
              onChange={(event) => updateFileDrop({ drop_path: event.target.value })}
            >
              {(fileDropChannel?.drop_paths ?? [fileDrop.drop_path]).map((path) => (
                <option key={path} value={path}>{path}</option>
              ))}
            </CompactSelect>
          }
        />
        {!fileDropChannel ? (
          <small className="settings-warning">{t("system.inboxChannels.fileDropMissing")}</small>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title={t("system.inboxChannels.paths.title")}
        description={t("system.inboxChannels.paths.subtitle")}
      >
        {Object.entries(config.paths).map(([key, value]) => (
          <SettingsRow
            key={key}
            label={key}
            htmlFor={`inbox-path-${key}`}
            control={
              <input
                id={`inbox-path-${key}`}
                value={String(value)}
                onChange={(event) =>
                  updatePath(key as keyof InboxRuntimeConfig["paths"], event.target.value)
                }
                spellCheck={false}
              />
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title={t("system.inboxChannels.artifacts.title")}
        description={t("system.inboxChannels.artifacts.subtitle")}
      >
        {Object.entries(config.naming).map(([key, value]) => (
          <SettingsRow
            key={key}
            label={key}
            htmlFor={`inbox-naming-${key}`}
            control={
              <input
                id={`inbox-naming-${key}`}
                value={String(value)}
                onChange={(event) =>
                  updateNaming(key as keyof InboxRuntimeConfig["naming"], event.target.value)
                }
                spellCheck={false}
              />
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title={t("system.inboxChannels.channels.title")}
        description={t("system.inboxChannels.channels.subtitle")}
        padded
      >
        <div className="inbox-channel-editor">
          <div className="inbox-channel-list" role="listbox" aria-label={t("system.inboxChannels.channels.listLabel")}>
            <div className="inbox-channel-list-actions">
              <Button size="sm" variant="ghost" onClick={addChannel} icon={<Plus size={14} />}>
                {t("system.inboxChannels.channel.add")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!selectedChannel}
                onClick={duplicateChannel}
              >
                {t("system.inboxChannels.channel.duplicate")}
              </Button>
            </div>
            {channelKeys.map((key) => (
              <button
                type="button"
                key={key}
                className={selectedKey === key ? "system-list-item active" : "system-list-item"}
                onClick={() => setSelectedKey(key)}
              >
                <strong>{key}</strong>
                <span>{config.channels[key]?.provider ?? "local"}</span>
              </button>
            ))}
          </div>

          {selectedChannel ? (
            <div className="inbox-channel-fields">
              <SettingsSection
                title={selectedKey}
                actions={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={deleteChannel}
                    icon={<Trash2 size={14} />}
                  >
                    {t("system.rules.delete")}
                  </Button>
                }
              >
                <SettingsRow
                  label={t("system.inboxChannels.field.channelKey")}
                  htmlFor="inbox-channel-key"
                  control={
                    <input
                      id="inbox-channel-key"
                      value={channelKeyDraft}
                      onChange={(event) => setChannelKeyDraft(event.target.value)}
                      onBlur={() => renameChannel(selectedKey, channelKeyDraft)}
                      spellCheck={false}
                    />
                  }
                />
                <SettingsRow
                  label={t("system.inboxChannels.field.provider")}
                  htmlFor="inbox-channel-provider"
                  control={
                    <input
                      id="inbox-channel-provider"
                      value={selectedChannel.provider}
                      onChange={(event) =>
                        updateChannel(selectedKey, { provider: event.target.value })
                      }
                      spellCheck={false}
                    />
                  }
                />
                <SettingsRow
                  label={t("system.inboxChannels.field.skill")}
                  htmlFor="inbox-channel-skill"
                  control={
                    <input
                      id="inbox-channel-skill"
                      value={selectedChannel.skill ?? ""}
                      onChange={(event) =>
                        updateChannel(selectedKey, { skill: event.target.value.trim() || null })
                      }
                      spellCheck={false}
                    />
                  }
                />
                <SettingsRow
                  label={t("system.inboxChannels.field.kind")}
                  htmlFor="inbox-channel-kind"
                  control={
                    <input
                      id="inbox-channel-kind"
                      value={selectedChannel.kind}
                      onChange={(event) =>
                        updateChannel(selectedKey, { kind: event.target.value })
                      }
                      spellCheck={false}
                    />
                  }
                />
                <SettingsRow
                  label={t("system.inboxChannels.field.dedupe")}
                  htmlFor="inbox-channel-dedupe"
                  control={
                    <input
                      id="inbox-channel-dedupe"
                      value={selectedChannel.dedupe}
                      onChange={(event) =>
                        updateChannel(selectedKey, { dedupe: event.target.value })
                      }
                      spellCheck={false}
                    />
                  }
                />
                <SettingsRow
                  label={t("system.inboxChannels.field.dropPaths")}
                  htmlFor="inbox-channel-drop-paths"
                  wide
                  control={
                    <textarea
                      id="inbox-channel-drop-paths"
                      className="settings-textarea"
                      value={formatStringList(selectedChannel.drop_paths)}
                      onChange={(event) =>
                        updateChannel(selectedKey, {
                          drop_paths: parseStringList(event.target.value),
                        })
                      }
                      spellCheck={false}
                      rows={4}
                    />
                  }
                />
                <SettingsRow
                  label={t("system.inboxChannels.field.sourceKindMapping")}
                  htmlFor="inbox-channel-source-kinds"
                  wide
                  control={
                    <textarea
                      id="inbox-channel-source-kinds"
                      className="settings-textarea"
                      value={formatStringMap(selectedChannel.source_kinds)}
                      onChange={(event) =>
                        updateChannel(selectedKey, {
                          source_kinds: parseStringMap(event.target.value),
                        })
                      }
                      spellCheck={false}
                      rows={5}
                    />
                  }
                />
              </SettingsSection>
            </div>
          ) : (
            <div className="inbox-empty">{t("system.inboxChannels.channel.none")}</div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("system.inboxChannels.scan.title")}
        description={t("system.inboxChannels.scan.subtitle")}
      >
        <SettingsRow
          label={t("system.inboxChannels.scan.includeDotFolders")}
          description={t("system.inboxChannels.scan.help")}
          htmlFor="inbox-scan-dot-folders"
          wide
          control={
            <textarea
              id="inbox-scan-dot-folders"
              className="settings-textarea"
              value={dotIncludesText}
              onChange={(event) => setDotIncludesText(event.target.value)}
              onBlur={() => updateDotFolderIncludes(dotIncludesText)}
              spellCheck={false}
              rows={4}
              placeholder={"inbox/drop/kakao/.omc\n.github"}
            />
          }
        />
      </SettingsSection>

      {status ? <div className="toast">{status}</div> : null}
      {error ? (
        <div className="toast" title={error}>
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

function cloneChannel(channel: InboxChannelConfig): InboxChannelConfig {
  return JSON.parse(JSON.stringify(channel)) as InboxChannelConfig;
}

function uniqueChannelKey(config: InboxRuntimeConfig, base: string): string {
  let key = base.replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!key) key = "channel";
  if (!config.channels[key]) return key;
  let index = 2;
  while (config.channels[`${key}-${index}`]) index += 1;
  return `${key}-${index}`;
}

function formatStringList(values: string[]): string {
  return values.join("\n");
}

function parseStringList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatStringMap(value: Record<string, string> = {}): string {
  return Object.entries(value)
    .map(([key, item]) => `${key}=${item}`)
    .join("\n");
}

function parseStringMap(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.includes("=") ? "=" : ":";
    const [rawKey, ...rest] = line.split(separator);
    const key = rawKey.trim();
    const item = rest.join(separator).trim();
    if (key && item) out[key] = item;
  }
  return out;
}
