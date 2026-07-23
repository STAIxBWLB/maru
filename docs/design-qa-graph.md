# Design QA: Graph canvas-first redesign

## Evidence

- Reference: `/var/folders/98/_przjd655416vf04xccddy280000gn/T/clipboard-2026-07-24-041352-3CE9AD21.png`
- Implementation: `artifacts/design-qa/graph-implementation-final.png`
- Full-view comparison: `artifacts/design-qa/graph-comparison-full.png`
- Focused canvas comparison: `artifacts/design-qa/graph-comparison-canvas.png`
- Viewport: 1912 x 1242 CSS pixels, DPR 2
- Captured dimensions: 3824 x 2484 pixels
- Fixture: workspace graph, 1,200 nodes and 6,224 edges
- State: dark theme, neutral color mode, violet accent, selected node with related edges emphasized, compact controls visible

The source includes Obsidian's file sidebar and outer macOS window frame. Maru's
comparison keeps its own application shell and isolates the graph canvas as the
matching surface. This is an intentional product constraint, not a missing
graph element.

## Rubric

### Typography

- PASS: restrained system/Pretendard hierarchy matches the reference's quiet
  canvas chrome.
- PASS: labels remain subordinate to graph structure; dense-graph LOD prevents
  a wall of text.

### Spacing and layout

- PASS: the canvas remains primary with no persistent side panels by default.
- PASS: view/source, search, tools, more, selection, and zoom controls use
  compact floating groups at the canvas edges.
- PASS: tools use a single drawer/overlay/bottom-sheet surface and can be pinned
  and resized on wide layouts.

### Color and rendering

- PASS: the default canvas is near-black with subdued neutral nodes and edges.
- PASS: violet is reserved for the selected node and its incident edges, closely
  matching the reference's focus treatment.
- PASS: theme, accent, color grouping, and relation colors apply without a graph
  rebuild.
- PASS: the graph remains readable at 1,200 nodes without a bright edge mass.

### Asset quality

- PASS: Sigma/WebGL renders graph geometry; Lucide supplies interface icons.
- PASS: no placeholder, rasterized UI, fake icon, or improvised SVG asset is
  used.

### Copy and localization

- PASS: toolbar, menus, display controls, tool sections, hints, and selection
  actions have Korean and English labels.
- PASS: the fixture's missing-community hint states the degraded state without
  blocking the live graph.

### Accessibility and interaction

- PASS: search, menus, segmented controls, panel actions, and node actions remain
  keyboard-addressable with accessible names.
- PASS: Escape closes transient layers progressively; zoom, reset, refresh,
  filtering, saved views, focus, selection, and open-note actions are functional.
- PASS: temporarily hiding the graph canvas, including terminal maximize, no
  longer causes Sigma's zero-size container exception or blanks the app.
- PASS: the capture completed with no console or page errors.

## Iteration history

### Pass 1

- P1: high edge opacity created a bright white mass in the dense fixture.
- P2: default node and edge scale remained too prominent relative to the
  Obsidian reference.

Changes:

- Replaced translucent edge colors with opaque near-background tokens suitable
  for Sigma's WebGL color path.
- Added dense-graph visual LOD, reducing node size to 0.62 and edge width to
  0.55 before user scaling.

### Pass 2

- Repeated the exact-size full-view and focused-canvas comparison.
- Verified neutral overview and selected-node states.
- No remaining P0, P1, or P2 visual defects.
- P3 accepted: the synthetic fixture's radial distribution differs from the
  user's real vault layout, while the visual hierarchy and interaction model
  match the requested Obsidian direction.

### Adversarial pass

- Removed the color legend in neutral mode and bound domain/community legends
  to the color mode they actually describe.
- Shifted graph status and focus guidance below the expanded search layer.
- Re-captured the exact-size implementation and full-view comparison with no
  console or page errors.

## Final result

passed
