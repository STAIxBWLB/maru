import { RefreshCcw, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalInput } from "../../approval/ApprovalDialog";
import {
  enqueueKakaoSend,
  readKakaoRelayMessages,
  readKakaoSendResults,
} from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
import {
  envelopePreview,
  type KakaoRelayEnvelope,
  type KakaoRelayStatus,
} from "../../lib/kakaoRelay";

const MESSAGE_LIMIT = 50;
const SEND_POLL_INTERVAL_MS = 5000;
const SEND_POLL_ATTEMPTS = 12;

interface KakaoRelayPanelProps {
  status: KakaoRelayStatus | null;
  workPath: string | null;
  onConfirmApproval: (input: ApprovalInput) => Promise<string | null>;
}

type SendState = "idle" | "sending" | "queued" | "sent" | "failed";

export function KakaoRelayPanel({
  status,
  workPath,
  onConfirmApproval,
}: KakaoRelayPanelProps) {
  const { t } = useTranslation();
  const rooms = useMemo(
    () => status?.rooms.filter((room) => room.managed) ?? [],
    [status],
  );
  const sendRooms = useMemo(
    () => status?.rooms.filter((room) => room.sendAllowed) ?? [],
    [status],
  );

  const [viewerRoom, setViewerRoom] = useState("");
  const [messages, setMessages] = useState<KakaoRelayEnvelope[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const effectiveViewerRoom = viewerRoom || rooms[0]?.slug || "";

  const loadMessages = useCallback(async () => {
    if (!workPath || !effectiveViewerRoom) {
      setMessages([]);
      return;
    }
    setMessagesLoading(true);
    setMessagesError(null);
    try {
      const items = await readKakaoRelayMessages(workPath, effectiveViewerRoom, MESSAGE_LIMIT);
      setMessages(items);
    } catch (err) {
      setMessagesError(err instanceof Error ? err.message : String(err));
    } finally {
      setMessagesLoading(false);
    }
  }, [effectiveViewerRoom, workPath]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  const [composerRoom, setComposerRoom] = useState("");
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState("");
  const [sendState, setSendState] = useState<SendState>("idle");
  const [sendError, setSendError] = useState<string | null>(null);
  const pollSeqRef = useRef(0);
  // Cancel any in-flight send-result polling on unmount.
  useEffect(
    () => () => {
      pollSeqRef.current += 1;
    },
    [],
  );

  const effectiveComposerRoom = composerRoom || sendRooms[0]?.slug || "";

  const pollSendResult = useCallback(
    async (id: string, seq: number) => {
      if (!workPath) return;
      for (let attempt = 0; attempt < SEND_POLL_ATTEMPTS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, SEND_POLL_INTERVAL_MS));
        if (pollSeqRef.current !== seq) return;
        try {
          const results = await readKakaoSendResults(workPath, [id]);
          const result = results.find((entry) => entry.id === id);
          if (result && result.status === "done") {
            if (result.ok) {
              setSendState("sent");
            } else {
              setSendState("failed");
              setSendError(result.error);
            }
            return;
          }
        } catch {
          // A transient read failure should not abort the polling loop.
        }
      }
    },
    [workPath],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    // The relay re-resolves `chat` by exact KakaoTalk display name (AX sends
    // target a room by name), so always enqueue the room name, not the slug.
    const chatName =
      sendRooms.find((room) => room.slug === effectiveComposerRoom)?.name ??
      effectiveComposerRoom;
    if (!workPath || !chatName || !text || sendState === "sending") return;
    setSendState("sending");
    setSendError(null);
    try {
      const approvalId = await onConfirmApproval({
        kind: "kakao.relay_send",
        summary: t("comms.kakao.send.summary"),
        target: chatName,
      });
      if (!approvalId) {
        setSendState("idle");
        return;
      }
      const queued = await enqueueKakaoSend(
        workPath,
        chatName,
        text,
        attachment.trim() || null,
      );
      setSendState("queued");
      setDraft("");
      setAttachment("");
      const seq = ++pollSeqRef.current;
      void pollSendResult(queued.id, seq);
    } catch (err) {
      setSendState("failed");
      setSendError(err instanceof Error ? err.message : String(err));
    }
  }, [
    attachment,
    draft,
    effectiveComposerRoom,
    onConfirmApproval,
    pollSendResult,
    sendRooms,
    sendState,
    t,
    workPath,
  ]);

  if (!status || !status.configured) {
    return (
      <section className="kakao-relay-panel">
        <p className="kakao-relay-hint">{t("comms.kakao.viewer.unconfigured")}</p>
      </section>
    );
  }

  return (
    <section className="kakao-relay-panel">
      <div className="kakao-relay-section">
        <div className="kakao-relay-section-header">
          <h3 className="comms-results-title">{t("comms.kakao.viewer.title")}</h3>
          <button
            type="button"
            className="secondary-button"
            disabled={messagesLoading}
            onClick={() => void loadMessages()}
          >
            <RefreshCcw size={14} className={messagesLoading ? "spin" : undefined} />
            <span>{t("comms.source.refresh")}</span>
          </button>
        </div>
        {rooms.length === 0 ? (
          <p className="kakao-relay-hint">{t("comms.kakao.viewer.noRooms")}</p>
        ) : (
          <>
            <label className="kakao-relay-field">
              <span>{t("comms.kakao.viewer.room")}</span>
              <select
                value={effectiveViewerRoom}
                onChange={(event) => setViewerRoom(event.target.value)}
              >
                {rooms.map((room) => (
                  <option key={room.slug} value={room.slug}>
                    {room.name}
                  </option>
                ))}
              </select>
            </label>
            {messagesError ? <p className="kakao-relay-error">{messagesError}</p> : null}
            {messagesLoading && messages.length === 0 ? (
              <p className="kakao-relay-hint">{t("comms.kakao.viewer.loading")}</p>
            ) : messages.length === 0 ? (
              <p className="kakao-relay-hint">{t("comms.kakao.viewer.empty")}</p>
            ) : (
              <ul className="kakao-relay-messages">
                {messages.map((envelope, index) => {
                  const preview = envelopePreview(envelope);
                  const mine = envelope.message?.is_me === true;
                  return (
                    <li
                      key={envelope.message?.id ?? index}
                      className={mine ? "kakao-relay-message me" : "kakao-relay-message"}
                    >
                      <div className="kakao-relay-message-meta">
                        <span className="kakao-relay-message-sender">
                          {mine ? t("comms.kakao.message.me") : preview.sender}
                        </span>
                        {preview.sentAt ? <time>{preview.sentAt}</time> : null}
                      </div>
                      <p className="kakao-relay-message-text">{preview.text}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="kakao-relay-section">
        <h3 className="comms-results-title">{t("comms.kakao.composer.title")}</h3>
        {sendRooms.length === 0 ? (
          <p className="kakao-relay-hint">{t("comms.kakao.noSendRooms")}</p>
        ) : (
          <div className="kakao-relay-form">
            <label className="kakao-relay-field">
              <span>{t("comms.kakao.viewer.room")}</span>
              <select
                value={effectiveComposerRoom}
                onChange={(event) => setComposerRoom(event.target.value)}
              >
                {sendRooms.map((room) => (
                  <option key={room.slug} value={room.slug}>
                    {room.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="kakao-relay-field">
              <span>{t("comms.kakao.composer.message")}</span>
              <textarea
                rows={3}
                value={draft}
                placeholder={t("comms.kakao.composer.messagePlaceholder")}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <label className="kakao-relay-field">
              <span>{t("comms.kakao.composer.attachment")}</span>
              <input
                type="text"
                value={attachment}
                placeholder={t("comms.kakao.composer.attachmentPlaceholder")}
                onChange={(event) => setAttachment(event.target.value)}
              />
            </label>
            <div className="kakao-relay-form-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={!draft.trim() || sendState === "sending"}
                onClick={() => void send()}
              >
                <Send size={14} />
                <span>{t("comms.kakao.composer.send")}</span>
              </button>
              {sendState === "sending" || sendState === "queued" ? (
                <span className="kakao-relay-send-state">{t("comms.kakao.send.queued")}</span>
              ) : null}
              {sendState === "sent" ? (
                <span className="kakao-relay-send-state ok">{t("comms.kakao.send.sent")}</span>
              ) : null}
              {sendState === "failed" ? (
                <span className="kakao-relay-send-state error">
                  {t("comms.kakao.send.failed", { error: sendError ?? "" })}
                </span>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
