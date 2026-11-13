import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { remote } from "webdriverio";
import { afterEach, describe, expect, it, vi } from "vitest";

// Native-e2e owns the helper's typecheck; keep the scripts composite separate.
const helperModule = resolve("e2e-native/helpers/hwpxHostState.ts");
afterEach(() => { vi.unstubAllGlobals(); });

/** Real webdriver@9 HTTP decoding, isolated from browser/product behavior. */
async function withDriverValue(value: unknown, check: (client: Awaited<ReturnType<typeof remote>>) => Promise<void>) {
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && request.url === "/session") {
      response.end(JSON.stringify({ value: { sessionId: "host-state-fixture", capabilities: { browserName: "fixture", platformName: "test" } } }));
    } else {
      response.end(JSON.stringify({ value: request.url?.endsWith("/execute/sync") ? value : null }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let client: Awaited<ReturnType<typeof remote>> | undefined;
  try {
    client = await remote({
      hostname: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/",
      capabilities: { browserName: "fixture", webSocketUrl: false }, connectionRetryCount: 0, logLevel: "silent",
    });
    await check(client);
  } finally {
    await client?.deleteSession();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("native HWPX host-state transport", () => {
  it("demonstrates the real client's reserved error-key collision at HTTP 200", async () => {
    await withDriverValue({ error: "document_conflict: expected fixture refusal", conflict: true }, async (client) => {
      await expect(client.execute(() => null)).rejects.toThrow("document_conflict");
    });
  });

  it.each([
    ["document_conflict: expected fixture refusal", true],
    ["Cannot create recovery snapshot directory; keep edits and retry", false],
  ])("reads application refusal %s as data without losing conflict state", async (message, conflict) => {
    const dom = new JSDOM();
    vi.stubGlobal("document", dom.window.document);
    const error = dom.window.document.createElement("div");
    error.dataset.testid = "hwpx-error"; error.textContent = message;
    dom.window.document.body.append(error);
    if (conflict) {
      const notice = dom.window.document.createElement("div"); notice.dataset.testid = "hwpx-conflict";
      dom.window.document.body.append(notice);
    }
    try {
      const { readHwpxHostState } = await import(helperModule);
      await withDriverValue(readHwpxHostState(), async (client) => {
        const state = JSON.parse(await client.execute(readHwpxHostState));
        expect(state.error).toBe(message);
        expect(state.conflict).toBe(conflict);
      });
    } finally { dom.window.close(); }
  });
});
