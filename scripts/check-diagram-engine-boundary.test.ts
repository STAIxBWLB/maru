import { describe, expect, it } from "vitest";
import { dependencyViolations } from "./check-diagram-engine-boundary.mjs";

describe("diagram SDK dependency boundary", () => {
  const pkg = (name: string, dependencies: Array<{ name: string; path?: string }>) => ({ name, version: "0.1.0", dependencies });
  it("refuses direct/renamed application dependencies and outside path dependencies", () => {
    expect(dependencyViolations([pkg("tauri-plugin-maru-diagram", [{ name: "maru" }])], "/sdk")).toHaveLength(1);
    expect(dependencyViolations([pkg("tauri-plugin-maru-diagram", [{ name: "other", path: "/app" }])], "/sdk")).toHaveLength(1);
  });
  it("refuses Tauri in the engine while admitting the plugin's internal core dependency", () => {
    expect(dependencyViolations([pkg("maru-diagram-engine", [{ name: "tauri" }])], "/sdk")).toHaveLength(1);
    expect(dependencyViolations([pkg("tauri-plugin-maru-diagram", [{ name: "maru-diagram-engine", path: "/sdk/maru-diagram-engine" }, { name: "tauri" }])], "/sdk")).toEqual([]);
  });
});
