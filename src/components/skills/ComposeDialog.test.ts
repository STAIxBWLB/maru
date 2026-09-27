import { describe, expect, it } from "vitest";
import {
  COMPOSE_SKILL_RUNTIMES,
  composeInvocationPolicy,
  parseStoredSkillRuntime,
} from "./ComposeDialog";

describe("ComposeDialog runtime selection", () => {
  it("pins an explicit selection while leaving automatic defaults eligible for routing", () => {
    const policy = { enabled: true, workload: "auto" as const };
    expect(composeInvocationPolicy(policy, "codex", true)).toEqual({ ...policy, agent: "codex" });
    expect(composeInvocationPolicy(policy, "codex", false)).toEqual(policy);
    expect(composeInvocationPolicy(undefined, "codex", true)).toBeUndefined();
  });
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
