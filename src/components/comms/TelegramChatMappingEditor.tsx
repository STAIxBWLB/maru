import { Plus, Trash2 } from "lucide-react";
import type {
  ProjectPickerEntry,
  TelegramMonitorChat,
  TelegramMonitorConfigView,
} from "../../lib/types";
import {
  selectedProjectId,
  telegramChatMappingReducer,
} from "../../lib/telegramMonitor";
import { useTranslation } from "../../lib/i18n";
import { ProjectPicker } from "./ProjectPicker";

interface TelegramChatMappingEditorProps {
  config: TelegramMonitorConfigView;
  projects: ProjectPickerEntry[];
  onChange: (config: TelegramMonitorConfigView) => void;
}

export function TelegramChatMappingEditor({
  config,
  projects,
  onChange,
}: TelegramChatMappingEditorProps) {
  const { t } = useTranslation();
  const updateChats = (chats: TelegramMonitorChat[]) => onChange({ ...config, chats });
  const dispatch = (action: Parameters<typeof telegramChatMappingReducer>[1]) =>
    updateChats(telegramChatMappingReducer(config.chats, action));
  const projectById = new Map(projects.map((project) => [project.id, project]));

  return (
    <div className="telegram-chat-mapping">
      <div className="settings-section-heading">
        <div>
          <strong>{t("comms.telegram.chats.title")}</strong>
          <span>{t("comms.telegram.chats.description")}</span>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => dispatch({ type: "add" })}
        >
          <Plus size={14} />
          <span>{t("comms.telegram.chats.addRow")}</span>
        </button>
      </div>
      {!config.exists ? (
        <div className="comms-setup-banner warn">
          <div>
            <strong>{t("comms.telegram.chats.missingConfig")}</strong>
            <p>{config.path}</p>
          </div>
        </div>
      ) : null}
      {config.chats.length === 0 ? (
        <div className="comms-setup-banner">
          <div>
            <strong>{t("comms.telegram.chats.empty")}</strong>
          </div>
        </div>
      ) : (
        <div className="telegram-chat-table-wrap">
          <table className="telegram-chat-table">
            <thead>
              <tr>
                <th>{t("comms.telegram.chats.columns.enabled")}</th>
                <th>{t("comms.telegram.chats.columns.name")}</th>
                <th>{t("comms.telegram.chats.columns.chatId")}</th>
                <th>{t("comms.telegram.chats.columns.priority")}</th>
                <th>{t("comms.telegram.chats.columns.tags")}</th>
                <th>{t("comms.telegram.chats.columns.project")}</th>
                <th>{t("comms.telegram.chats.columns.projectPath")}</th>
                <th>{t("comms.telegram.chats.profile")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {config.chats.map((chat) => {
                const selectedProject = selectedProjectId(chat);
                const project = projectById.get(selectedProject) ?? null;
                return (
                  <tr key={chat.chat_id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={chat.enabled}
                        onChange={(event) =>
                          dispatch({
                            type: "toggleEnabled",
                            chatId: chat.chat_id,
                            enabled: event.target.checked,
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        value={chat.name ?? ""}
                        onChange={(event) =>
                          dispatch({
                            type: "update",
                            chatId: chat.chat_id,
                            patch: { name: event.target.value },
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        value={String(chat.chat_id)}
                        onChange={(event) =>
                          dispatch({
                            type: "update",
                            chatId: chat.chat_id,
                            patch: { chat_id: Number(event.target.value) || chat.chat_id },
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        value={chat.priority ?? ""}
                        onChange={(event) =>
                          dispatch({
                            type: "setPriority",
                            chatId: chat.chat_id,
                            priority: event.target.value,
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        value={chat.tags.join(", ")}
                        onChange={(event) =>
                          dispatch({
                            type: "setTags",
                            chatId: chat.chat_id,
                            tags: event.target.value,
                          })
                        }
                      />
                    </td>
                    <td>
                      <ProjectPicker
                        projects={projects}
                        value={selectedProject}
                        onChange={(projectId) =>
                          dispatch({
                            type: "setProject",
                            chatId: chat.chat_id,
                            projectId,
                          })
                        }
                      />
                    </td>
                    <td>
                      <span className={project ? "" : "source-card-muted"}>
                        {project?.path ?? t("comms.telegram.chats.noProject")}
                      </span>
                    </td>
                    <td>
                      <select
                        value={chat.profile ?? "standard"}
                        onChange={(event) =>
                          dispatch({
                            type: "setProfile",
                            chatId: chat.chat_id,
                            profile: event.target.value,
                          })
                        }
                      >
                        <option value="standard">standard</option>
                        <option value="deep-digest">deep-digest</option>
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => dispatch({ type: "remove", chatId: chat.chat_id })}
                        title={t("comms.telegram.chats.removeRow")}
                        aria-label={t("comms.telegram.chats.removeRow")}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
