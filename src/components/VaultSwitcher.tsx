import { Check, ChevronDown, FolderOpen, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../lib/i18n";
import type { VaultList } from "../lib/types";

interface VaultSwitcherProps {
  vaultList: VaultList;
  activeVaultPath: string | null;
  onSelectVault: (path: string) => void;
  onAddVault: () => void;
  onRemoveVault: (path: string) => void;
  onUseSample: () => void;
}

export function VaultSwitcher({
  vaultList,
  activeVaultPath,
  onSelectVault,
  onAddVault,
  onRemoveVault,
  onUseSample,
}: VaultSwitcherProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const active = vaultList.vaults.find((v) => v.path === activeVaultPath);

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
        className="vault-switcher"
        onClick={() => setOpen((v) => !v)}
        title={active?.path ?? ""}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="vs-dot" aria-hidden />
        {active ? (
          <span className="vs-label">{active.label}</span>
        ) : (
          <span className="vs-label vs-empty">{t("vault.switcher.empty")}</span>
        )}
        <ChevronDown size={13} style={{ opacity: 0.55 }} />
      </button>

      {open ? (
        <div className="vault-menu" role="menu">
          {vaultList.vaults.length === 0 ? (
            <div style={{ padding: "12px 14px", color: "var(--faint)", fontSize: 12 }}>
              {t("vault.switcher.none")}
            </div>
          ) : (
            vaultList.vaults.map((vault) => (
              <div
                key={vault.path}
                className={vault.path === activeVaultPath ? "vault-menu-item active" : "vault-menu-item"}
                onClick={() => {
                  onSelectVault(vault.path);
                  setOpen(false);
                }}
                role="menuitem"
              >
                {vault.path === activeVaultPath ? (
                  <Check size={14} />
                ) : (
                  <FolderOpen size={14} style={{ opacity: 0.6 }} />
                )}
                <div style={{ minWidth: 0 }}>
                  <strong>{vault.label}</strong>
                  <span title={vault.path}>{vault.path}</span>
                </div>
                <button
                  type="button"
                  className="vault-menu-remove"
                  title={t("vault.remove")}
                  aria-label={t("vault.remove.label", { label: vault.label })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveVault(vault.path);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}

          <div className="vault-menu-divider" />

          <div
            className="vault-menu-action"
            onClick={() => {
              onAddVault();
              setOpen(false);
            }}
            role="menuitem"
          >
            <Plus size={14} />
            <span>{t("vault.add")}</span>
          </div>
          <div
            className="vault-menu-action"
            onClick={() => {
              onUseSample();
              setOpen(false);
            }}
            role="menuitem"
          >
            <FolderOpen size={14} />
            <span>{t("vault.useSample")}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
