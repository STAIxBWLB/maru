import { describe, expect, it } from "vitest";
import {
  COMPOSE_SKILL_RUNTIMES,
  parseStoredSkillRuntime,
} from "./ComposeDialog";

describe("ComposeDialog runtime selection", () => {
  it("offers every configured agent runtime", () => {
    expect(COMPOSE_SKILL_RUNTIMES).toEqual([
      "claude",
      "codex",
      "kimi",
      "kiro",
    ]);
  });

  it("restores Kimi and Kiro as the last selected runtime", () => {
    expect(parseStoredSkillRuntime("kimi")).toBe("kimi");
    expect(parseStoredSkillRuntime("kiro")).toBe("kiro");
    expect(parseStoredSkillRuntime("unknown")).toBeNull();
  });
});
