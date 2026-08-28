import { StudioMode } from "../../components/studio/StudioMode";
import { useStudioModeSlice } from "../documentOpsModeStore";
import type { ModeAdapterProps } from "../modeRegistry";

/** Dedicated lazy Studio surface over the document-ops controller host. */
export function StudioModeAdapter(_props: ModeAdapterProps) {
  const studio = useStudioModeSlice();
  return studio.host ? <StudioMode {...studio.host} /> : null;
}
