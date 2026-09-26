export const SKILL_EDITOR_OPEN_EVENT = "skills-editor://open";
export const SKILLS_UPDATED_EVENT = "skills://updated";
// Review finding #2: main's whole-app-quit path (requestAppQuit in
// useDestructiveActionGuard.ts) asks the skill editor window, if open,
// whether it is clear to quit — without destroying it — before deciding
// whether to proceed. The skill editor answers through its own dirty-draft
// guard (same confirm copy as its onCloseRequested handler) and reports back
// on the response event; main only actually destroys the window once its
// own guard also passes.
export const SKILL_EDITOR_QUIT_CHECK_EVENT = "skills-editor://quit-check";
export const SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT = "skills-editor://quit-check-response";
// Review finding #2, round 2: fired by the skill editor the instant its
// listener receives the quit-check request, before any dirty check or
// dialog. Lets requestSkillEditorQuitCheck tell "no listener registered yet
// (window still initializing)" apart from "listening and now awaiting a
// user decision" — only the former is safe to time out.
export const SKILL_EDITOR_QUIT_CHECK_ACK_EVENT = "skills-editor://quit-check-ack";

export interface SkillEditorOpenPayload {
  workPath: string | null;
  skillId: string;
}

export interface SkillEditorQuitCheckResponse {
  proceed: boolean;
}

export interface SkillsUpdatedPayload {
  workPath: string | null;
  skillId: string;
  action: "save" | "saveAs";
}
