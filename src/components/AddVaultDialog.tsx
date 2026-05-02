import * as Dialog from "@radix-ui/react-dialog";
import { FolderOpen, FolderPlus, Link2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/Button";
import { Field, TextInput } from "./ui/Field";
import { chooseVaultDirectory } from "../lib/api";
import { detectWorkspace } from "../lib/anchorDir";
import { useTranslation } from "../lib/i18n";
import type { WorkspaceDetect } from "../lib/types";

interface AddVaultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (label: string, path: string, externalWriter: string | null) => Promise<void>;
  /** Called when the user opts to register a paired workspace (the
   *  picked folder contains `workspace.config.yaml`). The handler is
   *  responsible for invoking `registerWorkspacePair` and refreshing
   *  the active vault. */
  onRegisterWorkspace: (workPath: string) => Promise<void>;
}

type WriterChoice = "none" | "obsidian";

export function AddVaultDialog({
  open,
  onOpenChange,
  onAdd,
  onRegisterWorkspace,
}: AddVaultDialogProps) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  const [path, setPath] = useState("");
  const [writer, setWriter] = useState<WriterChoice>("none");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [detected, setDetected] = useState<WorkspaceDetect | null>(null);
  const detectSeqRef = useRef(0);

  // Reset on close so a re-open starts clean.
  useEffect(() => {
    if (!open) {
      setLabel("");
      setPath("");
      setWriter("none");
      setError(null);
      setSaving(false);
      setDetected(null);
    }
  }, [open]);

  // Detect workspace.config.yaml whenever the path changes (typed or picked).
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
        if (seq === detectSeqRef.current) {
          setDetected(result);
        }
      } catch {
        if (seq === detectSeqRef.current) {
          setDetected(null);
        }
      }
    })();
  }, [path]);

  async function pickFolder() {
    setError(null);
    try {
      const selected = await chooseVaultDirectory(t("vault.dialog.title"));
      if (selected) {
        setPath(selected);
        if (!label.trim()) {
          const segments = selected.split(/[/\\]/);
          const tail = segments[segments.length - 1] || segments[segments.length - 2] || "vault";
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
      setError(t("vault.dialog.error.label"));
      return;
    }
    if (!path.trim()) {
      setError(t("vault.dialog.error.path"));
      return;
    }
    setSaving(true);
    try {
      const ext = writer === "obsidian" ? "mcp-obsidian" : null;
      await onAdd(label.trim(), path.trim(), ext);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function registerPair() {
    setError(null);
    if (!path.trim()) {
      setError(t("vault.dialog.error.path"));
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
  const vaultPath = detected?.resolvedVaultPath ?? null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <div className="dialog-header">
            <div>
              <Dialog.Title>{t("vault.dialog.title")}</Dialog.Title>
              <Dialog.Description>{t("vault.dialog.description")}</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" title={t("app.errorClose")}>
              <X size={16} />
            </Dialog.Close>
          </div>

          <Field label={t("vault.dialog.path")} error={error ?? undefined}>
            <div className="select-row">
              <TextInput
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/Users/.../vault"
              />
              <Button variant="secondary" onClick={pickFolder} icon={<FolderOpen size={14} />}>
                {t("vault.dialog.pickPath")}
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
                  <span className="muted">{t("workspace.pair.work")}</span>
                  <span>{detected.workPath}</span>
                </div>
                {vaultPath ? (
                  <div>
                    <span className="muted">{t("workspace.pair.vault")}</span>
                    <span>
                      {vaultPath}
                      {!detected.resolvedVaultExists ? (
                        <em className="warn"> · {t("workspace.pair.vault.missing")}</em>
                      ) : null}
                    </span>
                  </div>
                ) : (
                  <div>
                    <span className="muted">{t("workspace.pair.vault")}</span>
                    <em className="warn">{t("workspace.pair.vault.unset")}</em>
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
                  onClick={registerPair}
                  disabled={saving}
                  icon={<FolderPlus size={15} />}
                >
                  {t("workspace.detect.register")}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <Field label={t("vault.dialog.label")}>
                <TextInput
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="e.g. Work, Knowledge Vault"
                />
              </Field>

              <Field
                label={t("vault.dialog.externalWriter")}
                helper={t("vault.dialog.externalWriter.help")}
              >
                <div className="select-row">
                  <button
                    type="button"
                    className={writer === "none" ? "chip active" : "chip"}
                    onClick={() => setWriter("none")}
                  >
                    {t("vault.dialog.externalWriter.none")}
                  </button>
                  <button
                    type="button"
                    className={writer === "obsidian" ? "chip active" : "chip"}
                    onClick={() => setWriter("obsidian")}
                  >
                    {t("vault.dialog.externalWriter.obsidian")}
                  </button>
                </div>
              </Field>

              <div className="dialog-actions">
                <Dialog.Close asChild>
                  <Button variant="ghost">{t("vault.dialog.cancel")}</Button>
                </Dialog.Close>
                <Button
                  variant="primary"
                  onClick={submit}
                  disabled={saving}
                  icon={<FolderPlus size={15} />}
                >
                  {t("vault.dialog.confirm")}
                </Button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
