import { useSyncExternalStore } from "react";

import type { InboxPane } from "../components/InboxPane";
import type { CommsPane } from "../components/CommsPane";

export type CommunicationsModeDomain = "inbox" | "comms" | "processed";

export type InboxModeProps = Parameters<typeof InboxPane>[0];
export type CommsModeProps = Parameters<typeof CommsPane>[0];

export interface InboxModeSlice {
  workspacePath: string | null;
  loading: boolean;
  sourceFilter: string | null;
  actionBusy: boolean;
  focusRequest: number;
  props: InboxModeProps | null;
}

export interface CommsModeSlice {
  workspacePath: string | null;
  refreshing: boolean;
  sourceFilter: string | null;
  props: CommsModeProps | null;
}

export interface ProcessedItemsSlice {
  query: string;
}

export interface CommunicationsModeController {
  subscribe(domain: CommunicationsModeDomain, listener: () => void): () => void;
  getInboxSlice(): InboxModeSlice;
  getCommsSlice(): CommsModeSlice;
  getProcessedSlice(): ProcessedItemsSlice;
  setWorkspace(workspacePath: string | null): number;
  publishInbox(patch: Partial<Omit<InboxModeSlice, "workspacePath">>): void;
  publishComms(patch: Partial<Omit<CommsModeSlice, "workspacePath">>): void;
  publishProcessed(patch: Partial<ProcessedItemsSlice>): void;
  publishInboxForWorkspace(
    generation: number,
    patch: Partial<Omit<InboxModeSlice, "workspacePath">>,
  ): boolean;
  publishCommsForWorkspace(
    generation: number,
    patch: Partial<Omit<CommsModeSlice, "workspacePath">>,
  ): boolean;
  bindInbox(props: InboxModeProps): void;
  bindComms(props: CommsModeProps): void;
}

const EMPTY_INBOX: InboxModeSlice = Object.freeze({
  workspacePath: null,
  loading: false,
  sourceFilter: null,
  actionBusy: false,
  focusRequest: 0,
  props: null,
});
const EMPTY_COMMS: CommsModeSlice = Object.freeze({
  workspacePath: null,
  refreshing: false,
  sourceFilter: null,
  props: null,
});
const EMPTY_PROCESSED: ProcessedItemsSlice = Object.freeze({ query: "" });

/**
 * Canonical Inbox/Comms render slices. The controller deliberately publishes
 * each domain independently so an Inbox transition cannot wake Comms readers.
 */
export function createCommunicationsModeController(): CommunicationsModeController {
  const listeners: Record<CommunicationsModeDomain, Set<() => void>> = {
    inbox: new Set(),
    comms: new Set(),
    processed: new Set(),
  };
  let inbox = EMPTY_INBOX;
  let comms = EMPTY_COMMS;
  let processed = EMPTY_PROCESSED;
  let workspaceGeneration = 0;

  const notify = (domain: CommunicationsModeDomain) => {
    for (const listener of listeners[domain]) listener();
  };
  const publishInbox = (next: InboxModeSlice) => {
    if (
      inbox.workspacePath === next.workspacePath &&
      inbox.loading === next.loading &&
      inbox.sourceFilter === next.sourceFilter &&
      inbox.actionBusy === next.actionBusy &&
      inbox.focusRequest === next.focusRequest &&
      inbox.props === next.props
    ) return;
    inbox = Object.freeze(next);
    notify("inbox");
  };
  const publishComms = (next: CommsModeSlice) => {
    if (
      comms.workspacePath === next.workspacePath &&
      comms.refreshing === next.refreshing &&
      comms.sourceFilter === next.sourceFilter &&
      comms.props === next.props
    ) return;
    comms = Object.freeze(next);
    notify("comms");
  };
  const publishProcessed = (next: ProcessedItemsSlice) => {
    if (processed.query === next.query) return;
    processed = Object.freeze(next);
    notify("processed");
  };

  return {
    subscribe(domain, listener) {
      listeners[domain].add(listener);
      return () => listeners[domain].delete(listener);
    },
    getInboxSlice: () => inbox,
    getCommsSlice: () => comms,
    getProcessedSlice: () => processed,
    setWorkspace(workspacePath) {
      workspaceGeneration += 1;
      publishInbox({ ...inbox, workspacePath, props: null });
      publishComms({ ...comms, workspacePath, props: null });
      return workspaceGeneration;
    },
    publishInbox(patch) {
      publishInbox({ ...inbox, ...patch });
    },
    publishComms(patch) {
      publishComms({ ...comms, ...patch });
    },
    publishProcessed(patch) {
      publishProcessed({ ...processed, ...patch });
    },
    publishInboxForWorkspace(generation, patch) {
      if (generation !== workspaceGeneration) return false;
      publishInbox({ ...inbox, ...patch });
      return true;
    },
    publishCommsForWorkspace(generation, patch) {
      if (generation !== workspaceGeneration) return false;
      publishComms({ ...comms, ...patch });
      return true;
    },
    bindInbox(props) {
      publishInbox({
        ...inbox,
        workspacePath: props.workPath,
        loading: props.loading,
        sourceFilter: props.sourceFilter,
        actionBusy: props.actionBusy ?? false,
        focusRequest: props.focusRequest ?? 0,
        props,
      });
      publishProcessed({ ...processed, query: props.processedQuery });
    },
    bindComms(props) {
      publishComms({
        ...comms,
        workspacePath: props.workPath,
        refreshing: props.refreshing,
        sourceFilter: props.sourceFilter,
        props,
      });
      publishProcessed({ ...processed, query: props.processedQuery });
    },
  };
}

export const communicationsModeController = createCommunicationsModeController();

function useSlice<T>(
  domain: CommunicationsModeDomain,
  getSnapshot: () => T,
): T {
  return useSyncExternalStore(
    (listener) => communicationsModeController.subscribe(domain, listener),
    getSnapshot,
    getSnapshot,
  );
}

export function useInboxModeSlice(): InboxModeSlice {
  return useSlice("inbox", communicationsModeController.getInboxSlice);
}

export function useCommsModeSlice(): CommsModeSlice {
  return useSlice("comms", communicationsModeController.getCommsSlice);
}

export function useProcessedItemsSlice(): ProcessedItemsSlice {
  return useSlice("processed", communicationsModeController.getProcessedSlice);
}
