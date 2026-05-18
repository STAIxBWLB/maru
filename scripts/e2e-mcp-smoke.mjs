#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-e2e-mcp-"));
const runId = "anchor-e2e-smoke";
const runDir = path.join(tmp, ".anchor", "e2e-runs", runId);
await fs.mkdir(runDir, { recursive: true });
await fs.writeFile(
  path.join(runDir, "metadata.json"),
  JSON.stringify({
    schemaVersion: "anchor_e2e_development_plan_v1",
    localStorageResult: { id: runId, status: "saved" },
    reportArtifact: { title: "Anchor E2E Development Report" },
    slideArtifact: { title: "Anchor E2E Flow" },
  }),
);
await fs.writeFile(path.join(runDir, "report.md"), "# Anchor E2E Development Report\n");
await fs.writeFile(path.join(runDir, "slides.html"), "<!doctype html><title>Anchor E2E Flow</title>");
await fs.writeFile(path.join(runDir, "todos.json"), "[]");
await fs.writeFile(path.join(runDir, "timings.json"), "{}");

const child = spawn(process.execPath, [path.join(root, "sidecars/anchor-mcp/index.mjs")], {
  cwd: tmp,
  env: { ...process.env, ANCHOR_MCP_WORKSPACE: tmp },
  stdio: ["pipe", "pipe", "inherit"],
});

const responses = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  for (const line of chunk.split("\n")) {
    if (line.trim()) responses.push(JSON.parse(line));
  }
});

function request(id, method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

request(1, "initialize");
request(2, "tools/list");
request(3, "tools/call", { name: "artifact.list", arguments: {} });
request(4, "tools/call", { name: "artifact.read", arguments: { runId } });

await new Promise((resolve) => setTimeout(resolve, 500));
child.stdin.end();
child.kill();

const list = responses.find((item) => item.id === 2)?.result?.tools?.map((tool) => tool.name) ?? [];
assert.ok(list.includes("artifact.list"));
assert.ok(list.includes("artifact.read"));

const artifactListText = responses.find((item) => item.id === 3)?.result?.content?.[0]?.text;
const artifactReadText = responses.find((item) => item.id === 4)?.result?.content?.[0]?.text;
const artifactList = JSON.parse(artifactListText);
const artifactRead = JSON.parse(artifactReadText);

assert.equal(artifactList.artifacts[0].runId, runId);
assert.equal(artifactRead.metadata.localStorageResult.id, runId);
assert.deepEqual(artifactRead.files, [
  "metadata.json",
  "report.md",
  "slides.html",
  "todos.json",
  "timings.json",
]);

console.log(JSON.stringify({ ok: true, runId }, null, 2));
