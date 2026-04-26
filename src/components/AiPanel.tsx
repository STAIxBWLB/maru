import { BrainCircuit, FileBarChart, FilePenLine, ListChecks, MessageSquareText, Table2 } from "lucide-react";
import type { AiDraft, DocumentMode, DocumentPayload } from "../lib/types";
import { Button } from "./ui/Button";
import { Field, TextArea } from "./ui/Field";

interface AiPanelProps {
  open: boolean;
  document: DocumentPayload | null;
  instruction: string;
  mode: DocumentMode;
  loading: boolean;
  lastDraft: AiDraft | null;
  error: string | null;
  onInstructionChange: (value: string) => void;
  onModeChange: (mode: DocumentMode) => void;
  onGenerate: () => void;
  onApplyDraft: () => void;
  onClose: () => void;
}

const modes: Array<{ value: DocumentMode; label: string; icon: typeof FilePenLine }> = [
  { value: "edit", label: "수정", icon: FilePenLine },
  { value: "summary", label: "요약", icon: MessageSquareText },
  { value: "report", label: "보고서", icon: FileBarChart },
  { value: "minutes", label: "회의록", icon: ListChecks },
  { value: "kpi", label: "KPI", icon: Table2 },
  { value: "budget", label: "예산", icon: FileBarChart },
];

export function AiPanel({
  open,
  document,
  instruction,
  mode,
  loading,
  lastDraft,
  error,
  onInstructionChange,
  onModeChange,
  onGenerate,
  onApplyDraft,
  onClose,
}: AiPanelProps) {
  return (
    <aside className={open ? "ai-panel open" : "ai-panel"}>
      <div className="ai-header">
        <div>
          <span className="eyebrow">Anchor Writer</span>
          <h2>AI 초안</h2>
        </div>
        <button className="icon-button" title="AI 패널 닫기" onClick={onClose}>
          <BrainCircuit size={16} />
        </button>
      </div>

      <div className="mode-grid" role="group" aria-label="AI 작업 모드">
        {modes.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.value}
              className={mode === item.value ? "mode-button active" : "mode-button"}
              onClick={() => onModeChange(item.value)}
            >
              <Icon size={15} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      <Field label="요청" helper="선택 문서와 Anchor 용어 규칙을 기준으로 로컬 초안을 만듭니다.">
        <TextArea
          rows={6}
          value={instruction}
          onChange={(event) => onInstructionChange(event.target.value)}
          placeholder="예: 2분기 운영위원회 보고용으로 개조식 보고서 초안 작성"
        />
      </Field>

      {error ? <p className="inline-error">{error}</p> : null}

      <Button variant="primary" disabled={!document || loading} onClick={onGenerate} icon={<BrainCircuit size={15} />}>
        {loading ? "초안 생성 중" : "초안 생성"}
      </Button>

      <div className="context-box">
        <span className="eyebrow">적용 컨텍스트</span>
        <ul>
          <li>Cheju Halla University 표기 고정</li>
          <li>RISE Project / Anchor Project 병기</li>
          <li>개조식 보고서 문체</li>
          <li>KPI, 예산 과목, 회의록 표준 구조</li>
        </ul>
      </div>

      {loading ? (
        <div className="ai-skeleton">
          <span />
          <span />
          <span />
        </div>
      ) : null}

      {lastDraft ? (
        <div className="draft-card">
          <span className="eyebrow">{lastDraft.provider}</span>
          <strong>{lastDraft.summary}</strong>
          <pre>{lastDraft.content.slice(0, 1200)}</pre>
          <Button variant="secondary" onClick={onApplyDraft} icon={<FilePenLine size={15} />}>
            에디터에 적용
          </Button>
        </div>
      ) : null}
    </aside>
  );
}
