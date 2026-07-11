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
