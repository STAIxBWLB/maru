import { describe, expect, it } from "vitest";

// Read through Vite's `?raw` rather than node:fs so this stays inside the app
// tsconfig, which has no node types.
import RUST_SOURCE from "../../src-tauri/src/agent_host/provider.rs?raw";

import { AGENT_CAPABILITIES } from "./agentCapabilities";

describe("AGENT_CAPABILITIES", () => {
  it("matches CliProviderKind::capabilities() in provider.rs", () => {
    for (const [id, caps] of Object.entries(AGENT_CAPABILITIES)) {
      const variant = id[0].toUpperCase() + id.slice(1);
      const arm = new RegExp(
        `Self::${variant} => ProviderCapabilities \\{([^}]*)\\}`,
      ).exec(RUST_SOURCE)?.[1];
      expect(arm, `no capabilities arm for ${id} in provider.rs`).toBeTruthy();

      const flag = (name: string) => new RegExp(`\\b${name}: (true|false)`).exec(arm!)?.[1];
      expect(flag("resume"), `${id}.resume`).toBe(String(caps.resume));
      expect(flag("usage"), `${id}.usage`).toBe(String(caps.usage));
      expect(flag("add_dirs"), `${id}.addDirs`).toBe(String(caps.addDirs));
    }
  });

  it("covers every provider variant declared in Rust", () => {
    const variants = [...RUST_SOURCE.matchAll(/Self::(\w+) => ProviderCapabilities/g)].map(
      (match) => match[1].toLowerCase(),
    );
    expect(variants.sort()).toEqual(Object.keys(AGENT_CAPABILITIES).sort());
  });
});
