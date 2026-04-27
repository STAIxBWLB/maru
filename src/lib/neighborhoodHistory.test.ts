import { describe, expect, it } from "vitest";
import { emptyHistory, goBack, goForward, pushHistory } from "./neighborhoodHistory";

describe("navigation history", () => {
  it("pushes back entries and clears forward history", () => {
    const withBack = pushHistory({ back: ["a.md"], forward: ["c.md"] }, "b.md");

    expect(withBack).toEqual({ back: ["a.md", "b.md"], forward: [] });
  });

  it("does not duplicate the current top of the back stack", () => {
    const history = { back: ["a.md"], forward: [] };

    expect(pushHistory(history, "a.md")).toBe(history);
  });

  it("moves between back and forward stacks", () => {
    const initial = pushHistory(pushHistory(emptyHistory, "a.md"), "b.md");
    const back = goBack(initial, "c.md");
    const forward = goForward(back.history, back.target ?? "");

    expect(back.target).toBe("b.md");
    expect(back.history).toEqual({ back: ["a.md"], forward: ["c.md"] });
    expect(forward.target).toBe("c.md");
    expect(forward.history).toEqual({ back: ["a.md", "b.md"], forward: [] });
  });
});
