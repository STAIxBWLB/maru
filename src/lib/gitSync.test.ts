import { describe, expect, it } from "vitest";

import { gitSyncRepoIsDetached } from "./gitSync";

describe("gitSyncRepoIsDetached", () => {
  it("treats null and HEAD branches as detached", () => {
    expect(gitSyncRepoIsDetached({ branch: null })).toBe(true);
    expect(gitSyncRepoIsDetached({ branch: "HEAD" })).toBe(true);
    expect(gitSyncRepoIsDetached({ branch: " head " })).toBe(true);
    expect(gitSyncRepoIsDetached({ branch: "" })).toBe(true);
  });

  it("does not treat named branches as detached", () => {
    expect(gitSyncRepoIsDetached({ branch: "main" })).toBe(false);
    expect(gitSyncRepoIsDetached({ branch: "feature/git-sync" })).toBe(false);
  });
});
