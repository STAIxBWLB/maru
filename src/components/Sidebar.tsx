import {
  Archive,
  BookOpenText,
  FileClock,
  FileText,
  FolderOpen,
  LibraryBig,
  Settings,
  UsersRound,
} from "lucide-react";
import { Button } from "./ui/Button";
import type { VaultEntry } from "../lib/types";
import { docTypeLabel } from "../lib/document";

interface SidebarProps {
  vaultPath: string;
  entries: VaultEntry[];
  activeType: string;
  onTypeChange: (type: string) => void;
  onChooseVault: () => void;
  onUseSample: () => void;
  onNewDocument: () => void;
}

const typeIcons: Record<string, typeof FileText> = {
  All: LibraryBig,
  Document: FileText,
  Meeting: FileClock,
  Project: Archive,
  Person: UsersRound,
  Template: BookOpenText,
  Reference: FolderOpen,
};

export function Sidebar({
  vaultPath,
  entries,
  activeType,
  onTypeChange,
  onChooseVault,
  onUseSample,
  onNewDocument,
}: SidebarProps) {
  const types = ["All", ...Array.from(new Set(entries.map((entry) => entry.docType))).sort()];
  const counts = entries.reduce<Record<string, number>>(
    (acc, entry) => {
      acc.All += 1;
      acc[entry.docType] = (acc[entry.docType] ?? 0) + 1;
      return acc;
    },
    { All: 0 },
  );

  return (
    <aside className="sidebar">
      <div className="brand-block">
        <div className="brand-mark" aria-hidden="true">
          A
        </div>
        <div>
          <h1>Anchor</h1>
          <p>RISE 문서 볼트</p>
        </div>
      </div>

      <div className="vault-box">
        <span className="eyebrow">현재 볼트</span>
        <p title={vaultPath}>{vaultPath}</p>
        <div className="vault-actions">
          <Button size="sm" variant="secondary" onClick={onChooseVault} icon={<FolderOpen size={14} />}>
            선택
          </Button>
          <Button size="sm" variant="ghost" onClick={onUseSample}>
            샘플
          </Button>
        </div>
      </div>

      <Button variant="primary" onClick={onNewDocument} icon={<FileText size={15} />}>
        새 문서
      </Button>

      <nav className="type-nav" aria-label="문서 타입">
        {types.map((type) => {
          const Icon = typeIcons[type] ?? FileText;
          return (
            <button
              key={type}
              className={activeType === type ? "type-row active" : "type-row"}
              onClick={() => onTypeChange(type)}
            >
              <Icon size={16} />
              <span>{type === "All" ? "전체" : docTypeLabel(type)}</span>
              <strong>{counts[type] ?? 0}</strong>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <Settings size={15} />
        <span>로컬 우선 · 파일 원천 · 버전 보존</span>
      </div>
    </aside>
  );
}
