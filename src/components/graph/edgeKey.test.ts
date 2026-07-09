import { describe, expect, it } from "vitest";
import { edgeKey } from "./GraphCanvas";

describe("edgeKey", () => {
  it("is order-independent", () => {
    expect(edgeKey("a", "b")).toBe(edgeKey("b", "a"));
  });

  it("does not collide when ids contain spaces", () => {
    // A plain-space delimiter would map both "x"+"y z" and "x y"+"z" to "x y z";
    // the NUL delimiter keeps them distinct (path-highlight correctness).
    expect(edgeKey("x", "y z")).not.toBe(edgeKey("x y", "z"));
  });

  it("keeps both ids recoverable", () => {
    const k = edgeKey("alpha", "beta");
    expect(k.includes("alpha")).toBe(true);
    expect(k.includes("beta")).toBe(true);
  });
});
