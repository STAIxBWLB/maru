// D-13 surface 1: the runner reads the real WKWebView DOM. Minimum size on
// purpose - one path, no second flow (see 06-01-PLAN.md Task 2 objective).
import assert from "node:assert/strict";
// Type-only: pulls in webdriverio's `declare global { namespace WebdriverIO
// { interface Browser ... } }` augmentation so the ambient `browser` global
// (from @wdio/globals/types) actually has the `$`/`$$` command surface,
// rather than the bare interface @wdio/globals/types.d.ts declares itself.
import type {} from "webdriverio";

import { FIXTURE_DOC_NAME } from "../helpers/fixtureWorkspace";

describe("native webview shell", () => {
  it("shows the activity rail and the seeded fixture document", async () => {
    const activityRail = await browser.$(".activity-rail");
    await activityRail.waitForDisplayed({ timeout: 30_000 });
    assert.equal(await activityRail.isDisplayed(), true, ".activity-rail must be displayed");

    // A fresh profile lands on the Today view, so the document list does
    // not exist until the documents (pkm) view is opened. The Korean
    // aria-label follows the Playwright suite's convention
    // (e2e/binary-viewer.spec.ts clicks "파일" the same way).
    const documentsButton = await browser.$('.activity-rail button[aria-label="문서"]');
    await documentsButton.waitForDisplayed({ timeout: 30_000 });
    await documentsButton.click();

    const documentList = await browser.$(".document-list");
    await documentList.waitForDisplayed({ timeout: 30_000 });
    await browser.waitUntil(async () => (await documentList.getText()).includes(FIXTURE_DOC_NAME), {
      timeout: 30_000,
      timeoutMsg: `expected the document list to show the seeded "${FIXTURE_DOC_NAME}" document`,
    });
  });
});
