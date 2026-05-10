import * as Dialog from "@radix-ui/react-dialog";
import { ShieldAlert, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { prepareApproval, recordApproval } from "../lib/api";
import type { ApprovalRequest } from "../lib/types";
import { Button } from "../components/ui/Button";

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (approvalId: string | null) => void;
}

export interface ApprovalInput {
  kind: string;
  summary: string;
  target?: string | null;
  payloadPreview?: string | null;
}

export function useApprovalGate() {
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [rememberKind, setRememberKind] = useState(false);

  const confirmApproval = useCallback(async (input: ApprovalInput): Promise<string | null> => {
    const request = await prepareApproval(input);
    if (request.autoApproved) return request.id;
    return await new Promise<string | null>((resolve) => {
      setRememberKind(false);
      setPending({ request, resolve });
    });
  }, []);

  const close = useCallback(
    async (approved: boolean) => {
      if (!pending) return;
      const { request, resolve } = pending;
      setPending(null);
      try {
        await recordApproval(request.id, approved ? "approved" : "rejected", approved && rememberKind);
        resolve(approved ? request.id : null);
      } catch {
        resolve(null);
      }
    },
    [pending, rememberKind],
  );

  const dialog = useMemo(
    () => (
      <ApprovalDialog
        pending={pending}
        rememberKind={rememberKind}
        onRememberKind={setRememberKind}
        onApprove={() => void close(true)}
        onCancel={() => void close(false)}
      />
    ),
    [close, pending, rememberKind],
  );

  return { confirmApproval, dialog };
}

function ApprovalDialog({
  pending,
  rememberKind,
  onRememberKind,
  onApprove,
  onCancel,
}: {
  pending: PendingApproval | null;
  rememberKind: boolean;
  onRememberKind: (value: boolean) => void;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const request = pending?.request ?? null;
  return (
    <Dialog.Root
      open={Boolean(request)}
      onOpenChange={(open) => {
        if (!open && request) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content approval-dialog">
          <div className="dialog-header">
            <Dialog.Title className="approval-title">
              <ShieldAlert size={17} />
              승인 필요
            </Dialog.Title>
            <button
              type="button"
              className="icon-button"
              aria-label="닫기"
              title="닫기"
              onClick={onCancel}
            >
              <X size={14} />
            </button>
          </div>

          {request ? (
            <div className="approval-body">
              <p>{request.summary}</p>
              {request.target ? (
                <div className="approval-target">
                  <span>Target</span>
                  <code>{request.target}</code>
                </div>
              ) : null}
              {request.payloadPreview ? (
                <pre className="approval-preview">{request.payloadPreview}</pre>
              ) : null}
              <label className="approval-remember">
                <input
                  type="checkbox"
                  checked={rememberKind}
                  onChange={(event) => onRememberKind(event.currentTarget.checked)}
                />
                <span>이번 세션 동안 같은 종류의 동작은 다시 묻지 않기</span>
              </label>
            </div>
          ) : null}

          <div className="dialog-actions">
            <Button type="button" variant="ghost" onClick={onCancel}>
              취소
            </Button>
            <Button type="button" onClick={onApprove}>
              승인
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
