#!/usr/bin/env node
// Captures the ?startupProfile=1 startup profile from the browser dev shell
// and prints it as JSON (or writes it to the path given as argv[2]).
//
// Provenance: the browser shell mocks Tauri IPC, so the numbers cover module
// parse, React mount and first render — not real IPC/scan times. Use the
// native app for those (see docs/perf-baseline.md).
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.MARU_PERF_PORT ?? 5319);
const outPath = process.argv[2] ?? null;

const server = spawn(
  "pnpm",
  ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  // `detached` puts the pnpm→vite chain in its own process group so cleanup
  // can kill the whole tree; a bare server.kill() leaves vite orphaned and
  // its open stdout pipe keeps this script alive.
  { cwd: root, detached: true, stdio: ["ignore", "pipe", "inherit"] },
);

try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("vite dev server did not start within 30s")),
      30_000,
    );
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", (chunk) => {
      if (chunk.includes("Local:") || chunk.includes("ready in")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/?startupProfile=1`);
    await page.waitForFunction(
      () =>
        window.__MARU_STARTUP_PROFILE__?.marks?.some(
          (mark) => mark.name === "boot:end" || mark.name === "boot:error",
        ) ?? false,
      null,
      { timeout: 30_000 },
    );
    const profile = await page.evaluate(() => window.__MARU_STARTUP_PROFILE__ ?? null);
    const json = `${JSON.stringify(profile, null, 2)}\n`;
    if (outPath) await fs.writeFile(outPath, json);
    else process.stdout.write(json);
  } finally {
    await browser.close();
  }
} finally {
  try {
    if (server.pid) process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill();
  }
}
