import { FileText, FolderOpen, Plus, Settings, Trash2 } from "lucide-react";
import { Button } from "./ui/Button";
import { useTranslation } from "../lib/i18n";
import type { VaultList } from "../lib/types";

interface SidebarProps {
  vaultList: VaultList;
  activeVaultPath: string | null;
  onSelectVault: (path: string) => void;
  onAddVault: () => void;
  onRemoveVault: (path: string) => void;
  onUseSample: () => void;
  onNewDocument: () => void;
}

export function Sidebar({
  vaultList,
  activeVaultPath,
  onSelectVault,
  onAddVault,
  onRemoveVault,
  onUseSample,
  onNewDocument,
}: SidebarProps) {
  const { t } = useTranslation();
  const activeVault = vaultList.vaults.find((v) => v.path === activeVaultPath);

  return (
    <aside className="sidebar">
      <div className="brand-block">
        <div className="brand-mark" aria-hidden="true">
          A
        </div>
        <div>
          <h1>{t("app.title")}</h1>
          <p>{t("app.subtitle.work")}</p>
        </div>
      </div>

      <div className="vault-box">
        <span className="eyebrow">{t("vault.current")}</span>
        <p title={activeVault?.path ?? ""}>
          {activeVault ? activeVault.label : t("vault.empty.title")}
        </p>
        {activeVault?.externalWriter ? (
          <span className="status-pill status-info">
            ✎ {activeVault.externalWriter}
          </span>
        ) : null}
        <div className="vault-actions">
          <Button
            size="sm"
            variant="secondary"
            onClick={onAddVault}
            icon={<Plus size={14} />}
          >
            {t("vault.add")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onUseSample}>
            {t("vault.useSample")}
          </Button>
        </div>
      </div>

      <Button variant="primary" onClick={onNewDocument} icon={<FileText size={15} />}>
        {t("newDoc.button")}
      </Button>

      {vaultList.vaults.length > 0 ? (
        <nav className="type-nav" aria-label="vaults">
          {vaultList.vaults.map((vault) => (
            <div
              key={vault.path}
              className={
                vault.path === activeVaultPath ? "type-row active vault-row" : "type-row vault-row"
              }
            >
              <button
                className="vault-row-pick"
                onClick={() => onSelectVault(vault.path)}
                title={vault.path}
              >
                <FolderOpen size={16} />
                <span>{vault.label}</span>
              </button>
              <button
                className="vault-row-remove"
                onClick={() => onRemoveVault(vault.path)}
                title={vault.path}
                aria-label={`remove ${vault.label}`}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </nav>
      ) : null}

      <div className="sidebar-footer">
        <Settings size={15} />
        <span>{t("footer.tagline")}</span>
      </div>
    </aside>
  );
}
