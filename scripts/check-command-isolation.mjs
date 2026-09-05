#!/usr/bin/env node
// Evidence/registration drift gate, not a Rust call-graph or thread-safety proof.
// Run from the repository root. --expected-count also permits tiny test repositories.
// Later producers extend their evidence, never the production command count via overlays.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const PHASE = ".planning/phases/08-main-thread-responsiveness";
const LIB = "src-tauri/src/lib.rs";
const EARLY = new Set(["08-01", "08-02", "08-03", "08-04", "08-05"]);
const INTEGRATIONS = new Map([
  ["src-tauri/src/skill_host/store.rs", "08-29"],
  ["src-tauri/src/skill_host/env.rs", "08-29"],
  ["src-tauri/src/skill_host/dispatch.rs", "08-29"],
  ["src-tauri/src/git.rs", "08-29"],
  ["src-tauri/src/dot_sync.rs", "08-29"],
  ["src-tauri/src/mission_state.rs", "08-16"],
  ["src-tauri/src/agent_host/event_store.rs", "08-17"],
]);
const DISPOSITIONS = new Set(["ISOLATED", "RETAIN", "UI", "BACKGROUND"]);
const SOURCE_REF = /([\w./-]+\.rs)::([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)/g;
const BLOCKING = /\b(?:std::fs|fs|host_fs)::(?:read\w*|write\w*|create\w*|copy|rename|remove\w*|metadata|canonicalize)|\b(?:Command|ProcessCommand)::new|\b(?:thread::sleep|WalkDir::new)|\.lock\s*\(/;
const textOf = (value) => typeof value === "string" ? value : JSON.stringify(value);
const nonempty = (value) => typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 && value.every(nonempty) : value !== null && typeof value === "object" ? Object.keys(value).length > 0 && Object.values(value).every(nonempty) : typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function insist(condition, message) { if (!condition) throw new Error(message); }
function concrete(value, label) {
  insist(nonempty(value), `${label}: empty nested evidence`);
  if (typeof value === "string") insist(!/^(?:TODO|TBD|AUDIT|unresolved|pending|unknown|assumed[- ]safe)(?:\s*$|[.!:])/i.test(value.trim()), `${label}: unresolved placeholder`);
  else if (Array.isArray(value)) value.forEach((item) => concrete(item, label));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => concrete(item, `${label}.${key}`));
}
const nativeCfg = (value) => /#\[cfg\s*\(\s*feature\s*=\s*"native-e2e"\s*\)\]/.test(value);


// Mask comments and literals without changing offsets. Handles nested Rust comments,
// raw strings, ordinary strings, and char literals; lifetimes remain identifiers.
export function maskRust(source) {
  const chars = source.split("");
  let i = 0;
  const mask = (start, end) => { for (let n = start; n < end; n++) if (chars[n] !== "\n") chars[n] = " "; };
  while (i < source.length) {
    const start = i;
    if (source.startsWith("//", i)) {
      i = source.indexOf("\n", i); if (i < 0) i = source.length;
    } else if (source.startsWith("/*", i)) {
      let depth = 1; i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) { depth++; i += 2; }
        else if (source.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
    } else {
      const raw = source.slice(i).match(/^(?:br|r)(#*)"/);
      const char = source.slice(i).match(/^b?'(?:\\.|[^'\\\n])'/);
      if (raw) {
        const end = source.indexOf('"' + raw[1], i + raw[0].length);
        insist(end >= 0, "Unterminated Rust raw string");
        i = end + 1 + raw[1].length;
      } else if (source[i] === '"' || source.startsWith('b"', i)) {
        if (source[i] === "b") i++;
        i++;
        while (i < source.length) {
          if (source[i] === "\\") i += 2;
          else if (source[i++] === '"') break;
        }
      } else if (char) i += char[0].length;
      else { i++; continue; }
    }
    mask(start, i);
  }
  return chars.join("");
}
function closeAt(source, start, left = "{", right = "}") {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === left) depth++;
    if (source[i] === right && --depth === 0) return i;
  }
  throw new Error(`Unbalanced source delimiter at ${start}`);
}
function splitTop(value) {
  const result = [];
  let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    if ("{[(".includes(value[i])) depth++;
    if ("}])".includes(value[i])) depth--;
    if (value[i] === "," && depth === 0) { result.push(value.slice(start, i).trim()); start = i + 1; }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}
function useEntries(expression, prefix = "") {
  return splitTop(expression).flatMap((part) => {
    const brace = part.indexOf("{");
    if (brace >= 0) return useEntries(part.slice(brace + 1, part.lastIndexOf("}")), prefix + part.slice(0, brace));
    const [path, alias] = part.trim().split(/\s+as\s+/);
    return [{ name: alias || path.split("::").at(-1), path: prefix + path }];
  });
}
class Sources {
  constructor(root) { this.root = root; this.cache = new Map(); }
  read(path) {
    insist(typeof path === "string" && !isAbsolute(path) && !relative(this.root, resolve(this.root, path)).startsWith(".."), `Invalid source path: ${path}`);
    insist(existsSync(resolve(this.root, path)), `Missing source/helper path: ${path}`);
    return readFileSync(resolve(this.root, path), "utf8");
  }
  get(path) {
    if (this.cache.has(path)) return this.cache.get(path);
    const raw = this.read(path), code = maskRust(raw);
    const modules = [...code.matchAll(/\bmod\s+(\w+)\s*\{/g)].map((m) => ({ name: m[1], start: m.index, end: closeAt(code, code.indexOf("{", m.index)), prefix: raw.slice(Math.max(code.lastIndexOf("}", m.index), code.lastIndexOf(";", m.index)) + 1, m.index) }));
    const functions = [...code.matchAll(/\b(async\s+)?fn\s+(\w+)\s*(?:<|\()/g)].flatMap((m) => {
      const start = code.indexOf("{", m.index), semi = code.indexOf(";", m.index);
      if (start < 0 || (semi >= 0 && semi < start)) return [];
      const end = closeAt(code, start);
      const ancestors = modules.filter((mod) => mod.start < m.index && mod.end > end);
      const parents = ancestors.map((mod) => mod.name);
      const prefixStart = Math.max(code.lastIndexOf("}", m.index), code.lastIndexOf(";", m.index));
      return [{ name: m[2], symbol: [...parents, m[2]].join("::"), async: Boolean(m[1]), start, end, body: code.slice(start + 1, end), prefix: raw.slice(prefixStart + 1, m.index), native: ancestors.some((mod) => nativeCfg(mod.prefix)) || nativeCfg(raw.slice(prefixStart + 1, m.index)), testOnly: ancestors.some((mod) => /#\[cfg\(test\)\]/.test(mod.prefix)), path }];
    });
    const imports = new Map([...code.matchAll(/\buse\s+([^;]+);/g)].flatMap((m) => useEntries(m[1])).map((entry) => [entry.name, entry.path.replace(/^crate::/, "")]));
    const result = { raw, code, functions, imports };
    this.cache.set(path, result);
    return result;
  }
  symbol(path, symbol) {
    const source = this.get(path);
    const matches = source.functions.filter((fn) => fn.symbol === symbol);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Ambiguous conditional function: ${path}::${symbol}; record platform-specific evidence`);
    return null;
  }
  resolve(path, seen = new Set()) {
    path = path.replace(/^crate::/, "");
    insist(!seen.has(path), `Cyclic source reexport: ${path}`);
    seen.add(path);
    const parts = path.split("::");
    for (let n = parts.length - 1; n >= 0; n--) {
      const base = `src-tauri/src/${parts.slice(0, n).join("/")}`;
      const candidates = n ? [`${base}.rs`, `${base}/mod.rs`] : [LIB];
      for (const file of candidates) {
        if (!existsSync(resolve(this.root, file))) continue;
        const symbol = parts.slice(n).join("::"), fn = this.symbol(file, symbol);
        if (fn) return fn;
        if (parts.length - n === 1) {
          const imported = this.get(file).imports.get(symbol);
          if (imported) {
            const expanded = imported.startsWith("super::") ? [...parts.slice(0, Math.max(0, n - 1)), imported.slice(7)].join("::")
              : [...parts.slice(0, n), imported.replace(/^self::/, "")].join("::");
            try { return this.resolve(expanded, new Set(seen)); } catch { return this.resolve(imported, new Set(seen)); }
          }
        }
      }
    }
    throw new Error(`Unresolved registered function: ${path}`);
  }
  nativeDefinition(fn) {
    if (fn.native) return true;
    const parts = fn.path.replace(/^src-tauri\/src\//, "").replace(/\/mod\.rs$|\.rs$/, "").split("/");
    for (let i = 0; i < parts.length; i++) {
      const parent = i === 0 ? LIB : `src-tauri/src/${parts.slice(0, i).join("/")}/mod.rs`;
      if (!existsSync(resolve(this.root, parent))) continue;
      const raw = this.get(parent).raw;
      if (new RegExp(`#\\[cfg\\s*\\(\\s*feature\\s*=\\s*"native-e2e"\\s*\\)\\]\\s*(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+${escape(parts[i])}\\s*;`).test(raw)) return true;
    }
    return false;
  }
  paths(value) {
    for (const [path] of textOf(value).matchAll(/\b(?:src|src-tauri)\/[\w./-]+\.(?:rs|sh|tsx?)\b/g)) this.read(path);
  }
  refs(value, context, requireRef = true) {
    const refs = [...textOf(value).matchAll(SOURCE_REF)];
    insist(!requireRef || refs.length, `${context}: missing physical source path + symbol`);
    for (const [, path, symbol] of refs) {
      const source = this.get(path), name = symbol.split("::").at(-1);
      insist(this.symbol(path, symbol) || new RegExp(`\\b(?:struct|enum|trait|type|const|static)\\s+${escape(name)}\\b`).test(source.code), `${context}: missing physical symbol ${path}::${symbol}`);
    }
    // Bare source citations in prose must exist too.
    this.paths(value);
    return refs;
  }
}
function registrations(sources) {
  const { raw, code, imports } = sources.get(LIB), result = [];
  for (const m of code.matchAll(/\bgenerate_handler!\s*\[/g)) {
    const start = code.indexOf("[", m.index), end = closeAt(code, start, "[", "]");
    for (const item of splitTop(raw.slice(start + 1, end).replace(/\/\/[^\n]*/g, ""))) {
      const attrs = [...item.matchAll(/#\[[\s\S]*?\]/g)].map((v) => v[0]).join(" ");
      const path = item.replace(/#\[[\s\S]*?\]/g, "").trim();
      insist(/^(?:\w+::)*\w+$/.test(path), `Unparsed generate_handler registration: ${item}`);
      const fn = sources.resolve(path.includes("::") ? path : imports.get(path) || path);
      result.push({ name: path.split("::").at(-1), fn, canonical: `${LIB}::${fn.path.replace(/^src-tauri\/src\//, "").replace(/\/mod\.rs$|\.rs$/, "").replaceAll("/", "::")}::${fn.symbol}`, native: nativeCfg(attrs) || sources.get(LIB).functions.some((entry) => entry.native && entry.start < m.index && entry.end > end) });
    }
  }
  insist(result.length, "No generate_handler registrations found");
  return result;
}
function inventory(sources) {
  const rows = new Map();
  for (const line of sources.read(`${PHASE}/08-COMMAND-INVENTORY.md`).split("\n")) {
    const m = line.match(/^\| `([^`]+)` \| `([^`]+\.rs):\d+` \|[^|]+\| \*\*(\w+)\*\*/);
    if (!m) continue;
    insist(!rows.has(m[1]), `Duplicate inventory command: ${m[1]}`);
    rows.set(m[1], { module: m[2], originalDisposition: m[3] });
  }
  insist(rows.size, "Empty research inventory");
  return rows;
}
function ownership(sources) {
  const owners = new Map();
  for (const line of sources.read(`${PHASE}/08-PLAN-MAP.md`).split("\n")) {
    const match = line.match(/^\| (08-\d\d) \| `([^`]+\.rs)` \| (.+) \|$/);
    if (!match) continue;
    for (const [, name] of match[3].matchAll(/`(\w+)`/g)) {
      insist(!owners.has(name), `Duplicate ownership: ${name}`);
      owners.set(name, { plan: match[1], module: match[2] });
    }
  }
  insist(owners.size, "Empty exact ownership table");
  return owners;
}
function validateTests(row, sources, label) {
  insist(Array.isArray(row.tests) && row.tests.length, `${label}: missing tests`);
  const successful = row.tests.filter((test) => {
    insist(nonempty(test.command), `${label}: missing test/check command`);
    if ("exitCode" in test) insist(test.exitCode === 0, `${label}: failed recorded check`);
    if ("passed" in test) {
      insist(Number.isInteger(test.passed) && test.passed > 0 && test.failed === 0 && (test.ignored ?? 0) === 0 && (test.skipped ?? 0) === 0, `${label}: zero/failed/skipped behavioral tests`);
      return /\b(?:test|vitest)\b|test:|test-/.test(test.command);
    }
    return false;
  });
  insist(successful.length, `${label}: no nonzero passing behavioral tests`);
  // Case records must resolve to actual test functions, not just compile/check output.
  const evidence = textOf(row.evidence);
  const functions = sources.get(row.module).functions;
  const cases = functions.filter((fn) => /#\[(?:\w+::)*test(?:\(|\])/.test(fn.prefix) && new RegExp(`\\b${escape(fn.name)}\\b`).test(evidence));
  insist(cases.length, `${label}: missing physical behavior-test names in evidence`);
  for (const [key, value] of Object.entries(row.evidence)) {
    if (!/(?:Cases|Case)$/.test(key)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      const symbol = typeof item === "string" ? item.match(/^[\w:]+/)?.[0] : null;
      insist(symbol && cases.some((fn) => fn.symbol === symbol || fn.symbol.endsWith(`::${symbol}`) || fn.name === symbol), `${label}: missing physical named case ${symbol || key}`);
    }
  }
  insist(cases.some((fn) => successful.some((test) => {
    if (!test.command.startsWith("cargo test ")) return false;
    const selector = test.command.match(/--lib\s+(?!-)([\w:]+)/)?.[1];
    return selector && (`${fn.path}::${fn.symbol}`.includes(selector) || fn.name.includes(selector));
  })), `${label}: named behavior test is not covered by a recorded passing selector`);
}
function reachable(fn, sources) {
  const queue = [fn], visited = new Map();
  while (queue.length) {
    const current = queue.shift(), key = `${current.path}::${current.symbol}`;
    if (visited.has(key)) continue;
    visited.set(key, current);
    for (const [, name] of current.body.matchAll(/\b([A-Za-z_]\w*)\s*(?:!|::\s*<[^;{}]*>)?\s*\(/g)) {
      const choices = sources.get(current.path).functions.filter((entry) => entry.name === name && !entry.testOnly && entry !== current);
      if (choices.length === 1) queue.push(choices[0]);
    }
  }
  return [...visited.values()];
}
function validateRow(row, shard, state) {
  const { sources, rows, owners, registered, all } = state, label = `${shard.plan}/${row.name}`;
  const original = rows.get(row.name), owner = owners.get(row.name), registration = registered.get(row.name);
  insist(original && owner && registration, `${label}: unknown/unowned/unregistered command`);
  insist(owner.plan === shard.plan && owner.module === row.module && original.module === row.module, `${label}: wrong exclusive owner/module`);
  insist(row.originalDisposition === original.originalDisposition, `${label}: changed original disposition`);
  insist(row.registrationPath === registration.canonical && registration.fn.path === row.module, `${label}: stale registrationPath (current ${registration.canonical})`);
  insist(DISPOSITIONS.has(row.disposition), `${label}: unresolved/AUDIT disposition`);
  for (const field of ["helperChain", "workerBoundary", "syncCallers", "mutationKey", "processingCaller", "evidence"]) {
    let value = row[field];
    if (field === "mutationKey" && value?.readOnly === true) {
      insist(/no (?:filesystem )?mutation|read.only/i.test(textOf(value)), `${label}: readOnly requires positive no-mutation evidence`);
      value = Object.fromEntries(Object.entries(value).filter(([key, item]) => !(["lexicalPaths", "aliasPaths"].includes(key) && Array.isArray(item) && item.length === 0)));
    }
    insist(nonempty(value), `${label}: empty ${field}`); concrete(value, `${label}.${field}`);
  }
  insist(Array.isArray(row.helperChain) && Array.isArray(row.syncCallers), `${label}: helperChain/syncCallers must be arrays`);
  // Existing 02 records helper names relative to its row.module; resolve those too.
  const chain = textOf(row.helperChain), chainRefs = sources.refs(row.helperChain, label, false);
  const mentioned = sources.get(row.module).functions.filter((fn) => new RegExp(`\\b${escape(fn.name)}\\b`).test(chain));
  insist(chainRefs.length || mentioned.length >= 2, `${label}: helperChain lacks physical helper symbols`);
  for (const entry of row.helperChain) insist(!/^(?:unknown|pending|unresolved|assumed.safe|TODO|TBD)$/i.test(entry.trim()), `${label}: unresolved helperChain`);
  sources.refs(row.workerBoundary, `${label} workerBoundary`, row.disposition === "ISOLATED");
  const graph = reachable(registration.fn, sources);
  if (row.originalDisposition === "CONVERT") insist(row.disposition === "ISOLATED", `${label}: CONVERT requires ISOLATED`);
  if (row.disposition === "ISOLATED") {
    insist(registration.fn.async, `${label}: blocking command(async)/sync registration is not async fn`);
    insist(/\bspawn_blocking\b/.test(registration.fn.body) && /\bspawn_blocking\b/.test(textOf(row.workerBoundary)), `${label}: missing actual spawn_blocking boundary`);
    insist(/\.await\b/.test(registration.fn.body), `${label}: worker boundary must await completion`);
    const preamble = registration.fn.body.slice(0, registration.fn.body.indexOf("spawn_blocking"));
    insist(!BLOCKING.test(preamble), `${label}: blocking work before spawn_blocking`);
    const delegates = graph.filter((fn) => fn !== registration.fn);
    if (delegates.length) insist(delegates.some((fn) => new RegExp(`\\b${escape(fn.name)}\\b`).test(chain)), `${label}: omitted indirect helper from reviewed chain`);
  } else {
    const reason = textOf(row.workerBoundary) + " " + (row.evidence.bounds || "") + " " + (row.evidence.affinity || "") + " " + (row.evidence.lifetime || "");
    insist(row.disposition !== "RETAIN" || /bound|limit|maximum|fixed|pure/i.test(reason), `${label}: RETAIN lacks positive bound`);
    insist(row.disposition !== "UI" || /main.thread|affinity|platform|dispatch/i.test(reason), `${label}: UI lacks positive affinity`);
    insist(row.disposition !== "BACKGROUND" || (/setup/i.test(reason) && /stop|shutdown/i.test(reason)), `${label}: BACKGROUND lacks setup/stop reasoning`);
    if (row.disposition !== "BACKGROUND") insist(!graph.some((fn) => BLOCKING.test(fn.body)), `${label}: blocking operation in retained/UI helper chain; isolate finite work`);
  }
  const staged = EARLY.has(shard.plan) && INTEGRATIONS.get(row.module) === "08-29";
  if (!staged) insist(shard.moduleIntegrationOwner === shard.plan, `${label}: wrong final moduleIntegrationOwner`);
  if (staged) insist(shard.integrationRequired === "08-29" && shard.moduleIntegrationOwner === "08-29", `${label}: missing explicit 08-29 integration obligation/owner`);
  const key = row.mutationKey;
  if (!(key?.readOnly === true || /\bno mutation\b|\bread.only\b/i.test(textOf(key)))) {
    for (const field of ["lexicalPaths", "aliasPaths", "postAdmissionPreconditions", "domainLockOrder", "sharedAdmissionEntry"]) insist(nonempty(key[field]), `${label}: missing mutationKey.${field}`);
    if (!staged || all) {
      const overlay = state.overlay?.integrations.find((entry) => entry.module === row.module);
      insist(overlay || !/integrationRequired|pending|08-29/i.test(key.sharedAdmissionEntry), `${label}: pending integration`);
      if (!overlay) {
        sources.refs(key.sharedAdmissionEntry, `${label} shared admission`);
        insist(/before/i.test(key.domainLockOrder), `${label}: admission must precede domain locks`);
      }
    }
  }
  for (const field of ["path", "payload", "terminalNoticeOwner"]) insist(nonempty(row.processingCaller[field]), `${label}: missing processingCaller.${field}`);
  sources.paths(row.processingCaller.path);
  if (all) {
    for (const field of ["classifier", "successRetention", "failureReasons"]) insist(nonempty(row.processingCaller[field]), `${label}: final processingCaller missing ${field}`);
    insist(row.processingCaller.singleTerminalNoticeOwner === true, `${label}: final processingCaller requires a single terminal-notice owner`);
  }
  validateTests(row, sources, label);
}

// Overlay inner records are deliberately explicit: refs are path.rs::symbol strings;
// commandRefs are {module,name}; testCases have entryPair:[a,b], orders:[a,b],
// aliases:["lexical","symlink","ancestor"], failureRelease, outcome, tests and evidence.
// networkRegistryAvailability: {networkWork:boolean, evidence:sourceRef, ...}.
// Network entries require registryReleasedDuringNetwork/AdmissionWait and
// listAndMetadataRemoveProgress=true; store also sourceDuplicateReturnsBusy and
// batchBusySourceSkipped=true. Non-network entries instead state reason.
// lifetime: {scope:"finite"|"background", admissionHeldThroughEffects:true,
// admissionHeldThroughRollback:true, evidence:sourceRef}; background additionally
// requires backgroundCallbacksCovered:true. Store/git writeSetCoverage requires
// wholeCheckout/gitDirectory/gitCommonDirectory/stagingRollback/registrySidecars=true.
// Final 16/17 moduleIntegrations: {integrationId,status:"complete",module,
// entrySymbols:[sourceRef],tests:[run],evidence:{behaviorCases:[physicalTestName]}}.
// Final processingCaller additionally records classifier, successRetention,
// failureReasons and singleTerminalNoticeOwner:true (producer 25/26 closure).
// documentRaceConsumer carries these six requiredPairs as a future 07 obligation;
// crossDomainConsumers in shard 07 carries {integration,selector,testCases} results.
const WRITERS = ["skills_save_skill_file", "skills_sync_source", "git_sync_pull_rebase"];
const DOCUMENTS = ["save_document", "create_document"];
function requirePairs(cases, right, label, actual, sources) {
  insist(Array.isArray(cases) && cases.length, `${label}: missing test cases/pairs`);
  for (const writer of WRITERS) for (const target of right) {
    const record = cases.find((entry) => Array.isArray(entry.entryPair) && entry.entryPair.length === 2 && entry.entryPair[0].split("::").at(-1) === writer && entry.entryPair[1].split("::").at(-1) === target);
    insist(record, `${label}: missing ${writer}/${target} pair`);
    insist(Array.isArray(record.orders) && record.orders.length === 2 && new Set(record.orders).size === 2 && record.orders.includes("writer-first") && record.orders.includes("other-first"), `${label}: missing both admission orders`);
    insist(Array.isArray(record.aliases) && record.aliases.includes("lexical") && record.aliases.includes("symlink") && record.aliases.includes("ancestor"), `${label}: missing lexical/symlink/ancestor variants`);
    if (actual) {
      sources.refs(record.entryPair, `${label} actual entry pair`);
      insist(nonempty(record.failureRelease) && nonempty(record.outcome), `${label}: missing failure release/outcome`);
      validateTests(record, sources, label);
    }
  }
}
function validateOverlay(overlay, state) {
  const { sources, owners, rows, all } = state;
  insist(overlay.plan === "08-29" && overlay.commandCount === rows.size, "08-29 overlay: wrong plan/commandCount");
  insist(!("commands" in overlay), "08-29 overlay cannot inject commands");
  insist(Array.isArray(overlay.integrations) && overlay.integrations.length === 7, "08-29 overlay requires exactly seven module integrations");
  const modules = new Set(), ids = new Set();
  for (const entry of overlay.integrations) {
    insist(nonempty(entry.id) && !ids.has(entry.id), "08-29 overlay duplicate/empty integration ID"); ids.add(entry.id);
    insist(INTEGRATIONS.has(entry.module) && !modules.has(entry.module), `08-29 duplicate/unknown module ${entry.module}`); modules.add(entry.module);
    insist(!("commands" in entry), "08-29 integration cannot inject commands");
    insist(entry.stageOwner === "08-29" && entry.finalModuleOwner === INTEGRATIONS.get(entry.module), `08-29 conflicting ownership: ${entry.module}`);
    for (const field of ["entrySymbols", "commandRefs", "admissionEntry", "pathSources", "lexicalPaths", "aliasPaths", "parentPreconditions", "sourceReservationOrder", "domainLockOrder", "lifetime", "networkRegistryAvailability", "testCases", "evidence"]) insist(nonempty(entry[field]), `08-29 ${entry.module}: missing ${field}`);
    sources.refs(entry.entrySymbols, "08-29 entrySymbols"); sources.refs(entry.admissionEntry, "08-29 admissionEntry"); sources.refs(entry.pathSources, "08-29 pathSources");
    insist(/before/i.test(textOf(entry.domainLockOrder)), `08-29 ${entry.module}: missing admission-before-domain-lock order`);
    concrete(entry, `08-29 ${entry.module}`);
    const network = entry.networkRegistryAvailability;
    const checkoutWriter = entry.module.endsWith("/store.rs") || entry.module.endsWith("/git.rs");
    if (checkoutWriter) insist(network.networkWork === true, "08-29 store/git must prove network registry availability");
    insist(typeof network === "object" && typeof network.networkWork === "boolean", "08-29 network availability must declare networkWork");
    if (network.networkWork) {
      for (const field of ["registryReleasedDuringNetwork", "registryReleasedDuringAdmissionWait", "listAndMetadataRemoveProgress"]) insist(network[field] === true, `08-29 network registry exclusion violation: ${field}`);
      if (entry.module.endsWith("/store.rs")) for (const field of ["sourceDuplicateReturnsBusy", "batchBusySourceSkipped"]) insist(network[field] === true, `08-29 network source regression: ${field}`);
    } else insist(nonempty(network.reason), "08-29 non-network entry requires positive reason");
    sources.refs(network.evidence, "08-29 network availability evidence");
    const lifetime = entry.lifetime;
    if (/\/(?:env|dispatch)\.rs$/.test(entry.module)) insist(lifetime.scope === "background", "08-29 env/dispatch require background callback lifetime");
    insist(lifetime && ["finite", "background"].includes(lifetime.scope) && lifetime.admissionHeldThroughEffects === true && lifetime.admissionHeldThroughRollback === true, "08-29 incomplete admission lifetime");
    if (lifetime.scope === "background") insist(lifetime.backgroundCallbacksCovered === true, "08-29 missing background callback admission lifetime");
    sources.refs(lifetime.evidence, "08-29 lifetime evidence");
    if (entry.module.endsWith("/store.rs") || entry.module.endsWith("/git.rs")) {
      for (const field of ["wholeCheckout", "gitDirectory", "gitCommonDirectory", "stagingRollback", "registrySidecars"]) insist(entry.writeSetCoverage?.[field] === true, `08-29 abbreviated write set: ${field}`);
    }
    insist(Array.isArray(entry.commandRefs), "08-29 commandRefs must be an array");
    for (const ref of entry.commandRefs) insist(rows.has(ref.name) && owners.get(ref.name)?.module === ref.module && ref.module === entry.module, `08-29 invalid command reference ${ref.name}`);
    insist(Array.isArray(entry.testCases) && entry.testCases.length, "08-29 missing produced testCases");
    for (const record of entry.testCases) {
      sources.refs(record.entryPair, "08-29 actual entryPair");
      insist(record.orders?.includes("writer-first") && record.orders?.includes("other-first") && record.aliases?.includes("lexical") && record.aliases?.includes("symlink") && record.aliases?.includes("ancestor"), "08-29 test case missing orders/aliases");
      insist(nonempty(record.failureRelease) && nonempty(record.outcome), "08-29 test case missing failure release/outcome");
      validateTests(record, sources, "08-29 produced tests");
    }
    if (all && entry.finalModuleOwner !== "08-29") {
      const handoff = state.shards.find((shard) => shard.plan === entry.finalModuleOwner)?.moduleIntegrations;
      const record = handoff?.find((item) => item.integrationId === entry.id && item.status === "complete");
      insist(record && record.module === entry.module, `08-29 missing ${entry.finalModuleOwner} completed handoff`);
      concrete(record, "08-29 final handoff");
      sources.refs(record.entrySymbols, "08-29 final handoff entrySymbols");
      validateTests(record, sources, "08-29 final handoff");
    }
  }
  requirePairs(overlay.integrations.flatMap((entry) => entry.testCases), ["rename_workspace_entry", "trash_workspace_entries"], "08-29 parent races", true, sources);
  const consumer = overlay.documentRaceConsumer;
  insist(consumer?.plan === "08-07" && consumer.selector === "phase08_07_earlier_writer_document_races", "08-29 missing exact 07 document consumer obligation");
  requirePairs(consumer.requiredPairs, DOCUMENTS, "08-29 document obligation", false, sources);
  if (all) {
    const consumers = state.shards.find((shard) => shard.plan === "08-07")?.crossDomainConsumers;
    const result = consumers?.find((entry) => entry.integration === "08-29" && entry.selector === consumer.selector);
    insist(result, "Missing actual 07 crossDomainConsumers evidence");
    requirePairs(result.testCases, DOCUMENTS, "07 document consumer", true, sources);
  }
}
export function parseArgs(argv) {
  const options = { expectedCount: 365 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") { insist(!options.all, "Duplicate --all"); options.all = true; }
    else if (["--plan", "--integration", "--expected-count"].includes(arg)) {
      const value = argv[++i];
      insist(value && /^\d+$/.test(value), `${arg} requires a positive number`);
      const field = { "--plan": "plan", "--integration": "integration", "--expected-count": "expectedCount" }[arg];
      insist(field === "expectedCount" || !options[field], `Duplicate ${arg}`);
      if (field === "expectedCount") { insist(Number(value) > 0, "--expected-count must be positive"); options[field] = Number(value); }
      else options[field] = value.padStart(2, "0");
    } else throw new Error(`Unknown argument ${arg}`);
  }
  insist([Boolean(options.plan), Boolean(options.all), Boolean(options.integration)].filter(Boolean).length === 1, "Choose exactly one: --plan NN, --all, --integration 29");
  insist(!options.integration || options.integration === "29", "Only --integration 29 is defined");
  insist(!options.plan || (+options.plan >= 1 && +options.plan <= 24), "Command shard plan must be 01-24");
  return options;
}
export function checkIsolation(options, root = process.cwd()) {
  const sources = new Sources(resolve(root));
  const rows = inventory(sources), owners = ownership(sources);
  const readJson = (path) => JSON.parse(sources.read(path));
  const changesPath = "docs/performance/phase08-registration-changes.json";
  if (existsSync(resolve(root, changesPath))) {
    const changes = readJson(changesPath);
    insist(changes.baselineCount === 365 && rows.size === 365 && Array.isArray(changes.additions) && !changes.removals?.length, "Registration reconciliation must preserve the 365 baseline");
    for (const addition of changes.additions) {
      insist(!rows.has(addition.name) && nonempty(addition.reason) && owners.get(addition.name)?.plan === addition.owner && owners.get(addition.name)?.module === addition.module && DISPOSITIONS.has(addition.originalDisposition), "Invalid explicit new production registration/owner");
      rows.set(addition.name, addition);
    }
  }
  insist(rows.size === options.expectedCount, `Inventory count ${rows.size} differs from expected ${options.expectedCount}`);
  for (const [name, row] of rows) insist(owners.get(name)?.module === row.module, `Missing/mismatched inventory owner ${name}`);
  insist(owners.size === rows.size, "Ownership/inventory count mismatch");
  const nativePath = "docs/performance/phase08-native-allowlist.json";
  const native = existsSync(resolve(root, nativePath)) ? readJson(nativePath).commands : [];
  insist(Array.isArray(native), "Native allowlist commands must be an array");
  const registered = new Map(), seenNative = new Set();
  for (const reg of registrations(sources)) {
    if (reg.native) {
      insist(sources.nativeDefinition(reg.fn), `Native command definition is not feature-gated: ${reg.name}`);
      const entry = native.find((candidate) => candidate.name === reg.name);
      insist(!rows.has(reg.name) && !seenNative.has(reg.name) && entry?.feature === "native-e2e" && entry.registrationPath === reg.canonical && nonempty(entry.reason), `Native feature command missing separate allowlist: ${reg.name}`);
      seenNative.add(reg.name);
    } else {
      insist(!registered.has(reg.name), `Duplicate production registration ${reg.name}`);
      insist(rows.has(reg.name), `New production registration needs explicit reconciliation: ${reg.name}`);
      registered.set(reg.name, reg);
    }
  }
  insist(native.length === seenNative.size, "Stale/duplicate native command allowlist");
  insist(registered.size === rows.size, `Current production registration count ${registered.size} differs from inventory ${rows.size}`);
  const files = readdirSync(resolve(root, "docs/performance")).filter((file) => /^phase08-\d\d\.json$/.test(file));
  const shards = files.map((file) => {
    const shard = readJson(`docs/performance/${file}`);
    insist(shard.plan === `08-${file.slice(8, 10)}` && Array.isArray(shard.commands), `Invalid shard identity/schema: ${file}`);
    return shard;
  });
  const state = { sources, rows, owners, registered, shards, all: Boolean(options.all) };
  if (options.all || options.integration) {
    state.overlay = readJson("docs/performance/phase08-29-integration.json");
    validateOverlay(state.overlay, state);
  }
  const selected = options.plan ? shards.filter((shard) => shard.plan === `08-${options.plan}`) : options.all ? shards : [];
  insist(!options.plan || selected.length === 1, `Missing evidence shard 08-${options.plan}`);
  const seen = new Set();
  for (const shard of selected) {
    insist(nonempty(shard.moduleIntegrationOwner), `${shard.plan}: missing moduleIntegrationOwner`);
    const expected = [...owners].filter(([, owner]) => owner.plan === shard.plan).map(([name]) => name);
    insist(shard.commands.length === expected.length && expected.length > 0, `${shard.plan}: missing/extra exact owned commands (expected ${expected.length}, got ${shard.commands.length})`);
    for (const row of shard.commands) {
      insist(!seen.has(row.name), `Duplicate evidence command ${row.name}`); seen.add(row.name);
      validateRow(row, shard, state);
    }
  }
  if (options.all) insist(seen.size === rows.size, `Incomplete command closure: ${seen.size}/${rows.size}`);
  return { commands: seen.size, production: registered.size, native: seenNative.size, integration: Boolean(state.overlay), scope: options.plan ? `08-${options.plan}` : options.integration ? "08-29 integration" : "all" };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkIsolation(parseArgs(process.argv.slice(2)));
    console.log(`command-isolation: PASS ${result.scope}; ${result.commands} command evidence rows, ${result.production} production registrations, ${result.native} native-only commands. Source scans are drift alarms; recorded behavioral evidence is not re-executed by this gate.`);
  } catch (error) {
    console.error(`command-isolation: FAIL ${error.message}`);
    process.exitCode = 1;
  }
}
