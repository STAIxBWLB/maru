#!/usr/bin/env node
/**
 * mode-css-ownership — produced-artifact guard for the mode CSS split
 * (PERF-05, phase 10 plan 02).
 *
 * Every mode's pane CSS moved out of src/styles.css into per-mode files
 * (src/components/{today,meetings,tasks,calendar,drafts,gap,agents}) and
 * rides that mode's lazy chunk: the component imports its CSS, and Vite
 * 7.3.2 (default cssCodeSplit) hoists the import into that mode's lazy CSS
 * chunk. styles.css keeps only entry-side shared chrome (shell grid-area
 * placements, container-query overrides, the shared pane-resize-handle
 * rules, tokens, FOUC block).
 *
 * Vite's esbuild pipeline forces legalComments: "none", so the marker text
 * `/*! maru:mode:<id> *` exists in SRC only and never survives into dist.
 * The dist side is therefore asserted by ownership fingerprints:
 *
 *   1. RED LIST      — the entry chunk (index-*.css) must carry zero
 *                      markers and zero per-mode pane-root signatures: no
 *                      mode's pane CSS may leak back into the entry CSS.
 *   2. FULL INVENTORY — every registered mode id (hardcoded 18-mode list;
 *                      keep in sync with modeRegistry.getRegisteredModeIds())
 *                      either has a marker-bearing per-mode CSS file whose
 *                      ownership fingerprint is verified in exactly one
 *                      produced CSS chunk, or is on the documented
 *                      NO_PER_MODE_CSS exception list.
 *   3. NO CROSS-CHUNK DUPLICATES — a per-mode file's ownership fingerprint
 *                      must appear in exactly one dist chunk (calendar.css
 *                      rides the shared fromEntries-*.css chunk in the CSS
 *                      dep graph of both MeetingsModeAdapter and
 *                      TasksModeAdapter; the rules are still emitted once).
 *   4. MISSING MARKER — every marker-bearing per-mode CSS file under
 *                      src/components must land in some produced dist CSS
 *                      chunk (an unimported per-mode file is a silent
 *                      split defeat).
 *   5. ORPHANED MARKER — a marker id outside the known inventory is a
 *                      violation (keep the inventory in sync).
 *
 * Hermetic — node builtins only, reads dist/assets and src/components.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DIST_ASSETS_DIR = path.resolve("dist/assets");
const SRC_COMPONENTS_DIR = path.resolve("src/components");

/** Raw-text marker scan (markers live in comments; a raw scan cannot false-positive). */
const MARKER_SCAN = /\/\*!\s*maru:mode:([a-z0-9-]+)\s*\*\//g;

/**
 * Keep in sync with src/lib/modeRegistry.tsx getRegisteredModeIds().
 * The 18 registered production modes; the subset with a marker-bearing
 * per-mode CSS file must pass FULL INVENTORY via that file's ownership
 * fingerprint.
 */
const REGISTERED_MODE_IDS = [
  "pkm",
  "e2e",
  "diagram",
  "graph",
  "sites",
  "agents",
  "inbox",
  "comms",
  "meetings",
  "today",
  "tasks",
  "dashboard",
  "scratchpad",
  "drafts",
  "gap",
  "files",
  "studio",
  "catalog",
];

/**
 * Documented exception list for FULL INVENTORY (plan-allowed): registered
 * modes without a marker-bearing per-mode CSS file.
 *   - pkm/e2e/sites/inbox/comms/dashboard/scratchpad/files/studio/catalog
 *     keep their rules entry-side in styles.css per the D-02 boundary review.
 *   - diagram/graph colocate markerless CSS (src/components/{diagram,graph})
 *     that is not gated yet (see the Makefile check-type-tokens comment).
 */
const NO_PER_MODE_CSS = [
  "pkm",
  "e2e",
  "diagram",
  "graph",
  "sites",
  "inbox",
  "comms",
  "dashboard",
  "scratchpad",
  "files",
  "studio",
  "catalog",
];

/**
 * Marker-bearing per-mode CSS file, its marker id, and its ownership
 * fingerprint: a selector prefix (the pane root class) that must appear in
 * exactly one owning dist chunk.
 */
const PER_MODE_FINGERPRINTS = [
  { id: "today", file: "src/components/today/today.css", selector: ".today-pane" },
  { id: "meetings", file: "src/components/meetings/meetings-pane.css", selector: ".meetings-pane" },
  { id: "tasks", file: "src/components/tasks/tasks.css", selector: ".tasks-pane" },
  { id: "calendar", file: "src/components/calendar/calendar.css", selector: ".unified-calendar" },
  { id: "drafts", file: "src/components/drafts/drafts.css", selector: ".drafts-pane" },
  { id: "gap", file: "src/components/gap/gap.css", selector: ".gap-pane" },
  { id: "agents", file: "src/components/agents/agents.css", selector: ".agents-pane" },
];

/**
 * Pane-root rule identity per mode: the body prefix of the esbuild-minified
 * pane-root rule (the first rule of each per-mode file). Shell chrome
 * legitimately carries the bare selectors (grid-area placements,
 * container-query overrides, :is() compounds) but never these rule bodies.
 * Used by both the RED LIST (entry chunk) and NO CROSS-CHUNK DUPLICATES
 * (owning chunk) assertions: the pane-root rule, not the bare selector,
 * is the ownership fingerprint. Must stay in sync with the first rule of
 * each per-mode file.
 */
const PANE_ROOT_BODY_PREFIX = {
  ".today-pane": "display:grid",
  ".meetings-pane": "--meetings-event-1",
  ".tasks-pane": "grid-area:tasks;display:grid",
  ".unified-calendar": "display:grid",
  ".drafts-pane": "display:flex",
  ".gap-pane": "display:flex",
  ".agents-pane": "display:flex",
};

/**
 * Sanctioned co-located rules on the same selector in styles.css: the
 * shell-grid grid-area placement and the secondaryworkbench container
 * override. A bare `${selector}{` hit matching neither the pane-root body
 * prefix nor one of these exceptions is a leak.
 */
const ENTRY_SELECTOR_EXCEPTION_BODIES = ["grid-area:", "grid-template-columns:minmax(0,1fr)"];

/** Body window sliced after a `${selector}{` hit; long enough for every body-prefix and exception comparison. */
const BODY_WINDOW = 80;

async function collectCssFiles(dir) {
  const files = [];
  let current = [dir];
  while (current.length > 0) {
    const next = [];
    for (const entry of await readdir(current[0], { withFileTypes: true })) {
      const full = path.join(current[0], entry.name);
      if (entry.isDirectory()) {
        next.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".css")) {
        files.push(full);
      }
    }
    current = current.slice(1).concat(next);
  }
  return files.sort();
}

function firstMarker(text) {
  MARKER_SCAN.lastIndex = 0;
  return [...text.matchAll(MARKER_SCAN)][0] ?? null;
}

async function main() {
  let chunkNames;
  try {
    chunkNames = (await readdir(DIST_ASSETS_DIR)).filter((f) => f.endsWith(".css"));
  } catch {
    console.error(
      "mode-css-ownership: dist/assets not found — run `pnpm build:frontend` first, then re-run this guard",
    );
    process.exit(1);
  }
  if (chunkNames.length === 0) {
    console.error(
      "mode-css-ownership: no CSS chunks in dist/assets — run `pnpm build:frontend` first, then re-run this guard",
    );
    process.exit(1);
  }

  const violations = [];
  const chunkTexts = new Map();
  for (const name of chunkNames) {
    chunkTexts.set(name, await readFile(path.join(DIST_ASSETS_DIR, name), "utf8"));
  }

  // Assertion 1: RED LIST — the entry chunk carries zero markers and zero
  // per-mode pane-root rules. Bare selector hits are allowed only when the
  // rule body matches a sanctioned shell-chrome exception (grid-area
  // placement, container override).
  const entryChunks = chunkNames.filter((f) => /^index-.*\.css$/.test(f));
  for (const name of entryChunks) {
    const text = chunkTexts.get(name);
    MARKER_SCAN.lastIndex = 0;
    const entryMarkers = [...text.matchAll(MARKER_SCAN)].map((m) => m[1]);
    if (entryMarkers.length > 0) {
      violations.push(
        `RED LIST: entry chunk ${name} carries maru:mode markers: ${entryMarkers.join(", ")} — entry CSS must hold only shared chrome`,
      );
    }
    for (const fingerprint of PER_MODE_FINGERPRINTS) {
      const { selector } = fingerprint;
      const bodyPrefix = PANE_ROOT_BODY_PREFIX[selector];
      let searchFrom = 0;
      while (true) {
        const idx = text.indexOf(`${selector}{`, searchFrom);
        if (idx < 0) {
          break;
        }
        const bodyStart = idx + selector.length + 1;
        const body = text.slice(bodyStart, bodyStart + BODY_WINDOW);
        if (body.startsWith(bodyPrefix)) {
          violations.push(
            `RED LIST: entry chunk ${name} carries the ${fingerprint.id} pane-root rule — that mode's CSS leaked into the entry CSS`,
          );
        } else if (!ENTRY_SELECTOR_EXCEPTION_BODIES.some((exc) => body.startsWith(exc))) {
          violations.push(
            `RED LIST: entry chunk ${name} carries an unrecognized rule on ${selector} (${body.slice(0, 40)}...) — not a sanctioned shell-chrome exception`,
          );
        }
        searchFrom = idx + 1;
      }
    }
  }
  if (entryChunks.length !== 1) {
    violations.push(
      `RED LIST: expected exactly one entry chunk (index-*.css), found ${entryChunks.length}: ${entryChunks.join(", ") || "(none)"}`,
    );
  }

  // Marker-bearing per-mode src files (raw-text scan).
  const srcCssFiles = await collectCssFiles(SRC_COMPONENTS_DIR);
  const srcMarkerIds = new Map();
  for (const file of srcCssFiles) {
    const match = firstMarker(await readFile(file, "utf8"));
    if (match) {
      srcMarkerIds.set(file, match[1]);
    }
  }

  // Assertion 5: ORPHANED MARKER — a marker id outside the known inventory
  // (registered modes plus the calendar marker, which is not a mode id).
  const knownIds = new Set([...REGISTERED_MODE_IDS, "calendar"]);
  for (const [file, id] of srcMarkerIds) {
    if (!knownIds.has(id)) {
      violations.push(
        `ORPHANED MARKER: ${file} carries maru:mode:${id} — not in the mode inventory (keep REGISTERED_MODE_IDS in sync with modeRegistry.getRegisteredModeIds())`,
      );
    }
  }

  // Assertions 2 + 3 + 4: per-mode file ownership.
  for (const fingerprint of PER_MODE_FINGERPRINTS) {
    const srcText = await readFile(path.resolve(fingerprint.file), "utf8");
    const markerMatch = firstMarker(srcText);
    if (!markerMatch) {
      violations.push(
        `MISSING MARKER: ${fingerprint.file} carries no maru:mode:${fingerprint.id} marker — the per-mode file header was removed`,
      );
      continue;
    }
    if (markerMatch[1] !== fingerprint.id) {
      violations.push(
        `ORPHANED MARKER: ${fingerprint.file} carries maru:mode:${markerMatch[1]}, expected maru:mode:${fingerprint.id}`,
      );
    }

    const owningChunks = [];
    const bodyPrefix = PANE_ROOT_BODY_PREFIX[fingerprint.selector];
    for (const [name, text] of chunkTexts) {
      if (name.startsWith("index-")) {
        continue; // the entry chunk is the red list, not an owning chunk
      }
      let searchFrom = 0;
      while (true) {
        const idx = text.indexOf(`${fingerprint.selector}{`, searchFrom);
        if (idx < 0) {
          break;
        }
        const bodyStart = idx + fingerprint.selector.length + 1;
        const body = text.slice(bodyStart, bodyStart + BODY_WINDOW);
        if (body.startsWith(bodyPrefix)) {
          owningChunks.push(name);
        }
        searchFrom = idx + 1;
      }
    }

    if (owningChunks.length === 0) {
      violations.push(
        `MISSING MARKER: no produced dist chunk carries ${fingerprint.file}'s ownership fingerprint (${fingerprint.selector}{) — the per-mode file was never imported by any component (silent split defeat)`,
      );
      continue;
    }

    // Assertion 3: NO CROSS-CHUNK DUPLICATES — the mode's pane root rule
    // must be defined in exactly one chunk. calendar.css rides the shared
    // fromEntries-*.css chunk (imported by both MeetingsPane and TasksPane);
    // Vite still emits the rules once, so any real duplication is a defeat.
    if (owningChunks.length > 1) {
      violations.push(
        `NO CROSS-CHUNK DUPLICATES: ${fingerprint.file}'s ownership fingerprint (${fingerprint.selector}{) appears in ${owningChunks.length} chunks: ${owningChunks.join(", ")}`,
      );
    }
  }

  // Assertion 2: FULL INVENTORY — every registered mode id either has a
  // marker-bearing per-mode CSS file with a verified owning chunk, or is on
  // the documented exception list.
  const coveredIds = new Set(srcMarkerIds.values());
  for (const id of REGISTERED_MODE_IDS) {
    if (NO_PER_MODE_CSS.includes(id)) {
      continue;
    }
    if (!coveredIds.has(id)) {
      violations.push(
        `FULL INVENTORY: mode id ${id} has no marker-bearing per-mode CSS file and is not on the documented exception list (NO_PER_MODE_CSS) — add the per-mode file or document the exception`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(
      `mode-css-ownership: ${violations.length} violation(s) in the produced bundle\n  ${violations.join("\n  ")}`,
    );
    process.exit(1);
  }

  console.log(
    `mode-css-ownership: ${chunkTexts.size} CSS chunks, ${srcMarkerIds.size} marker-bearing per-mode files, ownership verified, entry chunk clean`,
  );
}

main().catch((error) => {
  console.error(`mode-css-ownership: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
