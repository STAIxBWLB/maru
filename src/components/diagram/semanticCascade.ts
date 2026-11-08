import type { SemanticCascadeEffect } from "../../lib/diagram/semanticEdit";

export type SemanticTranslate = (key: string, vars?: Record<string, string | number>) => string;

export function semanticCascadeLines(effects: readonly SemanticCascadeEffect[], t: SemanticTranslate): string[] {
  return effects.map((effect) => {
    const collection = t(`diagram.semantic.collection.${effect.field}`);
    const reference = effect.field === "mainPath" || effect.field.startsWith("semanticChecks.");
    const detail = effect.index >= 0 ? ` #${effect.index + 1}${reference ? "" : `: ${effect.label}`}` : "";
    return `- ${t(`diagram.semantic.effect.${effect.action}`)} ${collection}${detail}`;
  });
}
