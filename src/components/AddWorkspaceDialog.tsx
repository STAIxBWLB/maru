import * as Dialog from "@radix-ui/react-dialog";
import { FolderOpen, FolderPlus, Link2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { chooseWorkspaceDirectory } from "../lib/api";
import { detectWorkspace } from "../lib/anchorDir";
import { useTranslation } from "../lib/i18n";
import type {
  WorkspaceDetect,
  WorkspaceExternalWriter,
  WorkspaceProvider,
  WorkspaceRootEntry,
  WorkspaceVisibility,
  WorkspaceWritePolicy,
} from "../lib/types";
import { manualPermissionSummary, providerLabel } from "../lib/workspaceCapabilities";
import { Button } from "./ui/Button";
import { Field, TextInput } from "./ui/Field";

interface AddWorkspaceDialogProps {
  open: boolean;
  defaultVisibility: WorkspaceVisibility;
  onOpenChange: (open: boolean) => void;
  onAdd: (entry: WorkspaceRootEntry) => Promise<void>;
  onRegisterWorkspace: (workPath: string) => Promise<void>;
}

const PROVIDERS: WorkspaceProvider[] = [
  "local",
  "googleDrive",
  "oneDrive",
  "sharePoint",
  "nextcloud",
  "obsidian",
];

function externalWriterForProvider(
  provider: WorkspaceProvider,
  writePolicy: WorkspaceWritePolicy,
): WorkspaceExternalWriter | null {
  if (provider === "obsidian") return "mcp-obsidian";
  if (writePolicy !== "delegated") return null;
  switch (provider) {
    case "googleDrive":
      return "gdrive";
    case "oneDrive":
      return "onedrive";
    case "sharePoint":
      return "sharepoint";
    case "nextcloud":
      return "nextcloud";
    default:
      return null;
  }
}

export function AddWorkspaceDialog({
  open,
  defaultVisibility,
  onOpenChange,
  onAdd,
  onRegisterWorkspace,
}: AddWorkspaceDialogProps) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  const [path, setPath] = useState("");
  const [visibility, setVisibility] = useState<WorkspaceVisibility>(defaultVisibility);
  const [provider, setProvider] = useState<WorkspaceProvider>("local");
  const [providerId, setProviderId] = useState("");
  const [writePolicy, setWritePolicy] = useState<WorkspaceWritePolicy>("direct");
  const [role, setRole] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [detected, setDetected] = useState<WorkspaceDetect | null>(null);
  const detectSeqRef = useRef(0);

  useEffect(() => {
    if (open) setVisibility(defaultVisibility);
  }, [defaultVisibility, open]);

  useEffect(() => {
    if (!open) {
      setLabel("");
      setPath("");
      setVisibility(defaultVisibility);
      setProvider("local");
      setProviderId("");
      setWritePolicy("direct");
      setRole("");
      setError(null);
      setSaving(false);
      setDetected(null);
    }
  }, [defaultVisibility, open]);

  useEffect(() => {
    if (!open) return;
    if (provider === "obsidian") {
      setWritePolicy("delegated");
    }
  }, [open, provider]);

  useEffect(() => {
    const trimmed = path.trim();
    if (!trimmed) {
      setDetected(null);
      return;
    }
    const seq = ++detectSeqRef.current;
    void (async () => {
      try {
        const result = await detectWorkspace(trimmed);
        if (seq === detectSeqRef.current) setDetected(result);
      } catch {
        if (seq === detectSeqRef.current) setDetected(null);
      }
    })();
  }, [path]);

  async function pickFolder() {
    setError(null);
    try {
      const selected = await chooseWorkspaceDirectory(t("workspace.dialog.title"));
      if (selected) {
        setPath(selected);
        if (!label.trim()) {
          const segments = selected.split(/[/\\]/);
          const tail =
            segments[segments.length - 1] || segments[segments.length - 2] || "workspace";
          setLabel(tail);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submit() {
    setError(null);
    if (!label.trim()) {
      setError(t("workspace.dialog.error.label"));
      return;
    }
    if (!path.trim()) {
      setError(t("workspace.dialog.error.path"));
      return;
    }
    setSaving(true);
    try {
      const trimmedRole = role.trim();
      await onAdd({
        label: label.trim(),
        path: path.trim(),
        visibility,
        provider,
        providerId: providerId.trim() || null,
        externalWriter: externalWriterForProvider(provider, writePolicy),
        writePolicy: provider === "obsidian" ? "delegated" : writePolicy,
        permissionSummary: trimmedRole ? manualPermissionSummary(trimmedRole) : null,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function registerWorkspaceConfig() {
    setError(null);
    if (!path.trim()) {
      setError(t("workspace.dialog.error.path"));
      return;
    }
    setSaving(true);
    try {
      await onRegisterWorkspace(path.trim());
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const ownerName = detected?.config.owner?.name ?? null;
  const privatePath = detected?.resolvedPrivatePath ?? null;
  const publicWorkspaces = detected?.publicWorkspaces ?? [];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <div className="dialog-header">
            <div>
              <Dialog.Title>{t("workspace.dialog.title")}</Dialog.Title>
              <Dialog.Description>{t("workspace.dialog.description")}</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" title={t("app.errorClose")}>
              <X size={16} />
            </Dialog.Close>
          </div>

          <Field label={t("workspace.dialog.path")} error={error ?? undefined}>
            <div className="select-row">
              <TextInput
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/Users/.../workspace"
              />
              <Button variant="secondary" onClick={pickFolder} icon={<FolderOpen size={14} />}>
                {t("workspace.dialog.pickPath")}
              </Button>
            </div>
          </Field>

          {detected ? (
            <div className="workspace-detect-card">
              <div className="workspace-detect-title">
                <Link2 size={14} />
                <strong>{t("workspace.detected")}</strong>
              </div>
              <div className="workspace-detect-meta">
                {ownerName ? (
                  <div>
                    <span className="muted">{t("workspace.owner")}</span>
                    <span>{ownerName}</span>
                  </div>
                ) : null}
                <div>
                  <span className="muted">{t("workspace.visibility.private")}</span>
                  <span>
                    {privatePath}
                    {!detected.resolvedPrivateExists ? (
                      <em className="warn"> · {t("workspace.path.missing")}</em>
                    ) : null}
                  </span>
                </div>
                {publicWorkspaces.length > 0 ? (
                  publicWorkspaces.map((workspace) => (
                    <div key={workspace.path}>
                      <span className="muted">
                        {t("workspace.visibility.public")} · {providerLabel(workspace.provider)}
                      </span>
                      <span>
                        {workspace.label}: {workspace.path}
                        {!workspace.exists ? (
                          <em className="warn"> · {t("workspace.path.missing")}</em>
                        ) : null}
                      </span>
                    </div>
                  ))
                ) : (
                  <div>
                    <span className="muted">{t("workspace.visibility.public")}</span>
                    <em>{t("workspace.public.optional")}</em>
                  </div>
                )}
              </div>
              <p className="workspace-detect-hint">{t("workspace.detect.hint")}</p>
              <div className="dialog-actions">
                <Button variant="ghost" onClick={() => setDetected(null)}>
                  {t("workspace.detect.useStandalone")}
                </Button>
                <Button
                  variant="primary"
                  onClick={registerWorkspaceConfig}
                  disabled={saving}
                  icon={<FolderPlus size={15} />}
                >
                  {t("workspace.detect.register")}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <Field label={t("workspace.dialog.visibility")}>
                <div className="select-row">
                  <button
                    type="button"
                    className={visibility === "private" ? "chip active" : "chip"}
                    onClick={() => setVisibility("private")}
                  >
                    {t("workspace.visibility.private")}
                  </button>
                  <button
                    type="button"
                    className={visibility === "public" ? "chip active" : "chip"}
                    onClick={() => setVisibility("public")}
                  >
                    {t("workspace.visibility.public")}
                  </button>
                </div>
              </Field>

              <Field label={t("workspace.dialog.label")}>
                <TextInput
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="e.g. Work, Public Notes"
                />
              </Field>

              <Field
                label={t("workspace.dialog.provider")}
                helper={t("workspace.dialog.provider.help")}
              >
                <div className="select-row">
                  {PROVIDERS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={provider === item ? "chip active" : "chip"}
                      onClick={() => setProvider(item)}
                    >
                      {providerLabel(item)}
                    </button>
                  ))}
                </div>
              </Field>

              <div className="field-grid two">
                <Field
                  label={t("workspace.dialog.writePolicy")}
                  helper={t("workspace.dialog.writePolicy.help")}
                >
                  <div className="select-row">
                    <button
                      type="button"
                      className={writePolicy === "direct" ? "chip active" : "chip"}
                      onClick={() => setWritePolicy("direct")}
                      disabled={provider === "obsidian"}
                    >
                      {t("workspace.writePolicy.direct")}
                    </button>
                    <button
                      type="button"
                      className={writePolicy === "delegated" ? "chip active" : "chip"}
                      onClick={() => setWritePolicy("delegated")}
                    >
                      {t("workspace.writePolicy.delegated")}
                    </button>
                    <button
                      type="button"
                      className={writePolicy === "readOnly" ? "chip active" : "chip"}
                      onClick={() => setWritePolicy("readOnly")}
                      disabled={provider === "obsidian"}
                    >
                      {t("workspace.writePolicy.readOnly")}
                    </button>
                  </div>
                </Field>

                <Field
                  label={t("workspace.dialog.providerId")}
                  helper={t("workspace.dialog.providerId.help")}
                >
                  <TextInput
                    value={providerId}
                    onChange={(event) => setProviderId(event.target.value)}
                    placeholder={t("workspace.dialog.providerId.placeholder")}
                  />
                </Field>
              </div>

              {visibility === "public" ? (
                <Field
                  label={t("workspace.dialog.role")}
                  helper={t("workspace.dialog.role.help")}
                >
                  <TextInput
                    value={role}
                    onChange={(event) => setRole(event.target.value)}
                    placeholder={t("workspace.dialog.role.placeholder")}
                  />
                </Field>
              ) : null}

              <div className="dialog-actions">
                <Dialog.Close asChild>
                  <Button variant="ghost">{t("workspace.dialog.cancel")}</Button>
                </Dialog.Close>
                <Button
                  variant="primary"
                  onClick={submit}
                  disabled={saving}
                  icon={<FolderPlus size={15} />}
                >
                  {t("workspace.dialog.confirm")}
                </Button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
