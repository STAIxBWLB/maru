import type { InboxRuntimeConfig } from "../../../lib/types";

export function cloneInboxConfig(config: InboxRuntimeConfig): InboxRuntimeConfig {
  return JSON.parse(JSON.stringify(config)) as InboxRuntimeConfig;
}
