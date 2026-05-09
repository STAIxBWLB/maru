export const SKILL_EDITOR_OPEN_EVENT = "skills-editor://open";
export const SKILLS_UPDATED_EVENT = "skills://updated";

export interface SkillEditorOpenPayload {
  workPath: string | null;
  skillId: string;
}

export interface SkillsUpdatedPayload {
  workPath: string | null;
  skillId: string;
  action: "save" | "saveAs";
}
