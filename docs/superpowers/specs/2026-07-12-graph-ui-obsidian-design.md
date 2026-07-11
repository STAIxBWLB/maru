# Graph UI refresh: Obsidian-benchmark rendering and typography

Date: 2026-07-12
Status: approved (design), pending implementation plan

## Problem

The V4 graph screen reads poorly (user screenshot, 2026-07-12):

- Labels pile up illegibly in cluster centers; Sigma's built-in density
  heuristic pops them in and out binarily with no zoom relationship.
- Community hulls stack 8%-alpha fills per community, producing smeared
  blotches wherever communities overlap.
- Every canvas color is a hardcoded light-theme hex (`GraphCanvas.tsx`:
  labels, node borders, edge/dim colors, ghost fill, export background),
  so the canvas ignores the app's dark theme tokens entirely.
- Panel/toolbar typography around the canvas is inconsistent (mixed sizes,
  no numeric alignment, heavy boxes).

Benchmark: Obsidian's graph view (flat dots on a clean background,
whisper-thin edges, labels that fade in as you zoom, color groups instead
of area fills, theme-native colors).

## Decisions (user-confirmed)

1. Scope: canvas rendering **and** the surrounding graph-screen panels
   (filter panel, insights panel, toolbar, legend typography).
2. Communities: **remove hulls entirely**; represent communities by node
   color only (Obsidian-style color groups). The legend stays as the key.
3. Approach: custom Sigma label renderer (zoom-linked fade), not just
   settings tuning.

## Design

### 1. Theme tokens → canvas

Extend `src/components/graph/graphStyle.ts` with a theme reader: sample the
CSS custom properties (`--bg`, `--ink`, `--muted`, `--line`, `--accent`,
warn color) via `getComputedStyle(document.documentElement)` and expose a
`GraphThemeColors` object. All hardcoded hex values in
`src/components/graph/GraphCanvas.tsx` (label color, node `borderColor`,
hover-dim colors, edge default/dim colors, ghost fill, SVG/PNG export
background) switch to this object. On theme change (MutationObserver on
`document.documentElement`'s `data-theme` + `prefers-color-scheme` media
listener), re-read tokens and push via `renderer.setSetting()` /
`scheduleRefresh()`; no renderer rebuild.

### 2. Nodes

- Keep `MaruNodeBorderProgram`; border color = theme `--bg` token (flat-dot
  look). Ghost nodes keep bg fill + muted border.
- Hover: grow the hovered node ~1.15× in the nodeReducer (today only
  selected/emphasized nodes grow). Neighbors keep color; non-neighbors dim
  to a token-derived low-contrast color (existing logic, token color).
- Size curve `nodeRadius` and selected/focus accent ring: unchanged.

### 3. Edges

Values-only change in the existing edgeReducer/settings:

- Default: thinner, lower contrast, derived from `--line` mixed toward bg;
  frontmatter edges remain slightly stronger than body-link edges.
- Dimmed (hover elsewhere): near-invisible.
- Highlighted (hover/pair/path): accent token, current thickness logic.

### 4. Labels (core)

Custom `defaultDrawNodeLabel` replacement (~30 lines, canvas 2D):

- Alpha ramps with the node's rendered (on-screen) size: 0 below ~6px,
  1 above ~12px, linear between. Zooming in fades labels in gradually
  (the Obsidian signature) instead of thresholded popping.
- Hub nodes (`forceLabel`/god nodes), the selected node, and the hovered
  node always render at full alpha (hovered via the hover-label drawer,
  slightly larger: 12px/600).
- Type: Pretendard 11px/500 (unchanged family), fill = `--ink` at ~80%,
  with a bg-colored halo (shadowBlur ≈ 3 or 4-directional offset fill) for
  readability over edges.
- Retune `labelRenderedSizeThreshold` down (the fade replaces the hard
  gate) and keep `labelDensity` as the collision limiter; final values
  tuned against a real vault during verification.

### 5. Communities: hulls removed → color groups

Delete outright (net code reduction):

- `GraphView.tsx`: `hulls` useMemo, `settled`/`settledNodesRef` usage that
  exists only for hulls (the layout-cache save keeps its own settled use),
  `showHulls` state and prop plumbing.
- `GraphCanvas.tsx`: `hullCanvas` layer, `drawHulls`, `hulls` prop, and the
  hull markup in the e2e debug overlay.
- `GraphFilterPanel.tsx`: hull toggle (`graph-hulls-toggle`).
- `graph.css`: `.graph-hull*` rules.
- `e2e/graph.spec.ts`: hull assertions replaced with a color-group
  assertion (legend swatch color matches node fill for a community).

Community identity is carried by node color alone. Replace the current
single Tableau10-ish palette with **two 12-color palettes keyed by theme**
(muted for light, brighter for dark), validated with the dataviz skill's
palette method during implementation. `nodeColor`/`communityColor`/
`domainColor` take the active theme.

### 6. Panel and toolbar typography (`graph.css` only)

Style pass, no structural/markup changes beyond class tweaks:

- One type scale across filter panel, insights panel, inspector, toolbar,
  legend: panel titles, body, chip labels, counts.
- Counts and metrics use `font-variant-numeric: tabular-nums`.
- 8px spacing grid; hairline `--line` borders; drop redundant boxes/fills
  so panels read like Obsidian's quiet control drawers.

### Out of scope (deliberate)

Curved edges, physics/layout changes, panel restructuring, animations
beyond the hover grow, node icons/shapes.

## Verification

- `pnpm test` unit suite (palette/theme reader units added in graphStyle
  tests if logic warrants).
- `e2e/graph.spec.ts`: hull test replaced; full graph suite (12) green;
  full `pnpm playwright test` green.
- Manual: web-mode dev server; check light and dark (`data-theme`) both;
  zoom in/out to confirm label fade; hover/selection/path states; legend
  color-key correctness on an enriched vault.
- `make verify` (typecheck, ts+rust tests, build, bundle budget).
