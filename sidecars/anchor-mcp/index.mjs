#!/usr/bin/env node
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const workspace = path.resolve(process.env.ANCHOR_MCP_WORKSPACE ?? process.cwd());
const workspaceReal = realpathSync(workspace);

const tools = [
  {
    name: "workspace.search",
    description: "Search text files in the local Anchor workspace.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "document.read",
    description: "Read a workspace file by relative path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "skill.list",
    description: "List bundled skill folders.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run.status",
    description: "Read run event counts from .anchor/runs/skills.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
      },
    },
  },
  {
    name: "proposal.read",
    description: "Read proposal.created events for a run.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
      },
      required: ["runId"],
    },
  },
  {
    name: "proposal.create",
    description: "Append a proposal.created event; does not write workspace files.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        proposal: { type: "object" },
      },
      required: ["runId", "proposal"],
    },
  },
  {
    name: "artifact.list",
    description: "List saved Anchor E2E artifacts from .anchor/e2e-runs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "artifact.read",
    description: "Read saved Anchor E2E artifact metadata and file inventory.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
      },
      required: ["runId"],
    },
  },
];

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
rl.on("line", (line) => {
  queue = queue.then(() => handleLine(line));
});

async function handleLine(line) {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
    const result = await dispatch(request.method, request.params ?? {});
    send({ jsonrpc: "2.0", id: request.id, result });
  } catch (err) {
    send({
      jsonrpc: "2.0",
      id: request?.id ?? null,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
    });
  }
}

async function dispatch(method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      serverInfo: { name: "anchor-mcp", version: "0.1.0" },
      capabilities: { tools: {} },
    };
  }
  if (method === "tools/list") {
    return { tools };
  }
  if (method === "tools/call") {
    const { name, arguments: args = {} } = params;
    const content = await callTool(name, args);
    return { content: [{ type: "text", text: JSON.stringify(content, null, 2) }] };
  }
  return {};
}

async function callTool(name, args) {
  switch (name) {
    case "workspace.search":
      return searchWorkspace(String(args.query ?? ""), Number(args.limit ?? 20));
    case "document.read":
      return readDocument(String(args.path ?? ""));
    case "skill.list":
      return listSkills();
    case "run.status":
      return runStatus(args.runId ? String(args.runId) : null);
    case "proposal.read":
      return readProposals(String(args.runId ?? ""));
    case "proposal.create":
      return createProposal(String(args.runId ?? ""), args.proposal ?? {});
    case "artifact.list":
      return listArtifacts();
    case "artifact.read":
      return readArtifact(String(args.runId ?? ""));
    default:
      throw new Error(`unknown_tool: ${name}`);
  }
}

async function searchWorkspace(query, limit) {
  if (!query.trim()) throw new Error("query_required");
  const results = [];
  for await (const file of walk(workspace)) {
    if (results.length >= limit) break;
    if (isIgnored(file)) continue;
    const rel = path.relative(workspace, file);
    const text = await readText(file);
    if (text && text.toLowerCase().includes(query.toLowerCase())) {
      results.push({ path: rel, preview: snippet(text, query) });
    }
  }
  return { workspace, results };
}

async function readDocument(relPath) {
  const file = await safeJoin(relPath);
  return { path: path.relative(workspaceReal, file), content: await fs.readFile(file, "utf8") };
}

async function listSkills() {
  const root = path.join(workspace, "skills", "skills");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return {
    skills: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: path.relative(workspace, path.join(root, entry.name)) })),
  };
}

async function runStatus(runId) {
  const root = path.join(workspace, ".anchor", "runs", "skills");
  const runs = runId ? [runId] : await fs.readdir(root).catch(() => []);
  const statuses = [];
  for (const id of runs) {
    const events = await readEvents(id);
    statuses.push({
      runId: id,
      eventCount: events.length,
      lastType: events.at(-1)?.type ?? null,
    });
  }
  return { runs: statuses };
}

async function readProposals(runId) {
  const events = await readEvents(runId);
  return {
    runId,
    proposals: events
      .filter((event) => event.type === "proposal.created")
      .map((event) => event.payload?.proposal ?? event.payload),
  };
}

async function createProposal(runId, proposal) {
  validateRunId(runId);
  const event = {
    id: `event-${randomUUID()}`,
    runId,
    ts: new Date().toISOString(),
    type: "proposal.created",
    actor: "anchor.mcp",
    payload: { proposal },
    schemaVersion: "anchor_agent_run_event_v1",
    parentId: null,
  };
  const eventsPath = path.join(workspace, ".anchor", "runs", "skills", runId, "events.jsonl");
  await fs.mkdir(path.dirname(eventsPath), { recursive: true });
  await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`);
  return { runId, eventId: event.id };
}

async function listArtifacts() {
  const root = path.join(workspace, ".anchor", "e2e-runs");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const artifacts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    if (!isValidRunId(runId)) continue;
    const dir = path.join(root, runId);
    const metadata = await readJsonIfExists(path.join(dir, "metadata.json"));
    artifacts.push({
      runId,
      status: metadata?.localStorageResult?.status ?? null,
      reportTitle: metadata?.reportArtifact?.title ?? null,
      slideTitle: metadata?.slideArtifact?.title ?? null,
      path: path.relative(workspace, dir),
    });
  }
  artifacts.sort((a, b) => a.runId.localeCompare(b.runId));
  return { workspace, artifacts };
}

async function readArtifact(runId) {
  validateRunId(runId);
  const root = path.join(workspace, ".anchor", "e2e-runs", runId);
  const realRoot = await fs.realpath(root);
  if (!isInside(realRoot, workspaceReal)) {
    throw new Error("path_escapes_workspace");
  }
  const files = [];
  for (const name of ["metadata.json", "report.md", "slides.html", "todos.json", "timings.json"]) {
    const file = path.join(realRoot, name);
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) files.push(name);
    } catch {
      // Missing optional artifacts are reflected by omission.
    }
  }
  return {
    runId,
    path: path.relative(workspaceReal, realRoot),
    files,
    metadata: await readJsonIfExists(path.join(realRoot, "metadata.json")),
    todos: await readJsonIfExists(path.join(realRoot, "todos.json")),
    timings: await readJsonIfExists(path.join(realRoot, "timings.json")),
  };
}

async function readEvents(runId) {
  validateRunId(runId);
  const eventsPath = path.join(workspace, ".anchor", "runs", "skills", runId, "events.jsonl");
  const raw = await fs.readFile(eventsPath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readJsonIfExists(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "node_modules", "target", "dist", ".anchor"].includes(entry.name)) continue;
      yield* walk(file);
    } else if (entry.isFile()) {
      yield file;
    }
  }
}

async function readText(file) {
  try {
    const stat = await fs.stat(file);
    if (stat.size > 1024 * 1024) return null;
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function safeJoin(relPath) {
  const file = path.resolve(workspace, relPath);
  if (!isInside(file, workspace)) {
    throw new Error("path_escapes_workspace");
  }
  const realFile = await fs.realpath(file);
  if (!isInside(realFile, workspaceReal)) {
    throw new Error("path_escapes_workspace");
  }
  return realFile;
}

function isInside(file, root) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isIgnored(file) {
  return /\.(png|jpg|jpeg|gif|pdf|zip|dmg|icns|ico|hwpx|pptx|xlsx)$/i.test(file);
}

function snippet(text, query) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + query.length + 80);
  return text.slice(start, end);
}

function validateRunId(runId) {
  if (!isValidRunId(runId)) throw new Error("run_id_invalid");
}

function isValidRunId(runId) {
  return Boolean(runId && /^[A-Za-z0-9_-]+$/.test(runId));
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
