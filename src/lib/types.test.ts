import { describe, expect, it } from "vitest";

// Read through Vite's `?raw` rather than node:fs so this stays inside the app
// tsconfig, which has no node types (pattern: agentCapabilities.test.ts).
import RUST_SOURCE from "../../src-tauri/src/ipc_error.rs?raw";

import { IPC_ERROR_CODES } from "./types";

describe("IPC_ERROR_CODES", () => {
  it("matches the pub const values declared in ipc_error.rs (ERR-02 cross-language guard)", () => {
    // Each side is pinned to itself already (ipc_error_codes_are_stable on the
    // Rust side, tsc -b's literal-union check on the TS side). Neither of
    // those catches a rename applied consistently on ONE side only - this is
    // the guard that closes that gap by asserting the two sides agree.
    const rustValues = [...RUST_SOURCE.matchAll(/pub const \w+: &str = "([^"]+)";/g)].map(
      (match) => match[1],
    );
    expect(rustValues.sort()).toEqual([...IPC_ERROR_CODES].sort());
  });
});
