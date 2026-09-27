#!/usr/bin/env node
// Node >= 22.4 ships an experimental global `localStorage`/`sessionStorage` (enabled by
// default since Node 25) that shadows jsdom's Storage in vitest component tests when no
// --localstorage-file is configured, failing with "window.localStorage.setItem is not a
// function". Disable the built-in for the vitest child process so jsdom always wins.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const vitestBin = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");

const [major, minor] = process.versions.node.split(".").map(Number);
const hasBuiltinWebstorage = major > 22 || (major === 22 && minor >= 4);

const env = { ...process.env };
if (hasBuiltinWebstorage) {
  env.NODE_OPTIONS = [env.NODE_OPTIONS, "--no-experimental-webstorage"]
    .filter(Boolean)
    .join(" ");
}

const result = spawnSync(process.execPath, [vitestBin, "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
process.exit(result.status ?? 1);
