# Graph UI Obsidian-Benchmark Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Sigma WebGL graph screen read like Obsidian's graph view: theme-token colors (dark mode works), zoom-linked label fade, whisper edges, hover grow, community color groups instead of hulls, and one consistent type scale across the graph panels.

**Architecture:** All color decisions centralize in `graphStyle.ts` behind a cached `GraphTheme` object refreshed from CSS custom properties; `GraphCanvas.tsx` consumes it everywhere it currently hardcodes hex and rebuilds on theme change via a `themeEpoch` state (positions are preserved by the existing `positionsValid` path, so no relayout). Labels move to a custom Sigma `defaultDrawNodeLabel`/`defaultDrawNodeHover` pair in a new `graphLabels.ts`. Hull rendering is deleted outright.

**Tech Stack:** React 18, sigma 3.0.3 (`sigma/settings`, `sigma/types`), graphology 0.26, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-12-graph-ui-obsidian-design.md`

## Global Constraints

- Work on branch `feat/graph-ui-obsidian` (already exists, holds the spec commit).
- Conventional commits, English messages, no `Co-authored-by` trailer.
- The 12-color palettes below are dataviz-validated (light: min adjacent deutan ΔE 13.3 on `#f4f3ee`; dark: 14.8 on `#181a18`, all checks pass). Do not reorder or swap entries; slot order is the CVD-safety mechanism.
- Slot order is identical in both palettes (a community keeps its hue across themes).
- Contrast relief for low-contrast light slots is provided by node labels, the legend, and the bg-colored node border; no extra work needed.
- `settled`/`settledNodesRef` in GraphView.tsx stay (the layout-cache save effect uses them); only their hull usage goes.
- Existing tests must stay green after every task; run the named test commands before each commit.

---

### Task 1: Theme system in graphStyle.ts

**Files:**
- Modify: `src/components/graph/graphStyle.ts`
- Test: `src/components/graph/graphStyle.test.ts` (create)

**Interfaces:**
- Consumes: CSS custom properties `--bg --ink --muted --line --accent` on `document.documentElement` (jsdom in tests).
- Produces (used by Tasks 2–5):
  - `interface GraphTheme { bg; ink; muted; line; accent; warn; labelColor; edge; edgeStrong; edgeDim; nodeBorder; ghostFill; dimNode; dark; communityColors: string[]; domainColors: Record<string,string>; fallback: string }` (all string hex/rgba unless noted; `dark: boolean`)
  - `refreshGraphTheme(): GraphTheme` re-reads tokens; `graphTheme(): GraphTheme` returns the cache.
  - `nodeColor(node, enriched)`, `communityColor(community)`, `domainColor(domain)` keep their exact current signatures but read the active theme palette.

- [ ] **Step 1: Write the failing test**

Create `src/components/graph/graphStyle.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  communityColor,
  domainColor,
  graphTheme,
  nodeColor,
  refreshGraphTheme,
} from "./graphStyle";
import type { GraphNode } from "../../lib/graph/model";

const node = (over: Partial<GraphNode>): GraphNode => ({
  id: "n1",
  label: "N1",
  type: "note",
  domain: null,
  community: null,
  degree: 1,
  isGodNode: false,
  ...over,
} as GraphNode);

function setTokens(tokens: Record<string, string>) {
  const root = document.documentElement;
  root.removeAttribute("style");
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(key, value);
  }
}

const LIGHT = { "--bg": "#f4f3ee", "--ink": "#1f1d18", "--muted": "#69645b", "--line": "#dedbd1", "--accent": "#2f5a3c" };
const DARK = { "--bg": "#181a18", "--ink": "#f2f0e8", "--muted": "#a19c8f", "--line": "#3a3d36", "--accent": "#7faf86" };

describe("graph theme", () => {
  beforeEach(() => setTokens(LIGHT));

  it("reads light tokens and exposes a 12-color light palette", () => {
    const theme = refreshGraphTheme();
    expect(theme.dark).toBe(false);
    expect(theme.bg).toBe("#f4f3ee");
    expect(theme.accent).toBe("#2f5a3c");
    expect(theme.communityColors).toHaveLength(12);
    expect(new Set(theme.communityColors).size).toBe(12);
    for (const hex of theme.communityColors) expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("switches to the dark palette when the bg token is dark", () => {
    setTokens(DARK);
    const theme = refreshGraphTheme();
    expect(theme.dark).toBe(true);
    expect(theme.communityColors).not.toEqual((() => { setTokens(LIGHT); return refreshGraphTheme().communityColors; })());
  });

  it("keeps a community on the same slot index across themes", () => {
    setTokens(LIGHT);
    const light = refreshGraphTheme().communityColors;
    setTokens(DARK);
    const dark = refreshGraphTheme().communityColors;
    // slot 0 is blue in both palettes
    expect(light[0]).toBe("#2a78d6");
    expect(dark[0]).toBe("#3987e5");
    expect(communityColor(0)).toBe(dark[0]);
  });

  it("nodeColor: ghost uses theme bg, community wins when enriched, domain otherwise", () => {
    const theme = refreshGraphTheme();
    expect(nodeColor(node({ type: "unresolved" }), false)).toBe(theme.bg);
    expect(nodeColor(node({ community: 2 }), true)).toBe(theme.communityColors[2]);
    expect(nodeColor(node({ domain: "research" }), false)).toBe(theme.domainColors.research);
    expect(nodeColor(node({}), false)).toBe(theme.fallback);
  });

  it("domainColor falls back for unknown domains", () => {
    const theme = refreshGraphTheme();
    expect(domainColor("nope")).toBe(theme.fallback);
    expect(domainColor(null)).toBe(theme.fallback);
    expect(graphTheme().domainColors.research).toBe(domainColor("research"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/graph/graphStyle.test.ts`
Expected: FAIL ("refreshGraphTheme" is not exported / palette length mismatch).

- [ ] **Step 3: Implement the theme system**

Rewrite `src/components/graph/graphStyle.ts` (keep `nodeRadius`, `edgeKey`, `graphTopologySignature` exactly as they are; replace the color section):

```ts
import type { GraphEdge, GraphNode } from "../../lib/graph/model";

// dataviz-validated categorical palettes (12 slots, same hue per slot across
// themes). Light: min adjacent deutan dE 13.3 on #f4f3ee. Dark: 14.8 on
// #181a18. Slot ORDER is the CVD-safety mechanism; never reorder or cycle.
const LIGHT_COMMUNITY_COLORS = [
  "#2a78d6", "#eda100", "#008300", "#e34948", "#0894ab", "#eb6834",
  "#4a3aa7", "#6b8e23", "#e87ba4", "#9c6410", "#1baf7a", "#7a4fb5",
];
const DARK_COMMUNITY_COLORS = [
  "#3987e5", "#c98500", "#17913a", "#e25b70", "#1a95aa", "#d95926",
  "#9085e9", "#7a9630", "#d55181", "#b07b28", "#199e70", "#a678d8",
];
// Domains map onto palette slots so domain and community coloring share hues.
const DOMAIN_SLOTS: Record<string, number> = {
  research: 0,      // blue
  projects: 5,      // orange
  teaching: 2,      // green
  operations: 3,    // red
  people: 11,       // purple
  "ai-practice": 4, // cyan
};

export interface GraphTheme {
  bg: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  warn: string;
  labelColor: string;
  edge: string;
  edgeStrong: string;
  edgeDim: string;
  nodeBorder: string;
  ghostFill: string;
  dimNode: string;
  dark: boolean;
  communityColors: string[];
  domainColors: Record<string, string>;
  fallback: string;
}

const LIGHT_DEFAULTS = { bg: "#f4f3ee", ink: "#1f1d18", muted: "#69645b", line: "#dedbd1", accent: "#2f5a3c" };
const DARK_DEFAULTS = { bg: "#181a18", ink: "#f2f0e8", muted: "#a19c8f", line: "#3a3d36", accent: "#7faf86" };

function hexLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 1;
  const value = parseInt(match[1], 16);
  const channel = (component: number) => {
    const c = component / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((value >> 16) & 0xff)
    + 0.7152 * channel((value >> 8) & 0xff)
    + 0.0722 * channel(value & 0xff);
}

function buildTheme(read: (name: string, fallback: string) => string): GraphTheme {
  const bgProbe = read("--bg", LIGHT_DEFAULTS.bg);
  const dark = hexLuminance(bgProbe) < 0.5;
  const defaults = dark ? DARK_DEFAULTS : LIGHT_DEFAULTS;
  const bg = read("--bg", defaults.bg);
  const ink = read("--ink", defaults.ink);
  const line = read("--line", defaults.line);
  const communityColors = dark ? DARK_COMMUNITY_COLORS : LIGHT_COMMUNITY_COLORS;
  const domainColors = Object.fromEntries(
    Object.entries(DOMAIN_SLOTS).map(([domain, slot]) => [domain, communityColors[slot]]),
  );
  return {
    bg,
    ink,
    muted: read("--muted", defaults.muted),
    line,
    accent: read("--accent", defaults.accent),
    warn: dark ? "#d6b070" : "#b8690f",
    labelColor: dark ? "rgba(242, 240, 232, 0.82)" : "rgba(31, 29, 24, 0.82)",
    edge: line,
    edgeStrong: dark ? "#4c5049" : "#c8c4b8",
    edgeDim: dark ? "rgba(58, 61, 54, 0.35)" : "rgba(222, 219, 209, 0.4)",
    nodeBorder: bg,
    ghostFill: bg,
    dimNode: dark ? "#2e312d" : "#dcdad2",
    dark,
    communityColors,
    domainColors,
    fallback: dark ? "#9aa0a8" : "#8a8f98",
  };
}

let activeTheme: GraphTheme = buildTheme((_name, fallback) => fallback);

export function refreshGraphTheme(): GraphTheme {
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const style = getComputedStyle(document.documentElement);
    activeTheme = buildTheme((name, fallback) => style.getPropertyValue(name).trim() || fallback);
  }
  return activeTheme;
}

export function graphTheme(): GraphTheme {
  return activeTheme;
}

export function nodeRadius(degree: number): number {
  return Math.min(20, Math.max(4, 4 + 2 * Math.sqrt(degree)));
}

export function nodeColor(node: GraphNode, enriched: boolean): string {
  const theme = activeTheme;
  if (node.type === "unresolved") return theme.ghostFill;
  if (enriched && node.community != null) {
    return theme.communityColors[node.community % theme.communityColors.length];
  }
  return node.domain ? (theme.domainColors[node.domain] ?? theme.fallback) : theme.fallback;
}

export function communityColor(community: number): string {
  return activeTheme.communityColors[community % activeTheme.communityColors.length];
}

export function domainColor(domain: string | null): string {
  return domain ? (activeTheme.domainColors[domain] ?? activeTheme.fallback) : activeTheme.fallback;
}
```

(`edgeKey` and `graphTopologySignature` stay below, unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/graph/graphStyle.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Check existing consumers still compile and pass**

Run: `pnpm typecheck && pnpm vitest run src`
Expected: PASS. `GraphLegend.tsx`, `GraphFilterPanel.tsx`, `GraphInsightsPanel.tsx`, `GraphCanvas.tsx` call these functions with unchanged signatures, so no edits are needed yet.

- [ ] **Step 6: Commit**

```bash
git add src/components/graph/graphStyle.ts src/components/graph/graphStyle.test.ts
git commit -m "feat(graph): theme-token color system with dataviz-validated palettes"
```

---

### Task 2: Wire theme tokens through GraphCanvas

**Files:**
- Modify: `src/components/graph/GraphCanvas.tsx`

**Interfaces:**
- Consumes: `graphTheme()`, `refreshGraphTheme()` from Task 1.
- Produces: `themeEpoch` state; every canvas color reads the theme. Tasks 3–4 assume no hardcoded hex remains in GraphCanvas.

- [ ] **Step 1: Replace the module constants**

At the top of `GraphCanvas.tsx`, delete:

```ts
const FALLBACK_COLOR = "#8a8f98";
const ACCENT_COLOR = "#2f5a3c";
const WARN_COLOR = "#d47a16";
```

Add `graphTheme` and `refreshGraphTheme` to the existing `./graphStyle` import. Then update every former use inside the component (reducers run on every refresh, so live `graphTheme()` reads pick up theme changes):

- `buildSigmaGraph` node attrs: `borderColor: node.type === "unresolved" ? graphTheme().muted : graphTheme().nodeBorder` (ghost ring uses muted, filled nodes use bg ring; the old values were `FALLBACK_COLOR` and `"#f7f7f5"`).
- nodeReducer emphasized branch: `patch.borderColor = overlayIds?.has(node) ? WARN_COLOR : ACCENT_COLOR` becomes `patch.borderColor = overlayIds?.has(node) ? graphTheme().warn : graphTheme().accent`; the favorite branch's `WARN_COLOR` also becomes `graphTheme().warn`.
- Hover dim color `"#d6d8dc"` → `graphTheme().dimNode`.
- edgeReducer dim branch `{ ...data, color: "#e2e3e5", size: 0.5 }` → `{ ...data, color: graphTheme().edgeDim, size: 0.4 }`; active pair/path color `ACCENT_COLOR` → `graphTheme().accent`.
- `graphToSvg`: `<rect ... fill="#f7f7f5"/>` → `fill="${xmlEscape(graphTheme().bg)}"`, and the label fill `#30343a` → `graphTheme().ink`.
- PNG export `toBlob(..., { backgroundColor: "#f7f7f5" })` → `backgroundColor: graphTheme().bg`.
- `StaticGraphFallback` label text fill is CSS-driven; leave markup as is.

- [ ] **Step 2: Add the theme observer + rebuild epoch**

Inside the `GraphCanvas` component add:

```ts
const [themeEpoch, setThemeEpoch] = useState(0);
useEffect(() => {
  refreshGraphTheme();
  const apply = () => {
    refreshGraphTheme();
    setThemeEpoch((epoch) => epoch + 1);
  };
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", apply);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", apply);
  };
}, []);
```

Append `themeEpoch` to the main renderer effect's dependency array (the one ending `..., exportControllerRef, webglFailed]`). A theme flip rebuilds the renderer with the new palette; node positions survive because `positionsValid` short-circuits to `snapshotPositions()` (no relayout).

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm vitest run src && pnpm playwright test e2e/graph.spec.ts --reporter=line`
Expected: typecheck clean, unit suite green, 12/12 graph e2e pass (canvas colors changed but no test asserts exact canvas hex).

- [ ] **Step 4: Manual dark-mode spot check**

Run: `pnpm dev` (or reuse the running server), open `http://127.0.0.1:5307`, enter 그래프 mode. In DevTools console run `document.documentElement.setAttribute("data-theme", "dark")` and confirm the canvas background, node borders, edges, and export SVG all flip with the theme (no light-gray ghosts on dark bg).

- [ ] **Step 5: Commit**

```bash
git add src/components/graph/GraphCanvas.tsx src/components/graph/graphStyle.ts src/components/graph/graphStyle.test.ts
git commit -m "feat(graph): drive all canvas colors from theme tokens with live theme switching"
```

---

### Task 3: Zoom-linked label fade (custom label + hover drawers)

**Files:**
- Create: `src/components/graph/graphLabels.ts`
- Test: `src/components/graph/graphLabels.test.ts`
- Modify: `src/components/graph/GraphCanvas.tsx`

**Interfaces:**
- Consumes: `graphTheme()` from Task 1.
- Produces: `labelAlpha(renderedSize: number, forced: boolean): number`, `drawMaruNodeLabel(context, data, settings): void`, `drawMaruNodeHover(context, data, settings): void`, registered as Sigma settings `defaultDrawNodeLabel` / `defaultDrawNodeHover`.

- [ ] **Step 1: Write the failing test**

Create `src/components/graph/graphLabels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { labelAlpha } from "./graphLabels";

describe("labelAlpha", () => {
  it("hides labels on small rendered nodes", () => {
    expect(labelAlpha(0, false)).toBe(0);
    expect(labelAlpha(6, false)).toBe(0);
  });
  it("ramps linearly between fade bounds", () => {
    expect(labelAlpha(9, false)).toBeCloseTo(0.5, 5);
  });
  it("saturates at full opacity", () => {
    expect(labelAlpha(12, false)).toBe(1);
    expect(labelAlpha(40, false)).toBe(1);
  });
  it("forced labels are always fully opaque", () => {
    expect(labelAlpha(0, true)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/graph/graphLabels.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement graphLabels.ts**

```ts
import type { Settings } from "sigma/settings";
import type { NodeDisplayData, PartialButFor } from "sigma/types";
import { graphTheme } from "./graphStyle";

type NodeLabelData = PartialButFor<NodeDisplayData, "x" | "y" | "size" | "label" | "color">;

// Obsidian-style zoom-linked fade: labels are invisible while a node renders
// small, ramp in as it grows on screen (zoom-in or high degree).
const FADE_START = 6;
const FADE_END = 12;

export function labelAlpha(renderedSize: number, forced: boolean): number {
  if (forced) return 1;
  if (renderedSize <= FADE_START) return 0;
  if (renderedSize >= FADE_END) return 1;
  return (renderedSize - FADE_START) / (FADE_END - FADE_START);
}

function drawLabelText(
  context: CanvasRenderingContext2D,
  data: NodeLabelData,
  settings: Settings,
  alpha: number,
  sizePx: number,
  weight: string,
): void {
  if (!data.label || alpha <= 0) return;
  const theme = graphTheme();
  context.save();
  context.globalAlpha = alpha;
  context.font = `${weight} ${sizePx}px ${settings.labelFont}`;
  context.textAlign = "center";
  context.textBaseline = "top";
  // bg-colored stroke halo keeps labels readable over edges (cheaper than shadowBlur)
  context.lineJoin = "round";
  context.lineWidth = 3;
  context.strokeStyle = theme.bg;
  const x = data.x;
  const y = data.y + data.size + 3;
  context.strokeText(data.label, x, y);
  context.fillStyle = theme.labelColor;
  context.fillText(data.label, x, y);
  context.restore();
}

export function drawMaruNodeLabel(
  context: CanvasRenderingContext2D,
  data: NodeLabelData,
  settings: Settings,
): void {
  const forced = data.forceLabel === true || data.highlighted === true;
  drawLabelText(context, data, settings, labelAlpha(data.size, forced), settings.labelSize, settings.labelWeight);
}

export function drawMaruNodeHover(
  context: CanvasRenderingContext2D,
  data: NodeLabelData,
  settings: Settings,
): void {
  // Hovered node: always-on, slightly larger label; no white box (Obsidian look).
  drawLabelText(context, data, settings, 1, settings.labelSize + 1, "600");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/graph/graphLabels.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Register the drawers and hover grow in GraphCanvas**

In `GraphCanvas.tsx`:

1. `import { drawMaruNodeLabel, drawMaruNodeHover } from "./graphLabels";`
2. In the `new Sigma(...)` settings object add:

```ts
        defaultDrawNodeLabel: drawMaruNodeLabel,
        defaultDrawNodeHover: drawMaruNodeHover,
        labelRenderedSizeThreshold: 3,
```

(keep `labelFont`, `labelSize: 11`, `labelWeight: "500"`, `labelDensity: 0.55` as they are; the fade replaces the old hard threshold of 8, and threshold 3 still culls dust-sized nodes from the label grid.)

3. Hover grow: in the nodeReducer, after the `hoverVisible`/`overlayVisible` block, add:

```ts
          if (node === state.hoverId) {
            patch.size = data.size * 1.15;
          }
```

(`enterNode`/`leaveNode` already call `scheduleRefresh`, so the grow renders immediately.)

- [ ] **Step 6: Verify**

Run: `pnpm typecheck && pnpm playwright test e2e/graph.spec.ts --reporter=line`
Expected: 12/12 pass. Then in the dev server: zoom out (labels disappear gradually), zoom in (labels fade in), hover a node (label pops at full opacity, node grows slightly).

- [ ] **Step 7: Commit**

```bash
git add src/components/graph/graphLabels.ts src/components/graph/graphLabels.test.ts src/components/graph/GraphCanvas.tsx
git commit -m "feat(graph): zoom-linked label fade with themed halo and hover grow"
```

---

### Task 4: Whisper edges

**Files:**
- Modify: `src/components/graph/GraphCanvas.tsx` (buildSigmaGraph edge attrs)

**Interfaces:**
- Consumes: `graphTheme().edge`, `.edgeStrong` from Task 1.
- Produces: nothing new; final edge values.

- [ ] **Step 1: Retune edge attributes**

In `buildSigmaGraph`, the edge loop currently sets:

```ts
      size: edge.fromFrontmatter ? 1.2 : 0.75,
      color: edge.fromFrontmatter ? "#90959e" : "#b4b7bd",
```

Replace with:

```ts
      size: edge.fromFrontmatter ? 1 : 0.6,
      color: edge.fromFrontmatter ? graphTheme().edgeStrong : graphTheme().edge,
```

(The dim/highlight branches were already tokenized in Task 2.)

- [ ] **Step 2: Verify visually and by suite**

Run: `pnpm typecheck && pnpm playwright test e2e/graph.spec.ts --reporter=line`
Expected: 12/12. Dev server: default edges read as quiet hairlines against both themes; hover highlights still legible.

- [ ] **Step 3: Commit**

```bash
git add src/components/graph/GraphCanvas.tsx
git commit -m "feat(graph): quieter theme-derived edge weights"
```

---

### Task 5: Remove community hulls (color groups take over)

**Files:**
- Modify: `src/components/graph/GraphView.tsx`
- Modify: `src/components/graph/GraphCanvas.tsx`
- Modify: `src/components/graph/GraphFilterPanel.tsx`
- Modify: `src/lib/settings.ts`
- Modify: `src/lib/i18n.ts`
- Modify: `src/components/graph/graph.css`
- Modify: `e2e/graph.spec.ts`
- Delete: `src/lib/graph/hull.ts` (and its test if `src/lib/graph/hull.test.ts` exists)

**Interfaces:**
- Consumes: node colors already carry community identity (Task 1); GraphLegend remains the color key.
- Produces: `GraphSettings` loses `showHulls`; `GraphCanvas` loses the `hulls` prop; `GraphFilterPanel` loses `hullsAvailable/showHulls/onShowHullsChange`.

- [ ] **Step 1: Strip GraphView**

- Remove the import `import { hullPath, type Point } from "../../lib/graph/hull";`
- Remove `const [showHulls, setShowHulls] = useState(graphSettings.showHulls);` and every `showHulls` reference (the settings-persist object around line 129, the settings-sync effect around line 145).
- Delete the `hulls` useMemo block (lines ~291-309). Keep `settled`, `settledNodesRef`, and `handleLayoutSettled` (the layout-cache save effect still uses them).
- Remove `hullsAvailable=`, `showHulls=`, `onShowHullsChange=` from the `<GraphFilterPanel .../>` call and `hulls={hulls}` from `<GraphCanvas .../>`.

- [ ] **Step 2: Strip GraphCanvas**

- Remove the `hulls` prop from the props interface and destructuring, plus `hullsRef` (lines ~300-301).
- Remove `const hullCanvas = renderer.createCanvas("maru-hulls", ...)`, the whole `drawHulls` function, `renderer.on("afterRender", drawHulls)`, and the matching `renderer.off("afterRender", drawHulls)` in the cleanup.
- In the e2e debug overlay JSX remove the `<g className="graph-hulls">...</g>` block.
- Drop `communityColor` from the `./graphStyle` import if now unused in this file.

- [ ] **Step 3: Strip GraphFilterPanel**

Remove `hullsAvailable`, `showHulls`, `onShowHullsChange` from the props interface and destructuring, and delete the `{hullsAvailable ? (...) : null}` toggle block containing `data-testid="graph-hulls-toggle"`.

- [ ] **Step 4: Strip settings + i18n**

- `src/lib/settings.ts`: remove `showHulls: boolean;` from `GraphSettings` (line ~285), `showHulls: false,` from the defaults (~442), and `showHulls: graph.showHulls === true,` from the normalizer (~908). Stored settings with a leftover `showHulls` key are simply ignored by the normalizer.
- `src/lib/i18n.ts`: remove both `"graph.filter.showHulls"` entries (Korean ~line 86, English ~line 2291).
- Run `grep -rn showHulls src e2e` and clean any remaining references (settings tests may assert the defaults object shape).

- [ ] **Step 5: Delete hull module + CSS**

```bash
git rm src/lib/graph/hull.ts
ls src/lib/graph/hull.test.ts 2>/dev/null && git rm src/lib/graph/hull.test.ts
```

In `graph.css` delete the `.graph-hull` rule block (grep `graph-hull`).

- [ ] **Step 6: Replace the e2e hull assertion with a color-group assertion**

In `e2e/graph.spec.ts`, the test `"enriched overlay renders the communities badge, legend, and hulls"`: rename to `"enriched overlay renders the communities badge, legend, and color groups"` and replace

```ts
  // Hull toggle appears (enriched + communities) and draws one area per community.
  await page.getByTestId("graph-hulls-toggle").check();
  await expect(page.locator(".graph-hull")).toHaveCount(2);
```

with

```ts
  // Communities are color groups: the two mock notes sit in different
  // communities and must render with different node fills.
  const meetingFill = await page
    .locator('.graph-node circle[data-node-id="maru-weekly-meeting"]')
    .getAttribute("fill");
  const glossaryFill = await page
    .locator('.graph-node circle[data-node-id="maru-glossary"]')
    .getAttribute("fill");
  expect(meetingFill).toBeTruthy();
  expect(glossaryFill).toBeTruthy();
  expect(meetingFill).not.toBe(glossaryFill);
```

- [ ] **Step 7: Verify**

Run: `pnpm typecheck && pnpm vitest run src && pnpm playwright test e2e/graph.spec.ts --reporter=line`
Expected: all green, including the renamed enriched-overlay test.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(graph)!: replace community hulls with color groups (Obsidian-style)"
```

---

### Task 6: Panel and toolbar typography pass

**Files:**
- Modify: `src/components/graph/graph.css` only (no markup changes)

**Interfaces:**
- Consumes: existing class names in GraphFilterPanel/GraphInsightsPanel/GraphInspector/GraphToolbar/GraphLegend.
- Produces: one type scale, numeric alignment, 8px spacing rhythm.

- [ ] **Step 1: Establish the scale at the top of graph.css**

Add after the existing top-of-file comment:

```css
/* Graph screen type scale: titles 12/600, body 12.5/400, meta 11.5/400.
   Counts and metrics align with tabular numerals. Spacing on an 8px grid. */
```

Then normalize (grep each selector; values below are the targets):

- Panel/section titles (`.graph-filter-title`, `.graph-insights-title`, inspector section headers): `font-size: 12px; font-weight: 600; letter-spacing: 0.01em; color: var(--muted);`
- Body rows (filter chips, insight list items, inspector rows): `font-size: 12.5px; line-height: 1.45;`
- Meta/secondary text (counts in chips, hints, stats): `font-size: 11.5px; color: var(--muted);`
- Every element that renders a number (`.graph-stats`, chip counts, insight metrics): add `font-variant-numeric: tabular-nums;`
- Spacing: panel padding and gaps snap to 8/12/16px; replace odd values (e.g. 9px/13px paddings) with the nearest grid step.
- Borders: any panel-internal `border: 1px solid` heavier than `var(--line)` becomes `var(--line)`; remove redundant background fills on nested boxes inside `.graph-filter-panel` and `.graph-insights-panel` (keep the panel surface itself).

Work selector-by-selector with grep; this is a values pass, not a rewrite. Do not touch `.graph-canvas*`, `.graph-node*`, `.graph-e2e-overlay` rules.

- [ ] **Step 2: Verify**

Run: `pnpm playwright test e2e/graph.spec.ts e2e/smoke.spec.ts --reporter=line`
Expected: green (tests select by role/testid/text, not by font metrics). Dev server: panels read consistently in both themes; numbers align in the insights panel.

- [ ] **Step 3: Commit**

```bash
git add src/components/graph/graph.css
git commit -m "style(graph): unify panel typography on one scale with tabular numerals"
```

---

### Task 7: Full verification + evidence screenshots + PR

**Files:**
- Create: none in-repo (screenshots go to the session scratchpad)

- [ ] **Step 1: Full suites**

Run: `make verify && pnpm playwright test --reporter=line`
Expected: verify green (typecheck, ts+rust tests, build, bundle budget) and full e2e 55/55.

- [ ] **Step 2: Light/dark screenshots for user review**

Write a throwaway Playwright script in the scratchpad (NOT in e2e/) that opens the dev server, enters graph mode with the enriched overlay flag (`maru:e2e:graph-overlay=1` and the workPath-namespaced settings key `maru:settings:fallback:v1:mock://maru-sample-workspace` set to `{"graph":{"source":"all","scope":"all"}}`), screenshots the graph screen, then sets `data-theme="dark"` on `document.documentElement` and screenshots again. Send both images to the user with SendUserFile.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin feat/graph-ui-obsidian
gh pr create --title "feat(graph): Obsidian-benchmark graph UI refresh" --body "<summary per repo conventions: spec link, before/after, verification results>"
```

Expected: PR CI (`make verify`) green. Note in the PR body that e2e runs at release preflight.
