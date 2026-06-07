import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const targetRoot = resolve(repoRoot, 'src-tauri/target');
const debugRoot = resolve(targetRoot, 'debug');
const statePath = resolve(targetRoot, '.anchor-debug-prune.json');

const GIB = 1024 ** 3;
const DEFAULT_MAX_BYTES = 4 * GIB;
const DEFAULT_INTERVAL_HOURS = 24;

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const options = {
  dryRun: args.includes('--dry-run'),
  force: args.includes('--force'),
  maxBytes: readNumberArg('--max-bytes', DEFAULT_MAX_BYTES),
  intervalHours: readNumberArg('--interval-hours', DEFAULT_INTERVAL_HOURS),
};

if (options.maxBytes <= 0) {
  throw new Error('--max-bytes must be greater than 0');
}
if (options.intervalHours < 0) {
  throw new Error('--interval-hours must be greater than or equal to 0');
}

const now = Date.now();
const state = readState();
const lastCheckedAt =
  typeof state.lastCheckedAt === 'number'
    ? state.lastCheckedAt
    : typeof state.lastPrunedAt === 'number'
      ? state.lastPrunedAt
      : 0;
const intervalMs = options.intervalHours * 60 * 60 * 1000;
const elapsedMs = lastCheckedAt > 0 ? now - lastCheckedAt : Number.POSITIVE_INFINITY;
const intervalElapsed = elapsedMs >= intervalMs;

if (!options.force && !options.dryRun && !intervalElapsed) {
  console.log(`tauri debug prune: skipped (last check was ${formatDuration(elapsedMs)} ago)`);
  process.exit(0);
}

const beforeBytes = pathSize(debugRoot);

if (beforeBytes === 0) {
  console.log('tauri debug prune: src-tauri/target/debug is empty or missing');
  if (!options.dryRun) {
    writeState({
      lastCheckedAt: now,
      lastCheckedAtIso: new Date(now).toISOString(),
      beforeBytes,
      afterBytes: beforeBytes,
      removed: [],
    });
  }
  process.exit(0);
}

const overLimit = beforeBytes >= options.maxBytes;

if (!options.force && !overLimit) {
  console.log(`tauri debug prune: skipped (${formatBytes(beforeBytes)}, below ${formatBytes(options.maxBytes)})`);
  writeState({
    lastCheckedAt: now,
    lastCheckedAtIso: new Date(now).toISOString(),
    beforeBytes,
    afterBytes: beforeBytes,
    removed: [],
  });
  process.exit(0);
}

const pruneTargets = [
  'bundle',
  'build',
  'deps',
  'examples',
  'incremental',
  '.fingerprint',
  'anchor',
  'anchor-cli',
  'anchor.d',
  'anchor-cli.d',
].map((name) => resolve(debugRoot, name));

const removed = [];
for (const target of pruneTargets) {
  assertInsideDebugRoot(target);
  if (!existsSync(target)) continue;
  const bytes = pathSize(target);
  removed.push({ path: target, bytes });
  if (!options.dryRun) {
    rmSync(target, { recursive: true, force: true });
  }
}

const afterBytes = options.dryRun ? beforeBytes : pathSize(debugRoot);
const summary = `${formatBytes(beforeBytes)} -> ${formatBytes(afterBytes)}`;
const action = options.dryRun ? 'would prune' : 'pruned';
console.log(`tauri debug prune: ${action} ${removed.length} paths (${summary})`);
for (const item of removed) {
  console.log(`  ${formatBytes(item.bytes).padStart(9)} ${relativeToRepo(item.path)}`);
}

if (!options.dryRun) {
  writeState({
    lastCheckedAt: now,
    lastCheckedAtIso: new Date(now).toISOString(),
    lastPrunedAt: now,
    lastPrunedAtIso: new Date(now).toISOString(),
    beforeBytes,
    afterBytes,
    removed: removed.map((item) => ({
      path: relativeToRepo(item.path),
      bytes: item.bytes,
    })),
  });
}

function readNumberArg(name, fallback) {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) {
    const value = Number(exact.slice(name.length + 1));
    return Number.isFinite(value) ? value : fallback;
  }
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) {
    const value = Number(args[index + 1]);
    return Number.isFinite(value) ? value : fallback;
  }
  if (name === '--max-bytes') {
    const maxGb = readNumberArg('--max-gb', Number.NaN);
    if (Number.isFinite(maxGb)) return maxGb * GIB;
  }
  return fallback;
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(nextState) {
  mkdirSync(targetRoot, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
}

function pathSize(path) {
  if (!existsSync(path)) return 0;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;

  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += pathSize(child);
    } else {
      total += lstatSync(child).size;
    }
  }
  return total;
}

function assertInsideDebugRoot(path) {
  if (path !== debugRoot && !path.startsWith(`${debugRoot}${sep}`)) {
    throw new Error(`refusing to prune outside src-tauri/target/debug: ${path}`);
  }
}

function relativeToRepo(path) {
  return path.startsWith(`${repoRoot}${sep}`) ? path.slice(repoRoot.length + 1) : path;
}

function formatBytes(bytes) {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)}GiB`;
  const mib = 1024 ** 2;
  if (bytes >= mib) return `${(bytes / mib).toFixed(0)}MiB`;
  const kib = 1024;
  if (bytes >= kib) return `${(bytes / kib).toFixed(0)}KiB`;
  return `${bytes}B`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'never';
  const hours = ms / (60 * 60 * 1000);
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  const minutes = ms / (60 * 1000);
  return `${minutes.toFixed(0)}m`;
}
