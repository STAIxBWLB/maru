import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createCommunicationsModeController,
  type CommunicationsModeController,
} from "./communicationsModeStore";

function createController(): CommunicationsModeController {
  return createCommunicationsModeController();
}

describe("communicationsModeStore", () => {
  it("publishes Inbox, Comms, and processed domains independently", () => {
    const controller = createController();
    let inboxUpdates = 0;
    let commsUpdates = 0;
    let processedUpdates = 0;
    const stopInbox = controller.subscribe("inbox", () => inboxUpdates += 1);
    const stopComms = controller.subscribe("comms", () => commsUpdates += 1);
    const stopProcessed = controller.subscribe("processed", () => processedUpdates += 1);

    controller.publishInbox({ loading: true });
    expect(inboxUpdates).toBe(1);
    expect(commsUpdates).toBe(0);
    expect(processedUpdates).toBe(0);

    controller.publishComms({ refreshing: true });
    expect(inboxUpdates).toBe(1);
    expect(commsUpdates).toBe(1);
    expect(processedUpdates).toBe(0);

    controller.publishProcessed({ query: "invoice" });
    expect(inboxUpdates).toBe(1);
    expect(commsUpdates).toBe(1);
    expect(processedUpdates).toBe(1);

    stopInbox();
    stopComms();
    stopProcessed();
  });

  it("rejects stale workspace generations while preserving canonical processed state", () => {
    const controller = createController();
    controller.publishProcessed({ query: "current" });
    const first = controller.setWorkspace("/workspace-a");
    const second = controller.setWorkspace("/workspace-b");

    expect(controller.publishInboxForWorkspace(first, { loading: true })).toBe(false);
    expect(controller.publishCommsForWorkspace(second, { refreshing: true })).toBe(true);
    expect(controller.getProcessedSlice().query).toBe("current");
    expect(controller.getInboxSlice().workspacePath).toBe("/workspace-b");
    expect(controller.getCommsSlice().workspacePath).toBe("/workspace-b");
  });

  it("retains slice identities for unrelated and equivalent publications", () => {
    const controller = createController();
    const inbox = controller.getInboxSlice();
    const comms = controller.getCommsSlice();
    const processed = controller.getProcessedSlice();

    controller.publishInbox({ loading: false });
    expect(controller.getInboxSlice()).toBe(inbox);

    controller.publishComms({ refreshing: true });
    expect(controller.getInboxSlice()).toBe(inbox);
    expect(controller.getProcessedSlice()).toBe(processed);

    controller.publishProcessed({ query: "" });
    expect(controller.getCommsSlice()).not.toBe(comms);
  });

  it("keeps Comms behind a dedicated adapter instead of a MainApp render branch", () => {
    const app = readFileSync(resolve(import.meta.dirname, "../App.tsx"), "utf8");
    const adapter = readFileSync(
      resolve(import.meta.dirname, "modeAdapters/CommsModeAdapter.tsx"),
      "utf8",
    );

    expect(app).not.toContain("LazyCommsPane");
    expect(adapter).toContain("useCommsModeSlice");
    expect(adapter).toContain("CommsPane");
  });
});
