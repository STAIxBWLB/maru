import { StudioMode } from "../../components/studio/StudioMode";
import type { ModeAdapterProps } from "../modeRegistry";

/** Dedicated lazy Studio surface over the existing typed document commands. */
export function StudioModeAdapter({ commands }: ModeAdapterProps) {
  const studio = commands.documentOps?.studio;
  return studio ? <StudioMode {...studio} /> : null;
}
