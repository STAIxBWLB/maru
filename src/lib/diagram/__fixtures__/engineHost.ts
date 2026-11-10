/** Shared validation host backed by the generated Maru SDK, never a sidecar process. */
import { validateEngineCandidate } from "../engine";

export const pinnedEngineHost = {
  validateCandidate: validateEngineCandidate,
};
