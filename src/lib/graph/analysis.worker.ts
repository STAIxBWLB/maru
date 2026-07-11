import {
  findBridges,
  findHiddenLinks,
  findOrphans,
  findStale,
  findSurprisingConnections,
  type BridgeNode,
  type HiddenLink,
  type OrphanNode,
  type StaleNode,
  type SurprisingConnection,
} from "./insights";
import type { GraphModel } from "./model";

export interface InsightBundle {
  hidden: HiddenLink[];
  surprising: SurprisingConnection[];
  bridges: BridgeNode[];
  orphans: OrphanNode[];
  stale: StaleNode[];
}

type Request = { epoch: number; model: GraphModel; now: number; staleDays: number };
type Response = { epoch: number; bundle: InsightBundle };

self.onmessage = (event: MessageEvent<Request>) => {
  const { epoch, model, now, staleDays } = event.data;
  const bundle: InsightBundle = {
    hidden: findHiddenLinks(model, 50),
    surprising: findSurprisingConnections(model, 50),
    bridges: findBridges(model, 50),
    orphans: findOrphans(model, 50),
    stale: findStale(model, staleDays, now, 50),
  };
  self.postMessage({ epoch, bundle } satisfies Response);
};
