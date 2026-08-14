import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const configPath = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "src-tauri/tauri.conf.json",
);

describe("static main window configuration contract", () => {
  it("defines one effective startup main window with background throttling", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const windows = config.app?.windows;

    expect(Array.isArray(windows)).toBe(true);

    const mainStartupWindows = windows.filter(
      (window) =>
        (window.label === undefined || window.label === "main") && window.create !== false,
    );

    expect(mainStartupWindows).toHaveLength(1);
    const [mainWindow] = mainStartupWindows;
    expect(mainWindow.create).not.toBe(false);
    expect(mainWindow.backgroundThrottling).toBe("throttle");
  });
});
