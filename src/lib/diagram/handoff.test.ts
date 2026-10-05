import { describe, expect, it } from "vitest";
import { requestDiagramHandoff, subscribeDiagramHandoff, takeDiagramHandoff } from "./handoff";

describe("diagram handoff", () => {
  it("retains a cold request until the lazy surface mounts, then consumes it once", () => {
    requestDiagramHandoff("/cold", "copy");
    expect(takeDiagramHandoff("/other")).toBeNull();
    expect(takeDiagramHandoff("/cold")).toBe("copy");
    expect(takeDiagramHandoff("/cold")).toBeNull();
  });

  it("notifies a mounted surface and preserves the latest request per workspace", () => {
    let notifications = 0;
    const off = subscribeDiagramHandoff(() => { notifications += 1; });
    requestDiagramHandoff("/warm", "first");
    requestDiagramHandoff("/warm", "second");
    off();
    expect(notifications).toBe(2);
    expect(takeDiagramHandoff("/warm")).toBe("second");
  });
});
