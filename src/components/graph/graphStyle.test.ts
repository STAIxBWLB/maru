// @vitest-environment jsdom

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

const LIGHT = { "--graph-canvas": "#f4f3ee", "--graph-ink": "#1f1d18", "--graph-muted": "#69645b", "--graph-line": "#dedbd1", "--graph-accent": "#7c5ce7" };
const DARK = { "--graph-canvas": "#1e1e1e", "--graph-ink": "#f2f0e8", "--graph-muted": "#8f918c", "--graph-line": "#30322f", "--graph-accent": "#8b5cf6" };

describe("graph theme", () => {
  beforeEach(() => setTokens(LIGHT));

  it("reads light tokens and exposes a 12-color light palette", () => {
    const theme = refreshGraphTheme();
    expect(theme.dark).toBe(false);
    expect(theme.bg).toBe("#f4f3ee");
    expect(theme.accent).toBe("#7c5ce7");
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

  it("recognizes computed rgb backgrounds used by the app theme", () => {
    setTokens({ ...DARK, "--graph-canvas": "rgb(30, 30, 30)" });
    const theme = refreshGraphTheme();
    expect(theme.dark).toBe(true);
    expect(theme.bg).toBe("rgb(30, 30, 30)");
  });

  it("falls back when tokens hold unevaluated color-mix()/var() values", () => {
    // getPropertyValue returns custom-property token streams unevaluated;
    // Sigma's parseColor would turn them into opaque black.
    setTokens({
      ...DARK,
      "--graph-edge": "color-mix(in srgb, var(--ink) 7%, transparent)",
      "--graph-line": "var(--line)",
    });
    const theme = refreshGraphTheme();
    expect(theme.dark).toBe(true);
    expect(theme.edge).toBe("#292a29"); // dark fallback, not the raw token text
    expect(theme.line).toBe("#30322f"); // DARK_DEFAULTS.line fallback
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

  it("nodeColor supports neutral, community, and domain appearance modes", () => {
    const theme = refreshGraphTheme();
    expect(nodeColor(node({ type: "unresolved" }), false)).toBe(theme.bg);
    expect(nodeColor(node({}), false, "neutral")).toBe(theme.neutralNode);
    expect(nodeColor(node({ community: 2 }), true, "community")).toBe(theme.communityColors[2]);
    expect(nodeColor(node({ domain: "research" }), false, "domain")).toBe(theme.domainColors.research);
    expect(nodeColor(node({}), false, "domain")).toBe(theme.fallback);
  });

  it("domainColor falls back for unknown domains", () => {
    const theme = refreshGraphTheme();
    expect(domainColor("nope")).toBe(theme.fallback);
    expect(domainColor(null)).toBe(theme.fallback);
    expect(graphTheme().domainColors.research).toBe(domainColor("research"));
  });
});
