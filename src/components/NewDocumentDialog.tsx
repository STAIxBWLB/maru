import * as Dialog from "@radix-ui/react-dialog";
import { FilePlus2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/Button";
import { Field, TextArea, TextInput } from "./ui/Field";

interface NewDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (title: string, docType: string, body: string) => Promise<void>;
}

const docTypes = ["Document", "Meeting", "Project", "Task", "Template", "Reference"];

export function NewDocumentDialog({ open, onOpenChange, onCreate }: NewDocumentDialogProps) {
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("Document");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError(null);
    if (!title.trim()) {
      setError("제목을 입력하세요.");
      return;
    }
    setSaving(true);
    try {
      await onCreate(title.trim(), docType, body.trim());
      setTitle("");
      setDocType("Document");
      setBody("");
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <div className="dialog-header">
            <div>
              <Dialog.Title>새 Anchor 문서</Dialog.Title>
              <Dialog.Description>볼트 루트에 표준 frontmatter가 포함된 Markdown 문서를 만듭니다.</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" title="닫기">
              <X size={16} />
            </Dialog.Close>
          </div>

          <Field label="제목" error={error ?? undefined}>
            <TextInput value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 2분기 운영위원회 보고" />
          </Field>

          <Field label="타입">
            <div className="select-row">
              {docTypes.map((type) => (
                <button
                  key={type}
                  className={docType === type ? "chip active" : "chip"}
                  onClick={() => setDocType(type)}
                  type="button"
                >
                  {type}
                </button>
              ))}
            </div>
          </Field>

          <Field label="초기 본문" helper="비워두면 제목만 포함된 문서가 생성됩니다.">
            <TextArea rows={7} value={body} onChange={(event) => setBody(event.target.value)} />
          </Field>

          <div className="dialog-actions">
            <Dialog.Close asChild>
              <Button variant="ghost">취소</Button>
            </Dialog.Close>
            <Button variant="primary" onClick={submit} disabled={saving} icon={<FilePlus2 size={15} />}>
              {saving ? "생성 중" : "생성"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
